/**
 * recording-v2.routes.ts — agent HTTP API for screen recording v2 (docs/recording-v2.md §6).
 * Mounted at /api/recording/v2. All routes: Authorization: Bearer <agent token>.
 */
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { requireAgentToken } from '../middleware/requireAgentToken';
import { isRecordingSchemaReady } from '../db/ensure-recording-schema';
import { HttpError } from '../services/recording.service';
import * as V2 from '../services/recording-v2.service';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isRecordingSchemaReady()) return res.status(503).json({ error: 'recording_schema_not_ready' });
  next();
});
router.use(requireAgentToken);

const userOf = (req: Request): string => (req as any).agentUser.userId;

function fail(res: Response, err: any, what: string) {
  if (err instanceof HttpError) {
    // 404 carries the machine-readable code the agent keys on.
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[Recording v2] ${what} failed:`, err?.message ?? err);
  return res.status(500).json({ error: `${what} failed` });
}

const validSegment = (id: string) => V2.SEGMENT_ID_RE.test(id);

/** PUT /segments/:segmentId — register (idempotent) */
router.put('/segments/:segmentId', async (req: Request, res: Response) => {
  const segmentId = String(req.params.segmentId);
  if (!validSegment(segmentId)) return res.status(400).json({ error: 'invalid segmentId' });
  try {
    const r = await V2.registerSegment(userOf(req), segmentId, req.body ?? {});
    res.status(r.created ? 201 : 200).json({ segmentId: r.segmentId, sessionId: r.sessionId, recordingDate: r.recordingDate, state: r.state });
  } catch (err) {
    fail(res, err, 'Segment registration');
  }
});

/** PUT /segments/:segmentId/chunks/:seq — raw body, X-Chunk-Sha256 required */
router.put('/segments/:segmentId/chunks/:seq', async (req: Request, res: Response) => {
  const segmentId = String(req.params.segmentId);
  const seq = V2.parseSeq(String(req.params.seq));
  if (!validSegment(segmentId) || seq === null) return res.status(400).json({ error: 'valid segmentId and seq required' });

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Empty or non-binary chunk body' });

  const sha = req.header('x-chunk-sha256');
  if (!V2.isSha(sha)) return res.status(400).json({ error: 'X-Chunk-Sha256 (hex sha256) header required' });
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  if (actual !== sha.toLowerCase()) return res.status(400).json({ error: 'sha256_mismatch' });

  let capturedAt: Date | null = null;
  const cap = req.header('x-captured-at');
  if (cap) {
    capturedAt = new Date(cap);
    if (isNaN(capturedAt.getTime())) return res.status(400).json({ error: 'X-Captured-At must be an ISO date' });
  }
  let durationMs: number | null = null;
  const dur = req.header('x-duration-ms');
  if (dur !== undefined && dur !== '') {
    if (!/^\d{1,9}$/.test(dur)) return res.status(400).json({ error: 'X-Duration-Ms must be a non-negative integer' });
    durationMs = parseInt(dur, 10);
  }
  const lo = req.header('x-logged-out');
  if (lo !== undefined && lo !== '0' && lo !== '1') return res.status(400).json({ error: 'X-Logged-Out must be 0 or 1' });

  try {
    const r = await V2.saveChunkV2(userOf(req), segmentId, seq, body, { sha256: sha, capturedAt, durationMs, loggedOut: lo === '1' });
    if (r.conflict) return res.status(201).json({ ok: true, conflict: true });
    if (r.duplicate) return res.status(200).json({ ok: true, duplicate: true });
    res.status(201).json({ ok: true });
  } catch (err) {
    fail(res, err, 'Chunk upload');
  }
});

/** POST /segments/:segmentId/close */
router.post('/segments/:segmentId/close', async (req: Request, res: Response) => {
  const segmentId = String(req.params.segmentId);
  if (!validSegment(segmentId)) return res.status(400).json({ error: 'invalid segmentId' });
  try {
    res.json(await V2.closeSegment(userOf(req), segmentId, req.body ?? {}));
  } catch (err) {
    fail(res, err, 'Segment close');
  }
});

/** GET /segments/:segmentId/manifest */
router.get('/segments/:segmentId/manifest', async (req: Request, res: Response) => {
  const segmentId = String(req.params.segmentId);
  if (!validSegment(segmentId)) return res.status(400).json({ error: 'invalid segmentId' });
  try {
    res.json(await V2.segmentManifest(userOf(req), segmentId));
  } catch (err) {
    fail(res, err, 'Segment manifest');
  }
});

export default router;
