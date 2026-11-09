// Run: node frontend/electron/recording-day.check.mjs
import assert from 'assert';
import { recordingDateFor, nextBoundaryInstant, normalizeRule } from './recording-day.js';

// Karachi local wall time -> Date (Karachi = UTC+5).
const k = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 5, mi));
const rule = (S, E) => {
  const gap = ((S - E + 1440) % 1440) || 1440;
  return { boundaryMinutes: (E + Math.floor(gap / 2)) % 1440, shiftStartMinutes: S };
};
const hm = (h, m = 0) => h * 60 + m;

// No rule -> plain Karachi calendar date.
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 0, 30), null), '2026-11-10');
assert.strictEqual(recordingDateFor(k(2026, 11, 9, 23, 59), undefined), '2026-11-09');
assert.deepStrictEqual(normalizeRule({ boundaryMinutes: 'x' }), { boundaryMinutes: 0, shiftStartMinutes: 0 });

// 09:00-18:00 -> boundary 01:30
const day = rule(hm(9), hm(18));
assert.strictEqual(day.boundaryMinutes, hm(1, 30));
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 0, 30), day), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 9), day), '2026-11-10');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 1, 29), day), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 1, 30), day), '2026-11-10');

// 19:00-04:00 -> boundary 11:30
const night = rule(hm(19), hm(4));
assert.strictEqual(night.boundaryMinutes, hm(11, 30));
assert.strictEqual(recordingDateFor(k(2026, 11, 9, 19), night), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 2), night), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 11), night), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 10, 12), night), '2026-11-10');

// 00:00-08:00 -> boundary 16:00, S < B so the day label is +1
const early = rule(0, hm(8));
assert.strictEqual(early.boundaryMinutes, hm(16));
assert.strictEqual(recordingDateFor(k(2026, 11, 9, 0, 30), early), '2026-11-09');
assert.strictEqual(recordingDateFor(k(2026, 11, 9, 17), early), '2026-11-10');

// nextBoundaryInstant: strictly after now, within 24h, and the date flips exactly there.
for (const r of [null, day, night, early]) {
  for (const now of [k(2026, 11, 9, 0), k(2026, 11, 9, 11, 30), k(2026, 11, 9, 1, 30), k(2026, 11, 10, 23, 59)]) {
    const t = nextBoundaryInstant(now.getTime(), r);
    assert.ok(t > now.getTime() && t - now.getTime() <= 86400000, 'within the next 24h');
    assert.notStrictEqual(recordingDateFor(t - 1, r), recordingDateFor(t, r), 'date flips at the boundary');
    assert.strictEqual(recordingDateFor(t, r), recordingDateFor(t + 3600000, r));
  }
}
assert.strictEqual(nextBoundaryInstant(k(2026, 11, 9, 12).getTime(), day), k(2026, 11, 10, 1, 30).getTime());
assert.strictEqual(nextBoundaryInstant(k(2026, 11, 9, 12).getTime(), null), k(2026, 11, 10, 0).getTime());

console.log('recording-day check passed');
