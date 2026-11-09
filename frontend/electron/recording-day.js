/**
 * recording-day.js — agent copy of the server's recording-day rule
 * (docs/recording-v2.md §2). Pure and dependency-free.
 *
 * rule = { boundaryMinutes, shiftStartMinutes } (Asia/Karachi minutes of day).
 * recordingDate(t) = karachiDate(t - B) + (S < B ? 1 day : 0)
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KARACHI_OFFSET_MS = 5 * 60 * MIN; // fixed UTC+5, no DST

/** Coerce anything (CONNECTED payload, cache) to a valid rule; no rule → calendar date. */
export function normalizeRule(rule) {
  const ok = (n) => Number.isFinite(n) && n >= 0 && n < 1440;
  const b = Number(rule?.boundaryMinutes);
  const s = Number(rule?.shiftStartMinutes);
  return { boundaryMinutes: ok(b) ? Math.floor(b) : 0, shiftStartMinutes: ok(s) ? Math.floor(s) : 0 };
}

/** 'YYYY-MM-DD' recording day of an instant (Date | ms | ISO string). */
export function recordingDateFor(date, rule) {
  const { boundaryMinutes: B, shiftStartMinutes: S } = normalizeRule(rule);
  const t = date instanceof Date ? date.getTime() : typeof date === 'number' ? date : Date.parse(date);
  let shifted = t + KARACHI_OFFSET_MS - B * MIN;
  if (S < B) shifted += DAY;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** First instant (ms) strictly after `nowMs` at which recordingDateFor() changes. */
export function nextBoundaryInstant(nowMs, rule) {
  const { boundaryMinutes: B } = normalizeRule(rule);
  const x = nowMs + KARACHI_OFFSET_MS - B * MIN;
  return (Math.floor(x / DAY) + 1) * DAY - KARACHI_OFFSET_MS + B * MIN;
}
