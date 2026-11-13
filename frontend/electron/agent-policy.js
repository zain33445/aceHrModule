/** agent-policy.js — pure decisions for the agent (dependency-free; checked by agent-policy.check.mjs). */

/** Should this user's screen be recorded? Never attribute to another user's token/policy (A9). */
export function decideRecording({ userId, tokens, policies }) {
  if (userId == null || userId === '') return { record: false, reason: 'no user' };
  const u = String(userId);
  if (!tokens?.[u]) return { record: false, reason: `no cached token for user ${u}` };
  const p = policies?.[u];
  if (!p) return { record: false, reason: `server has not confirmed a policy for user ${u}` };
  if (!p.record) return { record: false, reason: `recording disabled for user ${u}` };
  return { record: true };
}

/** serverTime (ms or ISO) minus local clock; 0 when unparsable (A12). */
export function clockOffset(serverTime, localNowMs = Date.now()) {
  const t = typeof serverTime === 'number' ? serverTime : Date.parse(serverTime);
  return Number.isFinite(t) ? t - localNowMs : 0;
}

export const serverNow = (offsetMs, localNowMs = Date.now()) => localNowMs + (Number.isFinite(offsetMs) ? offsetMs : 0);

/** Capture source of the primary display, else the first one (A14). */
export function pickPrimarySource(sources, primaryDisplayId) {
  if (!sources?.length) return null;
  if (primaryDisplayId == null) return sources[0];
  return sources.find((s) => String(s.display_id) === String(primaryDisplayId)) ?? sources[0];
}

const QUALITIES = ['480p', '720p', '1080p'];
const asQuality = (q) => (QUALITIES.includes(q) ? q : '720p');
/**
 * Quality is fixed for a recording day: a pin { userId, recordingDate, quality } for the same user+day wins over
 * the server's current setting; otherwise the server value (unknown/missing -> '720p') becomes the new pin.
 */
export function pinnedQuality(pin, recordingDate, userId, serverQuality) {
  if (pin && pin.recordingDate === recordingDate && String(pin.userId) === String(userId) && QUALITIES.includes(pin.quality)) {
    return { quality: pin.quality, pin };
  }
  const quality = asQuality(serverQuality);
  return { quality, pin: { userId: String(userId), recordingDate, quality } };
}
export { asQuality };

/**
 * Screen numbers (docs contract): Screen 1 = primary; the others sorted by bounds.x then bounds.y get 2..N.
 * @returns {{displayId: string, screen: number}[]} in screen order
 */
export function numberScreens(displays, primaryId) {
  const list = [...(displays || [])];
  const pid = primaryId == null ? null : String(primaryId);
  const primary = list.find((d) => String(d.id) === pid) ?? null;
  const rest = list
    .filter((d) => d !== primary)
    .sort((a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) || (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
  return [...(primary ? [primary] : []), ...rest].map((d, i) => ({ displayId: String(d.id), screen: i + 1 }));
}

/** Capture source of a display, else the primary one (fallback). */
export function sourceForDisplay(sources, displayId, primaryDisplayId) {
  const hit = displayId == null ? null : sources?.find((s) => String(s.display_id) === String(displayId));
  return hit ?? pickPrimarySource(sources, primaryDisplayId);
}

/**
 * Follow-the-cursor debounce. state = { current, candidate, since } (undefined at start: the first
 * observed display becomes current without a switch). A different display must hold the cursor for
 * delayMs without interruption before it becomes current; leaving it resets the timer.
 */
export function followStep(state, displayId, nowMs, delayMs) {
  const id = String(displayId);
  if (!state) return { state: { current: id, candidate: null, since: null }, switchTo: null };
  if (id === state.current) return { state: { ...state, candidate: null, since: null }, switchTo: null };
  if (state.candidate !== id) return { state: { ...state, candidate: id, since: nowMs }, switchTo: null };
  if (nowMs - state.since >= delayMs) return { state: { current: id, candidate: null, since: null }, switchTo: id };
  return { state, switchTo: null };
}
