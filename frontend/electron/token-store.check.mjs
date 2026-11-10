// Run: node frontend/electron/token-store.check.mjs   (edge cases A7, A11)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { check, assert, need, needFn, finish } from './check-harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokstore-'));
const f = (n) => path.join(dir, n);
const good1 = { tokens: { u1: 'tok-1' }, policies: { u1: { record: true, recordingDay: { boundaryMinutes: 690, shiftStartMinutes: 540 } } } };
const good2 = { tokens: { u1: 'tok-1', u2: 'tok-2' }, policies: {} };

// Wished API (new dependency-free frontend/electron/token-store.js, wired into ws-client.js):
//   loadStore(file) -> { data: object|null, from: 'main'|'bak'|null }
//   saveStore(file, data) -> sync; atomic (write <file>.tmp then rename); the previous VALID main is kept as <file>.bak;
//                           a main that failed to parse is never copied over the .bak
//   mergeConnected(prevPolicy, msg) -> new policy { record, recordingDay }
const M = './token-store.js';
const fns = async (...names) => { const m = await need(M); return names.map((n) => needFn(m, n, M)); };

await check('A7 corrupt main + valid .bak -> loadStore returns the .bak data', async () => {
  const [loadStore] = await fns('loadStore');
  fs.writeFileSync(f('a.json'), '\u0000\u0000{{not json');
  fs.writeFileSync(f('a.json.bak'), JSON.stringify(good1));
  const r = loadStore(f('a.json'));
  assert.deepStrictEqual(r.data, good1);
  assert.strictEqual(r.from, 'bak');
});

await check('A7 saving after a failed parse never destroys (or poisons) the .bak', async () => {
  const [loadStore, saveStore] = await fns('loadStore', 'saveStore');
  fs.writeFileSync(f('b.json'), 'garbage');
  fs.writeFileSync(f('b.json.bak'), JSON.stringify(good1));
  loadStore(f('b.json'));
  saveStore(f('b.json'), good2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f('b.json'), 'utf8')), good2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f('b.json.bak'), 'utf8')), good1, '.bak must still hold the last valid data, not the garbage');
});

await check('A7 both files corrupt or missing -> { data: null } and nothing throws', async () => {
  const [loadStore] = await fns('loadStore');
  assert.strictEqual(loadStore(f('missing.json')).data, null);
  fs.writeFileSync(f('c.json'), 'x'); fs.writeFileSync(f('c.json.bak'), 'y');
  assert.strictEqual(loadStore(f('c.json')).data, null);
});

await check('A7 normal save keeps the previous valid main as .bak and leaves no .tmp', async () => {
  const [loadStore, saveStore] = await fns('loadStore', 'saveStore');
  saveStore(f('d.json'), good1);
  saveStore(f('d.json'), good2);
  assert.deepStrictEqual(loadStore(f('d.json')).data, good2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f('d.json.bak'), 'utf8')), good1);
  assert.ok(!fs.existsSync(f('d.json.tmp')), 'tmp file left behind');
});

await check('A7 atomic: a save that cannot complete (tmp blocked) leaves the main file intact', async () => {
  const [loadStore, saveStore] = await fns('loadStore', 'saveStore');
  saveStore(f('e.json'), good1);
  fs.mkdirSync(f('e.json.tmp')); // writing the tmp file fails
  assert.throws(() => saveStore(f('e.json'), good2));
  assert.deepStrictEqual(loadStore(f('e.json')).data, good1, 'main file was damaged by an interrupted save');
});

await check('A7 a stale half-written .tmp from a crash does not break load or the next save', async () => {
  const [loadStore, saveStore] = await fns('loadStore', 'saveStore');
  saveStore(f('g.json'), good1);
  fs.writeFileSync(f('g.json.tmp'), '{"tokens":{"u1":"tr'); // crash mid-write
  assert.deepStrictEqual(loadStore(f('g.json')).data, good1);
  saveStore(f('g.json'), good2);
  assert.deepStrictEqual(loadStore(f('g.json')).data, good2);
});

await check('A11 mergeConnected keeps the previous recordingDay rule when CONNECTED omits it', async () => {
  const [mergeConnected] = await fns('mergeConnected');
  const prev = { record: true, recordingDay: { boundaryMinutes: 690, shiftStartMinutes: 540 } };
  const next = mergeConnected(prev, { type: 'CONNECTED', protocol: 2, userId: 'u1', record: false, serverTime: Date.now() });
  assert.deepStrictEqual(next.recordingDay, prev.recordingDay);
  assert.strictEqual(next.record, false, 'record flag must still follow the new message');
});

await check('A11 mergeConnected replaces the rule when present; no previous + no rule -> null', async () => {
  const [mergeConnected] = await fns('mergeConnected');
  const rule = { boundaryMinutes: 600, shiftStartMinutes: 480 };
  assert.deepStrictEqual(mergeConnected({ record: true, recordingDay: { boundaryMinutes: 690 } }, { record: true, recordingDay: rule }).recordingDay, rule);
  assert.strictEqual(mergeConnected(undefined, { record: true }).recordingDay, null);
});

fs.rmSync(dir, { recursive: true, force: true });
finish('token-store');
