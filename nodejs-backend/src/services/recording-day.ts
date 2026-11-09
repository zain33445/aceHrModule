/**
 * recording-day.ts — shift-based "recording day" (docs/recording-v2.md §2).
 * Pure functions + one DB lookup. All times are Asia/Karachi (UTC+5, no DST).
 * ponytail: fixed +05:00 offset; switch to Intl if Pakistan ever reintroduces DST.
 */
import prisma from '../prisma';
import { timeToMinutes } from './absence.service';

export interface RecordingDayRule {
  boundaryMinutes: number;
  shiftStartMinutes: number;
}

const KARACHI_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 86_400_000;

const validMinutes = (m: number) => Number.isFinite(m) && m >= 0 && m < 1440;

export function recordingDayRule(shift: { checkin?: string | null; checkout?: string | null } | null | undefined): RecordingDayRule {
  if (!shift?.checkin || !shift?.checkout) return { boundaryMinutes: 0, shiftStartMinutes: 0 };
  const S = timeToMinutes(shift.checkin);
  const E = timeToMinutes(shift.checkout);
  if (!validMinutes(S) || !validMinutes(E)) return { boundaryMinutes: 0, shiftStartMinutes: 0 };
  let gap = (S - E + 1440) % 1440;
  if (gap === 0) gap = 1440;
  const B = (E + Math.floor(gap / 2)) % 1440;
  return { boundaryMinutes: B, shiftStartMinutes: S };
}

/** 'YYYY-MM-DD' recording day (Karachi) that `date` belongs to. */
export function recordingDateFor(date: Date, rule: RecordingDayRule): string {
  const shifted = new Date(date.getTime() + KARACHI_OFFSET_MS - rule.boundaryMinutes * 60_000);
  const plusDay = rule.shiftStartMinutes < rule.boundaryMinutes ? DAY_MS : 0;
  return new Date(shifted.getTime() + plusDay).toISOString().slice(0, 10);
}

/** user → department → shift → rule (no shift = calendar date). */
export async function ruleForUser(userId: string): Promise<RecordingDayRule> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { department: { select: { shift: { select: { checkin: true, checkout: true } } } } },
  });
  return recordingDayRule(user?.department?.shift ?? null);
}

/** Instant (UTC) at which the given recording day ends (the next day boundary). */
export function recordingDayEndsAt(recordingDate: string, rule: RecordingDayRule): Date {
  // Day D spans Karachi [D 00:00 + B (minus one day when S < B)] for 24h.
  const startKarachi =
    Date.parse(`${recordingDate}T00:00:00.000Z`) +
    rule.boundaryMinutes * 60_000 -
    (rule.shiftStartMinutes < rule.boundaryMinutes ? DAY_MS : 0);
  return new Date(startKarachi + DAY_MS - KARACHI_OFFSET_MS);
}
