// Run: node frontend/electron/sync-v2.check.mjs   (edge cases A3, A4, A5, A6, A8, A13, A15-A19)
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
  req.on('end', async () => {
    const body = Buffer.concat(parts);
    const entry = { method: req.method, path: req.url.split('?')[0], headers: req.headers, body };
    reqLog.push(entry);
    const m = /\/segments\/([^/]+)(?:\/(chunks\/(\d+)|close))?$/.exec(entry.path);
    entry.segmentId = m?.[1]; entry.kind = m?.[2] ? (m[3] !== undefined ? 'chunk' : 'close') : 'register'; entry.seq = m?.[3] !== undefined ? Number(m[3]) : undefined;
    const r = (await handler(entry)) ?? { status: 200, body: '{"ok":true}' };
    if (r.destroy) return req.socket.destroy(); // network error (status 0 for the agent)
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

async function run(tokens, root, { warns = [], refresh = async () => { }, keepLog = false } = {}) {
  if (!keepLog) reqLog.length = 0;
  const m = await need(M);
  const init = needFn(m, 'initSyncV2', M);
  const syncPass = needFn(m, 'syncPass', M);
  const log = { info() { }, warn: (s) => warns.push(String(s)), error: (s) => warns.push(String(s)) };
  init({ root, tokenFor: async (u) => tokens[u] ?? null, refresh, request, log });
  await Promise.race([syncPass(), new Promise((_, rej) => setTimeout(() => rej(new Error('syncPass did not finish within 5 s (sleeping/backing off?)')), 5000))]);
  return m;
}
const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sync-v2-'));
const ok = (dir, seq) => fs.existsSync(`${spool.chunkFile(dir, seq)}.ok`);
const pass = (tokens, root, opts) => run(tokens, root, { ...opts, keepLog: true });
const isParked = (m, dir) => needFn(m, 'getParked', M)().some((d) => path.resolve(d) === path.resolve(dir));
async function withClock(offsetMs, fn) { // shift Date.now() only: park timers are checked against it
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}
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

// ---- A15: one failing segment must not block the others ------------------------------------------
await check('A15 chunk 500 three times in a row parks THAT segment for 5 min; the other segment keeps uploading', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'chunk' && e.segmentId === 'seg-a15-bad' ? { status: 500, body: '{"error":"boom"}' } : okRegister(e));
  const bad = await mkSegment(root, 'u1', 'seg-a15-bad', { startedAgoMs: 90 * MIN });
  const good = await mkSegment(root, 'u1', 'seg-a15-good', { startedAgoMs: 30 * MIN });
  const m = await run({ u1: 'tok1' }, root);
  await pass({ u1: 'tok1' }, root);
  assert.ok(!isParked(m, bad), 'two failures are not enough to park');
  await pass({ u1: 'tok1' }, root);
  assert.ok(isParked(m, bad), 'third 500 in a row must park the segment');
  assert.ok(!isParked(m, good) && ok(good, 0) && fs.existsSync(path.join(good, 'closed.ok')), 'the healthy segment must be uploaded and closed');
  const before = idCount('seg-a15-bad');
  await pass({ u1: 'tok1' }, root);
  assert.strictEqual(idCount('seg-a15-bad'), before, 'a parked segment must not be requested');
  await withClock(4 * MIN, async () => { await pass({ u1: 'tok1' }, root); });
  assert.strictEqual(idCount('seg-a15-bad'), before, 'still parked after 4 min');
  await withClock(6 * MIN, async () => { await pass({ u1: 'tok1' }, root); });
  assert.ok(idCount('seg-a15-bad') > before, 'retried after the 5 min park');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A15 404 that is not segment_not_registered counts like a 500; segment_not_registered never parks (re-registers)', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'chunk' && e.segmentId === 'seg-a15-404' ? { status: 404, body: '{"error":"not_found"}' } : okRegister(e));
  const bad = await mkSegment(root, 'u1', 'seg-a15-404', { startedAgoMs: 90 * MIN });
  const m = await run({ u1: 'tok1' }, root);
  await pass({ u1: 'tok1' }, root); await pass({ u1: 'tok1' }, root);
  assert.ok(isParked(m, bad), 'three plain 404s must park the segment');
  const root2 = newRoot();
  handler = (e) => (e.kind === 'chunk' ? { status: 404, body: '{"error":"segment_not_registered"}' } : okRegister(e));
  const reg = await mkSegment(root2, 'u1', 'seg-a15-reg', { startedAgoMs: 90 * MIN });
  await run({ u1: 'tok1' }, root2);
  for (let i = 0; i < 4; i++) await pass({ u1: 'tok1' }, root2);
  assert.ok(!isParked(m, reg), 'segment_not_registered is the re-register path, never a park');
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(root2, { recursive: true, force: true });
});

await check('A15 register 500 x3 and close 500 x3 park the segment too', async () => {
  const root = newRoot();
  handler = (e) => (e.segmentId === 'seg-a15-reg500' && e.kind === 'register' ? { status: 500, body: '{}' } : e.segmentId === 'seg-a15-close500' && e.kind === 'close' ? { status: 500, body: '{}' } : okRegister(e));
  const a = await mkSegment(root, 'u1', 'seg-a15-reg500', { startedAgoMs: 90 * MIN });
  const b = await mkSegment(root, 'u1', 'seg-a15-close500', { startedAgoMs: 60 * MIN });
  const c = await mkSegment(root, 'u1', 'seg-a15-fine', { startedAgoMs: 30 * MIN });
  const m = await run({ u1: 'tok1' }, root);
  await pass({ u1: 'tok1' }, root); await pass({ u1: 'tok1' }, root);
  assert.ok(isParked(m, a), 'register 500 x3 must park');
  assert.ok(isParked(m, b), 'close 500 x3 must park');
  assert.ok(fs.existsSync(path.join(c, 'closed.ok')), 'the fine segment is closed');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A15 server-wide trouble (network, 408, 429, 502/503/504, 520-530) never parks a segment: the lane just backs off', async () => {
  const root = newRoot();
  const m = await need(M);
  for (const status of [0, 408, 429, 502, 503, 504, 520, 524, 530]) {
    handler = (e) => (e.kind === 'chunk' ? (status === 0 ? { destroy: true } : { status, body: '{}' }) : okRegister(e));
    const dir = await mkSegment(root, 'u1', `seg-a15-sw-${status}`, { startedAgoMs: 30 * MIN });
    await run({ u1: 'tok1' }, root);
    for (let i = 0; i < 4; i++) await pass({ u1: 'tok1' }, root);
    assert.ok(!isParked(m, dir), `status ${status} x5 must not park the segment`);
    assert.ok(reqLog.some((r) => r.segmentId === `seg-a15-sw-${status}` && r.kind === 'chunk'), `precondition: chunks were sent (status ${status})`);
    fs.rmSync(dir, { recursive: true, force: true }); // next status gets a clean lane
  }
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A15 a success resets the streak: 500, 500, ok, then 500, 500 does not park', async () => {
  const root = newRoot();
  let n = 0;
  handler = (e) => {
    if (e.kind !== 'chunk') return okRegister(e);
    n++;
    return n === 3 ? undefined : { status: 500, body: '{}' };
  };
  const dir = await mkSegment(root, 'u1', 'seg-a15-streak', { startedAgoMs: 30 * MIN });
  const m = await run({ u1: 'tok1' }, root);
  await pass({ u1: 'tok1' }, root); await pass({ u1: 'tok1' }, root); // 500, 500, then the 3rd request (n=3) succeeds
  assert.ok(ok(dir, 0), 'precondition: third attempt uploaded the chunk');
  await spool.writeChunk(dir, 1, Buffer.from('more'), { capturedAt: isoAgo(1000), durationMs: 10000, loggedOut: false });
  await pass({ u1: 'tok1' }, root); await pass({ u1: 'tok1' }, root); // 500, 500
  assert.ok(!isParked(m, dir), 'two new failures after a success must not park');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A15 400 on close parks the segment for 30 min', async () => {
  const root = newRoot();
  handler = (e) => (e.kind === 'close' && e.segmentId === 'seg-a15-c400' ? { status: 400, body: '{"error":"bad_request"}' } : okRegister(e));
  const dir = await mkSegment(root, 'u1', 'seg-a15-c400', { startedAgoMs: 30 * MIN });
  const m = await run({ u1: 'tok1' }, root);
  assert.ok(isParked(m, dir), 'close 400 must park at once');
  assert.ok(!fs.existsSync(path.join(dir, 'closed.ok')));
  const before = idCount('seg-a15-c400');
  await withClock(29 * MIN, async () => { await pass({ u1: 'tok1' }, root); });
  assert.strictEqual(idCount('seg-a15-c400'), before, 'still parked after 29 min');
  await withClock(31 * MIN, async () => { await pass({ u1: 'tok1' }, root); });
  assert.ok(idCount('seg-a15-c400') > before, 'retried after 30 min');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A16: 401 -------------------------------------------------------------------------------------
await check('A16 401 and the token is still the same after refresh: parked (reason auth), other users continue, resumes on a DIFFERENT token', async () => {
  const root = newRoot();
  handler = (e) => (e.headers.authorization === 'Bearer old' ? { status: 401, body: '{"error":"expired"}' } : okRegister(e));
  const stale = await mkSegment(root, 'userOld', 'seg-a16-stale', { startedAgoMs: 90 * MIN });
  const other = await mkSegment(root, 'userNew', 'seg-a16-other', { startedAgoMs: 30 * MIN });
  const tokens = { userOld: 'old', userNew: 'fine' };
  const refreshed = [];
  const refresh = async (u) => { refreshed.push(u); };
  const m = await run(tokens, root, { refresh });
  assert.deepStrictEqual(refreshed, ['userOld'], 'refresh(userId) is called for the owner of the segment');
  assert.ok(isParked(m, stale), 'refresh did not change the token: the segment must be parked');
  assert.ok(ok(other, 0) && fs.existsSync(path.join(other, 'closed.ok')), 'the other user\'s segment is not blocked');
  const n = idCount('seg-a16-stale');
  await pass(tokens, root, { refresh }); await pass(tokens, root, { refresh });
  assert.strictEqual(idCount('seg-a16-stale'), n, 'no request (and no refresh storm) while the token stays the same');
  assert.strictEqual(refreshed.length, 1, 'refresh is not called again for a parked segment');
  tokens.userOld = 'brand-new';
  await pass(tokens, root, { refresh });
  assert.ok(ok(stale, 0) && fs.existsSync(path.join(stale, 'closed.ok')), 'a different token releases the park at the next scan');
  assert.ok(!isParked(m, stale));
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A16 401 and the refresh produced a new token: not parked, next attempt uses the new token', async () => {
  const root = newRoot();
  handler = (e) => (e.headers.authorization === 'Bearer old' ? { status: 401, body: '{}' } : okRegister(e));
  const dir = await mkSegment(root, 'u1', 'seg-a16-refresh', { startedAgoMs: 30 * MIN });
  const tokens = { u1: 'old' };
  const refresh = async (u) => { tokens[u] = 'fresh'; };
  const m = await run(tokens, root, { refresh });
  assert.ok(!isParked(m, dir), 'a successful refresh must not park');
  await pass(tokens, root, { refresh });
  assert.ok(ok(dir, 0) && fs.existsSync(path.join(dir, 'closed.ok')), 'uploaded with the new token');
  assert.ok(reqLog.some((r) => r.headers.authorization === 'Bearer fresh'));
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A16 an auth park is not forever: after 30 min the segment is tried again', async () => {
  const root = newRoot();
  handler = (e) => (e.headers.authorization === 'Bearer old' ? { status: 401, body: '{}' } : okRegister(e));
  const dir = await mkSegment(root, 'u1', 'seg-a16-retry', { startedAgoMs: 30 * MIN });
  const m = await run({ u1: 'old' }, root);
  assert.ok(isParked(m, dir));
  const n = idCount('seg-a16-retry');
  await withClock(31 * MIN, async () => { await pass({ u1: 'old' }, root); });
  assert.ok(idCount('seg-a16-retry') > n, 'periodic retry (a failed refresh must not strand the segment for good)');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A17: close race --------------------------------------------------------------------------------
await check('A17 a chunk stored while the segment is uploading is never closed over: no close, no closed.ok, next pass uploads it and closes with the new lastSeq', async () => {
  const root = newRoot();
  let injected = false;
  let dir;
  handler = async (e) => {
    if (e.kind === 'chunk' && e.segmentId === 'seg-a17-pre' && !injected) {
      injected = true;
      await spool.writeChunk(dir, 1, Buffer.from('late'), { capturedAt: isoAgo(1000), durationMs: 10000, loggedOut: false });
    }
    return okRegister(e);
  };
  dir = await mkSegment(root, 'u1', 'seg-a17-pre', { chunks: ['first'] });
  await run({ u1: 'tok1' }, root);
  assert.ok(injected, 'precondition: the late chunk was injected during the upload');
  assert.ok(!reqLog.some((r) => r.kind === 'close' && r.segmentId === 'seg-a17-pre'), 'close must not be sent while a chunk is unsent');
  assert.ok(!fs.existsSync(path.join(dir, 'closed.ok')), 'closed.ok must not exist with an unsent chunk');
  await pass({ u1: 'tok1' }, root);
  assert.ok(ok(dir, 1), 'the late chunk is uploaded');
  const close = reqLog.filter((r) => r.kind === 'close' && r.segmentId === 'seg-a17-pre');
  assert.strictEqual(close.length, 1);
  assert.strictEqual(JSON.parse(close[0].body.toString()).lastSeq, 1, 'close carries the raised lastSeq');
  assert.ok(fs.existsSync(path.join(dir, 'closed.ok')));
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A17 a chunk stored while the close request is in flight: closed.ok is NOT written, the chunk goes out next pass and the close is repeated', async () => {
  const root = newRoot();
  let injected = false;
  let dir;
  handler = async (e) => {
    if (e.kind === 'close' && e.segmentId === 'seg-a17-in' && !injected) {
      injected = true;
      await spool.writeChunk(dir, 1, Buffer.from('late'), { capturedAt: isoAgo(1000), durationMs: 10000, loggedOut: false });
    }
    return okRegister(e);
  };
  dir = await mkSegment(root, 'u1', 'seg-a17-in', { chunks: ['first'] });
  await run({ u1: 'tok1' }, root);
  assert.ok(injected, 'precondition');
  assert.ok(!fs.existsSync(path.join(dir, 'closed.ok')), 'closed.ok must not be written while a chunk is unsent');
  await pass({ u1: 'tok1' }, root);
  assert.ok(ok(dir, 1), 'late chunk uploaded');
  assert.strictEqual(reqLog.filter((r) => r.kind === 'close' && r.segmentId === 'seg-a17-in').length, 2, 'close is sent again with the new lastSeq');
  assert.ok(fs.existsSync(path.join(dir, 'closed.ok')));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A18: boot pass ---------------------------------------------------------------------------------
await check('A18 at start a closed.ok folder that holds an unsent chunk loses closed.ok (logged) and is uploaded; a fully synced one is left alone', async () => {
  const root = newRoot();
  handler = okRegister;
  const bad = await mkSegment(root, 'u1', 'seg-a18-bad', { chunks: ['x', 'y'], startedAgoMs: 90 * MIN });
  fs.writeFileSync(`${spool.chunkFile(bad, 0)}.ok`, ''); // 0 synced, 1 never uploaded
  fs.writeFileSync(path.join(bad, 'closed.ok'), '');     // the old race wrote this
  const good = await mkSegment(root, 'u1', 'seg-a18-good', { chunks: ['z'], startedAgoMs: 60 * MIN });
  fs.writeFileSync(`${spool.chunkFile(good, 0)}.ok`, '');
  fs.writeFileSync(path.join(good, 'closed.ok'), '');
  const warns = [];
  await run({ u1: 'tok1' }, root, { warns });
  assert.ok(warns.some((w) => /seg-a18-bad/.test(w) && /closed\.ok/.test(w)), `the repair must be logged, got ${JSON.stringify(warns)}`);
  assert.ok(ok(bad, 1), 'the unsent chunk must be uploaded');
  assert.ok(reqLog.some((r) => r.kind === 'close' && r.segmentId === 'seg-a18-bad'), 'and the segment closed again');
  assert.strictEqual(idCount('seg-a18-good'), 0, 'a fully synced closed segment costs no request');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- A19: A13 cleanup guard --------------------------------------------------------------------------
await check('A19 an empty closed segment with a .webm.tmp (write in progress) is not removed', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'u1', 'seg-a19-tmp', { chunks: [], closed: true });
  fs.writeFileSync(`${spool.chunkFile(dir, 0)}.tmp`, 'half-written');
  await run({ u1: 'tok1' }, root);
  assert.ok(fs.existsSync(dir), 'folder with a .webm.tmp must stay');
  assert.ok(fs.existsSync(`${spool.chunkFile(dir, 0)}.tmp`), 'the .tmp file must stay');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('A19 an empty closed segment is not removed while a chunk write is pending (writeChunkReliable holding bytes)', async () => {
  const root = newRoot();
  handler = okRegister;
  const dir = await mkSegment(root, 'u1', 'seg-a19-pending', { chunks: [], closed: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  const writing = spool.writeChunkReliable(dir, 0, Buffer.from('held'), { capturedAt: isoAgo(1000), durationMs: 10000, loggedOut: false },
    { write: async (d, s, b, mt) => { await gate; return spool.writeChunk(d, s, b, mt); } });
  await run({ u1: 'tok1' }, root);
  assert.ok(fs.existsSync(path.join(dir, 'segment.json')), 'folder must survive while bytes wait to be written');
  release(); await writing;
  assert.ok(fs.existsSync(spool.chunkFile(dir, 0)), 'the held chunk landed in its folder');
  fs.rmSync(root, { recursive: true, force: true });
});

server.close();
finish('sync-v2');
