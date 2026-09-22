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
 *     both isLead → allowed (lead ↔ lead, any department)
 *     otherwise → blocked (cross-dept employees / employee↔other-dept lead)
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
  // Leads may only DM other departments' leads (cross-dept); same-dept handled above
  if (a.isLead && b.isLead) return true;
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
      where: { conversation_type: 'group' },
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

  return { ...message, seen: false };
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
    include: { attachments: true, sender: { select: { id: true, name: true } } },
  });

  return messages.reverse().map((m) => ({
    ...m,
    seen: m.sender_user_id !== userId && m.created_at <= latestReadAt,
  }));
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
  // Leads may DM other departments' leads.
  assert(canOpenDirect(lead(1), lead(2)), 'lead ↔ other-dept lead allowed');
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
