// Run: node frontend/electron/spool-v2.check.mjs  (spool writes + v2 local retention)
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import crypto from 'crypto';
import * as spool from './spool-v2.js';
import { pruneV2Spool, V2_RETENTION_MS } from './local-retention.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-'));
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

/** Create a segment with chunks 0..n-1; optional .ok markers / closed state. */
async function mk(userId, id, { ageDays, n = 2, bytes = 10, synced = true, closed = true, closedOk = true }) {
  const started = Date.now() - ageDays * DAY;
  const dir = spool.segmentDir(root, userId, id);
  await spool.createSegment(dir, { segmentId: id, userId, recordingDate: iso(started).slice(0, 10), startedAt: iso(started), mime: 'video/webm', width: 1, height: 1, deviceId: 'd' });
  for (let i = 0; i < n; i++) {
    await spool.writeChunk(dir, i, Buffer.alloc(bytes, i), { capturedAt: iso(started), durationMs: 10000, loggedOut: false });
    if (synced) fs.writeFileSync(spool.chunkFile(dir, i) + '.ok', '');
  }
  if (closed) await spool.closeSegment(dir);
  if (closedOk) fs.writeFileSync(path.join(dir, 'closed.ok'), '');
  return dir;
}

// --- spool basics: sha, never overwrite, close, crash recovery ---
const d0 = spool.segmentDir(root, 'u1', 'seg-basic-01');
await spool.createSegment(d0, { segmentId: 'seg-basic-01', userId: 'u1', recordingDate: '2026-11-09', startedAt: iso(Date.now()) });
const buf = Buffer.from('hello');
const r0 = await spool.writeChunk(d0, 0, buf, { capturedAt: iso(Date.now()), durationMs: 10000, loggedOut: true });
assert.strictEqual(r0.seq, 0);
const meta0 = JSON.parse(fs.readFileSync(spool.chunkFile(d0, 0, 'json'), 'utf8'));
assert.strictEqual(meta0.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
assert.strictEqual(meta0.loggedOut, true);
const r1 = await spool.writeChunk(d0, 0, Buffer.from('other'), { loggedOut: false }); // seq taken -> next free
assert.strictEqual(r1.seq, 1);
assert.strictEqual(fs.readFileSync(spool.chunkFile(d0, 0), 'utf8'), 'hello');
const closed = await spool.closeSegment(d0, 5);
assert.strictEqual(closed.lastSeq, 5);
assert.ok(closed.closed && closed.endedAt);
assert.strictEqual((await spool.closeSegment(d0)).lastSeq, 5); // idempotent
const dOpen = spool.segmentDir(root, 'u1', 'seg-open-001');
await spool.createSegment(dOpen, { segmentId: 'seg-open-001', userId: 'u1', recordingDate: '2026-11-09', startedAt: iso(Date.now()) });
await spool.writeChunk(dOpen, 0, buf, {});
await spool.writeChunk(dOpen, 1, buf, {});
assert.strictEqual(await spool.recoverOpenSegments(root), 1);
assert.strictEqual((await spool.readSegment(dOpen)).lastSeq, 1);
fs.rmSync(path.join(root, 'u1'), { recursive: true, force: true });

// --- retention by age: only fully synced + closed + closed.ok + older than 15 days ---
const old = await mk('u2', 'seg-old-synced', { ageDays: 20 });
const oldUnsynced = await mk('u2', 'seg-old-unsynced', { ageDays: 20, synced: false });
const oldNoCloseOk = await mk('u2', 'seg-old-noclose', { ageDays: 20, closedOk: false });
const oldOpen = await mk('u2', 'seg-old-open', { ageDays: 20, closed: false, closedOk: false });
const fresh = await mk('u2', 'seg-fresh', { ageDays: 1 });
const noJson = path.join(root, 'u2', 'seg-nojson');
fs.mkdirSync(noJson);
fs.writeFileSync(path.join(noJson, '0.webm'), 'x');
let r = await pruneV2Spool(root, { capBytes: 1e12 });
assert.strictEqual(r.removedSegments, 1);
assert.ok(!fs.existsSync(old));
for (const d of [oldUnsynced, oldNoCloseOk, oldOpen, fresh, noJson]) assert.ok(fs.existsSync(d), `kept ${d}`);
assert.strictEqual(V2_RETENTION_MS, 15 * DAY);

// --- cap: oldest fully synced first, never unsynced ---
fs.rmSync(path.join(root, 'u2'), { recursive: true, force: true });
const a = await mk('u3', 'seg-cap-a', { ageDays: 5, bytes: 1000 });
const b = await mk('u3', 'seg-cap-b', { ageDays: 4, bytes: 1000 });
const c = await mk('u3', 'seg-cap-c', { ageDays: 3, bytes: 1000, synced: false });
const e = await mk('u3', 'seg-cap-d', { ageDays: 2, bytes: 1000 });
r = await pruneV2Spool(root, { capBytes: 5000 }); // ~8 KB + metadata on disk, cap 5 KB
assert.ok(!fs.existsSync(a), 'oldest synced removed first');
assert.ok(fs.existsSync(c), 'unsynced kept even though over the cap');
assert.ok(r.removedSegments >= 1);
await pruneV2Spool(root, { capBytes: 1 }); // everything synced goes, unsynced stays
assert.ok(!fs.existsSync(b) && !fs.existsSync(e) && fs.existsSync(c));

fs.rmSync(root, { recursive: true, force: true });
console.log('spool-v2 check passed');
