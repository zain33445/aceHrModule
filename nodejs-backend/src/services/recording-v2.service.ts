/**
 * recording-v2.service.ts — Screen recording v2 (docs/recording-v2.md).
 *
 * Segment registration, durable chunk ingest, generation-based assembly,
 * v2 sweeper and retention. Legacy (v1) sessions (recording_date NULL) are
 * never touched here.
 *
 * HARD RULE: a recorded chunk is never lost, refused or overwritten.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import prisma from '../prisma';
import {
  HttpError,
  RECORDINGS_DIR,
  durableWrite,
  sha256File,
  runFfmpeg,
  concatFiles,
  rm,
  concatListEntry,
  recordingEmitter,
} from './recording.service';
import { recordingDateFor, recordingDayEndsAt, ruleForUser } from './recording-day';

export const SEGMENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const IDLE_ASSEMBLE_MS = 30 * 60_000;
const DAY_OVER_GRACE_MS = 30 * 60_000;
const LIVE_WINDOW_MS = 10 * 60_000;
const STUCK_SEGMENT_MS = 48 * 3600_000;
const ASSEMBLABLE = ['complete', 'incomplete'];

const dateOnly = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

// ─────────────────────────────────────────
// Paths
// ─────────────────────────────────────────

export function safeName(name: string): string {
  const n = (name || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/ +/g, '-').slice(0, 40);
  return n || 'user';
}

function sessionDir(recordingDate: string, userId: string, name: string, sessionId: string): string {
  return path.join(RECORDINGS_DIR, recordingDate, `${userId}-${safeName(name)}_(${sessionId})`);
}

/** The session folder: dir_path as fixed at creation (never recomputed). */
function dirOf(s: { dir_path: string | null; id: string; user_id: string; recording_date: Date | null }): string {
  if (s.dir_path) return s.dir_path;
  // Only reachable for a v2 row whose dir_path is somehow NULL: derive deterministically.
  return sessionDir(dateStr(s.recording_date ?? new Date()), s.user_id, '', s.id);
}

// ─────────────────────────────────────────
// Segment registration
// ─────────────────────────────────────────

export interface RegisterBody {
  startedAt?: unknown; mime?: unknown; width?: unknown; height?: unknown; deviceId?: unknown; recordingDate?: unknown;
}

const optStr = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const optDim = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 20000 ? (v as number) : null);

/** Reopens a session when data keeps arriving (assembled/stopped → recording). */
async function touchSession(sessionId: string, status: string, extra: Record<string, unknown> = {}) {
  await prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: 'recording', ended_at: null, ...(status === 'pending' ? { started_at: new Date() } : {}), ...extra },
  });
  if (status !== 'recording') console.log(`[Recording v2] Reopened session ${sessionId} (was ${status})`);
}

export async function segmentExists(segmentId: string): Promise<boolean> {
  return !!(await prisma.recordingSegment.findUnique({ where: { id: segmentId }, select: { id: true } }));
}

const CLOCK_PAST_MS = 365 * 86_400_000;
const CLOCK_FUTURE_MS = 86_400_000;

export async function registerSegment(userId: string, segmentId: string, body: RegisterBody) {
  if (!SEGMENT_ID_RE.test(segmentId)) throw new HttpError(400, 'invalid segmentId');
  let startedAt = new Date(String(body.startedAt ?? ''));
  if (typeof body.startedAt !== 'string' || isNaN(startedAt.getTime())) throw new HttpError(400, 'startedAt (ISO date) required');
  // S5: a wrong agent clock must not create sessions in 1970 / 2099 - fall back to server receipt time.
  const nowMs = Date.now();
  if (startedAt.getTime() < nowMs - CLOCK_PAST_MS || startedAt.getTime() > nowMs + CLOCK_FUTURE_MS) {
    console.warn(`[Recording v2] Segment ${segmentId}: startedAt ${startedAt.toISOString()} outside [now-365d, now+1d] - clamped to server time`);
    startedAt = new Date(nowMs);
  }

  const existing = await prisma.recordingSegment.findUnique({ where: { id: segmentId }, include: { session: true } });
  if (existing) {
    if (existing.user_id !== userId) throw new HttpError(403, 'Segment belongs to another user');
    return { created: false, segmentId, sessionId: existing.session_id, recordingDate: dateStr(existing.session.recording_date ?? new Date()), state: existing.state };
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!user) throw new HttpError(404, 'User not found');
  const rule = await ruleForUser(userId);
  const recordingDate = recordingDateFor(startedAt, rule);
  if (typeof body.recordingDate === 'string' && body.recordingDate !== recordingDate) {
    console.log(`[Recording v2] Segment ${segmentId}: agent day ${body.recordingDate} != server day ${recordingDate} (server wins)`);
  }

  const where = { user_id_recording_date: { user_id: userId, recording_date: dateOnly(recordingDate) } };
  let session = await prisma.recordingSession.findUnique({ where });
  if (!session) {
    const id = crypto.randomUUID();
    const dir = sessionDir(recordingDate, userId, user.name, id);
    try {
      session = await prisma.recordingSession.create({
        data: {
          id, user_id: userId, created_by: userId, status: 'recording', started_at: new Date(),
          recording_date: dateOnly(recordingDate), dir_path: dir,
        },
      });
      console.log(`[Recording v2] Created session ${id} for ${userId} day ${recordingDate}`);
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // lost the creation race — refetch
      session = await prisma.recordingSession.findUnique({ where });
    }
  }
  if (!session) throw new Error('Session not found after create');
  await fs.promises.mkdir(dirOf(session), { recursive: true });

  try {
    await prisma.recordingSegment.create({
      data: {
        id: segmentId, session_id: session.id, user_id: userId,
        device_id: optStr(body.deviceId, 100), started_at: startedAt,
        mime: optStr(body.mime, 100), width: optDim(body.width), height: optDim(body.height),
      },
    });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err; // same segment registered concurrently
    const again = await prisma.recordingSegment.findUnique({ where: { id: segmentId } });
    if (!again) throw err;
    if (again.user_id !== userId) throw new HttpError(403, 'Segment belongs to another user');
    return { created: false, segmentId, sessionId: again.session_id, recordingDate, state: again.state };
  }
  await touchSession(session.id, session.status);
  return { created: true, segmentId, sessionId: session.id, recordingDate, state: 'open' };
}

// ─────────────────────────────────────────
// Chunk ingest
// ─────────────────────────────────────────

export interface ChunkMeta { sha256: string; capturedAt?: Date | null; durationMs?: number | null; loggedOut: boolean }
export interface ChunkResult { duplicate?: boolean; conflict?: boolean }

export function parseSeq(v: unknown): number | null {
  return typeof v === 'string' && /^\d{1,7}$/.test(v) ? parseInt(v, 10) : null;
}
export function isSha(v: unknown): v is string { return typeof v === 'string' && SHA_RE.test(v); }

/** Segment state after new information (chunk / close). Only touches open-ish states. */
async function recomputeSegmentState(segmentId: string): Promise<string> {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId } });
  if (!seg) return 'open';
  if (seg.state !== 'closed' && seg.state !== 'complete' && seg.state !== 'incomplete') return seg.state;
  if (seg.last_seq === null) return seg.state;
  const lost = new Set(seg.lost_seqs);
  const have = new Set((await prisma.recordingChunk.findMany({ where: { segment_id: segmentId }, select: { seq: true } })).map((c) => c.seq));
  let all = true;
  for (let i = 0; i <= seg.last_seq; i++) if (!lost.has(i) && !have.has(i)) { all = false; break; }
  const next = !all ? 'closed' : lost.size > 0 ? 'incomplete' : 'complete';
  if (next !== seg.state) await prisma.recordingSegment.update({ where: { id: segmentId }, data: { state: next } });
  return next;
}

export async function saveChunkV2(userId: string, segmentId: string, seq: number, buffer: Buffer, meta: ChunkMeta): Promise<ChunkResult> {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId }, include: { session: true } });
  if (!seg) throw new HttpError(404, 'segment_not_registered');
  if (seg.user_id !== userId) throw new HttpError(403, 'Segment belongs to another user');

  const sha = meta.sha256.toLowerCase();
  const session = seg.session;
  const segDir = path.join(dirOf(session), 'segments', segmentId);
  await fs.promises.mkdir(segDir, { recursive: true });
  const finalPath = path.join(segDir, `${seq}.webm`);

  const existingRow = await prisma.recordingChunk.findUnique({ where: { segment_id_seq: { segment_id: segmentId, seq } } });
  let result: ChunkResult = {};

  const keepConflict = async (srcTmp: string | null) => {
    const collDir = path.join(dirOf(session), 'collisions');
    await fs.promises.mkdir(collDir, { recursive: true });
    const collPath = path.join(collDir, `${segmentId}-${seq}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.webm`);
    if (srcTmp) await fs.promises.rename(srcTmp, collPath);
    else { await durableWrite(collPath, buffer); }
    console.warn(`[Recording v2] CHUNK COLLISION segment=${segmentId} seq=${seq} — incoming kept at ${collPath}`);
    return { conflict: true } as ChunkResult;
  };

  if (existingRow && (existingRow.purged_at || (existingRow.sha256 && fs.existsSync(existingRow.file_path)))) {
    // Purged after assembly (file gone) or file present with known sha: compare by hash.
    if (existingRow.sha256 === sha) result = { duplicate: true };
    else if (existingRow.sha256) result = await keepConflict(null);
  }

  if (!result.duplicate && !result.conflict) {
    const tmpPath = path.join(segDir, `.tmp-${seq}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await durableWrite(tmpPath, buffer);
    let placed = false;
    try {
      try {
        await fs.promises.link(tmpPath, finalPath); // fails with EEXIST instead of overwriting
        placed = true;
      } catch (err: any) {
        if (err.code !== 'EEXIST' && !fs.existsSync(finalPath)) {
          await fs.promises.rename(tmpPath, finalPath); // filesystem without hard links
          placed = true;
        }
      }
      if (!placed) {
        const existingHash = await sha256File(finalPath);
        if (existingHash === sha) {
          result = { duplicate: true };
          // S1: the file is there but its row is not (crash between link and insert) - heal it.
          if (!existingRow) await insertChunkRow(segmentId, session.id, seq, finalPath, existingHash, (await fs.promises.stat(finalPath)).size, meta);
        } else {
          result = await keepConflict(tmpPath);
          // Heal a row lost to a crash between file write and DB insert: row describes the ORIGINAL file.
          if (!existingRow) await insertChunkRow(segmentId, session.id, seq, finalPath, existingHash, (await fs.promises.stat(finalPath)).size, meta);
        }
      } else if (!existingRow) {
        await insertChunkRow(segmentId, session.id, seq, finalPath, sha, buffer.length, meta);
      } else if (existingRow.sha256 !== sha) {
        await prisma.recordingChunk.update({ where: { id: existingRow.id }, data: { sha256: sha, file_path: finalPath, file_size: buffer.length } });
      }
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }

  if (!result.duplicate && !result.conflict) {
    await prisma.recordingSession.update({
      where: { id: session.id },
      data: { last_chunk_at: new Date(), status: 'recording', ended_at: null, ...(session.status === 'pending' ? { started_at: new Date() } : {}) },
    });
    if (seg.state === 'assembled') {
      console.warn(`[Recording v2] Late chunk seg=${segmentId} seq=${seq} for an already assembled segment — kept on disk, not in the video`);
    }
  }
  // Always recompute (also after a duplicate: a healed row may complete the segment). Only touches open-ish states.
  if (!result.conflict && seg.state !== 'assembled') await recomputeSegmentState(segmentId);
  return result;
}

async function insertChunkRow(segmentId: string, sessionId: string, seq: number, filePath: string, sha: string, size: number, meta: ChunkMeta) {
  try {
    await prisma.recordingChunk.create({
      data: {
        session_id: sessionId, segment_id: segmentId, seq, file_path: filePath, file_size: size, sha256: sha,
        captured_at: meta.capturedAt ?? null, duration_ms: meta.durationMs ?? null, logged_out: meta.loggedOut,
      },
    });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err; // concurrent identical upload won the insert — file is the same bytes
  }
}

// ─────────────────────────────────────────
// Close / manifest
// ─────────────────────────────────────────

export async function closeSegment(userId: string, segmentId: string, body: { lastSeq?: unknown; endedAt?: unknown; lostSeqs?: unknown }) {
  const lastSeq = body.lastSeq;
  if (!Number.isInteger(lastSeq) || (lastSeq as number) < -1 || (lastSeq as number) > 9_999_999) throw new HttpError(400, 'lastSeq (integer >= -1) required');
  const lost = body.lostSeqs ?? [];
  if (!Array.isArray(lost) || lost.length > 1_000_000 || !lost.every((n) => Number.isInteger(n) && n >= 0 && n <= (lastSeq as number))) {
    throw new HttpError(400, 'lostSeqs must be integers within 0..lastSeq');
  }
  let endedAt: Date | null = null;
  if (body.endedAt !== undefined && body.endedAt !== null) {
    endedAt = new Date(String(body.endedAt));
    if (isNaN(endedAt.getTime())) throw new HttpError(400, 'endedAt must be an ISO date');
  }

  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId } });
  if (!seg) throw new HttpError(404, 'segment_not_registered');
  if (seg.user_id !== userId) throw new HttpError(403, 'Segment belongs to another user');
  if (seg.state === 'assembled') return { state: seg.state };

  const lostSeqs = [...new Set(lost as number[])].sort((a, b) => a - b);
  await prisma.recordingSegment.update({
    where: { id: segmentId },
    data: { state: 'closed', last_seq: lastSeq as number, lost_seqs: lostSeqs, ended_at: endedAt ?? seg.ended_at ?? new Date() },
  });
  return { state: await recomputeSegmentState(segmentId) };
}

export async function segmentManifest(userId: string, segmentId: string) {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId } });
  if (!seg) throw new HttpError(404, 'segment_not_registered');
  if (seg.user_id !== userId) throw new HttpError(403, 'Segment belongs to another user');
  const rows = await prisma.recordingChunk.findMany({ where: { segment_id: segmentId }, select: { seq: true }, orderBy: { seq: 'asc' } });
  return { state: seg.state, lastSeq: seg.last_seq, have: rows.map((r) => r.seq as number) };
}

// ─────────────────────────────────────────
// Assembly (generations)
// ─────────────────────────────────────────

interface Probe { ok: boolean; durationMs: number; width: number | null; height: number | null }

/** Full demux pass (-c copy to null). Duration = last `time=` the demuxer reached. */
export async function probeFile(file: string): Promise<Probe> {
  const r = await runFfmpeg(['-v', 'info', '-i', file, '-c', 'copy', '-f', 'null', '-']);
  const times = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const t = times.length ? times[times.length - 1] : null;
  const durationMs = t ? Math.round((+t[1] * 3600 + +t[2] * 60 + +t[3]) * 1000) : 0;
  const dim = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr);
  return { ok: r.code === 0, durationMs, width: dim ? +dim[1] : null, height: dim ? +dim[2] : null };
}

/** Stream dimensions from the header only (`ffmpeg -i`, no decode). */
async function probeDims(file: string): Promise<{ width: number; height: number } | null> {
  const r = await runFfmpeg(['-hide_banner', '-i', file]);
  const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr);
  return m ? { width: +m[1], height: +m[2] } : null;
}

const pendingCleanup = new Set<string>(); // files whose deletion failed (EBUSY…); retried by the sweeper

async function deleteFile(p: string) {
  try { await fs.promises.unlink(p); pendingCleanup.delete(p); }
  catch (err: any) {
    if (err.code === 'ENOENT') { pendingCleanup.delete(p); return; }
    pendingCleanup.add(p);
    console.warn(`[Recording v2] Could not delete ${p}: ${err.code ?? err.message} (will retry)`);
  }
}

async function fsyncFile(p: string) {
  const fh = await fs.promises.open(p, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
}

async function ffmpegOk(args: string[], out: string): Promise<boolean> {
  const r = await runFfmpeg(args);
  let size = 0;
  try { size = (await fs.promises.stat(out)).size; } catch { /* missing */ }
  if (r.code !== 0 || size <= 0) {
    console.warn(`[Recording v2] ffmpeg failed (code ${r.code}): ${r.stderr.slice(-300)}`);
    await rm(out);
    return false;
  }
  return true;
}

const ABANDONED_SEGMENT_MS = 30 * 60_000;

/**
 * S4: a segment that is still open/closed but has not received a chunk for 30 min is finished: lastSeq
 * = highest stored seq (kept when the agent already closed it), missing seqs below it become lost_seqs,
 * then the normal state recompute makes it complete/incomplete (= assemblable). Zero-chunk segments are
 * left to the 48 h rule. Optionally scoped to one session (assembly start).
 */
export async function closeAbandonedSegments(sessionId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_SEGMENT_MS);
  const groups = await prisma.recordingChunk.groupBy({
    by: ['segment_id'],
    where: { segment: { state: { in: ['open', 'closed'] } }, ...(sessionId ? { session_id: sessionId } : {}) },
    _max: { uploaded_at: true, seq: true },
    having: { uploaded_at: { _max: { lt: cutoff } } },
  });
  let n = 0;
  for (const g of groups) {
    if (!g.segment_id || g._max.seq === null) continue;
    const seg = await prisma.recordingSegment.findUnique({ where: { id: g.segment_id } });
    if (!seg || (seg.state !== 'open' && seg.state !== 'closed')) continue;
    const have = new Set((await prisma.recordingChunk.findMany({ where: { segment_id: seg.id }, select: { seq: true } })).map((c) => c.seq));
    const lastSeq = seg.last_seq ?? g._max.seq;
    const lost: number[] = [];
    for (let i = 0; i <= lastSeq; i++) if (!have.has(i)) lost.push(i);
    await prisma.recordingSegment.update({
      where: { id: seg.id },
      data: { state: 'closed', last_seq: lastSeq, lost_seqs: lost, ended_at: seg.ended_at ?? g._max.uploaded_at ?? new Date() },
    });
    const next = await recomputeSegmentState(seg.id);
    console.warn(`[Recording v2] Segment ${seg.id} abandoned (no chunk for 30 min) - closed at lastSeq ${lastSeq}, ${lost.length} lost, now ${next}`);
    n++;
  }
  return n;
}

const REENCODE = ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k', '-an'];

export async function assembleSessionV2(sessionId: string): Promise<void> {
  try {
    await assembleSessionV2Inner(sessionId);
  } catch (err: any) {
    console.error(`[Recording v2] Assembly failed for ${sessionId}: ${err.message}`);
    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { assembly_error: String(err.message).slice(0, 1000), assembly_attempts: { increment: 1 } },
    }).catch(() => {});
    throw err;
  }
}

async function assembleSessionV2Inner(sessionId: string): Promise<void> {
  const session = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
  if (!session || !session.recording_date) throw new Error('v2 session not found');
  await closeAbandonedSegments(sessionId); // S4: on-demand assembly benefits too
  const all = await prisma.recordingSegment.findMany({
    where: { session_id: sessionId, state: { in: ASSEMBLABLE } },
    orderBy: { started_at: 'asc' },
    include: { chunks: { where: { purged_at: null }, orderBy: { seq: 'asc' } } },
  });
  if (all.length === 0) return;

  // S2: never commit (and so never purge) a segment whose stored chunk file is missing. It stays as it is;
  // healthy segments of the same session are still assembled.
  const broken: string[] = [];
  const segments = all.filter((seg) => {
    const miss = seg.chunks.find((c) => !fs.existsSync(c.file_path));
    if (miss) broken.push(`segment ${seg.id} seq ${miss.seq} (${miss.file_path})`);
    return !miss;
  });
  const brokenMsg = () => `chunk file missing on disk: ${broken.join('; ')}`.slice(0, 900);
  if (broken.length) console.error(`[Recording v2] Session ${sessionId}: ${brokenMsg()}`);
  if (segments.length === 0) throw new Error(brokenMsg());
  const keepError = () => broken.length
    ? prisma.recordingSession.update({ where: { id: sessionId }, data: { assembly_error: brokenMsg(), assembly_attempts: { increment: 1 } } })
    : null;

  const dir = dirOf(session);
  await fs.promises.mkdir(dir, { recursive: true });

  // Segments that started before something already in the generation are appended in arrival order.
  const lastAssembled = await prisma.recordingSegment.findFirst({
    where: { session_id: sessionId, state: 'assembled' }, orderBy: { started_at: 'desc' }, select: { started_at: true },
  });
  if (lastAssembled && segments[0].started_at < lastAssembled.started_at) {
    console.warn(`[Recording v2] Session ${sessionId}: segment ${segments[0].id} (${segments[0].started_at.toISOString()}) is older than the current generation content — appended out of order`);
  }

  // Current generation file (must exist when generation > 0, otherwise earlier video would be dropped).
  let prevFile: string | null = null;
  let prevDuration = 0;
  let refSize: { w: number; h: number } | null = null;
  if (session.generation > 0) {
    if (!session.file_path || !fs.existsSync(session.file_path)) {
      throw new Error(`generation ${session.generation} file missing on disk (${session.file_path}) — refusing to build over it`);
    }
    prevFile = session.file_path;
    const p = await probeFile(prevFile);
    prevDuration = session.duration_ms ?? p.durationMs;
    const d = await probeDims(prevFile);
    if (d) refSize = { w: d.width, h: d.height };
  }

  const next = session.generation + 1;
  const ts = Date.now();
  const temps: string[] = [];
  const finalPath = path.join(dir, `recording-g${next}.webm`);
  const tmpFinal = `${finalPath}.tmp`;
  temps.push(tmpFinal);

  try {
    // 1. remux every segment (chunks in seq order → one WebM), re-encode on size mismatch
    const segFiles: string[] = [];
    const usedSegments: typeof segments = [];
    let newDuration = 0;
    for (const seg of segments) {
      const files = seg.chunks.filter((c) => fs.existsSync(c.file_path));
      if (files.length === 0) {
        console.warn(`[Recording v2] Segment ${seg.id} has no chunk files on disk — marking assembled without content`);
        usedSegments.push(seg);
        continue;
      }
      if (files.length !== seg.chunks.length) console.warn(`[Recording v2] Segment ${seg.id}: ${seg.chunks.length - files.length} chunk file(s) missing on disk`);
      const raw = path.join(dir, `.tmp-${ts}-${seg.id}.raw.webm`);
      const remuxed = path.join(dir, `.tmp-${ts}-${seg.id}.webm`);
      temps.push(raw, remuxed);
      await concatFiles(files.map((c) => c.file_path), raw);
      let useFile = raw;
      if (await ffmpegOk(['-y', '-i', raw, '-c', 'copy', '-f', 'webm', remuxed], remuxed)) useFile = remuxed;
      else console.warn(`[Recording v2] Segment ${seg.id}: remux failed, using raw bytes`);

      let probe = await probeFile(useFile);
      const dims = await probeDims(useFile);
      const sw = dims?.width ?? seg.width, sh = dims?.height ?? seg.height;
      if (!refSize && sw && sh) refSize = { w: sw, h: sh };
      if (refSize && sw && sh && (sw !== refSize.w || sh !== refSize.h)) {
        const scaled = path.join(dir, `.tmp-${ts}-${seg.id}.scaled.webm`);
        temps.push(scaled);
        const vf = `scale=${refSize.w}:${refSize.h}:force_original_aspect_ratio=decrease,pad=${refSize.w}:${refSize.h}:(ow-iw)/2:(oh-ih)/2`;
        console.log(`[Recording v2] Segment ${seg.id} is ${sw}x${sh}, generation is ${refSize.w}x${refSize.h} — re-encoding`);
        if (!(await ffmpegOk(['-y', '-i', useFile, '-vf', vf, ...REENCODE, '-f', 'webm', scaled], scaled))) {
          throw new Error(`re-encode of segment ${seg.id} to ${refSize.w}x${refSize.h} failed`);
        }
        useFile = scaled;
        probe = await probeFile(useFile);
      }
      newDuration += probe.durationMs;
      segFiles.push(useFile);
      usedSegments.push(seg);
    }
    if (segFiles.length === 0) {
      // Nothing playable in these segments: close them so they stop being retried; generation unchanged.
      await commitGeneration(session, usedSegments, null, session.duration_ms ?? 0, 0, session.generation, null);
      await keepError();
      return;
    }

    // 2. join [previous generation, new segments…]
    const inputs = [...(prevFile ? [prevFile] : []), ...segFiles];
    const minDuration = prevDuration + newDuration - 2000;
    const verify = async (): Promise<number | null> => {
      const p = await probeFile(tmpFinal);
      if (!p.ok || p.durationMs < minDuration) {
        console.warn(`[Recording v2] Verification failed for ${sessionId} g${next}: ok=${p.ok} duration=${p.durationMs}ms need>=${minDuration}ms`);
        return null;
      }
      return p.durationMs;
    };
    let finalDuration: number | null = null;
    if (inputs.length === 1) {
      await fs.promises.copyFile(inputs[0], tmpFinal);
      finalDuration = await verify();
    } else {
      const list = path.join(dir, `.tmp-${ts}-list.txt`);
      temps.push(list);
      await fs.promises.writeFile(list, inputs.map(concatListEntry).join('\n') + '\n');
      const base = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
      if (await ffmpegOk([...base, '-c', 'copy', '-f', 'webm', tmpFinal], tmpFinal)) finalDuration = await verify();
      if (finalDuration === null) {
        console.warn(`[Recording v2] concat -c copy unusable for ${sessionId}; retrying with re-encode`);
        await rm(tmpFinal);
        if (await ffmpegOk([...base, ...REENCODE, '-f', 'webm', tmpFinal], tmpFinal)) finalDuration = await verify();
      }
    }
    if (finalDuration === null) throw new Error('assembled generation failed verification');

    // 3. publish: fsync + rename, then one DB transaction
    await fsyncFile(tmpFinal);
    await fs.promises.rename(tmpFinal, finalPath);
    const loggedOutAdd = usedSegments.flatMap((s) => s.chunks).reduce((a, c) => a + (c.logged_out ? (c.duration_ms ?? 0) : 0), 0);
    await commitGeneration(session, usedSegments, finalPath, finalDuration, loggedOutAdd, next, prevFile);
    await keepError(); // the commit cleared assembly_error; a skipped broken segment must stay visible
    console.log(`[Recording v2] Session ${sessionId} g${next}: +${usedSegments.length} segment(s), ${Math.round(finalDuration / 1000)}s`);
  } finally {
    for (const t of temps) await rm(t);
  }
}

/** DB commit, then purge (after commit only). */
async function commitGeneration(
  session: { id: string; logged_out_ms: number },
  segs: { id: string; chunks: { id: string; file_path: string }[] }[],
  finalPath: string | null,
  durationMs: number,
  loggedOutAdd: number,
  generation: number,
  prevFile: string | null
) {
  const segIds = segs.map((s) => s.id);
  const chunkIds = segs.flatMap((s) => s.chunks.map((c) => c.id));
  await prisma.$transaction([
    prisma.recordingSession.update({
      where: { id: session.id },
      data: {
        generation,
        ...(finalPath ? { file_path: finalPath } : {}),
        duration_ms: durationMs,
        logged_out_ms: session.logged_out_ms + loggedOutAdd,
        assembly_error: null,
        assembly_attempts: 0,
      },
    }),
    prisma.recordingSegment.updateMany({ where: { id: { in: segIds }, state: { in: ASSEMBLABLE } }, data: { state: 'assembled', generation } }),
    prisma.recordingChunk.updateMany({ where: { id: { in: chunkIds } }, data: { purged_at: new Date() } }),
  ]);

  // Purge only after the commit. Only the chunks that went into this generation.
  for (const s of segs) for (const c of s.chunks) await deleteFile(c.file_path);
  for (const s of segs) if (s.chunks.length) await fs.promises.rmdir(path.dirname(s.chunks[0].file_path)).catch(() => {});
  if (prevFile && prevFile !== finalPath) await deleteFile(prevFile);
}

// ─────────────────────────────────────────
// Sweeper (called from the Phase 0 sweeper, every 5 min)
// ─────────────────────────────────────────

/** Backoff after failed assembly: 2^attempts * 5 min, capped at 6 h. */
export function assemblyBackoffMs(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 5 * 60_000, 6 * 3600_000);
}

let sweepingV2 = false;
export async function sweepV2(): Promise<void> {
  if (sweepingV2) return;
  sweepingV2 = true;
  try {
    const now = Date.now();
    const { requestAssembly } = await import('./recording.service');

    for (const p of [...pendingCleanup]) await deleteFile(p);

    // Segments nobody ever finished (agent gone for good): stop waiting, assemble what exists.
    const stuckBefore = new Date(now - STUCK_SEGMENT_MS);
    const stuck = await prisma.recordingSegment.updateMany({
      where: { state: { in: ['open', 'closed'] }, updated_at: { lt: stuckBefore }, session: { last_chunk_at: { lt: stuckBefore } } },
      data: { state: 'incomplete' },
    });
    if (stuck.count) console.warn(`[Sweeper v2] ${stuck.count} segment(s) idle > 48h marked incomplete`);

    // S4: finish segments nobody closed (agent crashed) so they become assemblable
    await closeAbandonedSegments().catch((err) => console.error('[Sweeper v2] abandoned-segment pass failed:', err.message));

    // (a) live → stopped after 10 min without chunks
    const live = await prisma.recordingSession.findMany({
      where: { recording_date: { not: null }, status: { in: ['pending', 'recording'] } },
      select: { id: true, created_at: true, last_chunk_at: true },
    });
    const stale = live.filter((s) => now - (s.last_chunk_at ?? s.created_at).getTime() > LIVE_WINDOW_MS);
    if (stale.length) {
      await prisma.recordingSession.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: 'stopped', ended_at: new Date() } });
      stale.forEach((s) => recordingEmitter.emit(`stopped:${s.id}`));
    }

    // (b) unassembled complete segments: idle ≥ 30 min, or recording day over + 30 min
    const pending = await prisma.recordingSession.findMany({
      where: { recording_date: { not: null }, segments: { some: { state: { in: ASSEMBLABLE } } } },
      select: { id: true, user_id: true, recording_date: true, last_chunk_at: true, created_at: true, assembly_attempts: true, assembly_error: true, updated_at: true },
    });
    let queued = 0;
    for (const s of pending) {
      if (s.assembly_error && now - s.updated_at.getTime() < assemblyBackoffMs(s.assembly_attempts)) continue;
      const idle = now - (s.last_chunk_at ?? s.created_at).getTime() >= IDLE_ASSEMBLE_MS;
      let dayOver = false;
      if (!idle) {
        const end = recordingDayEndsAt(dateStr(s.recording_date!), await ruleForUser(s.user_id));
        dayOver = now >= end.getTime() + DAY_OVER_GRACE_MS;
      }
      if (idle || dayOver) { queued++; await requestAssembly(s.id); }
    }

    // (c) stopped + current generation covers everything assemblable → assembled
    const done = await prisma.recordingSession.updateMany({
      where: { recording_date: { not: null }, status: 'stopped', generation: { gt: 0 }, segments: { none: { state: { in: ASSEMBLABLE } } } },
      data: { status: 'assembled' },
    });

    if (stale.length || queued || done.count) console.log(`[Sweeper v2] stopped ${stale.length}, assembly requested ${queued}, marked assembled ${done.count}`);
  } catch (err: any) {
    console.error('[Sweeper v2] failed:', err.message);
  } finally {
    sweepingV2 = false;
  }
}

/** True (and starts a background assembly) when the v2 session has unassembled complete segments. */
export async function assembleOnDemand(sessionId: string): Promise<boolean> {
  const n = await prisma.recordingSegment.count({ where: { session_id: sessionId, state: { in: ASSEMBLABLE } } });
  if (n === 0) return false;
  // S11: same backoff as the sweeper - a <video> Range request must not re-run a failing ffmpeg every time.
  const s = await prisma.recordingSession.findUnique({ where: { id: sessionId }, select: { assembly_error: true, assembly_attempts: true, updated_at: true } });
  if (s?.assembly_error && Date.now() - s.updated_at.getTime() < assemblyBackoffMs(s.assembly_attempts)) return false;
  const { requestAssembly } = await import('./recording.service');
  requestAssembly(sessionId).catch(console.error);
  return true;
}

// ─────────────────────────────────────────
// Settings + retention
// ─────────────────────────────────────────

export const RETENTION_KEY = 'recording.retention_days';
export const RETENTION_VALUES = [0, 30, 60, 90];

export async function getRetentionDays(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: RETENTION_KEY } });
  const n = row ? parseInt(row.value, 10) : 0;
  return RETENTION_VALUES.includes(n) ? n : 0;
}

export async function setRetentionDays(days: number, adminId: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: RETENTION_KEY },
    create: { key: RETENTION_KEY, value: String(days), updated_by: adminId },
    update: { value: String(days), updated_by: adminId },
  });
}

const root = path.resolve(RECORDINGS_DIR);
const insideRoot = (p: string) => {
  const r = path.relative(root, path.resolve(p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

let retentionRunning = false;
/** Deletes sessions older than the retention setting: files first, then rows. 0/missing = nothing. */
export async function runRetentionOnce(opts: { onlyUserId?: string } = {}): Promise<{ sessions: number }> {
  if (retentionRunning) return { sessions: 0 };
  retentionRunning = true;
  try {
    const days = await getRetentionDays();
    if (!days) return { sessions: 0 };
    const now = Date.now();
    const cutoffDate = dateOnly(new Date(now + 5 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10));
    const cutoffCreated = new Date(now - days * 86_400_000);
    const aged = {
      ...(opts.onlyUserId ? { user_id: opts.onlyUserId } : {}), // tests scope the sweep to their own user
      status: { notIn: ['pending', 'recording'] },
      OR: [{ recording_date: { lt: cutoffDate } }, { recording_date: null, created_at: { lt: cutoffCreated } }],
    };
    // S6: never delete what is not safely in a video yet, or what just arrived.
    const recent = new Date(now - 7 * 86_400_000);
    const unsafe = [{ segments: { some: { state: { not: 'assembled' } } } }, { chunks: { some: { uploaded_at: { gt: recent } } } }];
    const skipped = await prisma.recordingSession.findMany({ where: { ...aged, AND: [{ OR: unsafe }] }, select: { id: true } });
    if (skipped.length) console.warn(`[Retention] skipped ${skipped.length} old session(s) with unassembled segments or chunks from the last 7 days: ${skipped.slice(0, 10).map((x) => x.id).join(', ')}`);
    const old = await prisma.recordingSession.findMany({
      where: { ...aged, segments: { none: { state: { not: 'assembled' } } }, chunks: { none: { uploaded_at: { gt: recent } } } },
      select: { id: true, file_path: true, dir_path: true, recording_date: true, chunks: { select: { file_path: true } } },
      take: 200,
    });
    let removed = 0;
    for (const s of old) {
      try {
        if (s.dir_path) {
          if (insideRoot(s.dir_path)) await fs.promises.rm(s.dir_path, { recursive: true, force: true });
        } else {
          for (const c of s.chunks) if (insideRoot(c.file_path)) await fs.promises.unlink(c.file_path).catch(() => {});
          if (s.file_path && insideRoot(s.file_path)) await fs.promises.unlink(s.file_path).catch(() => {});
          const firstChunk = s.chunks[0]?.file_path;
          if (firstChunk && insideRoot(firstChunk) && path.basename(path.dirname(firstChunk)).endsWith(`_${s.id}`)) {
            await fs.promises.rm(path.dirname(firstChunk), { recursive: true, force: true });
          }
        }
        await prisma.recordingSession.delete({ where: { id: s.id } });
        removed++;
        console.log(`[Retention] deleted session ${s.id} (${s.recording_date ? dateStr(s.recording_date) : 'legacy'}, ${days}d policy)`);
      } catch (err: any) {
        console.error(`[Retention] could not delete session ${s.id}: ${err.message}`);
      }
    }
    if (removed) console.log(`[Retention] removed ${removed} session(s) older than ${days} days`);
    return { sessions: removed };
  } finally {
    retentionRunning = false;
  }
}

let retentionStarted = false;
/** First run 2 min after start, then daily. */
export function startRetentionJob(): void {
  if (retentionStarted) return;
  retentionStarted = true;
  const run = () => runRetentionOnce().catch((err) => console.error('[Retention] failed:', err.message));
  setTimeout(run, 2 * 60_000);
  setInterval(run, 24 * 3600_000);
}
