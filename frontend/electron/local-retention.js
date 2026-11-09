/**
 * local-retention.js — prunes recording artifacts kept on the client machine.
 *
 * The screen recorder spools each WebM chunk to
 * `<userData>/recordings/<sessionId>/chunk-*.webm` before uploading it. Once
 * the server confirms a chunk the recorder writes an empty `<chunk>.ok`
 * marker beside it. The chunks stay as a local backup for 15 days. A chunk is
 * deleted ONLY when it is older than the window AND has its `.ok` marker
 * (the marker goes with it). Chunks without a marker are unsynced and are
 * never deleted. Call audio is never written to the client disk.
 *
 * Kept dependency-free (fs/path only) so it can be exercised without Electron.
 */

import fs from 'fs';
import path from 'path';

/** Synced local chunks older than this are deleted. */
export const RECORDING_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

/** How often the sweep runs while the agent is up. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delete synced chunks (and their `.ok` markers) older than the retention
 * window, then remove any session directory left empty.
 *
 * @param {string} root
 * @param {{ maxAgeMs?: number, now?: number, skipSessionId?: string | null }} [opts]
 * @returns {Promise<{ removedFiles: number, removedDirs: number }>}
 */
export async function pruneOldRecordings(root, opts = {}) {
  const {
    maxAgeMs = RECORDING_RETENTION_MS,
    now = Date.now(),
    skipSessionId = null,
  } = opts;
  const cutoff = now - maxAgeMs;
  const result = { removedFiles: 0, removedDirs: 0 };

  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return result; // no recordings yet (or the folder is unreadable)
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // stray top-level files are never touched
    if (entry.name === 'v2') continue; // v2 spool has its own rules (pruneV2Spool)
    if (skipSessionId && entry.name === skipSessionId) continue; // still recording

    const entryPath = path.join(root, entry.name);
    let children;
    try {
      children = await fs.promises.readdir(entryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = new Set(children.filter((c) => c.isFile()).map((c) => c.name));
    let remaining = 0;
    for (const child of children) {
      const name = child.name;
      // Only a chunk that has its marker (= confirmed uploaded) is a candidate.
      // Markers are removed together with their chunk, never on their own.
      if (!child.isFile() || name.endsWith('.ok') || !names.has(`${name}.ok`)) {
        remaining += 1;
        continue;
      }
      const filePath = path.join(entryPath, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
          result.removedFiles += 1;
          try { await fs.promises.unlink(`${filePath}.ok`); } catch { /* marker already gone */ }
        } else {
          remaining += 1;
        }
      } catch {
        remaining += 1; // leave it for the next sweep
      }
    }

    if (remaining === 0) {
      try {
        await fs.promises.rmdir(entryPath);
        result.removedDirs += 1;
      } catch {
        /* not empty or already gone */
      }
    }
  }

  return result;
}

// ─── v2 spool (docs/recording-v2.md §8) ───────────────────────────────

/** A fully synced v2 segment older than this (by recordingDate) may be deleted. */
export const V2_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
/** v2 sweep cadence (also drives the legacy sweep). */
export const V2_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Over this much spool, oldest fully synced segments go first. */
export const V2_CAP_BYTES = 30 * 1024 * 1024 * 1024;

async function dirSize(dir) {
  let total = 0;
  try {
    for (const f of await fs.promises.readdir(dir)) {
      try { total += (await fs.promises.stat(path.join(dir, f))).size; } catch { /* vanished */ }
    }
  } catch { /* gone */ }
  return total;
}

/**
 * Delete v2 segment folders. A folder is deletable ONLY when segment.json says
 * closed, `closed.ok` exists, and every `<seq>.webm` has its `.ok` marker; then
 * either its recordingDate is older than the retention window or the spool is
 * over the cap (oldest first). Anything unsynced is never touched.
 *
 * @param {string} v2Root <userData>/recordings/v2
 * @param {{ maxAgeMs?: number, capBytes?: number, now?: number, skipSegmentIds?: Set<string> }} [opts]
 * @returns {Promise<{ removedSegments: number, removedBytes: number }>}
 */
export async function pruneV2Spool(v2Root, opts = {}) {
  const { maxAgeMs = V2_RETENTION_MS, capBytes = V2_CAP_BYTES, now = Date.now(), skipSegmentIds = new Set() } = opts;
  const result = { removedSegments: 0, removedBytes: 0 };
  const segs = []; // { dir, userDir, size, startedMs, dateMs, synced }
  let users;
  try { users = await fs.promises.readdir(v2Root, { withFileTypes: true }); } catch { return result; }

  let total = 0;
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const userDir = path.join(v2Root, u.name);
    let entries;
    try { entries = await fs.promises.readdir(userDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(userDir, e.name);
      const size = await dirSize(dir);
      total += size;
      if (skipSegmentIds.has(e.name)) continue;
      let seg = null;
      try { seg = JSON.parse(await fs.promises.readFile(path.join(dir, 'segment.json'), 'utf8')); } catch { continue; }
      if (!seg?.closed) continue;
      let names;
      try { names = new Set(await fs.promises.readdir(dir)); } catch { continue; }
      if (!names.has('closed.ok')) continue;
      let synced = true;
      for (const n of names) if (/^\d+\.webm$/.test(n) && !names.has(`${n}.ok`)) { synced = false; break; }
      if (!synced) continue;
      const startedMs = Date.parse(seg.startedAt) || 0;
      const dateMs = Date.parse(`${seg.recordingDate}T00:00:00Z`) || startedMs;
      segs.push({ dir, userDir, size, startedMs, dateMs });
    }
  }

  segs.sort((a, b) => a.startedMs - b.startedMs);
  const remove = async (s) => {
    try {
      await fs.promises.rm(s.dir, { recursive: true, force: true });
      result.removedSegments += 1;
      result.removedBytes += s.size;
      total -= s.size;
      s.gone = true;
      try { await fs.promises.rmdir(s.userDir); } catch { /* user folder not empty */ }
    } catch { /* leave for next sweep */ }
  };
  for (const s of segs) if (s.dateMs < now - maxAgeMs) await remove(s);
  for (const s of segs) {
    if (total <= capBytes) break;
    if (!s.gone) await remove(s);
  }
  return result;
}
