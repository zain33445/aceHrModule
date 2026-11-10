// Run: node frontend/electron/spool-reliability.check.mjs   (edge cases A1, A2)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { check, assert, needFn, finish } from './check-harness.mjs';
import * as spool from './spool-v2.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-rel-'));
const meta = { capturedAt: new Date().toISOString(), durationMs: 10000, loggedOut: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkSeg = async (user, id) => {
  const dir = spool.segmentDir(root, user, id);
  await spool.createSegment(dir, { segmentId: id, userId: user, recordingDate: '2026-11-09', startedAt: new Date().toISOString() });
  return dir;
};

// Wished API (spool-v2.js):
//   writeChunkReliable(dir, seq, buf, meta, { retryMs, onDiskLow, onError, write }) -> Promise<{seq,...}>
//     keeps the bytes in memory and retries writeChunk (injectable via `write`) until it succeeds.
//   pendingBytes() -> number of bytes currently held for retry.
await check('A1 write fails (blocked tmp path) -> bytes retained and retried until success', async () => {
  const writeChunkReliable = needFn(spool, 'writeChunkReliable', './spool-v2.js');
  const dir = await mkSeg('u1', 'seg-a1-block');
  const tmp = `${spool.chunkFile(dir, 0)}.tmp`;
  fs.mkdirSync(tmp); // open(tmp,'w') now fails with EISDIR/EPERM, like an AV lock
  const errors = [];
  const p = writeChunkReliable(dir, 0, Buffer.from('precious-bytes'), meta, { retryMs: 20, onError: (e) => errors.push(e) });
  await sleep(120);
  assert.ok(errors.length >= 1, 'onError was not called for a failing write');
  assert.ok(!fs.existsSync(spool.chunkFile(dir, 0)), 'chunk must not exist while the write is blocked');
  fs.rmdirSync(tmp); // lock released
  const r = await Promise.race([p, sleep(2000).then(() => 'timeout')]);
  assert.notStrictEqual(r, 'timeout', 'write was never retried after the obstacle disappeared');
  assert.strictEqual(fs.readFileSync(spool.chunkFile(dir, r.seq), 'utf8'), 'precious-bytes');
  assert.ok(fs.existsSync(spool.chunkFile(dir, r.seq, 'json')), '<seq>.json missing after retry');
});

await check('A1 ENOSPC is reported as disk_low via callback, bytes still kept and written later', async () => {
  const writeChunkReliable = needFn(spool, 'writeChunkReliable', './spool-v2.js');
  const dir = await mkSeg('u1', 'seg-a1-enospc');
  let calls = 0;
  const write = async (d, s, b, m) => {
    if (++calls <= 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return spool.writeChunk(d, s, b, m);
  };
  let lowCount = 0;
  const r = await writeChunkReliable(dir, 0, Buffer.from('abc'), meta, { retryMs: 10, write, onDiskLow: () => { lowCount++; } });
  assert.ok(lowCount >= 1, 'onDiskLow was not called for ENOSPC');
  assert.strictEqual(calls, 3);
  assert.strictEqual(fs.readFileSync(spool.chunkFile(dir, r.seq), 'utf8'), 'abc');
});

await check('A1 non-ENOSPC errors do not call onDiskLow; pendingBytes() counts held bytes and returns to 0', async () => {
  const writeChunkReliable = needFn(spool, 'writeChunkReliable', './spool-v2.js');
  const pendingBytes = needFn(spool, 'pendingBytes', './spool-v2.js');
  const dir = await mkSeg('u1', 'seg-a1-eperm');
  let calls = 0;
  const write = async (d, s, b, m) => {
    if (++calls === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return spool.writeChunk(d, s, b, m);
  };
  let low = 0;
  const p = writeChunkReliable(dir, 0, Buffer.alloc(1000, 1), meta, { retryMs: 10, write, onDiskLow: () => { low++; } });
  assert.strictEqual(pendingBytes(), 1000, 'bytes held for retry must be counted');
  await p;
  assert.strictEqual(low, 0, 'EPERM must not be reported as disk_low');
  assert.strictEqual(pendingBytes(), 0, 'pendingBytes must drop to 0 once written');
});

await check('A2 write after closeSegment raises segment.json lastSeq and removes closed.ok', async () => {
  const dir = await mkSeg('u2', 'seg-a2-late');
  await spool.writeChunk(dir, 0, Buffer.from('c0'), meta);
  await spool.writeChunk(dir, 1, Buffer.from('c1'), meta);
  const closed = await spool.closeSegment(dir);
  assert.strictEqual(closed.lastSeq, 1);
  fs.writeFileSync(path.join(dir, 'closed.ok'), ''); // server already acknowledged the close
  const r = await spool.writeChunk(dir, 2, Buffer.from('late'), meta);
  assert.strictEqual(r.seq, 2);
  const seg = await spool.readSegment(dir);
  assert.strictEqual(seg.lastSeq, 2, 'segment.json lastSeq not raised by a late chunk');
  assert.strictEqual(seg.closed, true, 'segment must stay closed');
  assert.ok(!fs.existsSync(path.join(dir, 'closed.ok')), 'closed.ok must be removed so the close is re-sent');
});

await check('A2 findSegmentDir(root, segmentId) locates an existing segment folder', async () => {
  const findSegmentDir = needFn(spool, 'findSegmentDir', './spool-v2.js');
  const dir = await mkSeg('some.user@x', 'seg-a2-find');
  assert.strictEqual(path.resolve(await findSegmentDir(root, 'seg-a2-find')), path.resolve(dir));
  assert.strictEqual(await findSegmentDir(root, 'does-not-exist'), null);
});

await check('A2 chunk for a segment not in memory is written into its own folder, never _orphan', async () => {
  const findSegmentDir = needFn(spool, 'findSegmentDir', './spool-v2.js');
  const dir = await mkSeg('u3', 'seg-a2-evicted');
  await spool.writeChunk(dir, 0, Buffer.from('c0'), meta);
  await spool.closeSegment(dir);
  // The caller only knows segmentId (its in-memory map forgot it): resolve the folder from disk.
  const target = (await findSegmentDir(root, 'seg-a2-evicted')) ?? spool.orphanDir(root, 'seg-a2-evicted');
  const r = await spool.writeChunk(target, 1, Buffer.from('c1'), meta);
  assert.strictEqual(path.resolve(target), path.resolve(dir));
  assert.ok(fs.existsSync(spool.chunkFile(dir, r.seq)));
  assert.ok(!fs.existsSync(spool.orphanDir(root, 'seg-a2-evicted')), '_orphan folder must not be created');
});

fs.rmSync(root, { recursive: true, force: true });
finish('spool-reliability');
