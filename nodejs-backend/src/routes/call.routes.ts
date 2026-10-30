/**
 * call.routes.ts — REST surface for voice & video calls.
 *
 * All routes require a signed token (`requireUser`). The legacy unsigned
 * `X-User-Id` trust model is deliberately NOT accepted here: calls can be
 * recorded for HR audit, so identity has to be verifiable.
 *
 * Route map:
 *   POST   /ws-token              short-lived ticket for the call WebSocket
 *   GET    /ice-servers           STUN/TURN configuration with a fresh credential
 *   POST   /sessions              start a call (1:1 or group)
 *   GET    /sessions              calls the caller took part in
 *   GET    /sessions/:id          one call with its participants
 *   POST   /sessions/:id/accept   accept an incoming call
 *   POST   /sessions/:id/decline  decline an incoming call
 *   POST   /sessions/:id/leave    leave a call
 *   POST   /sessions/:id/end      end a call for everyone (host/admin)
 *   GET    /history               call log (own calls, or all for admins)
 */

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import prisma from '../prisma';
import { requireUser, signCallToken } from '../middleware/requireUser';
import { getIceServers } from '../services/turn.service';
import { getCallGateway } from '../gateways/call.gateway';
import {
  createCallSession,
  endCallSession,
  getCallSession,
  isParticipant,
  listCallLogs,
  listCallsForUser,
  markLogOutcome,
  markParticipantLeft,
  MAX_CALL_PARTICIPANTS,
} from '../services/call.service';
import { createAndDeliver, NOTIFICATION_TYPES } from '../services/notification.service';
import {
  saveChunk,
  listCallRecordings,
  getMixedRecording,
} from '../services/callrecording.service';

const router = Router();

/**
 * How many calls a single user may start per hour.
 * Override with CALL_RATE_LIMIT_PER_HOUR (the development value is raised so
 * the automated test suites are not throttled).
 */
const MAX_CALLS_PER_HOUR = Math.max(
  1,
  parseInt(process.env.CALL_RATE_LIMIT_PER_HOUR || '20', 10)
);

/** How many calls a user may be in at the same time. */
const MAX_CONCURRENT_CALLS = Math.max(
  1,
  parseInt(process.env.CALL_MAX_CONCURRENT_CALLS || '2', 10)
);

const callTimestamps: Map<string, number[]> = new Map();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const recent = (callTimestamps.get(userId) || []).filter((t) => t > hourAgo);
  if (recent.length >= MAX_CALLS_PER_HOUR) {
    callTimestamps.set(userId, recent);
    return true;
  }
  recent.push(now);
  callTimestamps.set(userId, recent);
  return false;
}

function isAdminRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** Resolves the acting user from the middleware-attached identity. */
function actingUser(req: Request): { userId: string; name: string; role: string } {
  const u = (req as any).user || { userId: '', name: '', role: '' };
  return { userId: u.userId, name: u.name, role: u.role };
}

// ── Auth / configuration ───────────────────────────────────

/**
 * Issues a short-lived (5 min) ticket for the call WebSocket.
 * The browser passes it as ?token= on /call-ws.
 */
router.post('/ws-token', requireUser, (req: Request, res: Response) => {
  const user = actingUser(req);
  const token = signCallToken(
    { id: user.userId, name: user.name, role: user.role },
    (req as any).user?.sessionId
  );
  res.json({ token, expiresIn: 300 });
});

/**
 * STUN/TURN configuration. TURN credentials are minted per request so the
 * shared secret never leaves the server.
 */
router.get('/ice-servers', requireUser, (_req: Request, res: Response) => {
  res.json(getIceServers());
});

// ── Call lifecycle ─────────────────────────────────────────

/**
 * Starts a call. Body: { user_id, target_user_ids: string[], conversation_id? }
 */
router.post('/sessions', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const body = req.body || {};
  const targetUserIds: string[] = Array.isArray(body.target_user_ids)
    ? body.target_user_ids.map(String)
    : [];

  if (targetUserIds.length === 0) {
    return res.status(400).json({ error: 'target_user_ids is required.' });
  }

  if (isRateLimited(user.userId)) {
    return res.status(429).json({ error: 'Too many calls started. Try again later.' });
  }

  const openCalls = await listCallsForUser(user.userId, { limit: 100, isAdmin: false });
  const stillOpen = openCalls.filter(
    (c) => (c.status === 'ringing' || c.status === 'active') && !c.ended_at
  );
  if (stillOpen.length >= MAX_CONCURRENT_CALLS) {
    return res.status(409).json({ error: 'You are already in a call.' });
  }

  let created;
  try {
    created = await createCallSession({
      startedBy: user.userId,
      targetUserIds,
      conversationId: body.conversation_id ?? null,
      maxParticipants: MAX_CALL_PARTICIPANTS,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Could not start the call.' });
  }

  // Ring the callees on the call gateway (live UI) and raise a notification
  // (notification centre + native OS notification on the Electron agent).
  // `ringCall` tells us which callees were actually reachable, so the caller
  // can show "Ringing…" when someone is online and keep "Connecting…" while
  // every callee is offline.
  const gateway = getCallGateway();
  const ring = gateway
    ? gateway.ringCall(created.id, { userId: user.userId, name: user.name }, created.targetUserIds)
    : { onlineUserIds: [], offlineUserIds: created.targetUserIds };

  // Names are resolved here so the caller can display the person they are
  // calling instead of a generic label.
  const targetUsers = await prisma.user.findMany({
    where: { id: { in: created.targetUserIds } },
    select: { id: true, name: true },
  });

  for (const targetId of created.targetUserIds) {
    await createAndDeliver({
      userId: targetId,
      type: NOTIFICATION_TYPES.CALL_INCOMING,
      title: 'Incoming call',
      message: `${user.name} is calling you.`,
      link: `/calls/${created.id}`,
    });
  }

  res.json({
    id: created.id,
    status: 'ringing',
    started_by: user.userId,
    target_user_ids: created.targetUserIds,
    target_users: targetUsers,
    online_user_ids: ring.onlineUserIds,
    offline_user_ids: ring.offlineUserIds,
    conversation_id: created.conversationId,
    started_at: created.createdAt,
  });
});

/** Lists the calls the caller took part in. */
router.get('/sessions', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const limit = parseInt(String(req.query.limit || '50'), 10);
  const calls = await listCallsForUser(user.userId, { limit, isAdmin: isAdminRole(user.role) });
  res.json(calls);
});

/** One call with its participants. Participants and admins only. */
router.get('/sessions/:id', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const session = await getCallSession(String(req.params.id));
  if (!session) return res.status(404).json({ error: 'Call not found.' });

  if (!isAdminRole(user.role) && !(await isParticipant(session.id, user.userId))) {
    return res.status(403).json({ error: 'You are not part of this call.' });
  }

  res.json(session);
});

/**
 * Accepts an incoming call. The client then joins over the WebSocket, which
 * is what actually establishes the media path; this records the outcome.
 */
router.post('/sessions/:id/accept', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const session = await getCallSession(String(req.params.id));
  if (!session) return res.status(404).json({ error: 'Call not found.' });

  if (!(await isParticipant(session.id, user.userId))) {
    return res.status(403).json({ error: 'You are not part of this call.' });
  }

  await markLogOutcome(session.id, user.userId, 'answered');
  res.json({ ok: true, call_id: session.id });
});

/** Declines an incoming call and notifies the caller. */
router.post('/sessions/:id/decline', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const session = await getCallSession(String(req.params.id));
  if (!session) return res.status(404).json({ error: 'Call not found.' });

  if (!(await isParticipant(session.id, user.userId))) {
    return res.status(403).json({ error: 'You are not part of this call.' });
  }

  await markLogOutcome(session.id, user.userId, 'declined');
  // Mark the participant as gone, otherwise a reconnect would replay the
  // invite while the session is still ringing for the other callees.
  await markParticipantLeft(session.id, user.userId);

  const gateway = getCallGateway();
  if (gateway) {
    gateway.notifyDeclined(session.id, user.userId, session.started_by);
  }

  await createAndDeliver({
    userId: session.started_by,
    type: NOTIFICATION_TYPES.CALL_DECLINED,
    title: 'Call declined',
    message: `${user.name} declined your call.`,
    link: `/calls/${session.id}`,
  });

  res.json({ ok: true, call_id: session.id });
});

/** Leaves a call. */
router.post('/sessions/:id/leave', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const session = await getCallSession(String(req.params.id));
  if (!session) return res.status(404).json({ error: 'Call not found.' });

  if (!(await isParticipant(session.id, user.userId))) {
    return res.status(403).json({ error: 'You are not part of this call.' });
  }

  await prisma.callParticipant.updateMany({
    where: { call_id: session.id, user_id: user.userId, left_at: null },
    data: { left_at: new Date() },
  });

  res.json({ ok: true, call_id: session.id });
});

/** Ends a call for everyone. Host or admin only. */
router.post('/sessions/:id/end', requireUser, async (req: Request, res: Response) => {
  const user = actingUser(req);
  const session = await getCallSession(String(req.params.id));
  if (!session) return res.status(404).json({ error: 'Call not found.' });

  const isHost = session.started_by === user.userId;
  if (!isHost && !isAdminRole(user.role)) {
    return res.status(403).json({ error: 'Only the host can end this call.' });
  }

  await endCallSession(session.id);

  const gateway = getCallGateway();
  if (gateway) {
    // Tell the other participants and clean up the live mesh state.
    await gateway.endCall(session.id, user.userId);

    const others = session.participants
      .filter((p) => p.user_id !== user.userId)
      .map((p) => p.user_id);
    gateway.notifyCancelled(session.id, user.userId, others);
  }

  res.json({ ok: true, call_id: session.id });
});

  /** Call log — own calls, or every call for admins. */
  router.get('/history', requireUser, async (req: Request, res: Response) => {
    const user = actingUser(req);
    const limit = parseInt(String(req.query.limit || '100'), 10);
    const logs = await listCallLogs(user.userId, { limit, isAdmin: isAdminRole(user.role) });
    res.json(logs);
  });

  // ── Recordings ───────────────────────────────────────────

  /**
   * Uploads one 30-second audio chunk of a call recording.
   * Body: raw `application/octet-stream`. Headers: X-Call-Id, X-Chunk-Index.
   */
  router.post(
    '/recordings/chunk',
    requireUser,
    async (req: Request, res: Response) => {
      const user = actingUser(req);
      const callId = String(req.headers['x-call-id'] || '');
      const chunkIndex = parseInt(String(req.headers['x-chunk-index'] || '0'), 10);

      if (!callId) {
        return res.status(400).json({ error: 'X-Call-Id header is required.' });
      }
      if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ error: 'X-Chunk-Index header must be a non-negative integer.' });
      }
      if (!(await isParticipant(callId, user.userId))) {
        return res.status(403).json({ error: 'You are not part of this call.' });
      }

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length === 0) {
        return res.status(400).json({ error: 'Empty chunk body.' });
      }

      const size = await saveChunk(callId, user.userId, chunkIndex, buffer);
      res.json({ ok: true, chunk_index: chunkIndex, size });
    }
  );

  /** Lists the recordings of a call. Admin only. */
  router.get('/recordings/call/:callId', requireUser, async (req: Request, res: Response) => {
    const user = actingUser(req);
    if (!isAdminRole(user.role)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const recordings = await listCallRecordings(String(req.params.callId));
    res.json(recordings);
  });

  /**
   * Streams the mixed recording of a whole call. Admin only.
   * Registered before /recordings/:id/play so "call" is not read as an id.
   */
  router.get(
    '/recordings/call/:callId/play',
    requireUser,
    async (req: Request, res: Response) => {
      const user = actingUser(req);
      if (!isAdminRole(user.role)) {
        return res.status(403).json({ error: 'Admin access required.' });
      }

      const file = await getMixedRecording(String(req.params.callId));
      if (!file || !fs.existsSync(file)) {
        return res.status(404).json({ error: 'No recording found for this call.' });
      }

      res.setHeader('Content-Type', 'audio/webm');
      res.setHeader('Content-Length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    }
  );

  /** Streams one participant's recording. Admin only. */
  router.get('/recordings/:id/play', requireUser, async (req: Request, res: Response) => {
    const user = actingUser(req);
    if (!isAdminRole(user.role)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const recording = await prisma.callRecording.findUnique({
      where: { id: String(req.params.id) },
    });

    if (!recording || !fs.existsSync(recording.file_path)) {
      return res.status(404).json({ error: 'Recording not found.' });
    }

    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Content-Length', recording.file_size);
    fs.createReadStream(recording.file_path).pipe(res);
  });


export default router;
