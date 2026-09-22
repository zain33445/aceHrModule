/**
 * notification.service.ts — Centralized notification creation and delivery.
 *
 * All notification creation goes through this service so that:
 *   1. User preferences (per-type opt-out) are respected.
 *   2. A DB record is created.
 *   3. A real-time push is sent to connected Electron clients via the chat gateway.
 */

import prisma from '../prisma';
import { getChatGateway } from '../gateways/chat.gateway';

// ── Canonical notification types ──────────────────────────

export const NOTIFICATION_TYPES = {
  NEW_DISPUTE:             'new_dispute',
  DISPUTE_LEAD_APPROVED:   'dispute_lead_approved',
  DISPUTE_APPROVED:        'dispute_approved',
  NEW_LEAVE_REQUEST:       'new_leave_request',
  LEAD_LEAVE_DECISION:     'lead_leave_decision',
  ADMIN_LEAVE_DECISION:    'admin_leave_decision',
  NEW_OVERTIME_REQUEST:    'new_overtime_request',
  OVERTIME_LEAD_DECISION:  'overtime_lead_decision',
  OVERTIME_ADMIN_DECISION: 'overtime_admin_decision',
  HOLIDAY_CREATED:         'holiday_created',
  SALARY_GENERATED:        'salary_generated',
  NEW_MESSAGE:             'new_message',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

// ── Preference helpers ────────────────────────────────────

/** Check whether a user has opted out of a notification type. Defaults to enabled. */
async function isDisabledForUser(userId: string, type: string): Promise<boolean> {
  const pref = await prisma.userNotificationPreference.findUnique({
    where: { user_id_type: { user_id: userId, type } },
    select: { enabled: true },
  });
  return pref !== null && !pref.enabled;
}

/** Get all notification preferences for a user. */
export async function getUserPreferences(userId: string) {
  return prisma.userNotificationPreference.findMany({
    where: { user_id: userId },
    orderBy: { type: 'asc' },
  });
}

/** Bulk upsert notification preferences for a user. */
export async function upsertUserPreferences(
  userId: string,
  prefs: { type: string; enabled: boolean }[]
) {
  const ops = prefs.map((p) =>
    prisma.userNotificationPreference.upsert({
      where: { user_id_type: { user_id: userId, type: p.type } },
      create: { user_id: userId, type: p.type, enabled: p.enabled },
      update: { enabled: p.enabled },
    })
  );
  return prisma.$transaction(ops);
}

// ── Core: create + deliver ────────────────────────────────

export interface CreateNotificationOpts {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  /** Skip preference check (e.g. system-critical notifications). */
  force?: boolean;
}

/**
 * Create a notification DB record and push it to the user's connected clients.
 * Respects per-type opt-out unless `force` is true.
 * Returns the created notification, or null if suppressed by preference.
 */
export async function createAndDeliver(opts: CreateNotificationOpts) {
  const { userId, type, title, message, link, force } = opts;

  if (!force && await isDisabledForUser(userId, type)) {
    return null;
  }

  const notification = await prisma.notification.create({
    data: { user_id: userId, type, title, message, link: link ?? null },
  });

  // Push to connected Electron / browser clients via the chat WebSocket.
  getChatGateway()?.notifyUser(userId, {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    link: notification.link,
    is_read: notification.is_read,
    created_at: notification.created_at,
  });

  return notification;
}

/**
 * Convenience: deliver a notification to multiple users at once.
 * Returns the count of notifications actually created.
 */
export async function bulkCreateAndDeliver(
  userIds: string[],
  opts: Omit<CreateNotificationOpts, 'userId'>
): Promise<number> {
  let count = 0;
  for (const userId of userIds) {
    const result = await createAndDeliver({ ...opts, userId });
    if (result) count++;
  }
  return count;
}
