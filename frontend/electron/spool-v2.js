/**
 * spool-v2.js — durable local spool for recording v2 (docs/recording-v2.md §8).
 *
 *   <recordings>/v2/<userId>/<segmentId>/
 *       segment.json  <seq>.webm  <seq>.json  <seq>.webm.ok  registered  closed.ok
 *
 * Dependency-free (fs/path/crypto) so it can be checked without Electron.
 * Nothing here ever deletes or overwrites a chunk.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const v2Root = (recordingsDir) => path.join(recordingsDir, 'v2');
export const safeUserDir = (u) => String(u).replace(/[^A-Za-z0-9_-]/g, '_') || '_';
export const segmentDir = (root, userId, segmentId) => path.join(root, safeUserDir(userId), segmentId);
export const orphanDir = (root, segmentId) => path.join(root, '_orphan', segmentId);
export const chunkFile = (dir, seq, ext = 'webm') => path.join(dir, `${seq}.${ext}`);

// Per-directory promise chain: serialises chunk writes and segment.json edits.
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const p = prev.catch(() => { }).then(fn);
  _locks.set(key, p);
  p.then(() => { }, () => { }).then(() => { if (_locks.get(key) === p) _locks.delete(key); });
  return p;
}

const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };

/** tmp → fsync → rename. */
export async function writeFileDurable(file, data) {
  const tmp = `${file}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fs.promises.rename(tmp, file);
}

export async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}

export const readSegment = (dir) => readJson(path.join(dir, 'segment.json'));

/** @param {object} info { segmentId, userId, recordingDate, startedAt, mime, width, height, deviceId } */
export async function createSegment(dir, info) {
  await fs.promises.mkdir(dir, { recursive: true });
  await withLock(dir, () => writeFileDurable(path.join(dir, 'segment.json'),
    JSON.stringify({ closed: false, lastSeq: null, endedAt: null, ...info })));
}

export function updateSegment(dir, patch) {
  return withLock(dir, async () => {
    const cur = await readSegment(dir);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await writeFileDurable(path.join(dir, 'segment.json'), JSON.stringify(next));
    return next;
  });
}

/** Highest <seq>.webm present in the folder, -1 when none. */
export async function maxSeq(dir) {
  let max = -1;
  try {
    for (const f of await fs.promises.readdir(dir)) {
      const m = /^(\d+)\.webm$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no folder */ }
  return max;
}

/** Mark closed. lastSeq = max(hint, highest chunk on disk). Idempotent. */
export async function closeSegment(dir, lastSeqHint = -1) {
  const lastSeq = Math.max(Number.isInteger(lastSeqHint) ? lastSeqHint : -1, await maxSeq(dir));
  return withLock(dir, async () => {
    const cur = await readSegment(dir);
    if (!cur || cur.closed) return cur;
    const next = { ...cur, closed: true, lastSeq, endedAt: new Date().toISOString() };
    await writeFileDurable(path.join(dir, 'segment.json'), JSON.stringify(next));
    return next;
  });
}

/**
 * Durably store one chunk (never overwrites: takes the next free seq).
 * @returns {Promise<{seq:number, sha256:string, bytes:number, moved:boolean}>}
 */
export function writeChunk(dir, seq, buffer, { capturedAt, durationMs, loggedOut }) {
  return withLock(dir, async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    let n = seq;
    while (await exists(chunkFile(dir, n))) n++;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    await writeFileDurable(chunkFile(dir, n), buffer); // chunk first: the bytes are what matters
    await writeFileDurable(chunkFile(dir, n, 'json'), JSON.stringify({
      capturedAt: capturedAt || new Date().toISOString(),
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
      loggedOut: !!loggedOut,
      sha256,
    }));
    return { seq: n, sha256, bytes: buffer.length, moved: n !== seq };
  });
}

/** Segment folders under the v2 root: [{ dir, userDir, segmentId }]. */
export async function listSegmentDirs(root) {
  const out = [];
  let users;
  try { users = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const u of users) {
    if (!u.isDirectory()) continue;
    let segs;
    try { segs = await fs.promises.readdir(path.join(root, u.name), { withFileTypes: true }); } catch { continue; }
    for (const s of segs) if (s.isDirectory()) out.push({ dir: path.join(root, u.name, s.name), userDir: u.name, segmentId: s.name });
  }
  return out;
}

/** At boot: close every segment left open by a crash/quit (nothing else is writing yet). */
export async function recoverOpenSegments(root) {
  let n = 0;
  for (const { dir } of await listSegmentDirs(root)) {
    const seg = await readSegment(dir);
    if (seg && !seg.closed) { await closeSegment(dir); n++; }
  }
  return n;
}

export function readRegisteredSessionSync(dir) {
  try { return fs.readFileSync(path.join(dir, 'registered'), 'utf8').trim() || null; } catch { return null; }
}
