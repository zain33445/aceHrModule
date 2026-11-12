/**
 * chat.service.ts — Chat permissions + persistence (shared by REST routes and the WS gateway).
 *
 * Permission model:
 *   isHr    = role === 'hr'  OR  member of a department named "HR" (case-insensitive)
 *   isAdmin = role in {superadmin, admin}
 *   isLead  = lead_id of ≥1 department
 *
 *   canOpenDirect(a,b):
 *     same department  → allowed
 *     either side isHr or isAdmin → allowed (anyone)
 *     otherwise → blocked (any cross-dept pair, leads included)
 *   canCreateGroup = isAdmin OR isHr
 *   Groups: admin + HR users are auto-added as participants so they see every dept group.
 *
 * Pure helpers take plain objects (self-check: `npx ts-node src/services/chat.service.ts`).
 */

import prisma from '../prisma';

const ADMIN_ROLES = new Set(['superadmin', 'admin']);

export interface ChatUser {
  id: string;
  role: string;
  department_id: number | null;
  isLead: boolean;
  isHr: boolean;    // role hr OR HR-department member
  isAdmin: boolean; // superadmin | admin
}

// ── Pure permission helpers ───────────────────────────────

/** Elevated for group visibility / unrestricted DM (admin or HR). Leads are not in this set. */
export function isPrivileged(u: ChatUser): boolean {
  return u.isAdmin || u.isHr;
}

export function canCreateGroup(u: ChatUser): boolean {
  return u.isAdmin || u.isHr;
}

export function canOpenDirect(a: ChatUser, b: ChatUser): boolean {
  if (a.id === b.id) return false; // no chatting with yourself
  const sameDept = a.department_id != null && a.department_id === b.department_id;
  if (sameDept) return true;
  // HR and admin may DM anyone
  if (a.isHr || b.isHr || a.isAdmin || b.isAdmin) return true;
  return false;
}

// ── DB loading ────────────────────────────────────────────

/** Load a user as a ChatUser (isLead / isHr / isAdmin derived). Null if not found. */
export async function loadChatUser(userId: string): Promise<ChatUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      department_id: true,
      department: { select: { name: true } },
      led_departments: { select: { id: true } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    department_id: user.department_id,
    isLead: user.led_departments.length > 0,
    isHr: isHrRoleOrDept(user.role, user.department?.name ?? null),
    isAdmin: ADMIN_ROLES.has(user.role),
  };
}

function isHrRoleOrDept(role: string, departmentName: string | null): boolean {
  if (role === 'hr') return true;
  return (departmentName ?? '').trim().toLowerCase() === 'hr';
}

/** All active user ids that should sit in every department group (admins + HR). */
export async function getAdminHrUserIds(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: 'active',
      OR: [
        { role: { in: ['admin', 'superadmin', 'hr'] } },
        { department: { name: { equals: 'HR', mode: 'insensitive' } } },
      ],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

// ── Conversations ─────────────────────────────────────────

/** Open (or reuse) a 1:1 direct conversation between two users. Enforces canOpenDirect. */
export async function getOrCreateDirect(requesterId: string, otherUserId: string) {
  const a = await loadChatUser(requesterId);
  const b = await loadChatUser(otherUserId);
  if (!a || !b) throw new ChatError(404, 'User not found');
  if (!canOpenDirect(a, b)) throw new ChatError(403, 'You are not allowed to message this user');

  // Reuse an existing direct conversation containing exactly these two users.
  const existing = await prisma.chatConversation.findFirst({
    where: {
      conversation_type: 'direct',
      participants: { every: { user_id: { in: [a.id, b.id] } } },
      AND: [
        { participants: { some: { user_id: a.id } } },
        { participants: { some: { user_id: b.id } } },
      ],
    },
  });
  if (existing) return existing;

  return prisma.chatConversation.create({
    data: {
      conversation_type: 'direct',
      created_by_user_id: requesterId,
      participants: { create: [{ user_id: a.id }, { user_id: b.id }] },
    },
  });
}

/** Create the single group chat for a department: active dept members + all admin/HR. */
export async function createDepartmentGroup(creatorId: string, departmentId: number) {
  const creator = await loadChatUser(creatorId);
  if (!creator) throw new ChatError(404, 'User not found');
  if (!canCreateGroup(creator)) throw new ChatError(403, 'Only admins and HR can create group chats');

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, chat_group: { select: { id: true } } },
  });
  if (!dept) throw new ChatError(404, 'Department not found');
  if (dept.chat_group) throw new ChatError(409, 'This department already has a group chat');

  const [members, adminHrIds] = await Promise.all([
    prisma.user.findMany({
      where: { department_id: departmentId, status: 'active' },
      select: { id: true },
    }),
    getAdminHrUserIds(),
  ]);
  const participantIds = [...new Set([...members.map((m) => m.id), ...adminHrIds])];

  return prisma.chatConversation.create({
    data: {
      conversation_type: 'group',
      department_id: departmentId,
      created_by_user_id: creatorId,
      participants: { create: participantIds.map((user_id) => ({ user_id })) },
    },
    include: { participants: true },
  });
}

/**
 * Ensure every department group has all current admin/HR users as active participants.
 * Idempotent — safe to call on every startup (backfill for groups created before this rule).
 */
export async function ensureAdminHrInAllGroups(): Promise<number> {
  const [groups, adminHrIds] = await Promise.all([
    prisma.chatConversation.findMany({
      where: { conversation_type: 'group', department_id: { not: null } }, // custom groups stay private
      select: { id: true, participants: { select: { user_id: true, is_active: true } } },
    }),
    getAdminHrUserIds(),
  ]);
  if (groups.length === 0 || adminHrIds.length === 0) return 0;

  let added = 0;
  for (const group of groups) {
    const existing = new Map(group.participants.map((p) => [p.user_id, p.is_active]));
    for (const userId of adminHrIds) {
      if (!existing.has(userId)) {
        await prisma.chatParticipant.create({ data: { conversation_id: group.id, user_id: userId } });
        added++;
      } else if (existing.get(userId) === false) {
        await prisma.chatParticipant.updateMany({
          where: { conversation_id: group.id, user_id: userId },
          data: { is_active: true },
        });
      }
    }
  }
  return added;
}

/**
 * Reconcile a department group's participants with its current active members.
 * Admin/HR users always stay active participants (they see every group).
 * Call after department assignment changes.
 */
export async function syncDepartmentGroupMembers(departmentId: number) {
  const group = await prisma.chatConversation.findUnique({
    where: { department_id: departmentId },
    select: { id: true, participants: { select: { user_id: true, is_active: true } } },
  });
  if (!group) return; // no group for this dept yet

  const [activeMembers, adminHrIds] = await Promise.all([
    prisma.user.findMany({
      where: { department_id: departmentId, status: 'active' },
      select: { id: true },
    }),
    getAdminHrUserIds(),
  ]);
  const shouldBe = new Set([...activeMembers.map((m) => m.id), ...adminHrIds]);
  const existing = new Map(group.participants.map((p) => [p.user_id, p.is_active]));

  const ops: Promise<unknown>[] = [];
  for (const userId of shouldBe) {
    if (!existing.has(userId)) {
      ops.push(prisma.chatParticipant.create({ data: { conversation_id: group.id, user_id: userId } }));
    } else if (existing.get(userId) === false) {
      ops.push(prisma.chatParticipant.updateMany({
        where: { conversation_id: group.id, user_id: userId },
        data: { is_active: true },
      }));
    }
  }
  for (const [userId, active] of existing) {
    if (active && !shouldBe.has(userId)) {
      ops.push(prisma.chatParticipant.updateMany({
        where: { conversation_id: group.id, user_id: userId },
        data: { is_active: false },
      }));
    }
  }
  await Promise.all(ops);
}

// ── Custom groups (any members, no department) ───────────

/** Create a custom group of hand-picked active users. Returns the creator's inbox row + ids to notify. */
export async function createCustomGroup(creatorId: string, title: string, memberIds: string[]) {
  const creator = await loadChatUser(creatorId);
  if (!creator) throw new ChatError(404, 'User not found');
  if (!canCreateGroup(creator)) throw new ChatError(403, 'Only admins and HR can create group chats');

  const name = typeof title === 'string' ? title.trim() : '';
  if (!name) throw new ChatError(400, 'Group name is required');
  if (name.length > 80) throw new ChatError(400, 'Group name must be 80 characters or fewer');

  if (!Array.isArray(memberIds)) throw new ChatError(400, 'member_ids must be an array');
  const others = [...new Set(memberIds.map(String))].filter((id) => id !== creatorId);
  if (others.length === 0) throw new ChatError(400, 'Pick at least one member');
  const bad = await findInvalidUserIds(others);
  if (bad.length) throw new ChatError(400, `Unknown or inactive users: ${bad.join(', ')}`);

  const conv = await prisma.chatConversation.create({
    data: {
      conversation_type: 'group',
      title: name,
      created_by_user_id: creatorId,
      participants: { create: [creatorId, ...others].map((user_id) => ({ user_id })) },
    },
    select: { id: true },
  });
  const conversation = (await listConversations(creatorId)).find((c) => c.id === conv.id);
  return { conversation, notifyIds: [creatorId, ...others] };
}

async function findInvalidUserIds(ids: string[]): Promise<string[]> {
  const ok = await prisma.user.findMany({ where: { id: { in: ids }, status: 'active' }, select: { id: true } });
  const okSet = new Set(ok.map((u) => u.id));
  return ids.filter((id) => !okSet.has(id));
}

/** Load a custom group (group, no department) with its active participant ids, or throw 404/400. */
async function loadCustomGroup(conversationId: string) {
  const c = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: {
      conversation_type: true,
      department_id: true,
      created_by_user_id: true,
      participants: { where: { is_active: true }, select: { user_id: true } },
    },
  });
  if (!c) throw new ChatError(404, 'Conversation not found');
  if (c.conversation_type !== 'group' || c.department_id != null) {
    throw new ChatError(400, 'Only custom groups can be changed');
  }
  return { createdBy: c.created_by_user_id, activeIds: c.participants.map((p) => p.user_id) };
}

/** Creator (while still a member) or admin may manage members. */
async function assertCanManage(actorId: string, g: { createdBy: string; activeIds: string[] }) {
  if (actorId === g.createdBy && g.activeIds.includes(actorId)) return;
  const actor = await loadChatUser(actorId);
  if (!actor?.isAdmin) throw new ChatError(403, 'Only the group creator or an admin can do this');
}

/** Each of these returns the user ids to notify (everyone affected, old and new). */
export async function addGroupMembers(actorId: string, conversationId: string, userIds: string[]): Promise<string[]> {
  const g = await loadCustomGroup(conversationId);
  await assertCanManage(actorId, g);
  if (!Array.isArray(userIds)) throw new ChatError(400, 'user_ids must be an array');
  const ids = [...new Set(userIds.map(String))];
  if (ids.length === 0) throw new ChatError(400, 'user_ids required');
  const bad = await findInvalidUserIds(ids);
  if (bad.length) throw new ChatError(400, `Unknown or inactive users: ${bad.join(', ')}`);

  for (const user_id of ids) {
    await prisma.chatParticipant.upsert({
      where: { conversation_id_user_id: { conversation_id: conversationId, user_id } },
      create: { conversation_id: conversationId, user_id },
      update: { is_active: true, last_read_at: new Date() },
    });
  }
  return [...new Set([...g.activeIds, ...ids])];
}

export async function removeGroupMember(actorId: string, conversationId: string, userId: string): Promise<string[]> {
  const g = await loadCustomGroup(conversationId);
  await assertCanManage(actorId, g);
  if (userId === g.createdBy) throw new ChatError(400, 'The group creator cannot be removed (they can leave)');
  if (!g.activeIds.includes(userId)) throw new ChatError(404, 'User is not a member');
  await prisma.chatParticipant.updateMany({
    where: { conversation_id: conversationId, user_id: userId },
    data: { is_active: false },
  });
  return g.activeIds;
}

export async function leaveGroup(userId: string, conversationId: string): Promise<string[]> {
  const g = await loadCustomGroup(conversationId);
  if (!g.activeIds.includes(userId)) throw new ChatError(403, 'You are not a member of this group');
  await prisma.chatParticipant.updateMany({
    where: { conversation_id: conversationId, user_id: userId },
    data: { is_active: false },
  });
  return g.activeIds;
}

// ── Messages ──────────────────────────────────────────────

/** Assert the user is an active participant; returns the fellow participant ids for broadcast. */
export async function assertMemberAndGetParticipants(conversationId: string, userId: string): Promise<string[]> {
  const parts = await prisma.chatParticipant.findMany({
    where: { conversation_id: conversationId, is_active: true },
    select: { user_id: true },
  });
  if (!parts.some((p) => p.user_id === userId)) {
    throw new ChatError(403, 'You are not a participant of this conversation');
  }
  return parts.map((p) => p.user_id);
}

export interface AttachmentMeta {
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string; // already written to disk by the caller (route)
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  user_ids: string[];
}

/** Collapse raw reaction rows into `{ emoji, count, user_ids }`, preserving first-seen order. */
export function summarizeReactions(rows: { emoji: string; user_id: string }[]): ReactionSummary[] {
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const users = byEmoji.get(row.emoji);
    if (users) users.push(row.user_id);
    else byEmoji.set(row.emoji, [row.user_id]);
  }
  return [...byEmoji.entries()].map(([emoji, user_ids]) => ({
    emoji,
    count: user_ids.length,
    user_ids,
  }));
}

/** Persist a message plus any already-saved attachments in one write; bumps the inbox sort key. */
export async function postMessage(
  senderId: string,
  conversationId: string,
  text: string | null,
  attachments: AttachmentMeta[] = []
) {
  await assertMemberAndGetParticipants(conversationId, senderId);
  const body = text?.trim() || null;
  if (!body && attachments.length === 0) {
    throw new ChatError(400, 'Message must have text or an attachment');
  }

  const message = await prisma.chatMessage.create({
    data: {
      conversation_id: conversationId,
      sender_user_id: senderId,
      message_text: body,
      attachments: attachments.length ? { create: attachments } : undefined,
    },
    include: { attachments: true, sender: { select: { id: true, name: true } } },
  });

  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { last_message_at: message.created_at },
  });

  return { ...message, reactions: [] as ReactionSummary[], seen: false };
}

/**
 * Toggle one emoji reaction from `userId` on a message.
 * Returns the refreshed summary plus the participants to broadcast to.
 */
export async function toggleMessageReaction(userId: string, messageId: string, emoji: string) {
  const clean = (emoji ?? '').trim();
  if (!clean || clean.length > 32 || /\s/.test(clean)) {
    throw new ChatError(400, 'Invalid emoji');
  }

  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, deleted_at: null },
    select: { id: true, conversation_id: true },
  });
  if (!message) throw new ChatError(404, 'Message not found');

  const participantIds = await assertMemberAndGetParticipants(message.conversation_id, userId);

  const where = { message_id_user_id_emoji: { message_id: messageId, user_id: userId, emoji: clean } };
  const existing = await prisma.chatMessageReaction.findUnique({ where });
  if (existing) {
    await prisma.chatMessageReaction.delete({ where });
  } else {
    await prisma.chatMessageReaction.create({
      data: { message_id: messageId, user_id: userId, emoji: clean },
    });
  }

  const reactions = await loadReactionSummaries(messageId);
  return { conversationId: message.conversation_id, messageId, reactions, participantIds };
}

async function loadReactionSummaries(messageId: string): Promise<ReactionSummary[]> {
  const rows = await prisma.chatMessageReaction.findMany({
    where: { message_id: messageId },
    select: { emoji: true, user_id: true },
    orderBy: { created_at: 'asc' },
  });
  return summarizeReactions(rows);
}

/** Inbox: conversations the user is in, newest first, with unread counts. */
export async function listConversations(userId: string) {
  const memberships = await prisma.chatParticipant.findMany({
    where: { user_id: userId, is_active: true },
    select: {
      last_read_at: true,
      conversation: {
        select: {
          id: true,
          conversation_type: true,
          title: true,
          created_by_user_id: true,
          last_message_at: true,
          department: { select: { id: true, name: true } },
          participants: {
            where: { is_active: true },
            select: { user: { select: { id: true, name: true, role: true } } },
          },
          messages: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { message_text: true, created_at: true, sender_user_id: true },
          },
        },
      },
    },
    orderBy: { conversation: { last_message_at: 'desc' } },
  });

  const result = [];
  for (const m of memberships) {
    const c = m.conversation;
    const unread = await prisma.chatMessage.count({
      where: { conversation_id: c.id, created_at: { gt: m.last_read_at }, sender_user_id: { not: userId } },
    });

    // Check if the last message has been seen by the other participants
    let lastMessageSeen = false;
    if (c.messages[0] && c.messages[0].sender_user_id === userId) {
      const otherParts = await prisma.chatParticipant.findMany({
        where: { conversation_id: c.id, user_id: { not: userId }, is_active: true },
        select: { last_read_at: true },
      });
      lastMessageSeen = otherParts.length > 0 && otherParts.every(
        (p) => p.last_read_at >= c.messages[0].created_at
      );
    }

    result.push({
      id: c.id,
      type: c.conversation_type,
      title: c.title,
      created_by_user_id: c.created_by_user_id,
      department: c.department,
      last_message_at: c.last_message_at,
      last_message: c.messages[0] ?? null,
      last_message_seen: lastMessageSeen,
      participants: c.participants.map((p) => p.user),
      unread,
    });
  }
  return result;
}

/** Paged message history (membership-checked). Pass `before` (ISO date) to page backwards. */
export async function getMessages(conversationId: string, userId: string, before?: string, limit = 50) {
  await assertMemberAndGetParticipants(conversationId, userId);

  // Fetch the other participants' last_read_at to determine seen status
  const otherParticipants = await prisma.chatParticipant.findMany({
    where: { conversation_id: conversationId, user_id: { not: userId }, is_active: true },
    select: { last_read_at: true },
  });
  const latestReadAt = otherParticipants.length > 0
    ? new Date(Math.max(...otherParticipants.map((p) => p.last_read_at.getTime())))
    : new Date();

  const messages = await prisma.chatMessage.findMany({
    where: {
      conversation_id: conversationId,
      deleted_at: null,
      ...(before ? { created_at: { lt: new Date(before) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: Math.min(limit, 100),
    include: {
      attachments: true,
      sender: { select: { id: true, name: true } },
      reactions: {
        select: { emoji: true, user_id: true },
        orderBy: { created_at: 'asc' },
      },
    },
  });

  return messages.reverse().map((m) => {
    const { reactions, ...rest } = m;
    return {
      ...rest,
      reactions: summarizeReactions(reactions),
      seen: m.sender_user_id !== userId && m.created_at <= latestReadAt,
    };
  });
}

export async function markRead(conversationId: string, userId: string) {
  await prisma.chatParticipant.updateMany({
    where: { conversation_id: conversationId, user_id: userId },
    data: { last_read_at: new Date() },
  });
}

// ── Errors ────────────────────────────────────────────────

export class ChatError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── Self-check (pure permission logic) ────────────────────
// Run: npx ts-node src/services/chat.service.ts
if (require.main === module) {
  const mk = (
    id: string,
    department_id: number | null,
    opts: { role?: string; isLead?: boolean; isHr?: boolean; isAdmin?: boolean } = {},
  ): ChatUser => ({
    id,
    role: opts.role ?? 'employee',
    department_id,
    isLead: opts.isLead ?? false,
    isHr: opts.isHr ?? false,
    isAdmin: opts.isAdmin ?? false,
  });

  const emp = (dept: number | null, id?: string) => mk(id ?? 'e' + dept, dept);
  const lead = (dept: number) => mk('l' + dept, dept, { isLead: true });
  const hrRole = mk('hr', 9, { role: 'hr', isHr: true });
  const hrDeptEmp = mk('hrd', 99, { isHr: true }); // employee in "HR" department
  const admin = mk('a', null, { role: 'admin', isAdmin: true });

  const assert = (cond: boolean, msg: string) => { if (!cond) { throw new Error('FAIL: ' + msg); } };

  // Same-dept employees (incl. their lead) may DM.
  assert(canOpenDirect(emp(1), emp(1, 'e1b')), 'same-dept employees may DM');
  assert(canOpenDirect(emp(1), lead(1)), 'employee ↔ same-dept lead allowed');
  // Cross-dept regular employees blocked.
  assert(!canOpenDirect(emp(1), emp(2)), 'cross-dept employees blocked');
  // Cross-dept employee ↔ lead blocked (unless HR/admin).
  assert(!canOpenDirect(emp(1), lead(2)), 'employee ↔ other-dept lead blocked');
  // Leads may not DM other departments (leads included).
  assert(!canOpenDirect(lead(1), lead(2)), 'lead ↔ other-dept lead blocked');
  // HR (role or HR-dept) and admin may DM anyone.
  assert(canOpenDirect(emp(1), hrRole), 'employee ↔ role-hr allowed');
  assert(canOpenDirect(emp(1), hrDeptEmp), 'employee ↔ HR-dept emp allowed');
  assert(canOpenDirect(lead(2), hrDeptEmp), 'other-dept lead ↔ HR-dept allowed via isHr');
  assert(canOpenDirect(mk('x', 2), hrDeptEmp), 'cross-dept employee ↔ HR-dept allowed');
  assert(canOpenDirect(emp(1), admin), 'employee ↔ admin allowed');
  assert(canOpenDirect(lead(2), admin), 'lead ↔ admin allowed');
  // No self-DM.
  assert(!canOpenDirect(emp(1), emp(1)), 'no self DM');
  // Group creation: admin, role-hr, HR-dept employee. Not plain employee or lead.
  assert(canCreateGroup(admin) && canCreateGroup(hrRole) && canCreateGroup(hrDeptEmp), 'admin/hr can create groups');
  assert(!canCreateGroup(emp(1)) && !canCreateGroup(lead(1)), 'employees & leads cannot create groups');
  // Privilege = admin or HR only (not lead).
  assert(isPrivileged(hrRole) && isPrivileged(hrDeptEmp) && isPrivileged(admin), 'hr/admin privileged');
  assert(!isPrivileged(emp(1)) && !isPrivileged(lead(1)), 'employee & lead not group-privileged');

  console.log('chat.service permission self-check: all passed ✓');
}
