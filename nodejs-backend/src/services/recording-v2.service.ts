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
  startsWithEbml,
} from './recording.service';
import { recordingDateFor, recordingDayEndsAt, ruleForUser } from './recording-day';
import { getGateway } from '../gateways/recording.gateway';

export const SEGMENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const IDLE_ASSEMBLE_MS = 30 * 60_000;
const DAY_OVER_GRACE_MS = 30 * 60_000;
const DAY_OVER_SETTLE_MS = 5 * 60_000; // a finished day still receiving a backlog is not rebuilt per chunk
const LIVE_WINDOW_MS = 10 * 60_000;
const STUCK_SEGMENT_MS = 48 * 3600_000;
const PREBOOT_GRACE_MS = 2 * 3600_000;
const MAX_CONCURRENT_ASSEMBLIES = 1;
const INIT_MAX = 64 * 1024; // init bytes (EBML header .. first Cluster) are a few hundred bytes; more means this is not what we think
const TAIL_ALLOWANCE_MS = 15_000; // a grafted tail loses its frames before the first keyframe (keyframe every ~5 s)
const MAX_DONORS = 5;
const INIT_SEQ_MAX = 5; // the header may be spread over the first chunks (a still screen: seq 0 can be 1 byte)
const NEVER_CLOSED_KEEP_MS = 16 * 86_400_000; // the agent keeps its own spool 15 days
const PARTS_KEEP_DAYS = 4;
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
  if (seq <= INIT_SEQ_MAX && !result.conflict && !seg.init_data) {
    // the header bytes of the stream (chunks 0, 1, … up to the first Cluster): later chunks of this segment can be made readable with them even after seq 0 is gone
    const init = await readInitOfSegment(segmentId).catch(() => null);
    if (init) await prisma.recordingSegment.updateMany({ where: { id: segmentId, init_data: null }, data: { init_data: init } }).catch((err) => console.warn(`[Recording v2] init_data of ${segmentId} not stored: ${err.message}`));
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
  const lostSeqs = [...new Set(lost as number[])].sort((a, b) => a - b);
  const closedAt = seg.agent_closed_at ?? new Date(); // always remembered: it lets the kept chunk files go once everything is in the video
  if (seg.state === 'assembled' || seg.state === 'unreadable') {
    // already decided: only record the agent's close, a larger lastSeq and more lost seqs (the state stays)
    await prisma.recordingSegment.update({
      where: { id: segmentId },
      data: { agent_closed_at: closedAt, last_seq: Math.max(seg.last_seq ?? -1, lastSeq as number), lost_seqs: [...new Set([...seg.lost_seqs, ...lostSeqs])].sort((a, b) => a - b) },
    });
    return { state: seg.state };
  }
  await prisma.recordingSegment.update({
    where: { id: segmentId },
    data: { state: 'closed', last_seq: lastSeq as number, lost_seqs: lostSeqs, ended_at: endedAt ?? seg.ended_at ?? new Date(), agent_closed_at: closedAt },
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
// Stage 2 helpers (pure; unit-tested in test-recording-queue)
// ─────────────────────────────────────────

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const SEGMENT_ID = Buffer.from([0x18, 0x53, 0x80, 0x67]);
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/**
 * The bytes of a stream's first chunk before its first Cluster (EBML header, Segment, Info, Tracks): what a later chunk
 * needs in front of it to be readable. null when the chunk is not the start of a WebM, or no Cluster follows within 64 KB.
 * A known-size Segment is made unknown-size (valid EBML, what MediaRecorder writes) so grafted clusters are not "outside" it.
 * ponytail: byte search for the Cluster id, not an EBML walk; a false hit makes a short header that fails the decode check.
 */
export function extractInit(buf: Buffer): Buffer | null {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(EBML_MAGIC)) return null;
  const at = buf.indexOf(CLUSTER_ID, 4);
  if (at < 0 || at > INIT_MAX) return null;
  const init = Buffer.from(buf.subarray(0, at));
  const seg = init.indexOf(SEGMENT_ID, 4);
  const first = seg > 0 ? init[seg + 4] : 0;
  const len = first ? Math.clz32(first) - 23 : 0; // vint length from the leading zero bits
  if (len >= 1 && len <= 8 && seg + 4 + len <= init.length) return Buffer.concat([init.subarray(0, seg + 4), UNKNOWN_SIZE, init.subarray(seg + 4 + len)]);
  return init;
}

/** The init bytes of a stream whose first chunks may be tiny: the chunks from seq 0, in order, up to the first Cluster (which may start in one chunk and end in the next). */
export function initFromChunks(chunks: Buffer[]): Buffer | null {
  const parts: Buffer[] = [];
  let n = 0;
  for (const c of chunks) { parts.push(c); n += c.length; if (n > INIT_MAX + 4) break; }
  return extractInit(Buffer.concat(parts));
}

/** Where the first Cluster id of a run of chunk files starts (file index + offset in it), also when the id is split between two files. */
export async function firstClusterAt(files: string[]): Promise<{ index: number; offset: number } | null> {
  const starts: number[] = [];
  let global = 0;
  let carry = Buffer.alloc(0);
  for (const [index, file] of files.entries()) {
    starts.push(global);
    for await (const buf of fs.createReadStream(file)) {
      const hay = Buffer.concat([carry, buf as Buffer]);
      const at = hay.indexOf(CLUSTER_ID);
      if (at >= 0) {
        const g = global - carry.length + at;
        let i = index;
        while (starts[i] > g) i--;
        return { index: i, offset: g - starts[i] };
      }
      global += (buf as Buffer).length;
      carry = hay.subarray(Math.max(0, hay.length - (CLUSTER_ID.length - 1)));
    }
  }
  return null;
}

/**
 * May this segment's kept chunk files go? Only when every chunk is in the video (purged), nothing is flagged, and either the
 * agent closed it and every seq 0..lastSeq is stored or declared lost (so nothing can still extend it and a rebuild is never
 * needed), or nobody closed it and its last chunk is older than the agent's own 16-day spool.
 */
export function keptFilesDeletable(
  seg: { state: string; problem: string | null; agent_closed_at: Date | null; last_seq: number | null; lost_seqs: number[] },
  rows: { seq: number | null; purged_at: Date | null; uploaded_at: Date }[],
  now: number,
): boolean {
  if (seg.state !== 'assembled' || seg.problem || rows.length === 0 || rows.some((r) => !r.purged_at)) return false;
  if (!seg.agent_closed_at) return now - Math.max(...rows.map((r) => r.uploaded_at.getTime())) > NEVER_CLOSED_KEEP_MS;
  if (seg.last_seq === null) return false;
  const have = new Set(rows.map((r) => r.seq));
  const lost = new Set(seg.lost_seqs);
  for (let i = 0; i <= seg.last_seq; i++) if (!have.has(i) && !lost.has(i)) return false;
  return true;
}

export interface SizeMs { w: number; h: number; codec: string; ms: number }

/**
 * The size/codec a day is made at. Without a base (first generation): the size with the most video, sizes under 640 wide only
 * when there is nothing else, ties to the larger area. With a base: the base's size, except a base under 640 wide that is
 * shorter than the new material of a proper size, which is re-encoded once (rebase).
 */
export function chooseRef(base: SizeMs | null, items: SizeMs[]): { ref: { w: number; h: number; codec: string } | null; rebase: boolean } {
  const groups = new Map<string, { w: number; h: number; codec: string; ms: number; top: number }>();
  for (const i of items) {
    const g = groups.get(`${i.w}x${i.h}`) ?? { w: i.w, h: i.h, codec: i.codec, ms: 0, top: 0 };
    g.ms += i.ms;
    if (i.ms > g.top) { g.top = i.ms; g.codec = i.codec; }
    groups.set(`${i.w}x${i.h}`, g);
  }
  const all = [...groups.values()];
  const wide = all.filter((g) => g.w >= 640);
  const major = [...(wide.length ? wide : all)].sort((a, b) => b.ms - a.ms || b.w * b.h - a.w * a.h)[0];
  const pick = major ? { w: major.w, h: major.h, codec: major.codec } : null;
  if (!base) return { ref: pick, rebase: false };
  if (base.w < 640 && pick && pick.w >= 640 && items.reduce((a, i) => a + i.ms, 0) > base.ms) return { ref: pick, rebase: true };
  return { ref: { w: base.w, h: base.h, codec: base.codec }, rebase: false };
}

/** Where a tail sits on the day's clock: its segment's start plus the durations of the chunks before it (a missing one counts 10 s). */
export function tailStartMs(startedAt: Date, earlier: { seq: number | null; duration_ms: number | null }[], firstSeq: number): number {
  const dur = new Map(earlier.map((c) => [c.seq, c.duration_ms]));
  let ms = startedAt.getTime();
  for (let i = 0; i < firstSeq; i++) ms += dur.get(i) ?? 10_000;
  return ms;
}

/** The files the day's video is built from (names relative to the session folder), in time order. segmentId null = the base (an older generation). */
export interface PartItem { file: string; segmentId: string | null; firstSeq: number; startMs: number; durationMs: number; packets: number | null }
export interface PartsManifest { ref: { w: number; h: number; codec: string } | null; items: PartItem[] }

export function parseManifest(v: unknown): PartsManifest | null {
  const m = v as any;
  if (!m || typeof m !== 'object' || !Array.isArray(m.items) || m.items.length === 0) return null;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  for (const i of m.items) {
    if (!i || typeof i.file !== 'string' || !(i.segmentId === null || typeof i.segmentId === 'string') || !num(i.firstSeq) || !num(i.startMs) || !num(i.durationMs) || !(i.packets === null || num(i.packets))) return null;
  }
  const r = m.ref;
  return { ref: r && num(r.w) && num(r.h) && typeof r.codec === 'string' ? { w: r.w, h: r.h, codec: r.codec } : null, items: m.items };
}

/** True when the recording day is older than keepDays (Karachi today). */
export function partsExpired(recordingDate: string, nowMs: number, keepDays: number): boolean {
  const today = new Date(nowMs + 5 * 3600_000).toISOString().slice(0, 10);
  return dateOnly(recordingDate).getTime() < dateOnly(today).getTime() - keepDays * 86_400_000;
}

/** Parts need disk (a second copy of the day): not below RECORDING_PARTS_MIN_FREE_GB (default 20) free, nor when that cannot be read. */
async function partsAllowed(dir: string): Promise<boolean> {
  const minFree = Number(process.env.RECORDING_PARTS_MIN_FREE_GB ?? 20) * 1024 ** 3;
  if (!(minFree > 0)) return true;
  try { const s = await fs.promises.statfs(dir); return s.bavail * s.bsize >= minFree; } catch { return false; }
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
  beforeCommit?: () => Promise<void>; // S36: "crash" after the new parts are moved, before the DB commit
} = {};

interface SegChunk { id: string; seq: number | null; file_path: string; duration_ms: number | null; logged_out: boolean }
interface SegInfo {
  id: string; user_id: string; started_at: Date; width: number | null; height: number | null; mime: string | null; init_data: Uint8Array | null;
  chunks: SegChunk[];
  late?: SegChunk[]; // set when chunks was widened to the whole segment (rebuild): only the chunks that are not in the video yet
}
interface Item {
  seg: SegInfo; file: string; durationMs: number; packets: number | null; reencoded: boolean; short: string | null;
  startMs: number; firstSeq: number; dims: { width: number; height: number; codec: string } | null;
}
/** One file the day's video is concatenated from: an existing part (fresh = false) or a new file still to be moved into parts/. */
interface Piece { abs: string; segmentId: string | null; firstSeq: number; startMs: number; durationMs: number; packets: number | null; fresh: boolean }
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

/** A rebuilt segment replaces its old parts only if it holds at least as much video (2 s slack; packets too when both are known). */
export function rebuildKeepsVideo(old: { durationMs: number; packets: number | null }[], rebuilt: { durationMs: number; packets: number | null }): boolean {
  if (rebuilt.durationMs < old.reduce((a, p) => a + p.durationMs, 0) - 2000) return false;
  return !(rebuilt.packets !== null && old.every((p) => p.packets !== null) && rebuilt.packets < old.reduce((a, p) => a + p.packets!, 0));
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
 * Chunk files → one remuxed WebM (`-c copy`), optionally behind a header (`header` = init bytes borrowed for a tail
 * that lost its seq 0). Never falls back to raw bytes: nothing readable → null. If the plain remux plays less than
 * `expected` the tolerant remux is tried too and the longer one is kept.
 */
export async function remuxChunks(files: string[], expected: number, dir: string, tag: string, temps: string[], header?: Buffer): Promise<{ file: string; probe: Probe } | null> {
  const raw = path.join(dir, `.tmp-${tag}.raw.webm`);
  temps.push(raw);
  let src = files;
  if (header) {
    const h = `${raw}.hdr`;
    temps.push(h);
    await fs.promises.writeFile(h, header);
    src = [h, ...files];
  }
  await concatFiles(src, raw);
  const tries: string[][] = [[], ['-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err']];
  let best: { file: string; probe: Probe } | null = null;
  for (const [i, input] of tries.entries()) {
    const out = path.join(dir, `.tmp-${tag}.r${i}.webm`);
    temps.push(out);
    if (!(await ffmpegRun(['-y', ...input, '-i', raw, '-c', 'copy', '-f', 'webm', out], out, COPY_TIMEOUT_MS)).ok) continue;
    const probe = await probeFile(out);
    if (!probe.ok || probe.durationMs === 0) continue; // exit 0 with zero packets is not readable
    if (!best || probe.durationMs > best.probe.durationMs) best = { file: out, probe };
    if (!shortProblem(best.probe.durationMs, expected)) break; // plays what the chunks claim: no need to try harder
  }
  return best;
}

/** The file plays and its first 3 s decode without a single error (a borrowed header must not just "remux"). */
export async function decodesClean(file: string): Promise<boolean> {
  const r = await probeRun(['-v', 'error', '-t', '3', '-i', file, '-f', 'null', '-']);
  return r.code === 0 && r.stderr.trim() === '';
}

/** Init bytes from the first chunk files, read in order only as far as the first Cluster (at most 64 KB). */
async function readInitFiles(files: string[]): Promise<Buffer | null> {
  const got: Buffer[] = [];
  let n = 0;
  try {
    for (const file of files) {
      const fh = await fs.promises.open(file, 'r');
      try {
        const b = Buffer.alloc(INIT_MAX + 4 - n);
        const { bytesRead } = await fh.read(b, 0, b.length, 0);
        got.push(b.subarray(0, bytesRead));
        n += bytesRead;
      } finally { await fh.close(); }
      if (n >= INIT_MAX + 4 || Buffer.concat(got).includes(CLUSTER_ID)) break;
    }
  } catch { return null; }
  return initFromChunks(got);
}

/** The stored chunk files of a segment that are contiguous from seq 0 (at most the first INIT_SEQ_MAX + 1). */
async function readInitOfSegment(segmentId: string): Promise<Buffer | null> {
  const rows = await prisma.recordingChunk.findMany({ where: { segment_id: segmentId, seq: { lte: INIT_SEQ_MAX } }, orderBy: { seq: 'asc' }, select: { seq: true, file_path: true } });
  const files: string[] = [];
  for (const r of rows) { if (r.seq !== files.length || !fs.existsSync(r.file_path)) break; files.push(r.file_path); }
  return files.length ? readInitFiles(files) : null;
}

/** Older segments (before init_data existed) get theirs from their first chunk files while those are still there. Best effort. */
async function storeInit(seg: SegInfo) {
  const files: string[] = [];
  for (const c of seg.chunks) { if (c.seq !== files.length || files.length > INIT_SEQ_MAX) break; files.push(c.file_path); }
  const init = await readInitFiles(files);
  if (init) await prisma.recordingSegment.updateMany({ where: { id: seg.id, init_data: null }, data: { init_data: init } }).catch(() => {});
}

/** A tail that lost its header (first stored chunk is not seq 0): cut at its first Cluster (it may start inside the header or mid-cluster), the borrowed header put in front. null = no Cluster in it. */
export async function remuxTail(files: string[], expected: number, dir: string, tag: string, temps: string[], header: Buffer): Promise<{ file: string; probe: Probe } | null> {
  const cut = await firstClusterAt(files);
  if (!cut) return null;
  const rest = path.join(dir, `.tmp-${tag}.tail`);
  temps.push(rest);
  await fs.promises.writeFile(rest, (await fs.promises.readFile(files[cut.index])).subarray(cut.offset));
  return remuxChunks([rest, ...files.slice(cut.index + 1)], expected, dir, tag, temps, header);
}

/** Headers to try for a tail without seq 0: its own init_data, then those of the same user's segments with the same mime and size (nearest in time first). */
async function headerCandidates(seg: SegInfo): Promise<{ kind: 'own' | 'donor'; bytes: Buffer }[]> {
  const out: { kind: 'own' | 'donor'; bytes: Buffer }[] = [];
  if (seg.init_data) out.push({ kind: 'own', bytes: Buffer.from(seg.init_data) });
  if (!seg.width || !seg.height) return out;
  const where = { user_id: seg.user_id, id: { not: seg.id }, width: seg.width, height: seg.height, mime: seg.mime };
  const select = { id: true, started_at: true, init_data: true };
  const [before, after] = await Promise.all([
    prisma.recordingSegment.findMany({ where: { ...where, started_at: { lte: seg.started_at } }, orderBy: { started_at: 'desc' }, take: 8, select }),
    prisma.recordingSegment.findMany({ where: { ...where, started_at: { gt: seg.started_at } }, orderBy: { started_at: 'asc' }, take: 8, select }),
  ]);
  const near = (p: { started_at: Date }) => Math.abs(p.started_at.getTime() - seg.started_at.getTime());
  let donors = 0;
  for (const p of [...before, ...after].sort((a, b) => near(a) - near(b))) {
    if (donors >= MAX_DONORS) break;
    const bytes = p.init_data ? Buffer.from(p.init_data) : await readInitOfSegment(p.id);
    if (bytes) { out.push({ kind: 'donor', bytes }); donors++; }
  }
  return out;
}

/** One segment → a playable remuxed file (not yet in the generation's size), or the reason it cannot be used. Never throws for bad media. */
async function prepareSegment(seg: SegInfo, dir: string, ts: number, temps: string[], attempts: number): Promise<Item | { problem: string }> {
  try {
    return await prepareSegmentInner(seg, dir, ts, temps);
  } catch (err) {
    // Ambiguous ffmpeg text (Input/output error, …): retried 3 times as infrastructure, then it is this segment's problem.
    if (err instanceof AmbiguousFfmpegError && !ambiguousIsTransient(attempts)) return { problem: err.message };
    throw err;
  }
}

async function prepareSegmentInner(seg: SegInfo, dir: string, ts: number, temps: string[]): Promise<Item | { problem: string }> {
  const first = seg.chunks[0];
  const files = seg.chunks.map((c) => c.file_path);
  const tail = first.seq !== 0;
  const expected = expectedMs(seg.chunks);
  let rx: { file: string; probe: Probe } | null = null;
  let allowance = 0; // frames before a grafted tail's first keyframe are dropped by the remux
  let note: string | null = null;
  if (tail && !(await startsWithEbml(first.file_path))) {
    // a continuation without its header: borrow one (own init bytes first, then donors) and accept it only if it plays and decodes
    for (const [n, c] of (await headerCandidates(seg)).entries()) {
      const r = await remuxTail(files, Math.max(0, expected - TAIL_ALLOWANCE_MS), dir, `${ts}-${seg.id}-h${n}`, temps, c.bytes);
      if (r && (await decodesClean(r.file))) {
        rx = r;
        allowance = TAIL_ALLOWANCE_MS;
        note = `late chunks joined onto ${c.kind === 'own' ? 'their own header' : 'a donor header'}; frames before their first keyframe are not in the video (chunk files kept)`;
        break;
      }
    }
    if (!rx) return { problem: 'late chunks without a usable header (own or donor)' };
  } else {
    rx = await remuxChunks(files, expected, dir, `${ts}-${seg.id}`, temps);
    if (!rx) return { problem: 'no readable video' };
    if (!tail && !seg.init_data) await storeInit(seg);
  }
  // Coverage: the chunks say how much was recorded. Playing less than that is kept visible and the files are kept.
  const short = shortProblem(rx.probe.durationMs + allowance, expected) ?? note;
  let startMs = seg.started_at.getTime();
  if (tail) {
    const earlier = await prisma.recordingChunk.findMany({ where: { segment_id: seg.id, seq: { lt: first.seq! } }, select: { seq: true, duration_ms: true } });
    startMs = tailStartMs(seg.started_at, earlier, first.seq!);
  }
  return { seg, file: rx.file, durationMs: rx.probe.durationMs, packets: rx.probe.packets, reencoded: false, short, startMs, firstSeq: first.seq ?? 0, dims: await probeDims(rx.file) };
}

/** Converts one prepared segment to the generation's codec/size (one ffmpeg call, one segment). */
async function normalizeItem(it: Item, ref: Ref, dir: string, ts: number, temps: string[]): Promise<Item | { problem: string }> {
  const sw = it.dims?.width ?? it.seg.width, sh = it.dims?.height ?? it.seg.height;
  if (!(ref.size && sw && sh && (sw !== ref.size.w || sh !== ref.size.h || (it.dims && ref.codec && it.dims.codec !== ref.codec)))) return it;
  const scaled = path.join(dir, `.tmp-${ts}-${it.seg.id}-${it.firstSeq}.scaled.webm`);
  temps.push(scaled);
  console.log(`[Recording v2] Segment ${it.seg.id} is ${it.dims?.codec ?? '?'} ${sw}x${sh}, generation is ${ref.codec} ${ref.size.w}x${ref.size.h} — converting`);
  const enc = await ffmpegRun(['-y', '-i', it.file, '-vf', scaleFilter(ref.size), ...reencodeArgs(ref.codec ?? 'vp8'), '-f', 'webm', scaled], scaled, reencodeTimeoutMs(it.durationMs));
  const back = enc.ok ? await probeFile(scaled) : null;
  if (!back || !back.ok || !reencodeKeptVideo(it.durationMs, back.durationMs)) return { problem: `re-encode to ${ref.size.w}x${ref.size.h} failed` };
  return { ...it, file: scaled, durationMs: back.durationMs, packets: back.packets, reencoded: true };
}

const pieceOf = (i: Item): Piece => ({ abs: i.file, segmentId: i.seg.id, firstSeq: i.firstSeq, startMs: i.startMs, durationMs: i.durationMs, packets: i.packets, fresh: true });
const byStart = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs;

/** Parts of the day: each file is moved into <dir>/parts, the old generation file that is a base part is hard-linked there; null = could not (or must not), the manifest is then just the generation. */
async function placeParts(dir: string, pieces: Piece[], next: number, prevFile: string | null): Promise<PartItem[] | null> {
  if (!(await partsAllowed(dir))) return null;
  try {
    const partsDir = path.join(dir, 'parts');
    await fs.promises.mkdir(partsDir, { recursive: true });
    const items: PartItem[] = [];
    for (const p of pieces) {
      let dest = p.abs;
      if (p.fresh) {
        // the generation is in the name: a replaced part never overwrites the file the committed manifest still names
        dest = path.join(partsDir, `${p.segmentId ?? 'base'}-${p.firstSeq}-g${next}.webm`);
        await fs.promises.rename(p.abs, dest);
        const now = new Date();
        await fs.promises.utimes(dest, now, now); // the sweep removes unreferenced parts only when older than 1 h
      } else if (prevFile && p.abs === prevFile) {
        dest = path.join(partsDir, `base-${p.firstSeq}-g${next - 1}.webm`);
        await fs.promises.link(prevFile, dest).catch((err) => { if (err.code !== 'EEXIST') throw err; });
      }
      items.push({ file: path.relative(dir, dest).replace(/\\/g, '/'), segmentId: p.segmentId, firstSeq: p.firstSeq, startMs: p.startMs, durationMs: p.durationMs, packets: p.packets });
    }
    return items;
  } catch (err: any) {
    console.warn(`[Recording v2] could not keep parts (${err.code ?? err.message}): the day is kept as its generation only`);
    return null;
  }
}

async function assembleSessionV2Inner(sessionId: string): Promise<void> {
  const session = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
  if (!session || !session.recording_date) throw new Error('v2 session not found');
  await closeAbandonedSegments(sessionId); // S4: on-demand assembly benefits too
  const rows = await prisma.recordingSegment.findMany({
    where: { session_id: sessionId, state: { in: ASSEMBLABLE } },
    orderBy: { started_at: 'asc' },
    include: { chunks: { where: { purged_at: null }, orderBy: { seq: 'asc' } } },
  });
  if (rows.length === 0) return;
  await testHooks.afterSnapshot?.();

  const dir = dirOf(session);
  await fs.promises.mkdir(dir, { recursive: true });

  // What the current generation is made of. A manifest counts only while every part file is still there.
  const manifest0 = parseManifest(session.parts);
  const manifest = manifest0 && manifest0.items.every((i) => fs.existsSync(path.join(dir, i.file))) ? manifest0 : null;
  const all: SegInfo[] = rows.map((r) => ({ id: r.id, user_id: r.user_id, started_at: r.started_at, width: r.width, height: r.height, mime: r.mime, init_data: r.init_data, chunks: r.chunks }));

  // A segment that has a part of its own and whose earlier chunk files are all still on disk is rebuilt whole (its part is replaced).
  for (const seg of all) {
    if (!seg.chunks.length || !manifest?.items.some((i) => i.segmentId === seg.id && i.firstSeq === 0)) continue;
    const prior = await prisma.recordingChunk.findMany({ where: { segment_id: seg.id, purged_at: { not: null } }, orderBy: { seq: 'asc' } });
    if (prior.length && prior.every((p) => fs.existsSync(p.file_path))) {
      seg.late = seg.chunks;
      seg.chunks = [...prior, ...seg.chunks].sort((a, b) => a.seq! - b.seq!);
    }
  }

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

  // Current generation file (must exist when generation > 0, otherwise earlier video would be dropped).
  let prevFile: string | null = null;
  let prevDuration = 0;
  let prevPackets: number | null = 0;
  let prevDims: { width: number; height: number; codec: string } | null = null;
  if (session.generation > 0) {
    if (!session.file_path || !fs.existsSync(session.file_path)) {
      throw new Error(`generation ${session.generation} file missing on disk (${session.file_path}) — refusing to build over it`);
    }
    prevFile = session.file_path;
    const p = await probeFile(prevFile);
    if (!p.ok || p.durationMs === 0) throw new Error(`generation ${session.generation} file is not readable (${prevFile}) — refusing to build over it`);
    prevDuration = p.durationMs; // measured: a stale duration_ms in the DB must not make every join look short
    prevPackets = p.packets;
    prevDims = await probeDims(prevFile);
  }
  let basePieces: Piece[] = [];
  if (prevFile) {
    if (manifest) basePieces = manifest.items.map((i) => ({ abs: path.join(dir, i.file), segmentId: i.segmentId, firstSeq: i.firstSeq, startMs: i.startMs, durationMs: i.durationMs, packets: i.packets, fresh: false }));
    else {
      const first = await prisma.recordingSegment.findFirst({ where: { session_id: sessionId, state: 'assembled' }, orderBy: { started_at: 'asc' }, select: { started_at: true } });
      basePieces = [{ abs: prevFile, segmentId: null, firstSeq: 0, startMs: (first?.started_at ?? session.created_at).getTime(), durationMs: prevDuration, packets: prevPackets, fresh: false }];
    }
  }

  const next = session.generation + 1;
  const ts = Date.now();
  const temps: string[] = [];
  const finalPath = path.join(dir, `recording-g${next}.webm`);

  try {
    // 1. prepare every segment on its own; a bad one is flagged (chunks untouched) and the others carry on
    const prepared: Item[] = [];
    const empty: SegInfo[] = [];
    const problems: Problem[] = [];
    for (const seg of segments) {
      if (seg.chunks.length === 0) { empty.push(seg); continue; } // nothing unpurged left in it
      let r = await prepareSegment(seg, dir, ts, temps, session.assembly_attempts);
      if ('problem' in r && seg.late) {
        console.warn(`[Recording v2] Segment ${seg.id}: whole-segment rebuild failed (${r.problem}) — trying the late chunks alone`);
        r = await prepareSegment({ ...seg, chunks: seg.late, late: undefined }, dir, ts, temps, session.assembly_attempts);
      }
      if ('problem' in r) {
        problems.push({ seg, problem: r.problem });
        console.warn(`[Recording v2] Segment ${seg.id} unreadable: ${r.problem} — chunks kept on disk`);
      } else prepared.push(r);
    }

    // A whole-segment rebuild that plays less than the parts it would replace (rotten kept files) is not used: the late chunks go in alone.
    for (let k = 0; k < prepared.length; k++) {
      const it = prepared[k];
      const old = manifest?.items.filter((i) => i.segmentId === it.seg.id) ?? [];
      if (!it.seg.late || rebuildKeepsVideo(old, it)) continue;
      console.warn(`[Recording v2] Segment ${it.seg.id}: the whole-segment rebuild plays ${it.durationMs} ms, the parts it would replace ${old.reduce((a, p) => a + p.durationMs, 0)} ms — keeping them, using the late chunks alone`);
      const tailSeg = { ...it.seg, chunks: it.seg.late, late: undefined };
      const r = await prepareSegment(tailSeg, dir, ts, temps, session.assembly_attempts);
      if ('problem' in r) {
        problems.push({ seg: tailSeg, problem: r.problem });
        console.warn(`[Recording v2] Segment ${it.seg.id} unreadable: ${r.problem} — chunks kept on disk`);
        prepared.splice(k--, 1);
      } else prepared[k] = r;
    }

    // 2. the reference size: what the day already is, else the size with the most video (never just the first segment's)
    const ref: Ref = { size: null, codec: null };
    const sized = prepared.filter((i) => (i.dims?.width ?? i.seg.width) && (i.dims?.height ?? i.seg.height))
      .map((i) => ({ w: (i.dims?.width ?? i.seg.width)!, h: (i.dims?.height ?? i.seg.height)!, codec: i.dims?.codec ?? 'vp8', ms: i.durationMs }));
    const choice = chooseRef(prevDims ? { w: prevDims.width, h: prevDims.height, codec: prevDims.codec, ms: prevDuration } : null, sized);
    if (choice.ref) { ref.size = { w: choice.ref.w, h: choice.ref.h }; ref.codec = choice.ref.codec; }
    let rebase = choice.rebase;
    if (rebase) {
      // the day so far is smaller than 640 wide and the new material clearly is not: re-encode its pieces once
      const redone: Piece[] = [];
      for (const b of basePieces) {
        const out = path.join(dir, `.tmp-${ts}-rebase${redone.length}.webm`);
        temps.push(out);
        const enc = await ffmpegRun(['-y', '-i', b.abs, '-vf', scaleFilter(ref.size!), ...reencodeArgs(ref.codec ?? 'vp8'), '-f', 'webm', out], out, reencodeTimeoutMs(b.durationMs));
        const back = enc.ok ? await probeFile(out) : null;
        if (!back || !back.ok || !reencodeKeptVideo(b.durationMs, back.durationMs)) { redone.length = 0; break; }
        redone.push({ ...b, abs: out, durationMs: back.durationMs, packets: back.packets, fresh: true });
      }
      if (redone.length === basePieces.length) basePieces = redone;
      else {
        console.warn(`[Recording v2] Session ${sessionId}: the earlier video could not be re-encoded to ${ref.size!.w}x${ref.size!.h} — the new material is scaled to it instead`);
        rebase = false;
        ref.size = { w: prevDims!.width, h: prevDims!.height };
        ref.codec = prevDims!.codec;
      }
    }
    const items: Item[] = [];
    for (const it of prepared) {
      const r = await normalizeItem(it, ref, dir, ts, temps);
      if ('problem' in r) problems.push({ seg: it.seg, problem: r.problem });
      else items.push(r);
    }
    items.sort(byStart);

    // 3. join, copy only. If the whole list will not join it is split in halves on top of the last good file so one bad
    //    segment cannot hold back the others. A lone culprit gets one per-segment re-encode to the generation's
    //    codec/size and one more try before it is flagged. At most MAX_JOIN_STRIKES such culprits per run: beyond that
    //    the rest is left assemblable (a retry with backoff), never mass-flagged.
    const state = { file: prevFile, dur: prevDuration, packets: prevPackets };
    let joined: Item[] = [];
    const joinBad: Problem[] = [];
    const deferred: SegInfo[] = [];
    const joinOutputs = new Set<string>(); // each is a whole copy of the day: drop the superseded one at once (disk)
    let joins = 0;
    let strikes = 0;
    const concatVerify = async (inputs: string[], want: { ms: number; packets: number | null }): Promise<{ out: string; ms: number; packets: number | null } | null> => {
      const out = path.join(dir, `.tmp-${ts}-join${joins++}.webm`);
      const list = `${out}.txt`;
      temps.push(out, list);
      await fs.promises.writeFile(list, inputs.map(concatListEntry).join('\n') + '\n');
      const r = await ffmpegRun(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'webm', out], out, COPY_TIMEOUT_MS);
      if (r.timedOut) throw new Error('ffmpeg concat timed out');
      if (!r.ok) return null;
      const p = await probeFile(out);
      if (!p.ok || !joinVerified(want, { ms: p.durationMs, packets: p.packets })) {
        console.warn(`[Recording v2] Verification failed for ${sessionId} g${next}: ok=${p.ok} duration=${p.durationMs}ms need>=${want.ms - 2000}ms packets=${p.packets} need>=${want.packets}`);
        await rm(out);
        return null;
      }
      return { out, ms: p.durationMs, packets: p.packets };
    };
    const tryJoin = async (group: Item[]): Promise<boolean> => {
      const inputs = [...(state.file ? [state.file] : []), ...group.map((i) => i.file)];
      const want = {
        ms: state.dur + group.reduce((a, i) => a + i.durationMs, 0),
        packets: state.packets !== null && group.every((i) => i.packets !== null) ? state.packets + group.reduce((a, i) => a + i.packets!, 0) : null,
      };
      if (inputs.length === 1) { state.file = inputs[0]; state.dur = want.ms; state.packets = want.packets; joined.push(...group); return true; }
      if (testHooks.failJoin?.(group.map((i) => ({ id: i.seg.id, reencoded: i.reencoded })))) return false;
      const r = await concatVerify(inputs, want);
      if (!r) return false;
      if (state.file && joinOutputs.has(state.file)) await rm(state.file);
      joinOutputs.add(r.out);
      state.file = r.out;
      state.dur = r.ms;
      state.packets = r.packets;
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

    // Time order: a segment that started before something already in the day, or a rebuilt one that replaces its own part,
    // means the whole day is concatenated again from its parts in start order. Anything else is appended to the generation.
    const replaced = new Set(items.filter((i) => i.seg.late).map((i) => i.seg.id));
    const keptBase = basePieces.filter((b) => !(b.segmentId && replaced.has(b.segmentId)));
    const newPieces = items.map(pieceOf);
    let finalPieces: Piece[] = [...basePieces, ...newPieces];
    let collapse = false; // true: the manifest ends up as the generation alone
    const needOrdered = items.length > 0 && (rebase || replaced.size > 0 || newPieces.some((p) => keptBase.some((b) => p.startMs < b.startMs)));
    let appendItems = items;
    if (needOrdered) {
      const everything = [...keptBase, ...newPieces].sort(byStart);
      const want = { ms: everything.reduce((a, p) => a + p.durationMs, 0), packets: everything.every((p) => p.packets !== null) ? everything.reduce((a, p) => a + p.packets!, 0) : null };
      const r = testHooks.failJoin?.(items.map((i) => ({ id: i.seg.id, reencoded: i.reencoded }))) ? null : await concatVerify(everything.map((p) => p.abs), want);
      if (r) {
        state.file = r.out; state.dur = r.ms; state.packets = r.packets; joinOutputs.add(r.out);
        joined = [...items];
        finalPieces = everything;
        appendItems = [];
      } else {
        if (rebase) throw new Error('the day could not be re-joined after re-encoding its earlier video; nothing was changed');
        // fall back to appending to the current generation; its parts are collapsed. A rebuilt segment must then bring only its late chunks.
        console.warn(`[Recording v2] Session ${sessionId}: ordered join of the parts failed — appending to the generation instead`);
        collapse = true;
        appendItems = [];
        for (const it of items) {
          if (!it.seg.late) { appendItems.push(it); continue; }
          const r2 = await prepareSegment({ ...it.seg, chunks: it.seg.late, late: undefined }, dir, ts, temps, session.assembly_attempts);
          const n2 = 'problem' in r2 ? r2 : await normalizeItem(r2, ref, dir, ts, temps);
          if ('problem' in n2) problems.push({ seg: it.seg, problem: n2.problem });
          else appendItems.push(n2);
        }
        appendItems.sort(byStart);
      }
    }
    if (appendItems.length) await joinInto(appendItems);
    if (!prevFile && appendItems.length > 1 && joined.length === 1) {
      // Nothing joined onto the first segment: it is the odd one out, not all the others. Publish the LONGEST segment
      // alone (normal commit: only its own chunks are marked / purged) and do not flag the rest: they stay assemblable
      // (the run ends in recordFailure) and the next run joins them on top of it.
      const keep = appendItems.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
      for (const i of appendItems) if (i !== keep && !deferred.includes(i.seg)) deferred.push(i.seg);
      const k = deferred.indexOf(keep.seg);
      if (k >= 0) deferred.splice(k, 1);
      joinBad.length = 0;
      state.file = keep.file;
      state.dur = keep.durationMs;
      state.packets = keep.packets;
      joined = [keep];
    }
    problems.push(...joinBad);
    if (appendItems.length && !collapse) finalPieces = [...basePieces, ...joined.map(pieceOf)];

    // 4. publish: fsync + rename, then the parts (moved next to the generation, not yet referenced), then one DB transaction
    //    (only what really went into the video is marked / purged). A crash before the commit leaves the old manifest and
    //    every file it names untouched; new parts that were already moved are removed by the sweep after an hour.
    let published: string | null = null;
    let parts: PartsManifest | undefined;
    const obsolete: string[] = [];
    if (joined.length) {
      await fsyncFile(state.file!);
      if (joinOutputs.has(state.file!)) await fs.promises.rename(state.file!, finalPath);
      else { // a single segment is the whole day: its file is also its part, so the generation is a second name (or copy) of it
        await rm(finalPath);
        await fs.promises.link(state.file!, finalPath).catch(() => fs.promises.copyFile(state.file!, finalPath));
      }
      published = finalPath;
      const refOut = ref.size && ref.codec ? { w: ref.size.w, h: ref.size.h, codec: ref.codec } : null;
      const placed = collapse ? null : await placeParts(dir, finalPieces.sort(byStart), next, prevFile);
      const startMs = Math.min(...finalPieces.map((p) => p.startMs));
      parts = { ref: refOut, items: placed ?? [{ file: path.basename(finalPath), segmentId: null, firstSeq: 0, startMs, durationMs: state.dur, packets: state.packets }] };
      const keep = new Set(parts.items.map((i) => path.join(dir, i.file)));
      for (const b of basePieces) if (!keep.has(b.abs)) obsolete.push(b.abs);
      for (const i of manifest?.items ?? []) if (!keep.has(path.join(dir, i.file))) obsolete.push(path.join(dir, i.file));
    }
    await testHooks.beforeCommit?.();
    const short = joined.filter((i) => i.short).map((i) => ({ seg: i.seg, problem: i.short! }));
    const full = [...joined.filter((i) => !i.short).map((i) => i.seg), ...empty];
    const issues = [...broken, ...problems.map((p) => `segment ${p.seg.id}: ${p.problem}`), ...short.filter((s) => /^only /.test(s.problem)).map((s) => `segment ${s.seg.id}: ${s.problem}`),
      ...deferred.map((d) => `segment ${d.id}: not joined this run, will retry`)];
    const error = issues.length ? issues.join('; ').slice(0, 900) : null;
    const loggedOutAdd = joined.flatMap((i) => i.seg.late ?? i.seg.chunks).reduce((a, c) => a + (c.logged_out ? (c.duration_ms ?? 0) : 0), 0);
    await commitGeneration({
      session, generation: published ? next : session.generation, finalPath: published, durationMs: state.dur,
      loggedOutAdd, full, short, unreadable: problems, prevFile, error, parts, obsolete,
    });
    if (broken.length || deferred.length) await recordFailure(sessionId, error!); // transient (missing chunk file / join budget used up): retry later with backoff
    console.log(published
      ? `[Recording v2] Session ${sessionId} g${next}: +${joined.length} segment(s), ${Math.round(state.dur / 1000)}s${problems.length ? `, ${problems.length} unreadable` : ''}`
      : `[Recording v2] Session ${sessionId}: nothing new to publish${problems.length ? `, ${problems.length} segment(s) unreadable` : ''}`);
  } finally {
    for (const t of temps) await rm(t);
  }
}

/** DB commit, then purge (after commit only). Chunk files go only for segments whose frames are in the committed video and that nothing can still add to. */
async function commitGeneration(c: {
  session: { id: string; logged_out_ms: number };
  generation: number;
  finalPath: string | null; // null: this run added no video — generation, duration and the retry counters stay as they are
  durationMs: number;
  loggedOutAdd: number;
  full: SegInfo[]; // in the video: rows purged; their files are deleted when keptFilesDeletable says so
  short: Problem[]; // in the video but short or grafted: rows purged (not pending again), files KEPT
  unreadable: Problem[]; // not in the video: state 'unreadable', chunks untouched
  prevFile: string | null;
  error: string | null;
  parts?: PartsManifest; // the manifest of the new generation (committed with it)
  obsolete: string[]; // files the old generation / manifest named that the new one does not: deleted after the commit
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
            assembly_error: c.error, assembly_attempts: 0, assembly_next_at: null, parts: c.parts as any,
          }
        : { assembly_error: c.error },
    }),
    prisma.recordingSegment.updateMany({ where: { id: { in: c.full.map((s) => s.id) }, state: pending }, data: { state: 'assembled', generation: c.generation, problem: null } }),
    ...c.short.map((s) => prisma.recordingSegment.updateMany({ where: { id: s.seg.id, state: pending }, data: { state: 'assembled', generation: c.generation, problem: s.problem } })),
    ...c.unreadable.map((u) => prisma.recordingSegment.updateMany({ where: { id: u.seg.id, state: pending }, data: { state: 'unreadable', problem: u.problem } })),
    prisma.recordingChunk.updateMany({ where: { id: { in: chunkIds } }, data: { purged_at: new Date() } }),
  ]);

  // Delete only after the commit, and only what keptFilesDeletable allows (agent-closed, complete, nothing pending, no problem).
  for (const s of c.full) await deleteKeptFilesIfDone(s.id);
  for (const f of c.obsolete) await deleteFile(f);
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

/** Deletes a segment's kept chunk files when nothing can still need them (see keptFilesDeletable). Returns how many files went. */
async function deleteKeptFilesIfDone(segmentId: string, now = Date.now()): Promise<number> {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId }, select: { state: true, problem: true, agent_closed_at: true, last_seq: true, lost_seqs: true } });
  if (!seg) return 0;
  const rows = await prisma.recordingChunk.findMany({ where: { segment_id: segmentId }, select: { seq: true, purged_at: true, uploaded_at: true, file_path: true } });
  if (!keptFilesDeletable(seg, rows, now)) return 0;
  for (const r of rows) await deleteFile(r.file_path);
  await fs.promises.rmdir(path.dirname(rows[0].file_path)).catch(() => {});
  return rows.length;
}

/** Window of sessions the housekeeping looks at (kept files and parts older than this are retention's business). */
const HOUSEKEEPING_DAYS = 45;
async function recentSessions<T extends Record<string, boolean>>(select: T) {
  const since = dateOnly(new Date(Date.now() + 5 * 3600_000 - HOUSEKEEPING_DAYS * 86_400_000).toISOString().slice(0, 10));
  return prisma.recordingSession.findMany({ where: { recording_date: { gte: since }, generation: { gt: 0 }, dir_path: { not: null } }, select: { id: true, dir_path: true, ...select } });
}

/** Sweep: deletes kept chunk files whose segment the agent has closed since, or that nobody closed for 16 days. Returns the number of files deleted. */
export async function cleanKeptFiles(): Promise<number> {
  let n = 0;
  for (const s of await recentSessions({})) {
    const segDir = path.join(s.dir_path!, 'segments');
    const ids = await fs.promises.readdir(segDir).catch(() => [] as string[]); // only segments whose folder still exists have kept files
    for (const id of ids) {
      n += await deleteKeptFilesIfDone(id);
      await fs.promises.rmdir(path.join(segDir, id)).catch(() => {}); // only succeeds when empty
    }
  }
  if (n) console.log(`[Sweeper v2] deleted ${n} kept chunk file(s) of closed / long idle segments`);
  return n;
}

/** Sweep: parts of a day older than RECORDING_PARTS_KEEP_DAYS (or on a low disk) collapse into the generation file. Returns the number of sessions collapsed. */
export async function collapseParts(opts: { keepDays?: number } = {}): Promise<number> {
  const keepDays = opts.keepDays ?? (Number(process.env.RECORDING_PARTS_KEEP_DAYS ?? PARTS_KEEP_DAYS) || PARTS_KEEP_DAYS);
  let n = 0;
  for (const s of await recentSessions({ file_path: true, generation: true, recording_date: true, parts: true, duration_ms: true })) {
    const m = parseManifest(s.parts);
    if (!m || (m.items.length === 1 && m.items[0].segmentId === null && path.join(s.dir_path!, m.items[0].file) === s.file_path)) continue;
    if (!(partsExpired(dateStr(s.recording_date!), Date.now(), keepDays) || !(await partsAllowed(s.dir_path!)))) continue;
    if (!s.file_path || !fs.existsSync(s.file_path)) continue; // never drop parts when the generation they build is not there
    const collapsed: PartsManifest = { ref: m.ref, items: [{ file: path.relative(s.dir_path!, s.file_path).replace(/\\/g, '/'), segmentId: null, firstSeq: 0, startMs: Math.min(...m.items.map((i) => i.startMs)), durationMs: s.duration_ms ?? m.items.reduce((a, i) => a + i.durationMs, 0), packets: m.items.every((i) => i.packets !== null) ? m.items.reduce((a, i) => a + i.packets!, 0) : null }] };
    const done = await prisma.recordingSession.updateMany({ where: { id: s.id, generation: s.generation }, data: { parts: collapsed as any } }); // not if a run committed meanwhile
    if (!done.count) continue;
    for (const i of m.items) if (path.join(s.dir_path!, i.file) !== s.file_path) await deleteFile(path.join(s.dir_path!, i.file));
    n++;
  }
  if (n) console.log(`[Sweeper v2] collapsed the parts of ${n} session(s) into their generation file`);
  return n;
}

/** Sweep: files in parts/ that no manifest names and that are older than an hour (left by a crash before the commit). */
export async function removeUnknownParts(): Promise<number> {
  let n = 0;
  for (const s of await recentSessions({ parts: true })) {
    const dir = path.join(s.dir_path!, 'parts');
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    if (!names.length) continue;
    const known = new Set((parseManifest(s.parts)?.items ?? []).map((i) => path.basename(i.file)));
    for (const name of names) {
      if (known.has(name)) continue;
      const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600_000) { await deleteFile(path.join(dir, name)); n++; }
    }
  }
  if (n) console.log(`[Sweeper v2] removed ${n} unreferenced part file(s)`);
  return n;
}

/** Stage 1 flagged late chunks without a header as unreadable; they can be grafted now. Called once per boot. Returns how many were made pending again. */
export async function reviveHeaderlessUnreadable(): Promise<number> {
  const segs = await prisma.recordingSegment.findMany({ where: { state: 'unreadable', problem: { startsWith: 'late chunks without their header' } }, select: { id: true, session_id: true } });
  for (const s of segs) await reviveSegment(s.id);
  if (segs.length) {
    await prisma.recordingSession.updateMany({ where: { id: { in: [...new Set(segs.map((s) => s.session_id))] } }, data: { assembly_next_at: null } });
    console.log(`[Sweeper v2] ${segs.length} segment(s) flagged for a missing header are assemblable again (headers can be borrowed now)`);
  }
  return segs.length;
}

/** New data arrived for an unreadable segment: it gets another try. */
async function reviveSegment(segmentId: string) {
  await prisma.recordingSegment.updateMany({ where: { id: segmentId, state: 'unreadable' }, data: { state: 'closed', problem: null } });
  await recomputeSegmentState(segmentId);
}

/**
 * Admin retry / repair: every unreadable segment that still has unpurged chunk rows goes back into the queue, and the
 * session's attempts, backoff and error are cleared. Builds nothing itself. Returns how many segments were revived.
 */
export async function reviveUnreadable(sessionId: string): Promise<number> {
  const segs = await prisma.recordingSegment.findMany({ where: { session_id: sessionId, state: 'unreadable', chunks: { some: { purged_at: null } } }, select: { id: true } });
  for (const s of segs) await reviveSegment(s.id);
  await prisma.recordingSession.update({ where: { id: sessionId }, data: { assembly_attempts: 0, assembly_next_at: null, assembly_error: null } });
  return segs.length;
}

/** POST /sessions/:id/retry-assembly. 404 for an unknown or legacy session, 409 while a run is going; otherwise the build starts in the background. */
export async function retryAssembly(sessionId: string): Promise<{ revived: number; pending: number }> {
  const { requestAssembly, isAssembling } = await import('./recording.service');
  const s = await prisma.recordingSession.findUnique({ where: { id: sessionId }, select: { recording_date: true } });
  if (!s?.recording_date) throw new HttpError(404, 'Session not found');
  if (isAssembling(sessionId)) throw new HttpError(409, 'already_assembling');
  const revived = await reviveUnreadable(sessionId);
  const pending = await prisma.recordingSegment.count({ where: { session_id: sessionId, state: { in: ASSEMBLABLE } } });
  requestAssembly(sessionId).catch(console.error);
  return { revived, pending };
}

/** Chunk rows were added by hand (repair script): the same follow-up as a stored chunk — a fresh try for the session, the segment re-evaluated (revived or re-opened when it had given up or was assembled). */
export async function chunkRowsAdded(segmentId: string): Promise<void> {
  const seg = await prisma.recordingSegment.findUnique({ where: { id: segmentId }, select: { state: true, session_id: true } });
  if (!seg) return;
  await prisma.recordingSession.update({ where: { id: seg.session_id }, data: { assembly_next_at: null, assembly_attempts: 0 } });
  if (seg.state === 'assembled') await reopenAssembledSegment(segmentId, 'repair: chunk row added');
  else if (seg.state === 'unreadable') await reviveSegment(segmentId);
  else await recomputeSegmentState(segmentId);
}

// ─────────────────────────────────────────
// Sweeper (called from the Phase 0 sweeper, every 5 min)
// ─────────────────────────────────────────

/** Backoff after failed assembly: 2^attempts * 5 min, capped at 6 h. */
export function assemblyBackoffMs(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 5 * 60_000, 6 * 3600_000);
}

/**
 * Is a session with pending segments due? Idle for 30 min, or the recording day is over (+30 min) AND the last chunk is at least
 * 5 min old: while a backlog of a finished day is still being uploaded every chunk would otherwise start a rebuild of the whole day.
 */
export function assemblyDue(now: number, lastChunkAt: number, dayEndsAt: number): boolean {
  const idle = now - lastChunkAt;
  return idle >= IDLE_ASSEMBLE_MS || (now >= dayEndsAt + DAY_OVER_GRACE_MS && idle >= DAY_OVER_SETTLE_MS);
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
    const dayEnd = recordingDayEndsAt(dateStr(s.recording_date!), await ruleForUser(s.user_id)).getTime();
    if (assemblyDue(now, lastChunkAt.getTime(), dayEnd)) due.push({ id: s.id, attempts: s.assembly_attempts, nextAt: s.assembly_next_at, lastChunkAt });
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
let revivedHeaderless = false;
let lastHousekeeping = Date.now(); // the first pass runs 30 min after boot
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

    // Once per boot: segments stage 1 flagged for a missing header can be grafted now
    if (!revivedHeaderless) { revivedHeaderless = true; await reviveHeaderlessUnreadable().catch((err) => console.error('[Sweeper v2] revive pass failed:', err.message)); }

    // Every 30 min: kept chunk files of closed / long idle segments, expired parts, parts a crash left behind
    if (now - lastHousekeeping >= 30 * 60_000) {
      lastHousekeeping = now;
      for (const job of [cleanKeptFiles, collapseParts, removeUnknownParts]) await job().catch((err) => console.error(`[Sweeper v2] ${job.name} failed:`, err.message));
    }

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
