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
import { getGateway } from '../gateways/recording.gateway';

export const SEGMENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const IDLE_ASSEMBLE_MS = 30 * 60_000;
const DAY_OVER_GRACE_MS = 30 * 60_000;
const LIVE_WINDOW_MS = 10 * 60_000;
const STUCK_SEGMENT_MS = 48 * 3600_000;
const PREBOOT_GRACE_MS = 2 * 3600_000;
const MAX_CONCURRENT_ASSEMBLIES = 1;
const COPY_TIMEOUT_MS = 20 * 60_000; // copy / probe: a hung ffmpeg must not hold the queue forever
const ASSEMBLABLE = ['complete', 'incomplete'];
const PROCESS_STARTED_AT = Date.now();
const preBootDeferred = new Set<string>();

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
  startedAt?: unknown; mime?: unknown; width?: unknown; height?: unknown; deviceId?: unknown; recordingDate?: unknown; screen?: unknown;
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

/** Screen number 1..16, anything else -> null. */
const optScreen = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16 ? (v as number) : null);

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
    const scr = optScreen(body.screen);
    if (scr !== null && scr !== existing.screen) await prisma.recordingSegment.update({ where: { id: segmentId }, data: { screen: scr } }); // never overwrite with null
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
        screen: optScreen(body.screen),
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

async function reopenAssembledSegment(segmentId: string, reason: string): Promise<boolean> {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId }, select: { state: true, last_seq: true } });
  if (!seg || seg.state !== 'assembled') return false;
  const rows = await prisma.recordingChunk.findMany({ where: { segment_id: segmentId }, select: { seq: true } });
  const have = new Set<number>();
  for (const r of rows) if (r.seq !== null) have.add(r.seq);
  if (have.size === 0) return false;
  let maxSeq = -1;
  for (const s of have) if (s > maxSeq) maxSeq = s;
  const lastSeq = Math.max(seg.last_seq ?? -1, maxSeq);
  if (lastSeq < 0) return false;
  const lost: number[] = [];
  for (let i = 0; i <= lastSeq; i++) if (!have.has(i)) lost.push(i);
  const updated = await prisma.recordingSegment.updateMany({
    where: { id: segmentId, state: 'assembled' },
    data: { state: lost.length ? 'incomplete' : 'complete', last_seq: lastSeq, lost_seqs: lost },
  });
  if (!updated.count) return false;
  console.warn(`[Recording v2] Re-opened assembled segment ${segmentId} for tail assembly (${reason}) — lastSeq ${lastSeq}, ${lost.length} missing`);
  return true;
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
    const lateTail = seg.state === 'assembled';
    await prisma.recordingSession.update({
      where: { id: session.id },
      data: {
        last_chunk_at: new Date(),
        assembly_next_at: null, // new data is worth a fresh assembly try
        assembly_attempts: 0,
        ...(lateTail ? {} : { status: 'recording', ended_at: null, ...(session.status === 'pending' ? { started_at: new Date() } : {}) }),
      },
    });
    if (lateTail) {
      try { await reopenAssembledSegment(segmentId, 'late chunk'); }
      catch (err: any) { console.error(`[Recording v2] Could not re-open assembled segment ${segmentId}: ${err.message}`); }
    }
    if (seg.state === 'unreadable') await reviveSegment(segmentId);
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

interface Probe { ok: boolean; durationMs: number; packets: number | null; width: number | null; height: number | null }

/**
 * CERTAIN infrastructure failure: says nothing about the media (binary missing / spawn error, killed, Windows CTRL_C
 * exit, disk full). It always throws so the session backs off and retries, and never flags a segment. A timeout is
 * not listed: the caller treats it as a failure of that input.
 */
export function isInfraFailure(r: { code: number | null; stderr: string }): boolean {
  if (r.code === -1) return r.stderr !== 'timeout';
  if (r.code === null || r.code === 0xC000013A || r.code === -1073741510) return true;
  return /No space left/i.test(r.stderr);
}

/** AMBIGUOUS: ffmpeg prints these for corrupt media too (truncated EBML, bogus sizes), so they are not proof of infrastructure. */
export function isAmbiguousFailure(r: { code: number | null; stderr: string }): boolean {
  return r.code !== null && r.code !== 0 && !isInfraFailure(r) && /Cannot allocate memory|Input\/output error|Permission denied/i.test(r.stderr);
}

/** Ambiguous failures throw for the first 3 attempts of a session; from the 4th run they are that segment's problem. */
export const ambiguousIsTransient = (attempts: number) => attempts < 3;

class AmbiguousFfmpegError extends Error {}

/** Runs ffmpeg; certain infrastructure failures and ambiguous ones throw (the latter as AmbiguousFfmpegError). */
async function runChecked(args: string[], timeoutMs: number) {
  const fake = testHooks.ffmpegFault?.(args);
  const r = fake ? { code: 1, stderr: fake } : await runFfmpeg(args, { timeoutMs });
  if (isInfraFailure(r)) throw new Error(`ffmpeg infrastructure failure (code ${r.code}): ${r.stderr.slice(-200)}`);
  if (isAmbiguousFailure(r)) throw new AmbiguousFfmpegError(`ffmpeg: ${/Cannot allocate memory|Input\/output error|Permission denied/i.exec(r.stderr)![0]} (code ${r.code})`);
  return r;
}

async function probeRun(args: string[]) {
  return runChecked(args, COPY_TIMEOUT_MS);
}

/** Video packets muxed, from `ffmpeg -v verbose` ("Output stream #0:0 (video): N packets muxed"); null when absent. */
export function videoPackets(stderr: string): number | null {
  const all = [...stderr.matchAll(/Output stream #\d+:\d+ \(video\): (\d+) packets muxed/g)];
  return all.length ? all.reduce((a, m) => a + +m[1], 0) : null;
}

/** Full demux pass (-c copy to null). Duration = last `time=` the demuxer reached; packets = video packets muxed. */
export async function probeFile(file: string): Promise<Probe> {
  const r = await probeRun(['-v', 'verbose', '-i', file, '-c', 'copy', '-f', 'null', '-']);
  const times = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const t = times.length ? times[times.length - 1] : null;
  const durationMs = t ? Math.round((+t[1] * 3600 + +t[2] * 60 + +t[3]) * 1000) : 0;
  const dim = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr);
  return { ok: r.code === 0, durationMs, packets: videoPackets(r.stderr), width: dim ? +dim[1] : null, height: dim ? +dim[2] : null };
}

/** Stream dimensions from the header only (`ffmpeg -i`, no decode). */
export async function probeDims(file: string): Promise<{ width: number; height: number; codec: string } | null> {
  const r = await probeRun(['-hide_banner', '-i', file]);
  const m = /Video:\s*(\w+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr);
  return m ? { codec: m[1], width: +m[2], height: +m[3] } : null;
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

const ABANDONED_SEGMENT_MS = 30 * 60_000;

/**
 * S4: a segment that is still open/closed but has not received a chunk for 30 min is finished: lastSeq
 * = highest stored seq (kept when the agent already closed it), missing seqs below it become lost_seqs,
 * then the normal state recompute makes it complete/incomplete (= assemblable). Zero-chunk segments are
 * left to the 48 h rule. Optionally scoped to one session (assembly start).
 */
export async function closeAbandonedSegments(sessionId?: string): Promise<number> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - ABANDONED_SEGMENT_MS);
  const preBootGraceMs = Number(process.env.RECORDING_PREBOOT_GRACE_MS ?? PREBOOT_GRACE_MS);
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
    if (seg.state === 'open') {
      if (getGateway()?.isConnected(seg.user_id) && nowMs - seg.started_at.getTime() < 24 * 3600_000) continue;
      const lastAt = g._max.uploaded_at?.getTime() ?? 0;
      const recentlyActiveBeforeBoot = lastAt < PROCESS_STARTED_AT && lastAt >= PROCESS_STARTED_AT - ABANDONED_SEGMENT_MS;
      if (preBootGraceMs > 0 && recentlyActiveBeforeBoot && nowMs < PROCESS_STARTED_AT + preBootGraceMs) {
        if (!preBootDeferred.has(seg.id)) {
          preBootDeferred.add(seg.id);
          console.log(`[Recording v2] Segment ${seg.id} left open for the post-restart grace (agent may still be draining)`);
        }
        continue;
      }
    }
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

/** Quality-based (not realtime) encoder args for converting to a generation's codec. */
export function reencodeArgs(codec: string): string[] {
  return codec === 'vp9'
    ? ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-an']
    : ['-c:v', 'libvpx', '-crf', '10', '-b:v', '3M', '-deadline', 'good', '-cpu-used', '4', '-an'];
}

/** Test seams (never set in production): S22 injects a chunk between the assembly snapshot and its commit; S24/S27 make chosen joins fail; S29 fakes ffmpeg output. */
export const testHooks: {
  afterSnapshot?: () => Promise<void>;
  failJoin?: (group: { id: string; reencoded: boolean }[]) => boolean;
  ffmpegFault?: (args: string[]) => string | null; // S29: pretend ffmpeg printed this text and failed
} = {};

interface SegChunk { id: string; seq: number | null; file_path: string; duration_ms: number | null; logged_out: boolean }
interface SegInfo { id: string; started_at: Date; width: number | null; height: number | null; chunks: SegChunk[] }
interface Item { seg: SegInfo; file: string; durationMs: number; packets: number | null; reencoded: boolean; short: string | null }
interface Ref { size: { w: number; h: number } | null; codec: string | null }
interface Problem { seg: SegInfo; problem: string }

const reencodeTimeoutMs = (durationMs: number) => Math.min(3 * 3600_000, Math.max(10 * 60_000, 6 * durationMs));
const scaleFilter = (r: { w: number; h: number }) => `scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2`;
const minutes = (ms: number) => (ms / 60_000).toFixed(1);
const MAX_JOIN_STRIKES = 3; // single-segment join failures handled (re-encode / flag) per run; beyond it the rest waits for a retry

/** How much video the chunks claim: each chunk's duration_ms (null = 10 s), capped at 60 s so a PC sleep is no false alarm. */
export function expectedMs(chunks: { duration_ms: number | null }[]): number {
  return chunks.reduce((a, c) => a + Math.min(c.duration_ms ?? 10_000, 60_000), 0);
}

/** Playing less than expected − max(15 s, 1 %) is flagged (the files are then kept). Playing longer is fine. */
export function shortProblem(playableMs: number, expected: number): string | null {
  return playableMs < expected - Math.max(15_000, expected * 0.01) ? `only ${minutes(playableMs)} of ${minutes(expected)} min readable` : null;
}

/** A re-encode must not silently shorten the video. */
export const reencodeKeptVideo = (origMs: number, newMs: number) => newMs >= origMs - 5000;

/**
 * A join is good only if the output is not shorter than its inputs (concat adds a little per segment, hence 2 s of
 * slack) AND holds at least as many video packets (ffmpeg can skip an input and still exit 0). Unknown packet counts
 * fall back to the duration check.
 */
export function joinVerified(want: { ms: number; packets: number | null }, got: { ms: number; packets: number | null }): boolean {
  if (got.ms < want.ms - 2000) return false;
  if (want.packets !== null && got.packets !== null && got.packets < want.packets) return false;
  if (want.packets === null || got.packets === null) console.warn('[Recording v2] packet count unavailable: join verified by duration only');
  return true;
}

/** ffmpeg + non-empty output. Infrastructure failures (see isInfraFailure) throw; everything else is the media's. */
async function ffmpegRun(args: string[], out: string, timeoutMs: number): Promise<{ ok: boolean; timedOut: boolean }> {
  const r = await runChecked(args, timeoutMs).catch(async (err) => { await rm(out); throw err; });
  let size = 0;
  try { size = (await fs.promises.stat(out)).size; } catch { /* missing */ }
  if (r.code !== 0 || size <= 0) {
    console.warn(`[Recording v2] ffmpeg failed (code ${r.code}): ${r.stderr.slice(-300)}`);
    await rm(out);
    return { ok: false, timedOut: r.stderr === 'timeout' };
  }
  return { ok: true, timedOut: false };
}

/** A failed attempt: counts, and the next try waits assemblyBackoffMs(attempts). */
async function recordFailure(sessionId: string, message: string) {
  const s = await prisma.recordingSession.findUnique({ where: { id: sessionId }, select: { assembly_attempts: true } });
  const attempts = (s?.assembly_attempts ?? 0) + 1;
  await prisma.recordingSession.update({
    where: { id: sessionId },
    data: { assembly_error: message.slice(0, 1000), assembly_attempts: attempts, assembly_next_at: new Date(Date.now() + assemblyBackoffMs(attempts)) },
  });
}

export async function assembleSessionV2(sessionId: string): Promise<void> {
  try {
    await assembleSessionV2Inner(sessionId);
  } catch (err: any) {
    console.error(`[Recording v2] Assembly failed for ${sessionId}: ${err.message}`);
    await recordFailure(sessionId, String(err.message)).catch(() => {});
    throw err;
  }
}

/**
 * The segment's chunks → one remuxed WebM (`-c copy`). Never falls back to raw bytes: nothing readable → null.
 * If the plain remux plays less than the chunks claim, the tolerant remux is tried too and the longer one is kept.
 */
async function remuxSegment(seg: SegInfo, dir: string, ts: number, temps: string[]): Promise<{ file: string; probe: Probe } | null> {
  const raw = path.join(dir, `.tmp-${ts}-${seg.id}.raw.webm`);
  temps.push(raw);
  await concatFiles(seg.chunks.map((c) => c.file_path), raw);
  const expected = expectedMs(seg.chunks);
  const tries: string[][] = [[], ['-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err']];
  let best: { file: string; probe: Probe } | null = null;
  for (const [i, input] of tries.entries()) {
    const out = path.join(dir, `.tmp-${ts}-${seg.id}.r${i}.webm`);
    temps.push(out);
    if (!(await ffmpegRun(['-y', ...input, '-i', raw, '-c', 'copy', '-f', 'webm', out], out, COPY_TIMEOUT_MS)).ok) continue;
    const probe = await probeFile(out);
    if (!probe.ok || probe.durationMs === 0) continue; // exit 0 with zero packets is not readable
    if (!best || probe.durationMs > best.probe.durationMs) best = { file: out, probe };
    if (!shortProblem(best.probe.durationMs, expected)) break; // plays what the chunks claim: no need to try harder
  }
  return best;
}

/** One segment → a playable file in the generation's codec/size, or the reason it cannot be used. Never throws for bad media. */
async function prepareSegment(seg: SegInfo, dir: string, ts: number, temps: string[], ref: Ref, attempts: number): Promise<Item | { problem: string }> {
  try {
    return await prepareSegmentInner(seg, dir, ts, temps, ref);
  } catch (err) {
    // Ambiguous ffmpeg text (Input/output error, …): retried 3 times as infrastructure, then it is this segment's problem.
    if (err instanceof AmbiguousFfmpegError && !ambiguousIsTransient(attempts)) return { problem: err.message };
    throw err;
  }
}

async function prepareSegmentInner(seg: SegInfo, dir: string, ts: number, temps: string[], ref: Ref): Promise<Item | { problem: string }> {
  if (seg.chunks[0].seq !== 0) return { problem: `late chunks without their header (first stored chunk is seq ${seg.chunks[0].seq})` };
  const rx = await remuxSegment(seg, dir, ts, temps);
  if (!rx) return { problem: 'no readable video' };
  let { file, probe } = rx;
  // Coverage: the chunks say how much was recorded. Playing less than that is kept visible and the files are kept.
  const short = shortProblem(probe.durationMs, expectedMs(seg.chunks));
  const dims = await probeDims(file);
  const sw = dims?.width ?? seg.width, sh = dims?.height ?? seg.height;
  if (!ref.size && sw && sh) ref.size = { w: sw, h: sh };
  if (!ref.codec && dims) ref.codec = dims.codec;
  let reencoded = false;
  if (ref.size && sw && sh && (sw !== ref.size.w || sh !== ref.size.h || (dims && ref.codec && dims.codec !== ref.codec))) {
    const scaled = path.join(dir, `.tmp-${ts}-${seg.id}.scaled.webm`);
    temps.push(scaled);
    console.log(`[Recording v2] Segment ${seg.id} is ${dims?.codec ?? '?'} ${sw}x${sh}, generation is ${ref.codec} ${ref.size.w}x${ref.size.h} — converting`);
    const enc = await ffmpegRun(['-y', '-i', file, '-vf', scaleFilter(ref.size), ...reencodeArgs(ref.codec ?? 'vp8'), '-f', 'webm', scaled], scaled, reencodeTimeoutMs(probe.durationMs));
    const back = enc.ok ? await probeFile(scaled) : null;
    if (!back || !back.ok || !reencodeKeptVideo(probe.durationMs, back.durationMs)) return { problem: `re-encode to ${ref.size.w}x${ref.size.h} failed` };
    file = scaled;
    probe = back;
    reencoded = true;
  }
  return { seg, file, durationMs: probe.durationMs, packets: probe.packets, reencoded, short };
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
  await testHooks.afterSnapshot?.();

  // S2: never commit (and so never purge) a segment whose stored chunk file is missing. It stays as it is
  // (transient: the session backs off and retries); healthy segments of the same session are still assembled.
  const broken: string[] = [];
  const segments = all.filter((seg) => {
    const miss = seg.chunks.find((c) => !fs.existsSync(c.file_path));
    if (miss) broken.push(`segment ${seg.id} seq ${miss.seq} (${miss.file_path})`);
    return !miss;
  });
  const brokenMsg = () => `chunk file missing on disk: ${broken.join('; ')}`.slice(0, 900);
  if (broken.length) console.error(`[Recording v2] Session ${sessionId}: ${brokenMsg()}`);
  if (segments.length === 0) throw new Error(brokenMsg());

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
  let prevPackets: number | null = 0;
  const ref: Ref = { size: null, codec: null };
  if (session.generation > 0) {
    if (!session.file_path || !fs.existsSync(session.file_path)) {
      throw new Error(`generation ${session.generation} file missing on disk (${session.file_path}) — refusing to build over it`);
    }
    prevFile = session.file_path;
    const p = await probeFile(prevFile);
    if (!p.ok || p.durationMs === 0) throw new Error(`generation ${session.generation} file is not readable (${prevFile}) — refusing to build over it`);
    prevDuration = p.durationMs; // measured: a stale duration_ms in the DB must not make every join look short
    prevPackets = p.packets;
    const d = await probeDims(prevFile);
    if (d) { ref.size = { w: d.width, h: d.height }; ref.codec = d.codec; }
  }

  const next = session.generation + 1;
  const ts = Date.now();
  const temps: string[] = [];
  const finalPath = path.join(dir, `recording-g${next}.webm`);

  try {
    // 1. prepare every segment on its own; a bad one is flagged (chunks untouched) and the others carry on
    const items: Item[] = [];
    const empty: SegInfo[] = [];
    const problems: Problem[] = [];
    for (const seg of segments) {
      if (seg.chunks.length === 0) { empty.push(seg); continue; } // nothing unpurged left in it
      const r = await prepareSegment(seg, dir, ts, temps, ref, session.assembly_attempts);
      if ('problem' in r) {
        problems.push({ seg, problem: r.problem });
        console.warn(`[Recording v2] Segment ${seg.id} unreadable: ${r.problem} — chunks kept on disk`);
      } else items.push(r);
    }

    // 2. join [previous generation, new segments…], copy only. If the whole list will not join, split it in halves
    //    on top of the last good file so one bad segment cannot hold back the others. A lone culprit gets one
    //    per-segment re-encode to the generation's codec/size and one more try before it is flagged. At most
    //    MAX_JOIN_STRIKES such culprits per run: beyond that the rest is left assemblable (a retry with backoff),
    //    never mass-flagged.
    const state = { file: prevFile, dur: prevDuration, packets: prevPackets };
    const joined: Item[] = [];
    const joinBad: Problem[] = [];
    const deferred: SegInfo[] = [];
    const joinOutputs = new Set<string>(); // each is a whole copy of the day: drop the superseded one at once (disk)
    let joins = 0;
    let strikes = 0;
    const tryJoin = async (group: Item[]): Promise<boolean> => {
      const inputs = [...(state.file ? [state.file] : []), ...group.map((i) => i.file)];
      const want = {
        ms: state.dur + group.reduce((a, i) => a + i.durationMs, 0),
        packets: state.packets !== null && group.every((i) => i.packets !== null) ? state.packets + group.reduce((a, i) => a + i.packets!, 0) : null,
      };
      if (inputs.length === 1) { state.file = inputs[0]; state.dur = want.ms; state.packets = want.packets; joined.push(...group); return true; }
      if (testHooks.failJoin?.(group.map((i) => ({ id: i.seg.id, reencoded: i.reencoded })))) return false;
      const out = path.join(dir, `.tmp-${ts}-join${joins++}.webm`);
      const list = `${out}.txt`;
      temps.push(out, list);
      await fs.promises.writeFile(list, inputs.map(concatListEntry).join('\n') + '\n');
      const r = await ffmpegRun(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'webm', out], out, COPY_TIMEOUT_MS);
      if (r.timedOut) throw new Error('ffmpeg concat timed out');
      if (!r.ok) return false;
      const p = await probeFile(out);
      if (!p.ok || !joinVerified(want, { ms: p.durationMs, packets: p.packets })) {
        console.warn(`[Recording v2] Verification failed for ${sessionId} g${next}: ok=${p.ok} duration=${p.durationMs}ms need>=${want.ms - 2000}ms packets=${p.packets} need>=${want.packets}`);
        await rm(out);
        return false;
      }
      if (state.file && joinOutputs.has(state.file)) await rm(state.file);
      joinOutputs.add(out);
      state.file = out;
      state.dur = p.durationMs;
      state.packets = p.packets;
      joined.push(...group);
      return true;
    };
    const joinInto = async (group: Item[]): Promise<void> => {
      if (await tryJoin(group)) return;
      if (group.length > 1) {
        const mid = group.length >> 1;
        await joinInto(group.slice(0, mid));
        await joinInto(group.slice(mid));
        return;
      }
      const [it] = group;
      if (strikes >= MAX_JOIN_STRIKES) { deferred.push(it.seg); return; }
      strikes++;
      if (!it.reencoded && ref.size) {
        const fixed = path.join(dir, `.tmp-${ts}-${it.seg.id}.fix.webm`);
        temps.push(fixed);
        const enc = await ffmpegRun(['-y', '-i', it.file, '-vf', scaleFilter(ref.size), ...reencodeArgs(ref.codec ?? 'vp8'), '-f', 'webm', fixed], fixed, reencodeTimeoutMs(it.durationMs));
        const p = enc.ok ? await probeFile(fixed) : null;
        if (p?.ok && reencodeKeptVideo(it.durationMs, p.durationMs) && (await tryJoin([{ ...it, file: fixed, durationMs: p.durationMs, packets: p.packets, reencoded: true }]))) return;
      }
      joinBad.push({ seg: it.seg, problem: 'could not be joined onto the video (ffmpeg concat failed)' });
    };
    if (items.length) await joinInto(items);
    if (!prevFile && items.length > 1 && joined.length === 1) {
      // Nothing joined onto the first segment: it is the odd one out, not all the others. Publish the LONGEST segment
      // alone (normal commit: only its own chunks are marked / purged) and do not flag the rest: they stay assemblable
      // (the run ends in recordFailure) and the next run joins them on top of it.
      const keep = items.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
      for (const i of items) if (i !== keep && !deferred.includes(i.seg)) deferred.push(i.seg);
      const k = deferred.indexOf(keep.seg);
      if (k >= 0) deferred.splice(k, 1);
      joinBad.length = 0;
      state.file = keep.file;
      state.dur = keep.durationMs;
      state.packets = keep.packets;
      joined.length = 0;
      joined.push(keep);
    }
    problems.push(...joinBad);

    // 3. publish: fsync + rename, then one DB transaction (only what really went into the video is marked / purged)
    let published: string | null = null;
    if (joined.length) {
      await fsyncFile(state.file!);
      await fs.promises.rename(state.file!, finalPath);
      published = finalPath;
    }
    const short = joined.filter((i) => i.short).map((i) => ({ seg: i.seg, problem: i.short! }));
    const full = [...joined.filter((i) => !i.short).map((i) => i.seg), ...empty];
    const issues = [...broken, ...problems.map((p) => `segment ${p.seg.id}: ${p.problem}`), ...short.map((s) => `segment ${s.seg.id}: ${s.problem}`),
      ...deferred.map((d) => `segment ${d.id}: not joined this run, will retry`)];
    const error = issues.length ? issues.join('; ').slice(0, 900) : null;
    const loggedOutAdd = joined.flatMap((i) => i.seg.chunks).reduce((a, c) => a + (c.logged_out ? (c.duration_ms ?? 0) : 0), 0);
    await commitGeneration({
      session, generation: published ? next : session.generation, finalPath: published, durationMs: state.dur,
      loggedOutAdd, full, short, unreadable: problems, prevFile, error,
    });
    if (broken.length || deferred.length) await recordFailure(sessionId, error!); // transient (missing chunk file / join budget used up): retry later with backoff
    console.log(published
      ? `[Recording v2] Session ${sessionId} g${next}: +${joined.length} segment(s), ${Math.round(state.dur / 1000)}s${problems.length ? `, ${problems.length} unreadable` : ''}`
      : `[Recording v2] Session ${sessionId}: nothing new to publish${problems.length ? `, ${problems.length} segment(s) unreadable` : ''}`);
  } finally {
    for (const t of temps) await rm(t);
  }
}

/** DB commit, then purge (after commit only). Chunk files go only for segments whose frames are in the committed video. */
async function commitGeneration(c: {
  session: { id: string; logged_out_ms: number };
  generation: number;
  finalPath: string | null; // null: this run added no video — generation, duration and the retry counters stay as they are
  durationMs: number;
  loggedOutAdd: number;
  full: SegInfo[]; // fully covered: rows purged, files deleted
  short: Problem[]; // in the video but short: rows purged (not pending again), files KEPT
  unreadable: Problem[]; // not in the video: state 'unreadable', chunks untouched
  prevFile: string | null;
  error: string | null;
}) {
  const included = [...c.full, ...c.short.map((s) => s.seg)];
  const chunkIds = included.flatMap((s) => s.chunks.map((x) => x.id));
  const pending = { in: ASSEMBLABLE };
  await prisma.$transaction([
    prisma.recordingSession.update({
      where: { id: c.session.id },
      data: c.finalPath
        ? {
            generation: c.generation, file_path: c.finalPath, duration_ms: c.durationMs, logged_out_ms: c.session.logged_out_ms + c.loggedOutAdd,
            assembly_error: c.error, assembly_attempts: 0, assembly_next_at: null,
          }
        : { assembly_error: c.error },
    }),
    prisma.recordingSegment.updateMany({ where: { id: { in: c.full.map((s) => s.id) }, state: pending }, data: { state: 'assembled', generation: c.generation, problem: null } }),
    ...c.short.map((s) => prisma.recordingSegment.updateMany({ where: { id: s.seg.id, state: pending }, data: { state: 'assembled', generation: c.generation, problem: s.problem } })),
    ...c.unreadable.map((u) => prisma.recordingSegment.updateMany({ where: { id: u.seg.id, state: pending }, data: { state: 'unreadable', problem: u.problem } })),
    prisma.recordingChunk.updateMany({ where: { id: { in: chunkIds } }, data: { purged_at: new Date() } }),
  ]);

  // Purge only after the commit. Only the chunks that went into this generation and are fully covered by it.
  for (const s of c.full) for (const ch of s.chunks) await deleteFile(ch.file_path);
  for (const s of c.full) if (s.chunks.length) await fs.promises.rmdir(path.dirname(s.chunks[0].file_path)).catch(() => {});
  if (c.prevFile && c.finalPath && c.prevFile !== c.finalPath) await deleteFile(c.prevFile);

  // Chunks that arrived after the snapshot were not purged: their segment is pending again.
  const leftovers = await prisma.recordingSegment.findMany({
    where: { id: { in: included.map((s) => s.id) }, state: 'assembled', chunks: { some: { purged_at: null } } },
    select: { id: true },
  });
  for (const l of leftovers) {
    try { await reopenAssembledSegment(l.id, 'chunks arrived during assembly'); }
    catch (err: any) { console.error(`[Recording v2] Could not re-open assembled segment ${l.id}: ${err.message}`); }
  }
  const seen = [...included, ...c.unreadable.map((u) => u.seg)].flatMap((s) => s.chunks.map((x) => x.id));
  const fresh = await prisma.recordingSegment.findMany({
    where: { id: { in: c.unreadable.map((u) => u.seg.id) }, state: 'unreadable', chunks: { some: { purged_at: null, id: { notIn: seen } } } },
    select: { id: true },
  });
  for (const f of fresh) await reviveSegment(f.id);
}

/** New data arrived for an unreadable segment: it gets another try. */
async function reviveSegment(segmentId: string) {
  await prisma.recordingSegment.updateMany({ where: { id: segmentId, state: 'unreadable' }, data: { state: 'closed', problem: null } });
  await recomputeSegmentState(segmentId);
}

// ─────────────────────────────────────────
// Sweeper (called from the Phase 0 sweeper, every 5 min)
// ─────────────────────────────────────────

/** Backoff after failed assembly: 2^attempts * 5 min, capped at 6 h. */
export function assemblyBackoffMs(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 5 * 60_000, 6 * 3600_000);
}

export interface AssemblyCandidate { id: string; attempts: number; nextAt: Date | null; lastChunkAt: Date }

/**
 * Which due sessions to start now. Fewest failed attempts first (an untried day always beats a failing one, so a
 * few doomed sessions cannot own the queue), then the oldest data. Sessions still in backoff are skipped.
 */
export function pickAssemblies(candidates: AssemblyCandidate[], now: number, freeSlots: number): string[] {
  return candidates
    .filter((c) => !c.nextAt || c.nextAt.getTime() <= now)
    .sort((a, b) => a.attempts - b.attempts || a.lastChunkAt.getTime() - b.lastChunkAt.getTime())
    .slice(0, Math.max(0, freeSlots))
    .map((c) => c.id);
}

async function pumpOnce(): Promise<number> {
  const { requestAssembly, isAssembling, activeAssemblyCount } = await import('./recording.service');
  const free = (Number(process.env.RECORDING_MAX_CONCURRENT_ASSEMBLIES ?? MAX_CONCURRENT_ASSEMBLIES) || 1) - activeAssemblyCount();
  if (free <= 0) return 0;
  const now = Date.now();
  const rows = await prisma.recordingSession.findMany({
    where: { recording_date: { not: null }, segments: { some: { state: { in: ASSEMBLABLE } } } },
    select: { id: true, user_id: true, recording_date: true, last_chunk_at: true, created_at: true, assembly_attempts: true, assembly_next_at: true },
  });
  const due: AssemblyCandidate[] = [];
  for (const s of rows) {
    if (isAssembling(s.id) || (s.assembly_next_at && s.assembly_next_at.getTime() > now)) continue;
    const lastChunkAt = s.last_chunk_at ?? s.created_at;
    // idle >= 30 min, or the recording day is over + 30 min
    const ready = now - lastChunkAt.getTime() >= IDLE_ASSEMBLE_MS
      || now >= recordingDayEndsAt(dateStr(s.recording_date!), await ruleForUser(s.user_id)).getTime() + DAY_OVER_GRACE_MS;
    if (ready) due.push({ id: s.id, attempts: s.assembly_attempts, nextAt: s.assembly_next_at, lastChunkAt });
  }
  const ids = pickAssemblies(due, now, free);
  for (const id of ids) requestAssembly(id).catch((err) => console.error(`[Recording v2] assembly request failed for ${id}: ${err.message}`));
  return ids.length;
}

let pumping = false;
let pumpAgain = false;
/**
 * Starts due sessions until RECORDING_MAX_CONCURRENT_ASSEMBLIES (default 1) runs are active. Called by the sweep and
 * whenever a run ends (requestAssembly), so the queue moves on at once. Returns how many it started.
 */
export async function pumpAssemblies(): Promise<number> {
  if (pumping) { pumpAgain = true; return 0; } // a run ended mid-query: look again afterwards
  pumping = true;
  let started = 0;
  try {
    do {
      pumpAgain = false;
      started += await pumpOnce();
    } while (pumpAgain);
  } catch (err: any) {
    console.error('[Recording v2] assembly pump failed:', err.message);
  } finally {
    pumping = false;
  }
  return started;
}

let sweepingV2 = false;
export async function sweepV2(): Promise<void> {
  if (sweepingV2) return;
  sweepingV2 = true;
  try {
    const now = Date.now();

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

    const stranded = await prisma.recordingSegment.findMany({
      where: { state: 'assembled', chunks: { some: { purged_at: null } } },
      select: { id: true },
    });
    if (stranded.length) {
      console.warn(`[Sweeper v2] ${stranded.length} assembled segment(s) hold chunks that are not in the video — re-opening for assembly`);
      for (const s of stranded) {
        try { await reopenAssembledSegment(s.id, 'sweeper'); }
        catch (err: any) { console.error(`[Sweeper v2] Could not re-open segment ${s.id}: ${err.message}`); }
      }
    }

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

    // (b) unassembled complete segments: the queue (fair order, backoff, free slots) decides who runs; the sweep does not wait
    const queued = await pumpAssemblies();

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
  const s = await prisma.recordingSession.findUnique({ where: { id: sessionId }, select: { assembly_next_at: true } });
  if (s?.assembly_next_at && s.assembly_next_at.getTime() > Date.now()) return false;
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
  if (!row) return 30; // never saved → 30 days; a saved 0 (forever) has a row and returns 0 below
  const n = parseInt(row.value, 10);
  return RETENTION_VALUES.includes(n) ? n : 30;
}

export const QUALITY_KEY = 'recording.quality';
export const QUALITY_VALUES = ['480p', '720p', '1080p'] as const;
export type RecordingQuality = (typeof QUALITY_VALUES)[number];

export async function getRecordingQuality(): Promise<RecordingQuality> {
  const row = await prisma.appSetting.findUnique({ where: { key: QUALITY_KEY } });
  return (QUALITY_VALUES as readonly string[]).includes(row?.value ?? '') ? (row!.value as RecordingQuality) : '720p';
}

export async function setRecordingQuality(q: RecordingQuality, adminId: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: QUALITY_KEY },
    create: { key: QUALITY_KEY, value: q, updated_by: adminId },
    update: { value: q, updated_by: adminId },
  });
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
