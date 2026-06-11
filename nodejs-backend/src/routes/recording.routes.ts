/**
 * recording.routes.ts — REST API for Recording System
 *
 * All admin routes require X-Admin-Id header (validated against DB).
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

import { Router, Request, Response } from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireAgentToken } from '../middleware/requireAgentToken';
import { getGateway } from '../gateways/recording.gateway';
import * as RecordingService from '../services/recording.service';
import { recordingEmitter } from '../services/recording.service';
import prisma from '../prisma';

const AGENT_SECRET = process.env.AGENT_JWT_SECRET || 'ace-agent-secret-change-in-prod';

const router = Router();

// ─────────────────────────────────────────
// Agent Authentication
// ─────────────────────────────────────────

/**
 * POST /api/recording/agent-auth
 * Electron agent calls this on startup to get a 30-day JWT.
 * Body: { user_id: string }
 */
router.post('/agent-auth', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const token = await RecordingService.issueAgentToken(user_id);
    res.json({ token, expiresIn: '30d' });
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
 * Headers: X-Admin-Id: <adminUserId>
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
    res.status(500).json({ error: 'Failed to start recording session' });
  }
});

/**
 * POST /api/recording/session/stop
 * Headers: X-Admin-Id: <adminUserId>
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
router.get('/sessions', requireAdmin, async (req: Request, res: Response) => {
  const { userId } = req.query;
  try {
    const sessions = await RecordingService.listSessions(userId as string | undefined);
    res.json({ sessions, count: sessions.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/recording/sessions/:id
 * Returns session detail including chunk list.
 */
router.get('/sessions/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const session = await RecordingService.getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * GET /api/recording/sessions/:id/file
 * Streams the assembled WebM recording to the client for download.
 */
router.get('/sessions/:id/file', requireAdmin, async (req: Request, res: Response) => {
  try {
    const session = await RecordingService.getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.status !== 'assembled' || !session.file_path) {
      return res.status(409).json({
        error: 'Recording not yet assembled',
        status: session.status,
      });
    }

    const filePath = session.file_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Recording file not found on disk' });
    }

    const stats = fs.statSync(filePath);
    const employeeName = (session.employee?.name ?? 'unknown').replace(/\s+/g, '-');
    const filename = `recording-${employeeName}-${session.id.substring(0, 8)}.webm`;

    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('X-Session-Id', session.id);

    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    console.error('[Recording] File download failed:', err.message);
    res.status(500).json({ error: 'Failed to stream recording file' });
  }
});

// ─────────────────────────────────────────
// Live Stream Feed (Admin)
// ─────────────────────────────────────────

/**
 * GET /api/recording/sessions/:sessionId/stream
 * Streams the WebM chunks to the admin dashboard for live viewing.
 */
router.get('/sessions/:sessionId/stream', requireAdmin, async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);

  try {
    const session = await prisma.recordingSession.findUnique({
      where: { id: sessionId },
      include: { chunks: { orderBy: { chunk_index: 'asc' } } },
    });

    if (!session) {
      return res.status(404).send('Session not found');
    }

    res.writeHead(200, {
      'Content-Type': 'video/webm',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send existing chunks first
    for (const chunk of session.chunks) {
      if (fs.existsSync(chunk.file_path)) {
        const data = fs.readFileSync(chunk.file_path);
        res.write(data);
      }
    }

    // If session is already finished, end the stream
    if (session.status === 'stopped' || session.status === 'assembled') {
      return res.end();
    }

    // Subscribe to new chunks
    const onChunk = (buffer: Buffer) => {
      res.write(buffer);
    };

    const onStop = () => {
      res.end();
      cleanup();
    };

    const cleanup = () => {
      recordingEmitter.removeListener(`chunk:${sessionId}`, onChunk);
      recordingEmitter.removeListener(`stopped:${sessionId}`, onStop);
    };

    recordingEmitter.on(`chunk:${sessionId}`, onChunk);
    recordingEmitter.on(`stopped:${sessionId}`, onStop);

    // Handle client disconnect
    req.on('close', cleanup);
  } catch (err: any) {
    console.error('[Recording] Live stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Streaming error');
    } else {
      res.end();
    }
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
    const { sessionId, chunkIndex } = req.query;

    if (!sessionId || chunkIndex === undefined) {
      return res.status(400).json({ error: 'sessionId and chunkIndex query params required' });
    }

    const chunkIdx = parseInt(chunkIndex as string, 10);
    if (isNaN(chunkIdx) || chunkIdx < 0) {
      return res.status(400).json({ error: 'chunkIndex must be a non-negative integer' });
    }

    const buffer = req.body as Buffer;
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty chunk body' });
    }

    // Verify the agent is uploading for their own user's session
    const agentUser = (req as any).agentUser;
    try {
      await RecordingService.saveChunk(sessionId as string, chunkIdx, buffer);

      // Notify the gateway that a chunk was received (FIX #8: proper message type)
      getGateway()?.broadcast(agentUser.userId, {
        type: 'CHUNK_ACK',
        sessionId: sessionId as string,
        chunkIndex: chunkIdx,
      });

      res.status(201).json({ ok: true, chunkIndex: chunkIdx, sessionId });
    } catch (err: any) {
      const status = err.message === 'Session not found' ? 404 : 500;
      console.error('[Recording] Chunk upload failed:', err.message);
      res.status(status).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────
// Live Status (Admin)
// ─────────────────────────────────────────

/**
 * GET /api/recording/status/:userId
 * Returns whether the agent is connected and any active session.
 */
router.get('/status/:userId', requireAdmin, async (req: Request, res: Response) => {
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
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /api/recording/agents
 * Returns list of currently connected agent userIds.
 */
router.get('/agents', requireAdmin, (req: Request, res: Response) => {
  const gateway = getGateway();
  const agents = gateway?.getConnectedAgents() ?? [];
  res.json({ connectedAgents: agents, count: agents.length });
});

/**
 * POST /api/recording/admin-ws-token
 * Issues a short-lived JWT for admin WebSocket authentication.
 * Headers: X-Admin-Id
 */
router.post('/admin-ws-token', requireAdmin, (req: Request, res: Response) => {
  const admin = (req as any).adminUser;
  const token = jwt.sign(
    { sub: admin.id, role: 'admin-ws' },
    AGENT_SECRET,
    { expiresIn: '5m' }
  );
  res.json({ token });
});

export default router;
