// Run: node frontend/electron/sync-v2.check.mjs   (edge cases A3, A4, A5, A6, A8, A13)
// Runs the REAL sync worker against a fake HTTP server (node http) with real files in temp dirs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { check, assert, need, needFn, finish } from './check-harness.mjs';
import * as spool from './spool-v2.js';

// Wished seams in sync-v2.js (GREEN implements them):
//   * no top-level `import 'electron'` / logger (plain node must be able to import it); `net` is only needed
//     by the default request implementation and must be loaded lazily.
//   * initSyncV2({ root, tokenFor(userId), refresh(), request(opts) -> Promise<{status, body:string}>,
//                  log: { info, warn, error } })
//       request opts = { method, url, headers, body: Buffer|string|undefined }; status 0 = network error.
//   * syncPass() -> Promise<void>: ONE pass over all segments (oldest first), each segment attempted at most once,
//       no sleeping/backoff, runs even if setSyncEnabled(true) was never called.
//       Outcomes: ok | retry (left for the next pass) | parked.
//   * getParked() -> string[] of segment dirs currently parked.
const M = './sync-v2.js';
const MIN = 60_000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

// ---- fake server ----------------------------------------------------------------------------
let handler = () => ({ status: 200, body: '{"ok":true}' });
const reqLog = [];
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts);
    const entry = { method: req.method, path: req.url.split('?')[0], headers: req.headers, body };
    reqLog.push(entry);
    const m = /\/segments\/([^/]+)(?:\/(chunks\/(\d+)|close))?$/.exec(entry.path);
    entry.segmentId = m?.[1]; entry.kind = m?.[2] ? (m[3] !== undefined ? 'chunk' : 'close') : 'register'; entry.seq = m?.[3] !== undefined ? Number(m[3]) : undefined;
    const r = handler(entry) ?? { status: 200, body: '{"ok":true}' };
    res.writeHead(r.status, { 'Content-Type': r.type ?? 'application/json' });
    res.end(r.body ?? '');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const request = ({ method, url, headers, body }) => new Promise((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: '127.0.0.1', port, method, path: u.pathname, headers }, (res) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
  });
  req.on('error', () => resolve({ status: 0, body: '' }));
  if (body) req.write(body);
  req.end();
});
const okRegister = (e) => (e.kind === 'register' ? { status: 200, body: '{"ok":true,"sessionId":"sess-1"}' } : undefined);

// ---- helpers --------------------------------------------------------------------------------
async function mkSegment(root, userId, id, { startedAgoMs, chunks = ['aaa'], closed = true, chunkAgeMs = 120_000 } = {}) {
  const dir = spool.segmentDir(root, userId, id);
  await spool.createSegment(dir, { segmentId: id, userId, recordingDate: '2026-11-09', startedAt: isoAgo(startedAgoMs ?? 60 * MIN), mime: 'video/webm', width: 10, height: 10, deviceId: 'dev' });
  for (let i = 0; i < chunks.length; i++) {
    await spool.writeChunk(dir, i, Buffer.from(chunks[i]), { capturedAt: isoAgo(chunkAgeMs), durationMs: 10000, loggedOut: false });
  }
  if (closed) await spool.closeSegment(dir);
  return dir;
}

async function run(tokens, root, { warns = [] } = {}) {
  reqLog.length = 0;
  const m = await need(M);
  const init = needFn(m, 'initSyncV2', M);
  const syncPass = needFn(m, 'syncPass', M);
  const log = { info() { }, warn: (s) => warns.push(String(s)), error: (s) => warns.push(String(s)) };
  init({ root, tokenFor: async (u) => tokens[u] ?? null, refresh: async () => { }, request, log });
  await Promise.race([syncPass(), new Promise((_, rej) => setTimeout(() => rej(new Error('syncPass did not finish within 5 s (sleeping/backing off?)')), 5000))]);
  return m;
}
const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sync-v2-'));
const ok = (dir, seq) => fs.existsSync(`${spool.chunkFile(dir, seq)}.ok`);
const idCount = (id) => reqLog.filter((r) => r.segmentId === id).length;

// ---- A3 -------------------------------------------------------------------------------------
await check('A3 owner without a token is parked; the other user\'s segment still uploads; no cross-token request', async () => {
  const root = newRoot();
  handler = okRegister;
  const dirA = await mkSegment(root, 'userA', 'seg-a3-A', { startedAgoMs: 90 * MIN });
  const dirB = await mkSegment(root, 'userB', 'seg-a3-B', { startedAgoMs: 30 * MIN });
  const m = await run({ userB: 'tokB' }, root);
  assert.ok(ok(dirB, 0), 'userB chunk was not uploaded');
  assert.strictEqual(idCount('seg-a3-A'), 0, 'a request was made for userA\'s segment although userA has no token');
  assert.ok(!reqLog.some((r) => r.segmentId === 'seg-a3-A' && r.headers.authorization === 'Bearer tokB'), 'userA\'s segment must never be sent with userB\'s token');
  const getParked = needFn(m, 'getParked', M);
  assert.ok(getParked().some((d) => path.resolve(d) === path.resolve(dirA)), 'userA\'s segment must be parked');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A4 -------------------------------------------------------------------------------------
await check('A4 persistent 422 on a segment parks it and the newer segment uploads in the same run', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'chunk' && e.segmentId === 'seg-a4-old' ? { status: 422, body: '{"error":"unprocessable"}' } : okRegister(e));
  const dir1 = await mkSegment(root, 'u1', 'seg-a4-old', { startedAgoMs: 90 * MIN, chunks: ['a', 'b'] });
  const dir2 = await mkSegment(root, 'u1', 'seg-a4-new', { startedAgoMs: 30 * MIN, chunks: ['c', 'd'] });
  const m = await run({ u1: 'tok1' }, root);
  assert.ok(needFn(m, 'getParked', M)().some((d) => path.resolve(d) === path.resolve(dir1)), 'old segment must be parked after a persistent 422');
  assert.ok(ok(dir2, 0) && ok(dir2, 1), 'newer segment must be fully uploaded in the same run');
  assert.ok(fs.existsSync(path.join(dir2, 'closed.ok')), 'newer segment must be closed on the server');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A4 400 whose X-Chunk-Sha256 matches the file on disk parks the segment (no endless retry)', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'chunk' && e.segmentId === 'seg-a4b-old' ? { status: 400, body: '{"error":"bad_request"}' } : okRegister(e));
  const dir1 = await mkSegment(root, 'u1', 'seg-a4b-old', { startedAgoMs: 90 * MIN, chunks: ['payload'] });
  const dir2 = await mkSegment(root, 'u1', 'seg-a4b-new', { startedAgoMs: 30 * MIN, chunks: ['other'] });
  const m = await run({ u1: 'tok1' }, root);
  const sent = reqLog.find((r) => r.segmentId === 'seg-a4b-old' && r.kind === 'chunk');
  assert.strictEqual(sent.headers['x-chunk-sha256'], sha(Buffer.from('payload')), 'precondition: sha header matches the file');
  assert.ok(needFn(m, 'getParked', M)().some((d) => path.resolve(d) === path.resolve(dir1)), 'segment must be parked');
  assert.ok(ok(dir2, 0), 'newer segment must still upload');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A5 -------------------------------------------------------------------------------------
await check('A5 200 with an HTML body (captive portal) does not mark the chunk uploaded', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'chunk' ? { status: 200, type: 'text/html', body: '<html><body>Please log in to the wifi</body></html>' } : okRegister(e));
  const dir = await mkSegment(root, 'u1', 'seg-a5', { chunks: ['x'], closed: false });
  await run({ u1: 'tok1' }, root);
  assert.ok(reqLog.some((r) => r.kind === 'chunk'), 'precondition: the chunk was sent');
  assert.ok(!ok(dir, 0), '0.webm.ok must not be written for a non-JSON 2xx');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A5 200 with JSON {ok:true} still marks the chunk uploaded (control)', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'u1', 'seg-a5-ctl', { chunks: ['x'], closed: false });
  await run({ u1: 'tok1' }, root);
  assert.ok(ok(dir, 0));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A6 -------------------------------------------------------------------------------------
await check('A6 corrupt segment.json: segment is rebuilt from folder/userDir, registered, uploaded, warning reported', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'userC', 'seg-a6-corrupt', { chunks: ['abc'], closed: false });
  fs.writeFileSync(path.join(dir, 'segment.json'), Buffer.from([0, 255, 254, 123, 123, 0, 7]));
  const warns = [];
  await run({ userC: 'tokC' }, root, { warns });
  const reg = reqLog.find((r) => r.kind === 'register');
  assert.ok(reg, 'segment with corrupt segment.json was never registered');
  assert.strictEqual(reg.segmentId, 'seg-a6-corrupt', 'segmentId must come from the folder name');
  assert.strictEqual(reg.headers.authorization, 'Bearer tokC', 'userId must come from the parent folder');
  const body = JSON.parse(reg.body.toString('utf8'));
  assert.ok(Number.isFinite(Date.parse(body.startedAt)), 'rebuilt startedAt must be a valid ISO date');
  assert.ok(ok(dir, 0), 'chunk must be uploaded');
  assert.ok(warns.some((w) => /segment\.json/i.test(w)), `a warning mentioning segment.json is required, got: ${JSON.stringify(warns)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A8 -------------------------------------------------------------------------------------
async function mkNoMeta(root, id, ageMs) {
  const dir = await mkSegment(root, 'u1', id, { chunks: [], closed: false });
  const f = spool.chunkFile(dir, 0);
  fs.writeFileSync(f, 'raw-chunk-bytes'); // the .webm landed, its <seq>.json has not (yet)
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return dir;
}

await check('A8 fresh (<30 s) chunk without <seq>.json is not uploaded this pass', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkNoMeta(root, 'seg-a8-fresh', 5_000);
  await run({ u1: 'tok1' }, root);
  assert.ok(!reqLog.some((r) => r.kind === 'chunk'), 'a chunk younger than 30 s without metadata must be skipped');
  assert.ok(!ok(dir, 0));
  assert.ok(!fs.existsSync(spool.chunkFile(dir, 0, 'json')), 'no fake metadata may be written for a fresh chunk');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A8 old (>30 s) chunk without <seq>.json is uploaded with rebuilt metadata that never claims loggedOut:false', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkNoMeta(root, 'seg-a8-old', 90_000);
  await run({ u1: 'tok1' }, root);
  const sent = reqLog.find((r) => r.kind === 'chunk');
  assert.ok(sent, 'old chunk without metadata must be uploaded');
  assert.strictEqual(sent.headers['x-chunk-sha256'], sha(Buffer.from('raw-chunk-bytes')));
  assert.ok(!('x-logged-out' in sent.headers), `X-Logged-Out must be omitted for unknown state, got ${sent.headers['x-logged-out']}`);
  const meta = JSON.parse(fs.readFileSync(spool.chunkFile(dir, 0, 'json'), 'utf8'));
  assert.notStrictEqual(meta.loggedOut, false, 'rebuilt metadata must not claim loggedOut:false');
  assert.ok(meta.loggedOut === null || meta.loggedOut === undefined, 'loggedOut must be null/unknown');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A13 ------------------------------------------------------------------------------------
await check('A13 closed segment with zero chunks is never registered and its folder is removed', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'u1', 'seg-a13-empty', { chunks: [], closed: true });
  assert.strictEqual((await spool.readSegment(dir)).lastSeq, -1, 'precondition: lastSeq -1');
  await run({ u1: 'tok1' }, root);
  assert.strictEqual(idCount('seg-a13-empty'), 0, 'an empty segment must not be registered with the server');
  assert.ok(!fs.existsSync(dir), 'empty segment folder must be removed');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A13 an empty segment that is still OPEN is left alone (it may still receive chunks)', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'u1', 'seg-a13-open', { chunks: [], closed: false });
  await run({ u1: 'tok1' }, root);
  assert.ok(fs.existsSync(dir), 'open empty segment must not be deleted');
  assert.strictEqual(idCount('seg-a13-open'), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

server.close();
finish('sync-v2');
