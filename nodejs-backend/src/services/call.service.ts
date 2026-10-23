/**
 * call.service.ts — Persistence logic for voice & video calls.
 *
 * The gateway (call.gateway.ts) owns the *live* mesh state — who is connected
 * to which peer right now. This service owns the *durable* state: the call
 * session row, its participants, the per-pair call log (used for the call
 * history / missed-call list) and the recording metadata.
 *
 * Call logs are written provisionally at creation time with a `missed`
 * outcome and upgraded to `answered` / `declined` / `cancelled` as the call
 * progresses. That keeps a single row per (caller, callee) pair regardless of
 * how the call ends.
 */

import prisma from '../prisma';
import { CallOutcome, CallStatus } from '@prisma/client';

/**
 * Maximum number of people in a single mesh call.
 *
 * A full mesh needs one peer connection per participant, so every participant
 * holds N-1 connections and every renegotiation (switching the camera on, for
 * example) touches all of them. The reliability of a link drops as the number
 * of links grows — with four participants the chance that at least one link
 * misbehaves is high enough to be noticed, which is why production group
 * calls use an SFU.
 *
 * Three (the host plus two others) is the largest group the mesh is reliable
 * enough for today. Raise it with CALL_MAX_PARTICIPANTS once the call goes
 * through an SFU.
 */
export const MAX_CALL_PARTICIPANTS = Math.max(
  2,
  parseInt(process.env.CALL_MAX_PARTICIPANTS || '3', 10)
);

/** How many calls a single user may be in at once. */
export const MAX_CONCURRENT_CALLS_PER_USER = 2;

/** How long a call may ring before it is considered missed. */
export const RING_TIMEOUT_MS = 30_000;

export interface CreateCallInput {
  startedBy: string;
  targetUserIds: string[];
  conversationId?: string | null;
  maxParticipants?: number;
}

export interface CreatedCall {
  id: string;
  startedBy: string;
  conversationId: string | null;
  targetUserIds: string[];
  createdAt: Date;
}

/**
 * Creates a ringing call session plus one participant row per person
 * (host + targets). Throws if a target does not exist or is inactive.
 */
export async function createCallSession(input: CreateCallInput): Promise<CreatedCall> {
  const max = Math.min(
    input.maxParticipants ?? MAX_CALL_PARTICIPANTS,
    MAX_CALL_PARTICIPANTS
  );

  const targets = Array.from(
    new Set(input.targetUserIds.map(String).filter((id) => id && id !== String(input.startedBy)))
  );

  if (targets.length === 0) {
    throw new Error('At least one target user is required.');
  }

  if (targets.length + 1 > max) {
    throw new Error(`A call can have at most ${max} participants.`);
  }

  const validTargets = await prisma.user.findMany({
    where: { id: { in: targets }, status: 'active' },
    select: { id: true },
  });

  const validIds = validTargets.map((t) => t.id);
  const missing = targets.filter((id) => !validIds.includes(id));

  if (missing.length > 0) {
    throw new Error(`Unknown or inactive user(s): ${missing.join(', ')}`);
  }

  const session = await prisma.callSession.create({
    data: {
      started_by: String(input.startedBy),
      conversation_id: input.conversationId ?? null,
      status: 'ringing',
      max_participants: max,
      participants: {
        create: [
          {
            user_id: String(input.startedBy),
            role: 'host',
          },
          ...validIds.map((id) => ({
            user_id: id,
            role: 'member' as const,
          })),
        ],
      },
    },
  });

  // Provisional log rows — upgraded as the call progresses.
  await prisma.callLog.createMany({
    data: validIds.map((id) => ({
      call_id: session.id,
      from_user_id: String(input.startedBy),
      to_user_id: id,
      outcome: 'missed' as CallOutcome,
    })),
  });

  return {
    id: session.id,
    startedBy: String(input.startedBy),
    conversationId: session.conversation_id,
    targetUserIds: validIds,
    createdAt: session.started_at,
  };
}

/**
 * Marks a call as active (first participant accepted) and flips the
 * corresponding call-log rows to `answered`.
 */
export async function activateCall(callId: string, acceptedUserIds: string[] = []): Promise<void> {
  await prisma.callSession.updateMany({
    where: { id: callId, status: 'ringing' },
    data: { status: 'active' },
  });

  if (acceptedUserIds.length > 0) {
    await prisma.callLog.updateMany({
      where: { call_id: callId, to_user_id: { in: acceptedUserIds.map(String) } },
      data: { outcome: 'answered' },
    });
  }
}

/** Updates the outcome of a single (caller, callee) log row. */
export async function markLogOutcome(
  callId: string,
  calleeUserId: string,
  outcome: CallOutcome
): Promise<void> {
  await prisma.callLog.updateMany({
    where: { call_id: callId, to_user_id: String(calleeUserId) },
    data: { outcome },
  });
}

/**
 * Ends a call: flips the status, stamps the end time and computes the
 * duration on the log rows. Any participant still marked as present is closed out.
 */
export async function endCallSession(callId: string): Promise<void> {
  const session = await prisma.callSession.findUnique({
    where: { id: callId },
    select: { started_at: true, status: true, ended_at: true },
  });

  if (!session) return;
  if (session.status === 'ended') return;

  const endedAt = new Date();
  const durationSec = Math.max(
    0,
    Math.round((endedAt.getTime() - session.started_at.getTime()) / 1000)
  );

  await prisma.callSession.update({
    where: { id: callId },
    data: { status: 'ended', ended_at: endedAt },
  });

  await prisma.callParticipant.updateMany({
    where: { call_id: callId, left_at: null },
    data: { left_at: endedAt },
  });

  await prisma.callLog.updateMany({
    where: { call_id: callId },
    data: { duration_sec: durationSec },
  });
}

/** Records that a participant left the call (without ending it). */
export async function markParticipantLeft(callId: string, userId: string): Promise<void> {
  await prisma.callParticipant.updateMany({
    where: { call_id: callId, user_id: String(userId), left_at: null },
    data: { left_at: new Date() },
  });
}

/** Records that a participant (re)joined the call, assigning their mesh peer id. */
export async function upsertParticipantPeer(
  callId: string,
  userId: string,
  peerId: string
): Promise<void> {
  await prisma.callParticipant.updateMany({
    where: { call_id: callId, user_id: String(userId) },
    data: { peer_id: peerId, joined_at: new Date(), left_at: null },
  });
}

/** True when the given user is listed as a participant of the call. */
export async function isParticipant(callId: string, userId: string): Promise<boolean> {
  const row = await prisma.callParticipant.findFirst({
    where: { call_id: callId, user_id: String(userId) },
    select: { id: true },
  });
  return row !== null;
}

/** Fetches a call session with its participants and the caller's name. */
export async function getCallSession(callId: string) {
  return prisma.callSession.findUnique({
    where: { id: callId },
    include: {
      participants: {
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      },
      started_by_user: { select: { id: true, name: true, role: true } },
    },
  });
}

/**
 * Lists the calls a user took part in, newest first. Admins can list all calls.
 */
export async function listCallsForUser(
  userId: string,
  opts: { limit?: number; isAdmin?: boolean } = {}
) {
  const limit = Math.min(opts.limit ?? 50, 200);

  return prisma.callSession.findMany({
    where: opts.isAdmin
      ? undefined
      : { participants: { some: { user_id: String(userId) } } },
    orderBy: { started_at: 'desc' },
    take: limit,
    include: {
      participants: {
        include: { user: { select: { id: true, name: true, role: true } } },
      },
      started_by_user: { select: { id: true, name: true, role: true } },
      _count: { select: { recordings: true } },
    },
  });
}

/**
 * Per-user call history (who called whom, outcome, duration).
 */
export async function listCallLogs(
  userId: string,
  opts: { limit?: number; isAdmin?: boolean } = {}
) {
  const limit = Math.min(opts.limit ?? 100, 500);

  return prisma.callLog.findMany({
    where: opts.isAdmin
      ? undefined
      : {
          OR: [{ from_user_id: String(userId) }, { to_user_id: String(userId) }],
        },
    orderBy: { started_at: 'desc' },
    take: limit,
    include: {
      from_user: { select: { id: true, name: true } },
      to_user: { select: { id: true, name: true } },
      call: { select: { id: true, started_at: true, ended_at: true, status: true } },
    },
  });
}

/** Counts how many calls the user is currently listed in and still open. */
export async function countOpenCalls(userId: string): Promise<number> {
  return prisma.callSession.count({
    where: {
      status: { in: [CallStatus.ringing, CallStatus.active] },
      participants: { some: { user_id: String(userId), left_at: null } },
    },
  });
}
