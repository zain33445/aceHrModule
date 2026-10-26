/**
 * local-retention.js — prunes recording artifacts kept on the client machine.
 *
 * The screen recorder spools each WebM chunk to
 * `<userData>/recordings/<sessionId>/chunk-*.webm` before uploading it. Those
 * files are only useful as an upload source, so they are kept for a week and
 * then removed. Call audio is never written to the client disk — each
 * participant uploads its chunks straight to the server.
 *
 * Kept dependency-free (fs/path only) so it can be exercised without Electron.
 */

import fs from 'fs';
import path from 'path';

/** Local files older than this are deleted. */
export const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the sweep runs while the agent is up. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delete files under `root` whose mtime is older than the retention window,
 * then remove any session directory left empty.
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
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (skipSessionId && entry.name === skipSessionId) continue; // still recording

      let children = [];
      try {
        children = await fs.promises.readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      let remaining = 0;
      for (const child of children) {
        if (!child.isFile()) {
          remaining += 1;
          continue;
        }
        const filePath = path.join(entryPath, child.name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.promises.unlink(filePath);
            result.removedFiles += 1;
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
    } else if (entry.isFile()) {
      const filePath = path.join(root, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
          result.removedFiles += 1;
        }
      } catch {
        /* leave it for the next sweep */
      }
    }
  }

  return result;
}
