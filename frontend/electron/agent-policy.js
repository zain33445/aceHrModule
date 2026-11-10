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
