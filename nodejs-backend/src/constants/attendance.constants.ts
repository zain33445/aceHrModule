export const LATE_HALFDAY_EXEMPT_USER_IDS = new Set<string>(['34']);

export function isLateHalfdayExempt(userId: string | number): boolean {
  return LATE_HALFDAY_EXEMPT_USER_IDS.has(String(userId));
}
