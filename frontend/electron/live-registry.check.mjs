// Run: node frontend/electron/live-registry.check.mjs   (edge case A10)
import { createRequire } from 'module';
import { check, assert, finish } from './check-harness.mjs';

// Wished API (new dependency-free frontend/electron/live-registry.cjs; the live renderer require()s it):
//   createRegistry({ onClosed(streamId) }) -> {
//     start(streamId, startFn) -> Promise   startFn() -> Promise<handle>, handle.close()
//     stop(streamId)                        closes a running stream; if start is still pending, remembers it
//     count() -> number of OPEN streams
//   }
const create = (opts) => {
  let m;
  try { m = createRequire(import.meta.url)('./live-registry.cjs'); } catch (err) {
    throw new Error(`module ./live-registry.cjs cannot be imported: ${err.code ?? ''} ${String(err.message).split('\n')[0]}`);
  }
  if (typeof m.createRegistry !== 'function') throw new Error('missing export createRegistry in ./live-registry.cjs');
  return m.createRegistry(opts);
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

await check('A10 stop() while start() is pending -> closed when start completes, reported closed, count 0', async () => {
  const closedIds = [];
  const reg = create({ onClosed: (id) => closedIds.push(id) });
  const d = deferred();
  let closes = 0;
  const started = reg.start('s1', () => d.promise);
  reg.stop('s1'); // LIVE_STOP arrives while the capture is starting
  d.resolve({ close: () => { closes++; } });
  await started;
  assert.strictEqual(closes, 1, 'the late stream leaked: close() was not called');
  assert.deepStrictEqual(closedIds, ['s1'], 'stream must be reported closed exactly once');
  assert.strictEqual(reg.count(), 0);
});

await check('A10 start() that fails after stop() -> no unhandled throw, reported closed, count 0', async () => {
  const closedIds = [];
  const reg = create({ onClosed: (id) => closedIds.push(id) });
  const d = deferred();
  const started = reg.start('s2', () => d.promise);
  reg.stop('s2');
  d.reject(new Error('capture denied'));
  await started.catch(() => { /* either settle style is fine */ });
  assert.deepStrictEqual(closedIds, ['s2']);
  assert.strictEqual(reg.count(), 0);
});

await check('A10 normal flow: start -> count 1; stop twice -> close() once, reported once, count 0', async () => {
  const closedIds = [];
  const reg = create({ onClosed: (id) => closedIds.push(id) });
  let closes = 0;
  await reg.start('s3', async () => ({ close: () => { closes++; } }));
  assert.strictEqual(reg.count(), 1);
  reg.stop('s3'); reg.stop('s3');
  assert.strictEqual(closes, 1);
  assert.deepStrictEqual(closedIds, ['s3']);
  assert.strictEqual(reg.count(), 0);
});

await check('A10 a stop() for an id neither pending nor open does not poison a later start of that id', async () => {
  const reg = create({ onClosed: () => { } });
  reg.stop('s4');
  let closes = 0;
  await reg.start('s4', async () => ({ close: () => { closes++; } }));
  assert.strictEqual(reg.count(), 1);
  assert.strictEqual(closes, 0);
});

finish('live-registry');
