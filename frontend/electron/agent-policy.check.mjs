// Run: node frontend/electron/agent-policy.check.mjs   (edge cases A9, A12, A14)
import { check, assert, need, needFn, finish } from './check-harness.mjs';

// Wished API (new dependency-free frontend/electron/agent-policy.js, used by ws-client.js / recorder-main.js):
//   decideRecording({ userId, tokens, policies }) -> { record: boolean, reason?: string }
//   clockOffset(serverTime /* ms or ISO */, localNowMs) -> serverMs - localMs (0 when unparsable)
//   serverNow(offsetMs, localNowMs = Date.now()) -> localNowMs + offsetMs
//   pickPrimarySource(sources, primaryDisplayId) -> source with display_id === String(primaryDisplayId), else sources[0], else null
const M = './agent-policy.js';
const allow = { record: true, recordingDay: { boundaryMinutes: 690, shiftStartMinutes: 540 } };
const fns = async (...names) => { const m = await need(M); return names.map((n) => needFn(m, n, M)); };

await check('A9 user with no cached token/policy -> do not record, with a reason (even if another user has both)', async () => {
  const [decideRecording] = await fns('decideRecording');
  const r = decideRecording({ userId: 'B', tokens: { A: 'tokA' }, policies: { A: allow } });
  assert.strictEqual(r.record, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'a reason is required');
});

await check('A9 token without a policy, or policy without a token -> do not record', async () => {
  const [decideRecording] = await fns('decideRecording');
  assert.strictEqual(decideRecording({ userId: 'B', tokens: { B: 't' }, policies: {} }).record, false);
  assert.strictEqual(decideRecording({ userId: 'B', tokens: {}, policies: { B: allow } }).record, false);
});

await check('A9 no user id at all -> do not record', async () => {
  const [decideRecording] = await fns('decideRecording');
  assert.strictEqual(decideRecording({ userId: null, tokens: { A: 't' }, policies: { A: allow } }).record, false);
});

await check('A9 token + policy.record=true -> record; policy.record=false -> do not record', async () => {
  const [decideRecording] = await fns('decideRecording');
  assert.strictEqual(decideRecording({ userId: 'A', tokens: { A: 't' }, policies: { A: allow } }).record, true);
  const off = decideRecording({ userId: 'A', tokens: { A: 't' }, policies: { A: { ...allow, record: false } } });
  assert.strictEqual(off.record, false);
  assert.ok(off.reason);
});

await check('A12 serverTime 2 h ahead of local -> offset +2 h and a new startedAt is server-corrected', async () => {
  const [clockOffset, serverNow] = await fns('clockOffset', 'serverNow');
  const local = Date.parse('2026-11-10T08:00:00.000Z');
  const offset = clockOffset(local + 2 * 3600e3, local);
  assert.strictEqual(offset, 2 * 3600e3);
  assert.strictEqual(new Date(serverNow(offset, local)).toISOString(), '2026-11-10T10:00:00.000Z');
  assert.strictEqual(clockOffset(new Date(local + 5000).toISOString(), local), 5000, 'ISO serverTime must be accepted');
});

await check('A12 unparsable serverTime -> offset 0 (local clock used unchanged)', async () => {
  const [clockOffset, serverNow] = await fns('clockOffset', 'serverNow');
  assert.strictEqual(clockOffset(undefined, 1000), 0);
  assert.strictEqual(clockOffset('nonsense', 1000), 0);
  assert.strictEqual(serverNow(0, 1234), 1234);
});

await check('A14 pickPrimarySource picks the source whose display_id is the primary display', async () => {
  const [pick] = await fns('pickPrimarySource');
  const sources = [{ id: 'screen:1:0', display_id: '111' }, { id: 'screen:2:0', display_id: '222' }, { id: 'screen:3:0', display_id: '333' }];
  assert.strictEqual(pick(sources, '222').id, 'screen:2:0');
  assert.strictEqual(pick(sources, 333).id, 'screen:3:0', 'numeric primary id must match string display_id');
});

await check('A14 pickPrimarySource falls back to sources[0]; empty list -> null', async () => {
  const [pick] = await fns('pickPrimarySource');
  const sources = [{ id: 'screen:1:0', display_id: '111' }, { id: 'screen:2:0', display_id: '' }];
  assert.strictEqual(pick(sources, '999').id, 'screen:1:0');
  assert.strictEqual(pick(sources, undefined).id, 'screen:1:0');
  assert.strictEqual(pick([], '1'), null);
});

await check('pinnedQuality: same day keeps pin; new day/other user takes server; unknown -> 720p', async () => {
  const [pq] = await fns('pinnedQuality');
  const a = pq(null, '2026-11-12', 'u1', '1080p');
  assert.strictEqual(a.quality, '1080p');
  const b = pq(a.pin, '2026-11-12', 'u1', '480p');
  assert.strictEqual(b.quality, '1080p');
  assert.strictEqual(pq(a.pin, '2026-11-13', 'u1', '480p').quality, '480p');
  assert.strictEqual(pq(a.pin, '2026-11-12', 'u2', '480p').quality, '480p');
  assert.strictEqual(pq(null, 'd', 'u1', undefined).quality, '720p');
  assert.strictEqual(pq(null, 'd', 'u1', '4k').quality, '720p');
});

const disp = (id, x, y = 0) => ({ id, bounds: { x, y, width: 1920, height: 1080 } });

await check('numberScreens: primary is Screen 1, others left-to-right (then top-to-bottom) as 2..N', async () => {
  const [numberScreens] = await fns('numberScreens');
  const r = numberScreens([disp(7, 0), disp(3, 1920), disp(9, -1920), disp(5, 1920, 1080)], 7);
  assert.deepStrictEqual(r, [
    { displayId: '7', screen: 1 }, { displayId: '9', screen: 2 }, { displayId: '3', screen: 3 }, { displayId: '5', screen: 4 },
  ]);
});

await check('numberScreens: string/number ids mix, primary on the right still Screen 1, single display', async () => {
  const [numberScreens] = await fns('numberScreens');
  assert.deepStrictEqual(numberScreens([disp('1', 0), disp(2, 1920)], 2), [{ displayId: '2', screen: 1 }, { displayId: '1', screen: 2 }]);
  assert.deepStrictEqual(numberScreens([disp(4, 0)], '4'), [{ displayId: '4', screen: 1 }]);
  assert.deepStrictEqual(numberScreens([], 1), []);
});

await check('sourceForDisplay: matching display_id, else primary source, else first, else null', async () => {
  const [sourceForDisplay] = await fns('sourceForDisplay');
  const src = [{ id: 'screen:0', display_id: '11' }, { id: 'screen:1', display_id: '22' }];
  assert.strictEqual(sourceForDisplay(src, 22, 11).id, 'screen:1');
  assert.strictEqual(sourceForDisplay(src, '99', 22).id, 'screen:1');
  assert.strictEqual(sourceForDisplay(src, null, 99).id, 'screen:0');
  assert.strictEqual(sourceForDisplay([], 1, 1), null);
});

await check('followStep: no switch before 10 s, switch at 10 s, then the new display is current', async () => {
  const [followStep] = await fns('followStep');
  let r = followStep(undefined, 'A', 0, 10_000);
  assert.strictEqual(r.switchTo, null);
  for (let t = 2000; t < 10_000; t += 2000) { r = followStep(r.state, 'B', t, 10_000); assert.strictEqual(r.switchTo, null, `t=${t}`); }
  r = followStep(r.state, 'B', 10_000, 10_000); // first poll on B was t=2000 -> 8 s: still no
  assert.strictEqual(r.switchTo, null);
  r = followStep(r.state, 'B', 12_000, 10_000);
  assert.strictEqual(r.switchTo, 'B');
  r = followStep(r.state, 'B', 14_000, 10_000);
  assert.strictEqual(r.switchTo, null);
  assert.strictEqual(r.state.current, 'B');
});

await check('followStep: exactly 10 s on the other display switches', async () => {
  const [followStep] = await fns('followStep');
  let r = followStep(undefined, 1, 0, 10_000);
  r = followStep(r.state, 2, 1000, 10_000);
  assert.strictEqual(followStep(r.state, '2', 10_999, 10_000).switchTo, null);
  assert.strictEqual(followStep(r.state, '2', 11_000, 10_000).switchTo, '2');
});

await check('followStep: returning to the current display resets the timer; flapping never switches', async () => {
  const [followStep] = await fns('followStep');
  let r = followStep(undefined, 'A', 0, 10_000);
  r = followStep(r.state, 'B', 2000, 10_000);
  r = followStep(r.state, 'B', 8000, 10_000);
  r = followStep(r.state, 'A', 10_000, 10_000); // back: timer reset
  r = followStep(r.state, 'B', 12_000, 10_000);
  assert.strictEqual(followStep(r.state, 'B', 20_000, 10_000).switchTo, null, 'only 8 s since it came back to B');
  assert.strictEqual(followStep(r.state, 'B', 22_000, 10_000).switchTo, 'B');
  let f = followStep(undefined, 'A', 0, 10_000);
  for (let t = 2000; t <= 120_000; t += 2000) {
    f = followStep(f.state, (t / 2000) % 2 ? 'B' : 'A', t, 10_000);
    assert.strictEqual(f.switchTo, null, `flap t=${t}`);
  }
  assert.strictEqual(f.state.current, 'A');
});

await check('nativeCaptureSize: physical size, fitted to 4K, even, 1080p fallback', async () => {
  const [n] = await fns('nativeCaptureSize');
  assert.deepStrictEqual(n({ bounds: { width: 1536, height: 864 }, scaleFactor: 1.25 }), { width: 1920, height: 1080 });
  assert.deepStrictEqual(n({ bounds: { width: 2560, height: 1440 }, scaleFactor: 1 }), { width: 2560, height: 1440 });
  assert.deepStrictEqual(n({ bounds: { width: 3840, height: 2160 }, scaleFactor: 2 }), { width: 3840, height: 2160 });
  assert.deepStrictEqual(n({ bounds: { width: 5120, height: 1440 }, scaleFactor: 1 }), { width: 3840, height: 1080 });
  assert.deepStrictEqual(n(null), { width: 1920, height: 1080 });
});

finish('agent-policy');
