// Run: node frontend/electron/live-quality.check.mjs
import assert from 'assert';
import { createRequire } from 'module';
const { qualityToEncoding, serializeCandidate, mapConnectionState } = createRequire(import.meta.url)('./live-quality.cjs');

assert.deepStrictEqual(qualityToEncoding('grid'), { scaleResolutionDownBy: 2, maxFramerate: 5, maxBitrate: 250000 });
assert.deepStrictEqual(qualityToEncoding('focus'), { scaleResolutionDownBy: 1, maxFramerate: 10, maxBitrate: 1200000 });
assert.deepStrictEqual(qualityToEncoding('bogus'), qualityToEncoding('grid'));

// Getters live on the prototype, like RTCIceCandidate: JSON.stringify would drop them.
class Cand {
  get candidate() { return 'candidate:1'; }
  get sdpMid() { return '0'; }
  get sdpMLineIndex() { return 0; }
  get usernameFragment() { return 'x'; }
}
assert.strictEqual(JSON.stringify(new Cand()), '{}');
assert.deepStrictEqual(serializeCandidate(new Cand()), { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });

assert.strictEqual(mapConnectionState('new'), 'connecting');
assert.strictEqual(mapConnectionState('connecting'), 'connecting');
assert.strictEqual(mapConnectionState('connected'), 'connected');
assert.strictEqual(mapConnectionState('failed'), 'failed');
assert.strictEqual(mapConnectionState('closed'), 'closed');
assert.strictEqual(mapConnectionState('disconnected'), null);
console.log('live-quality: ok');
