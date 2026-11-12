/**
 * recording.routes.ts — REST API for Recording System
 *
 * All admin routes require Authorization: Bearer <user session token> (admin/superadmin role).
 * All agent routes require Authorization: Bearer <agent-jwt>.
 *
 * Endpoints:
 *   POST   /api/recording/agent-auth           Agent gets token
 *   POST   /api/recording/session/start        Admin starts session
 *   POST   /api/recording/session/stop         Admin stops session
 *   GET    /api/recording/sessions             List all sessions
 *   GET    /api/recording/sessions/:id         Get session detail
 *   GET    /api/recording/sessions/:id/file    Download assembled recording
 *   POST   /api/recording/chunk                Agent uploads video chunk
 *   GET    /api/recording/status/:userId       Live status for user
 *   GET    /api/recording/agents               List connected agents
 */

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireRecordingAccess, hasRecordingAccess } from '../middleware/requireRecordingAccess';
import { requireAgentToken } from '../middleware/requireAgentToken';
import { verifyUserToken, findSessionUser, TOKEN_EXPIRED_CODE, signViewerToken, signPlaybackToken, verifyPlaybackToken } from '../middleware/requireUser';
import { getGateway } from '../gateways/recording.gateway';
import * as RecordingService from '../services/recording.service';
import { recordingEmitter, HttpError, isValidSessionId, startsWithEbml } from '../services/recording.service';
import { assembleOnDemand, getRetentionDays, setRetentionDays, RETENTION_VALUES, QUALITY_VALUES, getRecordingQuality, setRecordingQuality } from '../services/recording-v2.service';
import prisma from '../prisma';

const router = Router();

// ─────────────────────────────────────────
// Agent Authentication
// ─────────────────────────────────────────

/**
 * POST /api/recording/agent-auth
 * Electron agent trades its user session token for a 30-day agent JWT.
 * Headers: Authorization: Bearer <user session token>
 * Body: { user_id?: string } (must match the token's user if present)
 * Legacy unauthenticated issuance only when ALLOW_LEGACY_AGENT_AUTH=1.
 */
router.post('/agent-auth', async (req: Request, res: Response) => {
  const bodyUserId = req.body?.user_id;
  const authHeader = req.headers.authorization;
  let userId: string;

  if (authHeader?.startsWith('Bearer ')) {
    const payload = verifyUserToken(authHeader.substring(7));
    if (!payload?.sessionId) {
      return res.status(401).json({ error: 'Invalid or expired token.', code: TOKEN_EXPIRED_CODE });
    }
    try {
      const user = await findSessionUser(payload.sessionId, payload.userId);
      if (!user) return res.status(401).json({ error: 'Session has ended.', code: TOKEN_EXPIRED_CODE });
      if (user.status !== 'active') return res.status(403).json({ error: 'User account is not active.' });
      userId = user.id;
    } catch (err: any) {
      console.error('[Recording] Agent auth lookup failed:', err.message);
      return res.status(500).json({ error: 'Authentication check failed.' });
    }
    if (bodyUserId && String(bodyUserId) !== userId) {
      return res.status(403).json({ error: 'user_id does not match authenticated user' });
    }
  } else if (process.env.ALLOW_LEGACY_AGENT_AUTH === '1' && bodyUserId) {
    userId = String(bodyUserId);
    console.warn(`[Recording] WARNING: legacy unauthenticated agent-auth used for user ${userId}`);
  } else {
    return res.status(401).json({
      error: 'Authentication required. Use Authorization: Bearer <token>.',
      code: TOKEN_EXPIRED_CODE,
    });
  }

  try {
    const token = await RecordingService.issueAgentToken(userId);
    res.json({ token, userId, expiresIn: '30d' });
  } catch (err: any) {
    console.error('[Recording] Agent auth failed:', err.message);
    res.status(err.message === 'User not found' ? 404 : 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Session Control (Admin)
// ─────────────────────────────────────────

/**
 * POST /api/recording/session/start
 * Headers: Authorization: Bearer <admin session token>
 * Body: { user_id: string, quality?: string }
 */
router.post('/session/start', requireAdmin, async (req: Request, res: Response) => {
  const { user_id, quality = '720p' } = req.body;
  const admin = (req as any).adminUser;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const result = await RecordingService.startSession(user_id, admin.id, quality);
    res.status(201).json({
      sessionId: result.sessionId,
      agentConnected: result.agentConnected,
      message: result.agentConnected
        ? 'Recording started on agent'
        : 'Session created — agent not connected yet',
    });
  } catch (err: any) {
    console.error('[Recording] Start session failed:', err.message);
    if (err.message === 'Admins cannot be recorded') {
      return res.status(400).json({ error: 'Admins cannot be recorded' });
    }
    res.status(500).json({ error: 'Failed to start recording session' });
  }
});

/**
 * POST /api/recording/session/stop
 * Headers: Authorization: Bearer <admin session token>
 * Body: { session_id: string }
 */
router.post('/session/stop', requireAdmin, async (req: Request, res: Response) => {
  const { session_id } = req.body;
  const admin = (req as any).adminUser;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    const result = await RecordingService.stopSession(session_id, admin.id);
    res.json({
      ok: result.ok,
      agentConnected: result.agentConnected,
      message: 'Stop command sent. Assembly will complete in ~15 seconds.',
    });
  } catch (err: any) {
    const status = err.message === 'Session not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Session Queries (Admin)
// ─────────────────────────────────────────

/**
 * GET /api/recording/sessions?userId=<optional>
 * Returns up to 100 most recent sessions.
 */
router.get('/sessions', requireRecordingAccess, async (req: Request, res: Response) => {
  const { userId } = req.query;
  try {
    const sessions = await RecordingService.listSessions(userId as string | undefined);
    res.json({ sessions, count: sessions.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
};

/**
 * GET /api/recording/days?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&page=1&pageSize=50
 * One row per recording session (v2: per day; legacy: per session), newest first.
 * v2 is filtered by recording_date, legacy by created_at (Karachi calendar day).
 */
router.get('/days', requireRecordingAccess, async (req: Request, res: Response) => {
  const from = parseDay(req.query.from);
  const to = parseDay(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: 'from must not be after to' });
  const intParam = (v: unknown, def: number) => (v === undefined || v === '' ? def : /^\d{1,6}$/.test(String(v)) ? parseInt(String(v), 10) : NaN);
  const page = intParam(req.query.page, 1);
  const pageSize = intParam(req.query.pageSize, 50);
  if (!(page >= 1) || !(pageSize >= 1 && pageSize <= 200)) return res.status(400).json({ error: 'page >= 1 and 1 <= pageSize <= 200 required' });
  const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;

  try {
    const legacyFrom = new Date(`${req.query.from}T00:00:00+05:00`);
    const legacyTo = new Date(new Date(`${req.query.to}T00:00:00+05:00`).getTime() + 86_400_000);
    const where = {
      ...(userId ? { user_id: userId } : {}),
      OR: [
        { recording_date: { gte: from, lte: to } },
        { recording_date: null, created_at: { gte: legacyFrom, lt: legacyTo } },
      ],
    };
    // ponytail: sort keys for the whole range in memory (a few thousand light rows); SQL COALESCE sort if ranges grow.
    const keys = await prisma.recordingSession.findMany({ where, select: { id: true, recording_date: true, created_at: true } });
    keys.sort((a, b) => (b.recording_date ?? b.created_at).getTime() - (a.recording_date ?? a.created_at).getTime() || b.created_at.getTime() - a.created_at.getTime());
    const ids = keys.slice((page - 1) * pageSize, page * pageSize).map((k) => k.id);
    const rows = await prisma.recordingSession.findMany({
      where: { id: { in: ids } },
      include: { employee: { select: { name: true, department: { select: { name: true } } } }, segments: { select: { state: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = await Promise.all(ids.map(async (id) => {
      const r = byId.get(id);
      if (!r) return null;
      const legacy = !r.recording_date;
      const st = (state: string) => r.segments.filter((x) => x.state === state).length;
      let hasFile = false;
      if (r.file_path) hasFile = await fs.promises.stat(r.file_path).then((f) => f.isFile(), () => false);
      return {
        sessionId: r.id,
        userId: r.user_id,
        name: r.employee.name,
        department: r.employee.department?.name ?? null,
        recordingDate: r.recording_date ? r.recording_date.toISOString().slice(0, 10) : null,
        createdAt: r.created_at,
        legacy,
        status: r.status,
        generation: r.generation,
        durationMs: legacy ? null : r.duration_ms,
        loggedOutMs: r.logged_out_ms,
        segments: r.segments.length,
        incompleteSegments: st('incomplete'),
        openSegments: st('open'),
        assembling: !legacy && (RecordingService.isAssembling(r.id) || st('complete') + st('incomplete') > 0),
        lastChunkAt: r.last_chunk_at,
        hasFile,
      };
    }));
    res.json({ items: items.filter(Boolean), total: keys.length, page, pageSize });
  } catch (err: any) {
    console.error('[Recording] days failed:', err.message);
    res.status(500).json({ error: 'Failed to list recording days' });
  }
});

/** GET /api/recording/live-presence - Agent[] (same data as LIVE_PRESENCE). */
router.get('/live-presence', requireRecordingAccess, async (req: Request, res: Response) => {
  try {
    res.json((await getGateway()?.getLivePresence()) ?? []);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read presence' });
  }
});

/**
 * GET /api/recording/sessions/:id
 * Returns session detail including chunk list.
 */
router.get('/sessions/:id', requireRecordingAccess, async (req: Request, res: Response) => {
  try {
    const session = await RecordingService.getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * File route auth: a Bearer header goes through requireRecordingAccess unchanged; without one,
 * `?pt=<playback token>` (POST /sessions/:id/playback-token) lets a <video src> stream with Range.
 * `pt` is honoured on this route only and only for the session it was minted for.
 */
async function requireFileAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pt = req.query.pt;
  if (req.headers.authorization || typeof pt !== 'string') return requireRecordingAccess(req, res, next);
  try {
    const d = verifyPlaybackToken(pt);
    if (!d || d.sid !== String(req.params.id)) {
      res.status(401).json({ error: 'Invalid playback token.' });
      return;
    }
    if (!(await hasRecordingAccess(d.sub))) {
      res.status(403).json({ error: 'Recording access required.' });
      return;
    }
    next();
  } catch (err: any) {
    const expired = err?.name === 'TokenExpiredError';
    res.status(401).json({ error: expired ? 'Playback token expired.' : 'Invalid playback token.' });
  }
}

/**
 * POST /api/recording/sessions/:id/playback-token
 * 10-minute token for GET /sessions/:id/file?pt=... (video element, no Authorization header).
 */
router.post('/sessions/:id/playback-token', requireRecordingAccess, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'Invalid session id' });
  try {
    const exists = await prisma.recordingSession.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Session not found' });
    const pt = signPlaybackToken((req as any).adminUser.id, id);
    res.json({ url: `/api/recording/sessions/${id}/file?pt=${pt}` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create playback token' });
  }
});

/**
 * GET /api/recording/sessions/:id/file
 * Streams the assembled WebM recording (supports HTTP Range).
 */
router.get('/sessions/:id/file', requireFileAccess, async (req: Request, res: Response) => {
  try {
    const session = await RecordingService.getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.recording_date) {
      // v2: kick off assembly of unassembled data in the background, serve the last good generation.
      const assembling = await assembleOnDemand(session.id);
      if (!session.file_path) {
        return res.status(409).json({ error: 'Recording not yet assembled', status: session.status, assembling });
      }
    } else if (session.status !== 'assembled' || !session.file_path) {
      return res.status(409).json({
        error: 'Recording not yet assembled',
        status: session.status,
      });
    }

    const filePath = session.file_path;
    let size: number;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch {
      return res.status(404).json({ error: 'Recording file not found on disk' });
    }

    const employeeName = (session.employee?.name ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    const dayPart = session.recording_date ? `${session.recording_date.toISOString().slice(0, 10)}-` : '';
    const filename = `recording-${employeeName}-${dayPart}${session.id.substring(0, 8)}.webm`.replace(/[^A-Za-z0-9._-]/g, '-');

    res.setHeader('Content-Type', 'video/webm');
    // S13: only an explicit download is an attachment (the browser then streams it to disk); <video> needs inline.
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Session-Id', session.id);

    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (m[1] === '') {
          start = Math.max(0, size - parseInt(m[2], 10)); // suffix range
        } else {
          start = parseInt(m[1], 10);
          if (m[2]) end = Math.min(end, parseInt(m[2], 10));
        }
        if (start > end || start >= size) {
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
    }
    res.setHeader('Content-Length', end - start + 1);

    if (size === 0) return res.end();
    const rs = fs.createReadStream(filePath, { start, end });
    rs.on('error', (err) => {
      console.error('[Recording] File stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream recording file' });
      else res.end();
    });
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  } catch (err: any) {
    console.error('[Recording] File download failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream recording file' });
    else res.end();
  }
});

// ─────────────────────────────────────────
// Live Stream Feed (Admin)
// ─────────────────────────────────────────

/** Resolves when res has drained or closed. */
const waitDrain = (res: Response) =>
  new Promise<void>((r) => { res.once('drain', () => r()); res.once('close', () => r()); });

/**
 * GET /api/recording/sessions/:sessionId/stream
 * Live HTTP fallback: streams the chunks of the LAST WebM run, then new chunks.
 */
router.get('/sessions/:sessionId/stream', requireRecordingAccess, async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  let closed = false;
  let ready = false;
  let stopped = false;
  const buffered: { index: number; buffer: Buffer }[] = [];
  const sent = new Set<number>();

  const write = async (buf: Buffer) => {
    if (closed) return;
    if (!res.write(buf)) await waitDrain(res);
  };
  const onChunk = async (ev: { index: number; buffer: Buffer }) => {
    if (!ready) { buffered.push(ev); return; }
    if (sent.has(ev.index)) return;
    sent.add(ev.index);
    await write(ev.buffer);
  };
  const onStop = () => {
    if (!ready) { stopped = true; return; }
    cleanup();
    res.end();
  };
  const cleanup = () => {
    closed = true;
    recordingEmitter.removeListener(`chunk:${sessionId}`, onChunk);
    recordingEmitter.removeListener(`stopped:${sessionId}`, onStop);
  };

  try {
    // Subscribe BEFORE reading existing files so nothing is missed.
    recordingEmitter.on(`chunk:${sessionId}`, onChunk);
    recordingEmitter.on(`stopped:${sessionId}`, onStop);
    req.on('close', cleanup);

    const session = await prisma.recordingSession.findUnique({
      where: { id: sessionId },
      select: { status: true, recording_date: true },
    });
    if (!session) {
      cleanup();
      return res.status(404).send('Session not found');
    }
    if (session.recording_date) {
      cleanup();
      return res.status(409).send('Live HTTP stream is not available for v2 sessions');
    }
    const chunks = await prisma.recordingChunk.findMany({
      where: { session_id: sessionId },
      orderBy: { chunk_index: 'asc' },
      select: { chunk_index: true, file_path: true },
    });

    res.writeHead(200, {
      'Content-Type': 'video/webm',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Find the start of the last run (last chunk beginning with EBML magic).
    let startAt = 0;
    for (let i = chunks.length - 1; i >= 0; i--) {
      try {
        if (await startsWithEbml(chunks[i].file_path)) { startAt = i; break; }
      } catch { /* missing file — keep looking */ }
    }

    for (const c of chunks.slice(startAt)) {
      if (closed) return;
      try {
        for await (const buf of fs.createReadStream(c.file_path)) await write(buf as Buffer);
        sent.add(c.chunk_index!);
      } catch { /* missing file — skip */ }
    }

    // Flush chunks that arrived while we were reading, then go live.
    for (const ev of buffered.splice(0)) {
      if (closed) return;
      if (sent.has(ev.index)) continue;
      sent.add(ev.index);
      await write(ev.buffer);
    }
    ready = true;

    if (stopped || session.status === 'stopped' || session.status === 'assembled') {
      cleanup();
      return res.end();
    }
  } catch (err: any) {
    console.error('[Recording] Live stream error:', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).send('Streaming error');
    else res.end();
  }
});

// ─────────────────────────────────────────
// Chunk Upload (Agent)
// ─────────────────────────────────────────

/**
 * POST /api/recording/chunk
 * Agent uploads a binary WebM chunk.
 * Headers: Authorization: Bearer <agent-token>, Content-Type: application/octet-stream
 * Query params: sessionId, chunkIndex
 */
router.post(
  '/chunk',
  requireAgentToken,
  // Raw binary body — express.raw() is configured in index.ts for this content-type
  async (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '');
    const chunkIndex = String(req.query.chunkIndex ?? '');

    if (!isValidSessionId(sessionId) || !/^\d{1,7}$/.test(chunkIndex)) {
      return res.status(400).json({ error: 'valid sessionId and chunkIndex query params required' });
    }
    const chunkIdx = parseInt(chunkIndex, 10);

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty or non-binary chunk body' });
    }

    const agentUser = (req as any).agentUser;
    try {
      const result = await RecordingService.saveChunk(sessionId, chunkIdx, buffer, agentUser.userId);

      // Notify the gateway that a chunk was received
      getGateway()?.broadcast(agentUser.userId, {
        type: 'CHUNK_ACK',
        sessionId,
        chunkIndex: chunkIdx,
      });

      if (result.duplicate) return res.status(201).json({ ok: true, duplicate: true });
      if (result.conflict) return res.status(201).json({ ok: true, conflict: true });
      res.status(201).json({ ok: true, chunkIndex: chunkIdx, sessionId });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      console.error('[Recording] Chunk upload failed:', err.message);
      res.status(status).json({ error: err.message });
    }
  }
);

/**
 * POST /api/recording/chunks/check
 * Agent backlog check (after a restart / first run of a new version): which of
 * these locally kept chunks does the server already hold? Lets the agent mark
 * them uploaded without re-sending video.
 * Body: { sessionId, chunks: [{ index, size, fp }] } (max 2000 per call)
 * Response: { owned: boolean, have: number[] }
 */
router.post('/chunks/check', requireAgentToken, async (req: Request, res: Response) => {
  const { sessionId, chunks } = req.body ?? {};
  const valid =
    isValidSessionId(sessionId) &&
    Array.isArray(chunks) &&
    chunks.length <= 2000 &&
    chunks.every((c: any) =>
      Number.isInteger(c?.index) && c.index >= 0 &&
      Number.isInteger(c?.size) && c.size > 0 &&
      typeof c?.fp === 'string' && /^[a-f0-9]{64}$/.test(c.fp));
  if (!valid) return res.status(400).json({ error: 'sessionId and chunks[{index,size,fp}] (max 2000) required' });

  try {
    res.json(await RecordingService.checkChunks(sessionId, (req as any).agentUser.userId, chunks));
  } catch (err: any) {
    console.error('[Recording] Chunk check failed:', err.message);
    res.status(500).json({ error: 'Chunk check failed' });
  }
});

// ─────────────────────────────────────────
// Live Status (Admin)
// ─────────────────────────────────────────

/**
 * GET /api/recording/status/:userId
 * Returns whether the agent is connected and any active session.
 */
router.get('/status/:userId', requireRecordingAccess, async (req: Request, res: Response) => {
  const userId = String(req.params.userId);
  try {
    const liveStatus = RecordingService.getLiveStatus(userId);

    const activeSession = await prisma.recordingSession.findFirst({
      where: { user_id: userId, status: { in: ['pending', 'recording'] } },
      select: { id: true, status: true, started_at: true },
    });

    res.json({
      userId,
      agentConnected: liveStatus.connected,
      activeSession: activeSession ?? null,
      agentError: getGateway()?.getAgentError(userId) ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /api/recording/agents
 * Returns list of currently connected agent userIds.
 */
router.get('/agents', requireRecordingAccess, (req: Request, res: Response) => {
  const gateway = getGateway();
  const agents = gateway?.getConnectedAgents() ?? [];
  res.json({ connectedAgents: agents, count: agents.length });
});

/**
 * GET /api/recording/agents-status
 * Every agent seen since boot: connection + protocol + latest v2 STATUS fields.
 */
router.get('/agents-status', requireRecordingAccess, (req: Request, res: Response) => {
  res.json(getGateway()?.getAgentsStatus() ?? []);
});

/** GET /api/recording/settings — { retentionDays (0 = forever), quality } */
router.get('/settings', requireRecordingAccess, async (req: Request, res: Response) => {
  try {
    res.json({ retentionDays: await getRetentionDays(), quality: await getRecordingQuality() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

/** PUT /api/recording/settings (admin) — body { retentionDays?: 0|30|60|90, quality?: '480p'|'720p'|'1080p' } */
router.put('/settings', requireAdmin, async (req: Request, res: Response) => {
  const { retentionDays: days, quality } = req.body ?? {};
  if (days === undefined && quality === undefined) {
    return res.status(400).json({ error: 'Provide retentionDays and/or quality' });
  }
  if (days !== undefined && (!Number.isInteger(days) || !RETENTION_VALUES.includes(days))) {
    return res.status(400).json({ error: 'retentionDays must be one of 0, 30, 60, 90' });
  }
  if (quality !== undefined && !(QUALITY_VALUES as readonly string[]).includes(quality)) {
    return res.status(400).json({ error: `quality must be one of ${QUALITY_VALUES.join(', ')}` });
  }
  try {
    const adminId = (req as any).adminUser.id;
    if (days !== undefined) await setRetentionDays(days, adminId);
    if (quality !== undefined) {
      const changed = quality !== (await getRecordingQuality());
      await setRecordingQuality(quality, adminId);
      if (changed) await getGateway()?.pushRecordingSettings();
    }
    res.json({ retentionDays: await getRetentionDays(), quality: await getRecordingQuality() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

/**
 * POST /api/recording/admin-ws-token
 * Issues a short-lived JWT for admin WebSocket authentication.
 * Headers: Authorization: Bearer <admin session token>
 */
router.post('/admin-ws-token', requireRecordingAccess, (req: Request, res: Response) => {
  const admin = (req as any).adminUser;
  res.json({ token: signViewerToken(admin.id) });
});

export default router;
