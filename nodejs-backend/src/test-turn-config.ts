import assert from 'assert';
import { buildTurnUrls } from './services/turn.service';

assert.deepStrictEqual(buildTurnUrls({ TURN_URLS: 'turn:x:1?transport=udp, turns:y:2', TURN_LAN_HOST: '1.1.1.1' }), [
  'turn:x:1?transport=udp',
  'turns:y:2',
]);
assert.deepStrictEqual(buildTurnUrls({}), [
  'turn:100.125.119.28:3478?transport=udp',
  'turn:100.125.119.28:3478?transport=tcp',
]);
assert.deepStrictEqual(buildTurnUrls({ TURN_TS_HOST: '' }).length, 2);
const both = buildTurnUrls({ TURN_LAN_HOST: '192.168.18.170' });
assert.strictEqual(both.length, 4);
assert.ok(both[0].includes('192.168.18.170') && both[1].includes('192.168.18.170'));
assert.ok(both[2].includes('100.125.119.28'));
assert.deepStrictEqual(buildTurnUrls({ TURN_PORT: '3479' })[0], 'turn:100.125.119.28:3479?transport=udp');
console.log('test-turn-config ok');
