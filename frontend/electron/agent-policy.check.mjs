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

finish('agent-policy');
