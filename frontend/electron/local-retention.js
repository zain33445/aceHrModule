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
