/**
 * recording.service.ts — Core Recording Business Logic
 *
 * Handles:
 *  - Session lifecycle (start, stop, status, adoption of agent-owned sessions)
 *  - Durable, never-overwriting chunk persistence to local disk
 *  - Streaming, run-aware session assembly (ffmpeg) + sweeper
 *  - Agent token issuance
 *
 * HARD RULE: recording chunks are never lost, refused or overwritten.
 *
 * Storage adapter note: All file I/O goes through the storage helpers at the
 * top of this file. To migrate to S3, replace only those.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { EventEmitter, once } from 'events';
import { spawn } from 'child_process';
import prisma from '../prisma';
import { getGateway } from '../gateways/recording.gateway';
import { signAgentToken } from '../middleware/requireAgentToken';

export const recordingEmitter = new EventEmitter();
recordingEmitter.setMaxListeners(100);

/** Error carrying an HTTP status for the route layer. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** sessionId is used in filesystem paths — keep it strictly safe. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidSessionId = (s: unknown): s is string =>
  typeof s === 'string' && SESSION_ID_RE.test(s);

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// ─────────────────────────────────────────
// Storage Configuration (Adapter Pattern)
// ─────────────────────────────────────────

// Base directory for recording files — outside web root.
// Override via RECORDINGS_DIR env var; defaults to I:\hrApp_data\recordings on Windows (production).
const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : process.platform === 'win32'
    ? 'I:\\hrApp_data\\recordings'
    : path.join(process.cwd(), 'uploads', 'recordings');

/** Build the session directory path, organized by date */
function sessionDirPath(userId: string, sessionId: string, createdAt: Date): string {
  const dateStr = createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(RECORDINGS_DIR, dateStr, `${userId}_${sessionId}`);
}

async function ensureSessionDir(userId: string, sessionId: string, createdAt: Date): Promise<string> {
  const dir = sessionDirPath(userId, sessionId, createdAt);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

const chunkName = (chunkIndex: number) => `chunk-${String(chunkIndex).padStart(5, '0')}.webm`;

/** Write + fsync + close. Caller renames/links into place afterwards. */
async function durableWrite(filePath: string, buffer: Buffer): Promise<void> {
  const fh = await fs.promises.open(filePath, 'w');
  try {
    await fh.writeFile(buffer);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(filePath)) h.update(c as Buffer);
  return h.digest('hex');
}

const FP_SPAN = 64 * 1024;

/**
 * Cheap chunk fingerprint: sha256 of the first and last 64 KB (whole file when
 * smaller). The agent computes the same over its local file, so the backlog
 * check never has to read or send whole chunks. Keep in sync with
 * frontend/electron/recorder-main.js `_fingerprint`.
 */
export async function chunkFingerprint(filePath: string): Promise<{ size: number; fp: string }> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const h = crypto.createHash('sha256');
    const head = Buffer.alloc(Math.min(FP_SPAN, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > FP_SPAN) {
      const tailLen = Math.min(FP_SPAN, size - FP_SPAN);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
    return { size, fp: h.digest('hex') };
  } finally {
    await fh.close();
  }
}

/**
 * Backlog check for an agent re-scanning its local spool: which of these
 * chunks does the server already hold (same size + fingerprint)? `owned` is
 * false when the session belongs to another user (the agent then skips it
 * instead of re-sending video that will be refused).
 */
export async function checkChunks(
  sessionId: string,
  userId: string,
  chunks: { index: number; size: number; fp: string }[]
): Promise<{ owned: boolean; have: number[] }> {
  const session = await prisma.recordingSession.findUnique({ where: { id: sessionId }, select: { user_id: true } });
  if (!session) return { owned: true, have: [] }; // created on first upload
  if (session.user_id !== userId) return { owned: false, have: [] };

  const rows = await prisma.recordingChunk.findMany({
    where: { session_id: sessionId, chunk_index: { in: chunks.map((c) => c.index) } },
    select: { chunk_index: true, file_path: true },
  });
  const byIndex = new Map(rows.map((r) => [r.chunk_index, r.file_path]));
  const have: number[] = [];
  for (const c of chunks) {
    const file = byIndex.get(c.index);
    if (!file) continue;
    try {
      const mine = await chunkFingerprint(file);
      if (mine.size === c.size && mine.fp === c.fp) have.push(c.index);
    } catch { /* file missing on disk: agent must re-send */ }
  }
  return { owned: true, have };
}

/** True when the file's first 4 bytes are the EBML magic (start of a new WebM stream). */
export async function startsWithEbml(filePath: string): Promise<boolean> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    return bytesRead === 4 && b.equals(EBML_MAGIC);
  } finally {
    await fh.close();
  }
}

// ─────────────────────────────────────────
// Agent Token
// ─────────────────────────────────────────

/**
 * Issues or refreshes an agent JWT for the given userId.
 * Stores token hash in DB for revocation capability.
 */
export async function issueAgentToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const token = signAgentToken(userId);

  await prisma.agentToken.upsert({
    where: { user_id: userId },
    create: { user_id: userId, token },
    update: { token, last_seen: new Date() },
  });

  return token;
}

// ─────────────────────────────────────────
// Per-user lock
// ─────────────────────────────────────────

const userLocks = new Map<string, Promise<void>>();

/** Serialises fn() with every other withUserLock(userId, ...) call. Not re-entrant. */
export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  userLocks.set(userId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  }
}

// ─────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────

const ACTIVE = ['pending', 'recording'];

/**
 * Fetches a session, creating it for `userId` if the id is unknown
 * (old agent scheduler used ids like 'sched-<ms>'). 403 if owned by someone else.
 */
export async function getOrCreateSession(sessionId: string, userId: string) {
  let s = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
  if (!s) {
    try {
      s = await prisma.recordingSession.create({
        data: {
          id: sessionId,
          user_id: userId,
          created_by: userId,
          status: 'recording',
          started_at: new Date(),
        },
      });
      console.log(`[Recording Service] Created session ${sessionId} for agent ${userId} (unknown id)`);
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // lost a creation race — refetch
      s = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
    }
  }
  if (!s) throw new Error('Session not found');
  if (s.user_id !== userId) throw new HttpError(403, 'Session belongs to another user');
  return s;
}

/** Moves a session back to 'recording' when data keeps arriving for it. Returns the new status. */
async function reopenIfNeeded(s: { id: string; status: string }): Promise<string> {
  if (s.status === 'recording') return s.status;
  if (s.status === 'pending') {
    await prisma.recordingSession.update({
      where: { id: s.id },
      data: { status: 'recording', started_at: new Date() },
    });
    return 'recording';
  }
  // stopped / assembled / anything else: never refuse, reopen.
  console.log(`[Recording Service] Reopening session ${s.id} (was ${s.status}) — data still arriving`);
  await prisma.recordingSession.update({
    where: { id: s.id },
    data: { status: 'recording', ended_at: null },
  });
  return 'recording';
}

/** Mark sessions stopped, notify live viewers, and assemble those that have chunks. */
async function stopSessionsNow(sessions: { id: string; _count?: { chunks: number } }[]): Promise<void> {
  if (sessions.length === 0) return;
  await prisma.recordingSession.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { status: 'stopped', ended_at: new Date() },
  });
  for (const s of sessions) {
    recordingEmitter.emit(`stopped:${s.id}`);
    const n = s._count?.chunks ?? (await prisma.recordingChunk.count({ where: { session_id: s.id } }));
    if (n > 0) requestAssembly(s.id).catch(console.error);
  }
}

/** Public: stop active sessions of a user (used by gateway disconnect handler). */
export async function stopActiveSessionsOf(userId: string): Promise<void> {
  const sessions = await prisma.recordingSession.findMany({
    where: { user_id: userId, status: { in: ACTIVE } },
    include: { _count: { select: { chunks: true } } },
  });
  for (const s of sessions) {
    console.log(`[Recording Service] Marking session ${s.id} stopped on disconnect (${s._count.chunks} chunks)`);
  }
  await stopSessionsNow(sessions);
}

/**
 * Agent says it is recording `sessionId`: adopt it (create/reopen) and stop
 * every OTHER active session of the user. MUST be called inside withUserLock.
 */
export async function adoptAgentSession(userId: string, sessionId: string): Promise<void> {
  const s = await getOrCreateSession(sessionId, userId);
  if (!ACTIVE.includes(s.status)) await reopenIfNeeded(s);
  const others = await prisma.recordingSession.findMany({
    where: { user_id: userId, status: { in: ACTIVE }, id: { not: sessionId } },
    include: { _count: { select: { chunks: true } } },
  });
  if (others.length) {
    console.log(`[Recording Service] Agent ${userId} adopted ${sessionId}; stopping ${others.length} other active session(s)`);
  }
  await stopSessionsNow(others);
}

/**
 * Starts (or re-attaches to) a recording session for the target user. Takes the
 * per-user lock. If an active session already exists it is kept and START_RECORDING
 * is re-sent for it — nothing is stopped.
 */
export function startSession(
  userId: string,
  adminId: string,
  quality: string = '720p'
): Promise<{ sessionId: string; agentConnected: boolean }> {
  return withUserLock(userId, () => startSessionUnlocked(userId, adminId, quality));
}

/** Same as startSession but the caller already holds the user lock. */
export async function startSessionUnlocked(
  userId: string,
  adminId: string,
  quality: string = '720p'
): Promise<{ sessionId: string; agentConnected: boolean }> {
  const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (targetUser && (targetUser.role === 'admin' || targetUser.role === 'superadmin')) {
    throw new Error('Admins cannot be recorded');
  }

  const gateway = getGateway();
  gateway?.clearAgentError(userId); // fresh attempt — drop stale permission errors

  const active = await prisma.recordingSession.findFirst({
    where: { user_id: userId, status: { in: ACTIVE } },
    orderBy: { created_at: 'desc' },
  });
  let sessionId: string;
  if (active) {
    sessionId = active.id;
    console.log(`[Recording Service] User ${userId} already has active session ${sessionId} — re-sending START_RECORDING`);
  } else {
    const session = await prisma.recordingSession.create({
      data: { user_id: userId, created_by: adminId, status: 'pending' },
    });
    await ensureSessionDir(userId, session.id, session.created_at);
    sessionId = session.id;
  }

  const agentConnected = gateway?.broadcast(userId, {
    type: 'START_RECORDING',
    sessionId,
    quality,
  }) ?? false;

  return { sessionId, agentConnected };
}

/**
 * Stops a recording session.
 * Sends STOP_RECORDING to agent and triggers assembly after a short delay.
 */
export async function stopSession(
  sessionId: string,
  adminId: string
): Promise<{ ok: boolean; agentConnected: boolean }> {
  const session = await prisma.recordingSession.findUnique({ where: { id: sessionId } });

  if (!session) throw new Error('Session not found');
  if (session.status === 'stopped' || session.status === 'assembled') {
    return { ok: true, agentConnected: false };
  }

  await prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: 'stopped', ended_at: new Date() },
  });

  const agentConnected = getGateway()?.broadcast(session.user_id, {
    type: 'STOP_RECORDING',
    sessionId,
  }) ?? false;

  recordingEmitter.emit(`stopped:${sessionId}`);

  // Assemble after 15s (allow final chunks to arrive)
  setTimeout(() => {
    requestAssembly(sessionId).catch((err) => {
      console.error(`[Recording Service] Assembly failed for ${sessionId}:`, err.message);
    });
  }, 15_000);

  return { ok: true, agentConnected };
}

export interface SaveChunkResult {
  duplicate?: boolean;
  conflict?: boolean;
}

/**
 * Durably saves a chunk. Never overwrites an existing chunk file: identical
 * re-uploads are acknowledged, differing bytes are kept under collisions/.
 */
export async function saveChunk(
  sessionId: string,
  chunkIndex: number,
  buffer: Buffer,
  agentUserId: string
): Promise<SaveChunkResult> {
  const session = await getOrCreateSession(sessionId, agentUserId);
  // Never refuse because of status — reopen instead.
  await reopenIfNeeded(session);

  const dir = await ensureSessionDir(session.user_id, sessionId, session.created_at);
  const finalPath = path.join(dir, chunkName(chunkIndex));
  const tmpPath = path.join(dir, `.tmp-${chunkName(chunkIndex)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);

  await durableWrite(tmpPath, buffer);

  let result: SaveChunkResult = {};
  let placed = false;
  try {
    try {
      await fs.promises.link(tmpPath, finalPath); // atomic, fails with EEXIST instead of overwriting
      placed = true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        // Filesystem without hard links: fall back to check + rename.
        if (!fs.existsSync(finalPath)) {
          await fs.promises.rename(tmpPath, finalPath);
          placed = true;
        }
      }
    }

    if (!placed) {
      // A file already exists for this index.
      const existingHash = await sha256File(finalPath);
      const incomingHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (existingHash === incomingHash) {
        result = { duplicate: true };
      } else {
        const collDir = path.join(dir, 'collisions');
        await fs.promises.mkdir(collDir, { recursive: true });
        const collPath = path.join(collDir, `chunk-${String(chunkIndex).padStart(5, '0')}-${Date.now()}.webm`);
        await fs.promises.rename(tmpPath, collPath); // tmp is already durable
        const existingSize = (await fs.promises.stat(finalPath)).size;
        console.warn(
          `[Recording Service] CHUNK COLLISION session=${sessionId} index=${chunkIndex} ` +
          `existing=${existingSize}B incoming=${buffer.length}B — incoming kept at ${collPath}`
        );
        result = { conflict: true };
      }
    }
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {}); // no-op if already renamed
  }

  // Only now record in DB (also heals a row lost to a crash between write and upsert).
  const size = result.conflict ? (await fs.promises.stat(finalPath)).size : buffer.length;
  await prisma.recordingChunk.upsert({
    where: { session_id_chunk_index: { session_id: sessionId, chunk_index: chunkIndex } },
    create: { session_id: sessionId, chunk_index: chunkIndex, file_path: finalPath, file_size: size },
    update: result.conflict ? {} : { file_path: finalPath, file_size: size, uploaded_at: new Date() },
  });

  if (!result.duplicate && !result.conflict) {
    recordingEmitter.emit(`chunk:${sessionId}`, { index: chunkIndex, buffer });
    console.log(`[Recording Service] Chunk ${chunkIndex} saved for session ${sessionId} (${Math.round(buffer.length / 1024)}KB)`);
  }
  return result;
}

// ─────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────

function runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let ffmpegPath: string | null;
    try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = null; }
    if (!ffmpegPath) return resolve({ code: -1, stderr: 'ffmpeg-static not available' });
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    p.on('error', (e) => resolve({ code: -1, stderr: e.message }));
    p.on('close', (code) => resolve({ code, stderr }));
  });
}

/** Stream-concatenate files into dest with backpressure. */
async function concatFiles(files: string[], dest: string): Promise<void> {
  const ws = fs.createWriteStream(dest);
  const failed = new Promise<never>((_, rej) => ws.once('error', rej));
  failed.catch(() => {});
  try {
    for (const f of files) {
      for await (const buf of fs.createReadStream(f)) {
        if (!ws.write(buf)) await Promise.race([once(ws, 'drain'), failed]);
      }
    }
    ws.end();
    await Promise.race([once(ws, 'finish'), failed]);
  } catch (err) {
    ws.destroy();
    throw err;
  }
}

const rm = (p: string) => fs.promises.unlink(p).catch(() => {});

const concatListEntry = (p: string) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

/**
 * Pure file work (no DB). Splits the ordered chunk files into WebM runs (each run
 * starts at a chunk beginning with the EBML magic), remuxes each run with ffmpeg
 * and joins the runs. Output is a NEW file `recording-<ts>.webm` in workDir.
 * If joining fails entirely the first run file is returned and the rest are kept.
 */
export async function assembleChunkFiles(
  chunkPaths: string[],
  workDir: string
): Promise<{ outputPath: string; runs: number }> {
  // A2: split into runs
  const runs: string[][] = [];
  for (const p of chunkPaths) {
    let magic: boolean;
    try {
      magic = await startsWithEbml(p);
    } catch (err: any) {
      console.warn(`[Recording Service] Missing/unreadable chunk file, skipping: ${p} (${err.code ?? err.message})`);
      continue;
    }
    if (magic) runs.push([p]);
    else if (runs.length === 0) {
      console.warn(`[Recording Service] First chunk lacks EBML header, treating as run 0: ${p}`);
      runs.push([p]);
    } else runs[runs.length - 1].push(p);
  }
  if (runs.length === 0) throw new Error('No readable chunk files');

  const ts = Date.now();
  const temps: string[] = [];
  const keep = new Set<string>();
  const finalPath = path.join(workDir, `recording-${ts}.webm`);

  try {
    // A3: per-run concat + remux
    const runFiles: string[] = [];
    for (let n = 0; n < runs.length; n++) {
      const raw = path.join(workDir, `run-${ts}-${n}.raw.webm`);
      const remuxed = path.join(workDir, `run-${ts}-${n}.webm`);
      temps.push(raw, remuxed);
      await concatFiles(runs[n], raw);
      const r = await runFfmpeg(['-y', '-i', raw, '-c', 'copy', remuxed]);
      let ok = false;
      if (r.code === 0) {
        try { ok = (await fs.promises.stat(remuxed)).size > 0; } catch { /* not created */ }
      }
      if (ok) runFiles.push(remuxed);
      else {
        console.warn(`[Recording Service] ffmpeg remux failed for run ${n} (code ${r.code}); using raw run. ${r.stderr.slice(-300)}`);
        runFiles.push(raw);
      }
    }

    let outputPath: string;
    if (runFiles.length === 1) {
      await fs.promises.rename(runFiles[0], finalPath);
      outputPath = finalPath;
      keep.add(finalPath);
    } else {
      const list = path.join(workDir, `list-${ts}.txt`);
      temps.push(list);
      await fs.promises.writeFile(list, runFiles.map(concatListEntry).join('\n') + '\n');
      const base = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
      let r = await runFfmpeg([...base, '-c', 'copy', finalPath]);
      if (r.code !== 0) {
        console.warn(`[Recording Service] concat -c copy failed (code ${r.code}); retrying with re-encode. ${r.stderr.slice(-300)}`);
        await rm(finalPath);
        r = await runFfmpeg([...base, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-an', finalPath]);
      }
      if (r.code === 0) {
        outputPath = finalPath;
        keep.add(finalPath);
      } else {
        await rm(finalPath);
        runFiles.forEach((f) => keep.add(f));
        outputPath = runFiles[0];
        console.error(
          `[Recording Service] Could not join ${runFiles.length} runs; keeping run files (no data loss). ` +
          `Session file set to first run. All runs: ${runFiles.join(', ')}. ${r.stderr.slice(-300)}`
        );
      }
    }

    const st = await fs.promises.stat(outputPath);
    if (st.size <= 0) throw new Error('Assembled output is empty');
    return { outputPath, runs: runs.length };
  } finally {
    for (const t of temps) if (!keep.has(t)) await rm(t);
  }
}

/**
 * Assembles all chunks of a session into a NEW generation file and switches the
 * DB to it. Chunks are never deleted. Prefer requestAssembly() (per-session lock).
 */
export async function assembleSession(sessionId: string): Promise<string> {
  const assemblyStartedAt = new Date();
  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
    select: { user_id: true, created_at: true, file_path: true },
  });
  if (!session) throw new Error('Session not found');

  const chunks = await prisma.recordingChunk.findMany({
    where: { session_id: sessionId },
    orderBy: { chunk_index: 'asc' },
  });
  if (chunks.length === 0) throw new Error('No chunks found for session');

  const dir = await ensureSessionDir(session.user_id, sessionId, session.created_at);
  console.log(`[Recording Service] Assembling ${sessionId} (${chunks.length} chunks)...`);
  const { outputPath, runs } = await assembleChunkFiles(chunks.map((c) => c.file_path), dir);

  // A5: only mark assembled if nothing arrived meanwhile and the session isn't live.
  await prisma.recordingSession.update({ where: { id: sessionId }, data: { file_path: outputPath } });
  const newer = await prisma.recordingChunk.count({
    where: { session_id: sessionId, uploaded_at: { gt: assemblyStartedAt } },
  });
  if (newer === 0) {
    await prisma.recordingSession.updateMany({
      where: { id: sessionId, status: { notIn: ACTIVE } },
      data: { status: 'assembled' },
    });
  } else {
    console.log(`[Recording Service] ${newer} chunk(s) arrived during assembly of ${sessionId}; leaving status for sweeper`);
  }

  // A4: drop the previous generation (may be locked by a download on Windows — ignore).
  if (session.file_path && session.file_path !== outputPath) {
    fs.promises.unlink(session.file_path).catch((err) => {
      if (err.code !== 'ENOENT') {
        console.warn(`[Recording Service] Could not delete previous recording ${session.file_path}: ${err.code ?? err.message}`);
      }
    });
  }

  const stats = await fs.promises.stat(outputPath);
  console.log(
    `[Recording Service] Session ${sessionId} assembled: ${chunks.length} chunks, ${runs} run(s) → ${Math.round(stats.size / 1024 / 1024 * 10) / 10}MB`
  );
  return outputPath;
}

const assemblyRuns = new Map<string, { rerun: boolean }>();

/** Per-session guarded assembly; a call during a run schedules exactly one more run. Never rejects. */
export async function requestAssembly(sessionId: string): Promise<void> {
  const running = assemblyRuns.get(sessionId);
  if (running) {
    running.rerun = true;
    return;
  }
  const state = { rerun: false };
  assemblyRuns.set(sessionId, state);
  try {
    do {
      state.rerun = false;
      try {
        await assembleSession(sessionId);
      } catch (err: any) {
        console.error(`[Recording Service] Assembly failed for ${sessionId}: ${err.message}`);
      }
    } while (state.rerun);
  } finally {
    assemblyRuns.delete(sessionId);
  }
}

// ─────────────────────────────────────────
// Sweeper
// ─────────────────────────────────────────

const lastChunk = { chunks: { orderBy: { uploaded_at: 'desc' as const }, take: 1, select: { uploaded_at: true } } };
let sweeping = false;
let sweeperStarted = false;

async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    let closed = 0, queued = 0;

    // (a) stale live sessions → stopped
    const live = await prisma.recordingSession.findMany({
      where: { status: { in: ACTIVE } },
      select: { id: true, created_at: true, ...lastChunk },
    });
    const stale = live.filter((s) => now - (s.chunks[0]?.uploaded_at ?? s.created_at).getTime() > 10 * 60_000);
    if (stale.length) {
      await prisma.recordingSession.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { status: 'stopped', ended_at: new Date() },
      });
      stale.forEach((s) => recordingEmitter.emit(`stopped:${s.id}`));
      closed = stale.length;
    }

    // (b) stopped with chunks, quiet for 2 min → assemble
    const stopped = await prisma.recordingSession.findMany({
      where: { status: 'stopped', chunks: { some: {} } },
      select: { id: true, ...lastChunk },
    });
    for (const s of stopped) {
      if (now - s.chunks[0].uploaded_at.getTime() > 2 * 60_000) {
        queued++;
        await requestAssembly(s.id);
      }
    }

    // (c) assembled but newer chunks than the file (or file gone) → re-assemble
    // ponytail: only sessions from the last 30 days are checked, widen if late chunks for older sessions matter.
    const assembled = await prisma.recordingSession.findMany({
      where: { status: 'assembled', created_at: { gte: new Date(now - 30 * 86_400_000) } },
      select: { id: true, file_path: true, ...lastChunk },
    });
    for (const s of assembled) {
      const last = s.chunks[0]?.uploaded_at;
      if (!last) continue;
      let stale2 = !s.file_path;
      if (!stale2) {
        try { stale2 = last.getTime() > (await fs.promises.stat(s.file_path!)).mtimeMs; } catch { stale2 = true; }
      }
      if (stale2) {
        queued++;
        await requestAssembly(s.id);
      }
    }

    if (closed || queued) console.log(`[Sweeper] closed ${closed} stale session(s), requested assembly for ${queued}`);
  } catch (err: any) {
    console.error('[Sweeper] failed:', err.message);
  } finally {
    sweeping = false;
  }
}

/** First sweep 30s after boot, then every 5 minutes. */
export function startAssemblySweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setTimeout(() => { sweepOnce(); }, 30_000);
  setInterval(() => { sweepOnce(); }, 5 * 60_000);
}

// ─────────────────────────────────────────
// Query Helpers
// ─────────────────────────────────────────

export async function getSession(sessionId: string) {
  return prisma.recordingSession.findUnique({
    where: { id: sessionId },
    include: {
      chunks: { orderBy: { chunk_index: 'asc' }, select: { chunk_index: true, file_size: true, uploaded_at: true } },
      employee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
    },
  });
}

export async function listSessions(userId?: string) {
  return prisma.recordingSession.findMany({
    where: userId ? { user_id: userId } : undefined,
    orderBy: { created_at: 'desc' },
    take: 100,
    include: {
      employee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      _count: { select: { chunks: true } },
    },
  });
}

export function getLiveStatus(userId: string): {
  connected: boolean;
  sessionId?: string;
} {
  const gateway = getGateway();
  return {
    connected: gateway?.isConnected(userId) ?? false,
  };
}

export function getAssembledFilePath(sessionId: string, storedPath: string): string {
  return storedPath;
}
