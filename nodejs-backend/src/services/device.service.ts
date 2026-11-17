/**
 * device.service.ts — persistence helpers for the device-control feature.
 *
 * Security notes:
 *   - Enrollment tokens are generated with 32 random bytes and only their
 *     SHA-256 hash is stored. The raw token is returned exactly once.
 *   - Machine GUIDs are hashed before they touch the database.
 *   - The service never returns `token_hash` to callers of the REST API.
 */

import { createHash, randomBytes } from 'crypto';
import prisma from '../prisma';

export const ENROLLMENT_DEFAULT_TTL_HOURS = 24;
export const ENROLLMENT_DEFAULT_MAX_USES = 1;
export const MAX_QUEUED_COMMANDS_PER_HEARTBEAT = 20;

export type DeviceRecord = Awaited<ReturnType<typeof prisma.device.create>>;
export type DeviceCommandRecord = Awaited<ReturnType<typeof prisma.deviceCommand.create>>;

export class EnrollmentError extends Error {
  constructor(message = 'Invalid or expired enrollment token.') {
    super(message);
    this.name = 'EnrollmentError';
  }
}

export class DeviceBlockedError extends Error {
  constructor() {
    super('This device has been disabled. Contact an administrator.');
    this.name = 'DeviceBlockedError';
  }
}

export const BLOCKED_DEVICE_STATUSES = new Set(['disabled', 'retired', 'revoked']);

export function isDeviceBlockedStatus(status: string | null | undefined): boolean {
  return !!status && BLOCKED_DEVICE_STATUSES.has(status.trim().toLowerCase());
}

export type DeviceAccessStatus = 'allowed' | 'blocked' | 'missing';

export async function getDeviceAccessStatus(
  deviceId: string
): Promise<DeviceAccessStatus> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { status: true },
  });

  if (!device) return 'missing';
  return isDeviceBlockedStatus(device.status) ? 'blocked' : 'allowed';
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Machine GUIDs are case-insensitive on Windows, so normalise before hashing. */
export function hashMachineGuid(machineGuid: string): string {
  return sha256(machineGuid.trim().toLowerCase());
}

export function hashEnrollmentToken(rawToken: string): string {
  return sha256(rawToken);
}

// ─────────────────────────────────────────
// Enrollment tokens
// ─────────────────────────────────────────

export interface CreatedEnrollmentToken {
  id: string;
  token: string;
  expires_at: Date;
  max_uses: number;
}

export async function createEnrollmentToken(options: {
  createdBy: string;
  expiresInHours?: number;
  maxUses?: number;
}): Promise<CreatedEnrollmentToken> {
  const expiresInHours = options.expiresInHours ?? ENROLLMENT_DEFAULT_TTL_HOURS;
  const maxUses = options.maxUses ?? ENROLLMENT_DEFAULT_MAX_USES;

  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  const record = await prisma.deviceEnrollmentToken.create({
    data: {
      token_hash: hashEnrollmentToken(rawToken),
      created_by: options.createdBy,
      expires_at: expiresAt,
      max_uses: maxUses,
      used_count: 0,
    },
  });

  return {
    id: record.id,
    token: rawToken,
    expires_at: record.expires_at,
    max_uses: record.max_uses,
  };
}

/**
 * Looks up a raw enrollment token. The returned row is internal only — it
 * contains `token_hash`, which must never be serialised to a client.
 */
export async function verifyEnrollmentToken(rawToken: string) {
  if (!rawToken) return null;

  const record = await prisma.deviceEnrollmentToken.findUnique({
    where: { token_hash: hashEnrollmentToken(rawToken) },
  });

  if (!record) return null;
  if (record.revoked_at) return null;
  if (record.expires_at.getTime() <= Date.now()) return null;
  if (record.used_count >= record.max_uses) return null;

  return record;
}

/**
 * Atomically consumes one use of a token. The `used_count < max_uses`
 * condition is part of the UPDATE, so two devices racing for the last use
 * cannot both succeed.
 */
export async function consumeEnrollmentToken(
  tokenId: string,
  maxUses: number,
  deviceId: string
): Promise<boolean> {
  const result = await prisma.deviceEnrollmentToken.updateMany({
    where: {
      id: tokenId,
      revoked_at: null,
      expires_at: { gt: new Date() },
      used_count: { lt: maxUses },
    },
    data: {
      used_count: { increment: 1 },
      used_by_device_id: deviceId,
    },
  });

  return result.count === 1;
}

// ─────────────────────────────────────────
// Enrollment
// ─────────────────────────────────────────

export interface EnrollDeviceInput {
  /** An admin-issued enrollment token, for rollouts that don't wait for a login. */
  token?: string;
  /** The verified user from a login grant. Takes the place of a token. */
  login_user_id?: string;
  device_key: string;
  hostname: string;
  machine_guid: string;
  os_name?: string;
  os_version?: string;
  agent_version?: string;
  ip?: string;
}

export interface EnrollDeviceResult {
  device: DeviceRecord;
}

export async function enrollDevice(input: EnrollDeviceInput): Promise<EnrollDeviceResult> {
  const machineGuidHash = hashMachineGuid(input.machine_guid);
  const loginUserId = input.login_user_id;

  return prisma.$transaction(async (tx) => {
    let enrollment = null;
    if (loginUserId) {
      const user = await tx.user.findUnique({
        where: { id: loginUserId },
        select: { status: true },
      });
      if (!user || user.status !== 'active') throw new EnrollmentError();
    } else {
      enrollment = input.token
        ? await tx.deviceEnrollmentToken.findUnique({
            where: { token_hash: hashEnrollmentToken(input.token) },
          })
        : null;

      if (
        !enrollment ||
        enrollment.revoked_at ||
        enrollment.expires_at.getTime() <= Date.now() ||
        enrollment.used_count >= enrollment.max_uses
      ) {
        throw new EnrollmentError();
      }
    }

    const existing = await tx.device.findFirst({
      where: {
        OR: [{ machine_guid_hash: machineGuidHash }, { device_key: input.device_key }],
      },
    });

    if (existing && isDeviceBlockedStatus(existing.status)) {
      throw new DeviceBlockedError();
    }

    const now = new Date();
    const baseData = {
      device_key: input.device_key,
      hostname: input.hostname,
      machine_guid_hash: machineGuidHash,
      os_name: input.os_name ?? null,
      os_version: input.os_version ?? null,
      agent_version: input.agent_version ?? null,
      last_seen: now,
      last_ip: input.ip ?? null,
    };

    let device: DeviceRecord;

    if (existing) {
      device = await tx.device.update({
        where: { id: existing.id },
        data: {
          ...baseData,
          os_name: input.os_name ?? existing.os_name,
          os_version: input.os_version ?? existing.os_version,
          agent_version: input.agent_version ?? existing.agent_version,
          last_ip: input.ip ?? existing.last_ip,
          // Never silently unblock/disable an existing device.
          status: existing.status === 'pending' ? 'active' : existing.status,
          // The first user owns the PC; only an admin should change that later.
          ...(loginUserId
            ? {
                assigned_user_id: existing.assigned_user_id ?? loginUserId,
                last_user_id: loginUserId,
              }
            : {}),
        },
      });
    } else {
      device = await tx.device.create({
        data: {
          ...baseData,
          status: 'active',
          ...(loginUserId ? { assigned_user_id: loginUserId, last_user_id: loginUserId } : {}),
        },
      });
    }

    if (enrollment) {
      const consumed = await tx.deviceEnrollmentToken.updateMany({
        where: {
          id: enrollment.id,
          revoked_at: null,
          expires_at: { gt: new Date() },
          used_count: { lt: enrollment.max_uses },
        },
        data: {
          used_count: { increment: 1 },
          used_by_device_id: device.id,
        },
      });

      if (consumed.count !== 1) {
        // Another request used the final slot between the read and the update.
        throw new EnrollmentError();
      }
    }

    await tx.deviceAuditLog.create({
      data: {
        actor_id: loginUserId ?? enrollment?.created_by ?? null,
        device_id: device.id,
        action: 'device.enrolled',
        details: {
          hostname: device.hostname,
          ip: input.ip ?? null,
          ...(enrollment ? { enrollment_token_id: enrollment.id } : { method: 'user_login' }),
        },
      },
    });

    return { device };
  });
}

/** Records who just signed in on an enrolled PC. Returns false for an inactive user. */
export async function recordDeviceLogin(
  deviceId: string,
  userId: string,
  ip?: string
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!user || user.status !== 'active') return false;

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { assigned_user_id: true, last_user_id: true },
  });
  if (!device) return false;

  await prisma.device.update({
    where: { id: deviceId },
    data: {
      assigned_user_id: device.assigned_user_id ?? userId,
      last_user_id: userId,
    },
  });

  if (device.last_user_id !== userId) {
    await createAuditLog({
      actorId: userId,
      deviceId,
      action: 'device.user_login',
      details: { previous_user_id: device.last_user_id },
      ip,
    });
  }
  return true;
}

/** Device rows only hold user ids, so admins would otherwise see bare numbers. */
async function withUserNames<T extends { assigned_user_id: string | null; last_user_id: string | null }>(
  devices: T[]
) {
  const ids = [
    ...new Set(devices.flatMap((d) => [d.assigned_user_id, d.last_user_id]).filter(Boolean)),
  ] as string[];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameOf = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  return devices.map((device) => ({
    ...device,
    assigned_user_name: nameOf(device.assigned_user_id),
    last_user_name: nameOf(device.last_user_id),
  }));
}

// ─────────────────────────────────────────
// Heartbeat / commands
// ─────────────────────────────────────────

export interface HeartbeatInput {
  last_user_id?: string;
  agent_version?: string;
  ip?: string;
}

export async function touchDevice(deviceId: string, ip?: string): Promise<void> {
  await prisma.device
    .update({
      where: { id: deviceId },
      data: {
        last_seen: new Date(),
        ...(ip ? { last_ip: ip } : {}),
      },
    })
    .catch(() => {
      /* presence updates must never take down the gateway */
    });
}

export async function claimQueuedCommands(
  deviceId: string
): Promise<DeviceCommandRecord[]> {
  const queued = await prisma.deviceCommand.findMany({
    where: { device_id: deviceId, status: 'queued' },
    orderBy: { created_at: 'asc' },
    take: MAX_QUEUED_COMMANDS_PER_HEARTBEAT,
  });

  if (queued.length === 0) return [];

  const ids = queued.map((command) => command.id);
  await prisma.deviceCommand.updateMany({
    where: { id: { in: ids }, status: 'queued' },
    data: { status: 'sent', sent_at: new Date() },
  });

  return prisma.deviceCommand.findMany({
    where: { id: { in: ids } },
    orderBy: { created_at: 'asc' },
  });
}

export async function processHeartbeat(
  deviceId: string,
  input: HeartbeatInput = {},
  claimCommands = true
): Promise<{ ok: boolean; commands: DeviceCommandRecord[] }> {
  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        last_seen: new Date(),
        ...(input.last_user_id !== undefined ? { last_user_id: input.last_user_id || null } : {}),
        ...(input.agent_version !== undefined
          ? { agent_version: input.agent_version || null }
          : {}),
        ...(input.ip !== undefined ? { last_ip: input.ip || null } : {}),
      },
    });
  } catch (err) {
    if ((err as any)?.code === 'P2025') {
      return { ok: false, commands: [] };
    }
    throw err;
  }

  // The HTTP heartbeat passes false: the service only runs commands that arrive
  // over its socket, so claiming them here would mark them sent and lose them.
  const commands = claimCommands ? await claimQueuedCommands(deviceId) : [];
  return { ok: true, commands };
}

export async function createCommand(options: {
  deviceId: string;
  type: string;
  payload?: unknown;
  createdBy?: string;
}): Promise<DeviceCommandRecord> {
  return prisma.deviceCommand.create({
    data: {
      device_id: options.deviceId,
      type: options.type,
      payload: options.payload as any,
      created_by: options.createdBy ?? null,
    },
  });
}

export async function markCommandSent(commandId: string): Promise<void> {
  await prisma.deviceCommand
    .updateMany({
      where: { id: commandId, status: 'queued' },
      data: { status: 'sent', sent_at: new Date() },
    })
    .catch(() => {});
}

export async function ackCommand(options: {
  deviceId: string;
  commandId: string;
  status?: string;
  result?: unknown;
}): Promise<boolean> {
  const allowed = new Set(['acked', 'completed', 'failed']);
  const status =
    options.status && allowed.has(options.status) ? options.status : 'acked';

  const updated = await prisma.deviceCommand.updateMany({
    where: { id: options.commandId, device_id: options.deviceId },
    data: {
      status,
      ack_at: new Date(),
      ...(options.result !== undefined ? { result: options.result as any } : {}),
    },
  });

  return updated.count === 1;
}

// ─────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────

export async function saveInventory(deviceId: string, snapshot: unknown) {
  return prisma.deviceInventory.create({
    data: {
      device_id: deviceId,
      snapshot: snapshot as any,
    },
  });
}

// ─────────────────────────────────────────
// Remote-control sessions (Phase 4 groundwork)
// ─────────────────────────────────────────

export async function createRemoteControlSession(options: {
  deviceId: string;
  adminId: string;
  reason?: string;
}) {
  return prisma.deviceRemoteSession.create({
    data: {
      device_id: options.deviceId,
      admin_id: options.adminId,
      status: 'requested',
      reason: options.reason ?? null,
    },
  });
}

export async function closeRemoteControlSessions(options: {
  deviceId: string;
  adminId?: string;
}): Promise<number> {
  const closed = await prisma.deviceRemoteSession.updateMany({
    where: {
      device_id: options.deviceId,
      ...(options.adminId ? { admin_id: options.adminId } : {}),
      status: { in: ['requested', 'active'] },
    },
    data: {
      status: 'ended',
      ended_at: new Date(),
    },
  });

  return closed.count;
}

// ─────────────────────────────────────────
// Groups / audit / queries
// ─────────────────────────────────────────

export interface DeviceGroupSummary {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  device_count: number;
  online_count: number;
}

export async function listGroups(): Promise<DeviceGroupSummary[]> {
  const groups = await prisma.deviceGroup.findMany({
    orderBy: { name: 'asc' },
    include: {
      devices: {
        select: { status: true, last_seen: true },
      },
    },
  });

  const onlineCutoff = Date.now() - 3 * 60 * 1000;

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    created_at: group.created_at,
    device_count: group.devices.length,
    online_count: group.devices.filter(
      (device) =>
        !isDeviceBlockedStatus(device.status) &&
        device.last_seen !== null &&
        device.last_seen.getTime() >= onlineCutoff
    ).length,
  }));
}

export async function getGroup(id: string) {
  return prisma.deviceGroup.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
}

export async function createGroup(name: string, description?: string) {
  return prisma.deviceGroup.create({
    data: { name, description: description ?? null },
  });
}

export async function updateGroup(
  id: string,
  data: { name?: string; description?: string | null }
) {
  return prisma.deviceGroup.update({
    where: { id },
    data,
  });
}

export async function deleteGroup(id: string) {
  const group = await prisma.deviceGroup.findUnique({
    where: { id },
    select: {
      name: true,
      _count: { select: { devices: true } },
    },
  });

  if (!group) return null;

  await prisma.deviceGroup.delete({ where: { id } });

  return {
    name: group.name,
    unassigned_devices: group._count.devices,
  };
}

export async function assignDeviceGroup(
  deviceId: string,
  groupId: string | null
) {
  return prisma.device.update({
    where: { id: deviceId },
    data: { group_id: groupId },
    include: {
      group: { select: { id: true, name: true } },
    },
  });
}

export async function listDevices(filters: {
  status?: string;
  group_id?: string;
  search?: string;
}) {
  const where: any = {};

  if (filters.status) where.status = filters.status;
  if (filters.group_id) where.group_id = filters.group_id;

  if (filters.search) {
    where.OR = [
      { hostname: { contains: filters.search, mode: 'insensitive' } },
      { device_key: { contains: filters.search, mode: 'insensitive' } },
      { assigned_user_id: { contains: filters.search, mode: 'insensitive' } },
      { last_user_id: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const devices = await prisma.device.findMany({
    where,
    orderBy: [{ last_seen: 'desc' }, { created_at: 'desc' }],
    include: {
      group: { select: { id: true, name: true } },
    },
    take: 200,
  });
  return withUserNames(devices);
}

export async function getDevice(id: string) {
  const device = await prisma.device.findUnique({
    where: { id },
    include: {
      group: { select: { id: true, name: true } },
      inventory: { orderBy: { collected_at: 'desc' }, take: 1 },
      commands: { orderBy: { created_at: 'desc' }, take: 10 },
      policy_statuses: {
        orderBy: { checked_at: 'desc' },
        take: 5,
        include: {
          policy: { select: { id: true, name: true, version: true, status: true } },
        },
      },
    },
  });
  return device ? (await withUserNames([device]))[0] : null;
}

export async function createAuditLog(options: {
  actorId?: string;
  deviceId?: string;
  action: string;
  details?: unknown;
  ip?: string;
}) {
  try {
    return await prisma.deviceAuditLog.create({
      data: {
        actor_id: options.actorId ?? null,
        device_id: options.deviceId ?? null,
        action: options.action,
        details: options.details as any,
        ip: options.ip ?? null,
      },
    });
  } catch (err) {
    // Audit logging must not turn an otherwise successful action into a 500.
    console.error('[Devices] failed to write device audit log:', err);
    return null;
  }
}

export async function listAuditLogs(options: {
  deviceId?: string;
  limit?: number;
}) {
  return prisma.deviceAuditLog.findMany({
    where: options.deviceId ? { device_id: options.deviceId } : {},
    orderBy: { created_at: 'desc' },
    take: options.limit ?? 100,
    include: {
      device: { select: { id: true, hostname: true, device_key: true } },
    },
  });
}
