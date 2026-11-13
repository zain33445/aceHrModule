// Run: node frontend/electron/live-quality.check.mjs
import assert from 'assert';
import { createRequire } from 'module';
const { qualityToEncoding, serializeCandidate, mapConnectionState } = createRequire(import.meta.url)('./live-quality.cjs');

const mk = (down, fps, br) => ({ scaleResolutionDownBy: down, maxFramerate: fps, maxBitrate: br, degradationPreference: 'maintain-resolution' });
assert.deepStrictEqual(qualityToEncoding('grid'), mk(2, 10, 600000));
assert.deepStrictEqual(qualityToEncoding('grid', 1920), mk(3, 10, 600000));
assert.deepStrictEqual(qualityToEncoding('grid', 480), mk(1, 10, 600000));
assert.deepStrictEqual(qualityToEncoding('grid2'), mk(2, 10, 1500000));
assert.deepStrictEqual(qualityToEncoding('grid2', 2560), mk(2, 10, 1500000));
assert.deepStrictEqual(qualityToEncoding('grid2', 1920), mk(1.5, 10, 1500000));
assert.deepStrictEqual(qualityToEncoding('grid2', 1000), mk(1, 10, 1500000));
assert.deepStrictEqual(qualityToEncoding('grid3', 1920), mk(2, 10, 1000000));
assert.deepStrictEqual(qualityToEncoding('grid3', 800), mk(1, 10, 1000000));
assert.deepStrictEqual(qualityToEncoding('focus', 1920), mk(1, 15, 4000000));
assert.deepStrictEqual(qualityToEncoding('focus', 3840), mk(1, 15, 4000000));
assert.deepStrictEqual(qualityToEncoding('bogus', 1920), qualityToEncoding('grid', 1920));
assert.deepStrictEqual(qualityToEncoding(undefined), qualityToEncoding('grid'));

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
