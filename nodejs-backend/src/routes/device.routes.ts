/**
 * device.routes.ts — REST surface for managed devices.
 *
 * Admin routes (/api/devices) require a verified user session plus an admin or
 * superadmin role. They deliberately do NOT accept the legacy unsigned
 * `X-Admin-Id` header.
 *
 * Agent routes (/api/device) use the device JWT issued at enrollment. The only
 * unauthenticated endpoint is /enroll, which needs a signed user login grant
 * (the normal path) or an expiring admin enrollment token, plus a light
 * in-memory per-IP rate limit. /login-grant is the one route here that takes a
 * user session instead of a device token.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { requireUser, signCallToken } from '../middleware/requireUser';
import { requireRole } from '../middleware/requireRole';
import {
  DEVICE_LOGIN_GRANT_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  requireActiveDevice,
  requireDeviceToken,
  signDeviceLoginGrant,
  signDeviceToken,
  verifyDeviceLoginGrant,
} from '../middleware/requireDeviceToken';
import { getDeviceGateway } from '../gateways/device.gateway';
import {
  DeviceBlockedError,
  EnrollmentError,
  ackCommand,
  assignDeviceGroup,
  closeRemoteControlSessions,
  createAuditLog,
  createCommand,
  createEnrollmentToken,
  createGroup,
  createRemoteControlSession,
  deleteGroup,
  enrollDevice,
  getDevice,
  getGroup,
  listAuditLogs,
  listDevices,
  listGroups,
  markCommandSent,
  processHeartbeat,
  recordDeviceLogin,
  saveInventory,
  updateGroup,
} from '../services/device.service';
import {
  POLICY_REPORT_STATUSES,
  POLICY_STATUSES,
  PolicyConfigError,
  createPolicy,
  createPolicyAssignment,
  deletePolicy,
  deletePolicyAssignment,
  getEffectivePolicyForDevice,
  getPolicy,
  listPolicies,
  listPolicyStatuses,
  listRecoveryKeys,
  recordPolicyStatus,
  saveRecoveryKey,
  updatePolicy,
} from '../services/device-policy.service';

import {
  SOFTWARE_DIR,
  SOFTWARE_INSTALL_COMMAND,
  SoftwarePackageError,
  deletePackage,
  deviceMayDownload,
  getPackage,
  listInstalls,
  listPackages,
  resolveInstallTargets,
  storePackage,
} from '../services/device-software.service';

export const adminRouter = Router();
export const agentRouter = Router();

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch((err) => {
      console.error('[Devices] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

function actingUser(req: Request): { userId: string; name: string; role: string } {
  const user = (req as any).user || {};
  return {
    userId: String(user.userId || ''),
    name: String(user.name || ''),
    role: String(user.role || ''),
  };
}

function requestIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

function readRequiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function readOptionalString(
  value: unknown,
  maxLength: number
): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function readInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (value === undefined || value === null) return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function readLimit(value: unknown, fallback: number, max: number): number {
  const parsed = readInt(value, fallback, 1, max);
  return parsed ?? fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'boolean' ? value : null;
}

function jsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────
// Admin API — /api/devices
// ─────────────────────────────────────────

adminRouter.use(requireUser, requireRole('admin', 'superadmin'));

adminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : undefined;
    const groupId =
      typeof req.query.group_id === 'string' && req.query.group_id.trim()
        ? req.query.group_id.trim()
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const devices = await listDevices({ status, group_id: groupId, search });
    res.json({ devices });
  })
);

adminRouter.post(
  '/enrollment-tokens',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const expiresInHours = readInt(req.body?.expires_in_hours, 24, 1, 720);
    const maxUses = readInt(req.body?.max_uses, 1, 1, 100);

    if (expiresInHours === null || maxUses === null) {
      res.status(400).json({
        error:
          'expires_in_hours must be 1-720 and max_uses must be 1-100.',
      });
      return;
    }

    const created = await createEnrollmentToken({
      createdBy: user.userId,
      expiresInHours,
      maxUses,
    });

    await createAuditLog({
      actorId: user.userId,
      action: 'enrollment_token.created',
      details: {
        enrollment_token_id: created.id,
        expires_at: created.expires_at.toISOString(),
        max_uses: created.max_uses,
      },
      ip: requestIp(req),
    });

    // The raw token is returned exactly once. Only its hash is stored.
    res.status(201).json({
      id: created.id,
      token: created.token,
      expires_at: created.expires_at,
      max_uses: created.max_uses,
    });
  })
);

adminRouter.get(
  '/policies',
  asyncHandler(async (_req, res) => {
    const policies = await listPolicies();
    res.json({ policies });
  })
);

adminRouter.post(
  '/policies',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const name = readRequiredString(req.body?.name, 120);
    const status =
      req.body?.status === undefined
        ? 'draft'
        : readRequiredString(req.body?.status, 20);

    if (!name) {
      res.status(400).json({ error: 'name is required (max 120 chars).' });
      return;
    }
    if (!status || !POLICY_STATUSES.has(status)) {
      res.status(400).json({ error: 'status must be draft, active, or disabled.' });
      return;
    }
    if (jsonSize(req.body?.config) > 64 * 1024) {
      res.status(400).json({ error: 'config is too large (max 64 KB).' });
      return;
    }

    try {
      const policy = await createPolicy({
        name,
        config: req.body?.config,
        status,
        createdBy: user.userId,
      });

      await createAuditLog({
        actorId: user.userId,
        action: 'policy.created',
        details: {
          policy_id: policy.id,
          name: policy.name,
          status: policy.status,
          version: policy.version,
        },
        ip: requestIp(req),
      });

      res.status(201).json({ policy });
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  })
);

adminRouter.get(
  '/policies/:id',
  asyncHandler(async (req, res) => {
    const policy = await getPolicy(String(req.params.id || ''));
    if (!policy) {
      res.status(404).json({ error: 'Policy not found.' });
      return;
    }
    res.json({ policy });
  })
);

adminRouter.patch(
  '/policies/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const policyId = String(req.params.id || '');
    const hasName = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'name');
    const hasConfig = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'config');
    const hasStatus = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status');

    if (!hasName && !hasConfig && !hasStatus) {
      res.status(400).json({ error: 'Provide name, config, or status to update.' });
      return;
    }

    const changes: { name?: string; config?: unknown; status?: string } = {};

    if (hasName) {
      const name = readRequiredString(req.body?.name, 120);
      if (!name) {
        res.status(400).json({ error: 'name must be 1-120 characters.' });
        return;
      }
      changes.name = name;
    }

    if (hasStatus) {
      const status = readRequiredString(req.body?.status, 20);
      if (!status || !POLICY_STATUSES.has(status)) {
        res.status(400).json({ error: 'status must be draft, active, or disabled.' });
        return;
      }
      changes.status = status;
    }

    if (hasConfig) {
      if (jsonSize(req.body?.config) > 64 * 1024) {
        res.status(400).json({ error: 'config is too large (max 64 KB).' });
        return;
      }
      changes.config = req.body?.config;
    }

    try {
      const policy = await updatePolicy(policyId, changes, user.userId);

      await createAuditLog({
        actorId: user.userId,
        action: 'policy.updated',
        details: {
          policy_id: policy.id,
          name: policy.name,
          status: policy.status,
          version: policy.version,
          changed: {
            name: hasName,
            config: hasConfig,
            status: hasStatus,
          },
        },
        ip: requestIp(req),
      });

      res.json({ policy });
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if ((err as any)?.code === 'P2025') {
        res.status(404).json({ error: 'Policy not found.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.delete(
  '/policies/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const policyId = String(req.params.id || '');

    try {
      const deleted = await deletePolicy(policyId);
      if (!deleted) {
        res.status(404).json({ error: 'Policy not found.' });
        return;
      }

      await createAuditLog({
        actorId: user.userId,
        action: 'policy.deleted',
        details: { policy_id: policyId, name: deleted.name, status: deleted.status },
        ip: requestIp(req),
      });

      res.json({ deleted: true, ...deleted });
    } catch (err) {
      if ((err as any)?.code === 'P2025') {
        res.status(404).json({ error: 'Policy not found.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.post(
  '/policies/:id/assignments',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const policyId = String(req.params.id || '');
    const groupId = readOptionalString(req.body?.group_id, 100);
    const deviceId = readOptionalString(req.body?.device_id, 100);
    const priority = readInt(req.body?.priority, 100, 1, 1000);
    const enabled = readBoolean(req.body?.enabled, true);

    if (groupId === null || deviceId === null || priority === null || enabled === null) {
      res.status(400).json({ error: 'Invalid assignment payload.' });
      return;
    }
    if ((groupId && deviceId) || (!groupId && !deviceId)) {
      res.status(400).json({ error: 'Provide exactly one of group_id or device_id.' });
      return;
    }

    try {
      const assignment = await createPolicyAssignment({
        policyId,
        groupId,
        deviceId,
        priority,
        enabled,
      });

      if ('missing' in assignment) {
        const labels = {
          policy: 'Policy not found.',
          group: 'Group not found.',
          device: 'Device not found.',
        };
        res.status(404).json({ error: labels[assignment.missing] });
        return;
      }

      await createAuditLog({
        actorId: user.userId,
        ...(deviceId ? { deviceId } : {}),
        action: 'policy.assignment_changed',
        details: {
          policy_id: policyId,
          assignment_id: assignment.id,
          target: deviceId ? { device_id: deviceId } : { group_id: groupId },
          priority,
          enabled,
        },
        ip: requestIp(req),
      });

      res.status(201).json({ assignment });
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if ((err as any)?.code === 'P2002') {
        res.status(409).json({ error: 'That assignment already exists.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.delete(
  '/policies/:id/assignments/:assignmentId',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const policyId = String(req.params.id || '');
    const assignmentId = String(req.params.assignmentId || '');
    const deleted = await deletePolicyAssignment(policyId, assignmentId);

    if (!deleted) {
      res.status(404).json({ error: 'Assignment not found.' });
      return;
    }

    await createAuditLog({
      actorId: user.userId,
      action: 'policy.assignment_removed',
      details: { policy_id: policyId, assignment_id: assignmentId },
      ip: requestIp(req),
    });

    res.json({ deleted: true });
  })
);

adminRouter.get(
  '/policies/:id/statuses',
  asyncHandler(async (req, res) => {
    const policyId = String(req.params.id || '');
    const limit = readLimit(req.query.limit, 100, 500);
    const statuses = await listPolicyStatuses({ policyId, limit });
    res.json({ statuses });
  })
);

adminRouter.get(
  '/software',
  asyncHandler(async (_req, res) => {
    res.json({ packages: await listPackages() });
  })
);

// Responding before the upload is read makes Node close the socket, and browsers then
// report an aborted connection instead of the error. Drain the body first when it is
// still readable; after a failed stream (e.g. the size cap) the socket is gone anyway.
function rejectUpload(req: Request, res: Response, status: number, error: string) {
  if (req.readableEnded || req.destroyed) {
    res.set('Connection', 'close');
    res.status(status).json({ error });
    return;
  }
  req.once('end', () => res.status(status).json({ error }));
  req.resume();
}

adminRouter.post(
  '/software',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const name = readRequiredString(req.query.name, 120);
    const filename = readRequiredString(req.query.filename, 255);
    const rawArgs = req.query.silent_args;
    const silentArgs = typeof rawArgs === 'string' ? rawArgs.trim() : '';

    if (!req.is('application/octet-stream')) {
      rejectUpload(req, res, 415, 'Upload the installer as application/octet-stream.');
      return;
    }
    if (!name || !filename) {
      rejectUpload(req, res, 400, 'name and filename are required.');
      return;
    }
    // Control characters have no place in installer switches.
    if (silentArgs.length > 500 || /[\x00-\x1f\x7f]/.test(silentArgs)) {
      rejectUpload(req, res, 400, 'Install switches must be plain text, at most 500 characters.');
      return;
    }

    try {
      const software = await storePackage(req, {
        name,
        filename: filename.split(/[\\/]/).pop() as string,
        silentArgs,
        createdBy: user.userId,
      });

      await createAuditLog({
        actorId: user.userId,
        action: 'software.uploaded',
        details: {
          package_id: software.id,
          name: software.name,
          sha256: software.sha256,
          size_bytes: software.size_bytes,
        },
        ip: requestIp(req),
      });

      res.status(201).json({ package: software });
    } catch (err) {
      if (err instanceof SoftwarePackageError) {
        rejectUpload(req, res, err.status, err.message);
        return;
      }
      throw err;
    }
  })
);

adminRouter.get(
  '/software/installs',
  asyncHandler(async (req, res) => {
    res.json({ installs: await listInstalls(readLimit(req.query.limit, 100, 500)) });
  })
);

adminRouter.delete(
  '/software/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const deleted = await deletePackage(String(req.params.id || ''));
    if (!deleted) {
      res.status(404).json({ error: 'Package not found.' });
      return;
    }

    await createAuditLog({
      actorId: user.userId,
      action: 'software.deleted',
      details: { package_id: deleted.id, name: deleted.name, sha256: deleted.sha256 },
      ip: requestIp(req),
    });

    res.json({ deleted: true });
  })
);

adminRouter.post(
  '/software/:id/install',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const software = await getPackage(String(req.params.id || ''));
    if (!software) {
      res.status(404).json({ error: 'Package not found.' });
      return;
    }

    const groupId = readOptionalString(req.body?.group_id, 100);
    const rawDeviceIds = req.body?.device_ids;
    const deviceIds =
      Array.isArray(rawDeviceIds) && rawDeviceIds.every((id) => typeof id === 'string')
        ? (rawDeviceIds as string[])
        : null;
    const hasDevices = Boolean(deviceIds?.length);

    if (groupId === null || Boolean(groupId) === hasDevices) {
      res.status(400).json({ error: 'Provide either device_ids or group_id.' });
      return;
    }
    if ((deviceIds?.length ?? 0) > 500) {
      res.status(400).json({ error: 'At most 500 devices at a time.' });
      return;
    }

    const targets = await resolveInstallTargets({
      deviceIds: deviceIds ?? undefined,
      groupId: groupId ?? undefined,
    });
    if (targets.length === 0) {
      res.status(404).json({ error: 'No matching devices.' });
      return;
    }

    const gateway = getDeviceGateway();
    const payload = {
      package_id: software.id,
      name: software.name,
      kind: software.kind,
      sha256: software.sha256,
      silent_args: software.silent_args,
    };
    let delivered = 0;

    for (const target of targets) {
      const command = await createCommand({
        deviceId: target.id,
        type: SOFTWARE_INSTALL_COMMAND,
        payload,
        createdBy: user.userId,
      });
      const sent = gateway
        ? gateway.sendToDevice(target.id, {
            type: 'DEVICE_COMMAND',
            commandId: command.id,
            commandType: command.type,
            payload: command.payload,
            createdAt: command.created_at,
          })
        : false;
      if (sent) {
        delivered += 1;
        await markCommandSent(command.id);
      }

      await createAuditLog({
        actorId: user.userId,
        deviceId: target.id,
        action: 'software.install_requested',
        details: {
          command_id: command.id,
          package_id: software.id,
          name: software.name,
          sha256: software.sha256,
          delivered: sent,
        },
        ip: requestIp(req),
      });
    }

    res.status(201).json({ queued: targets.length, delivered });
  })
);

adminRouter.get(
  '/groups',
  asyncHandler(async (_req, res) => {
    const groups = await listGroups();
    res.json({ groups });
  })
);

adminRouter.post(
  '/groups',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const name = readRequiredString(req.body?.name, 120);
    const description = readOptionalString(req.body?.description, 1000);

    if (!name || description === null) {
      res.status(400).json({ error: 'name is required (max 120 chars).' });
      return;
    }

    try {
      const group = await createGroup(name, description);

      await createAuditLog({
        actorId: user.userId,
        action: 'group.created',
        details: { group_id: group.id, name: group.name },
        ip: requestIp(req),
      });

      res.status(201).json({ group: { ...group, device_count: 0, online_count: 0 } });
    } catch (err) {
      if ((err as any)?.code === 'P2002') {
        res.status(409).json({ error: 'A group with that name already exists.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.patch(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const groupId = String(req.params.id || '');
    const hasName = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'name');
    const hasDescription = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'description'
    );

    if (!hasName && !hasDescription) {
      res.status(400).json({ error: 'Provide name or description to update.' });
      return;
    }

    const data: { name?: string; description?: string | null } = {};

    if (hasName) {
      const name = readRequiredString(req.body?.name, 120);
      if (!name) {
        res.status(400).json({ error: 'name must be 1-120 characters.' });
        return;
      }
      data.name = name;
    }

    if (hasDescription) {
      if (req.body?.description === null || req.body?.description === '') {
        data.description = null;
      } else {
        const description = readOptionalString(req.body?.description, 1000);
        if (description === null) {
          res.status(400).json({ error: 'description must be at most 1000 characters.' });
          return;
        }
        data.description = description;
      }
    }

    try {
      const existing = await getGroup(groupId);
      if (!existing) {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }

      const group = await updateGroup(groupId, data);

      await createAuditLog({
        actorId: user.userId,
        action: 'group.updated',
        details: {
          group_id: group.id,
          changes: data,
        },
        ip: requestIp(req),
      });

      res.json({ group });
    } catch (err) {
      if ((err as any)?.code === 'P2002') {
        res.status(409).json({ error: 'A group with that name already exists.' });
        return;
      }
      if ((err as any)?.code === 'P2025') {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.delete(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const groupId = String(req.params.id || '');

    try {
      const deleted = await deleteGroup(groupId);
      if (!deleted) {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }

      await createAuditLog({
        actorId: user.userId,
        action: 'group.deleted',
        details: {
          group_id: groupId,
          name: deleted.name,
          unassigned_devices: deleted.unassigned_devices,
        },
        ip: requestIp(req),
      });

      res.json({ deleted: true, ...deleted });
    } catch (err) {
      if ((err as any)?.code === 'P2025') {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.post(
  '/:id/commands',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const deviceId = String(req.params.id || '');
    const type = readRequiredString(req.body?.type, 40);
    const allowedTypes = ['lock', 'restart', 'shutdown'];

    if (!type || !allowedTypes.includes(type)) {
      res.status(400).json({
        error: "type must be one of 'lock', 'restart' or 'shutdown'.",
      });
      return;
    }

    if (req.body?.payload !== undefined) {
      try {
        if (JSON.stringify(req.body.payload).length > 100_000) {
          res.status(400).json({ error: 'payload is too large.' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'payload must be valid JSON.' });
        return;
      }
    }

    const device = await getDevice(deviceId);
    if (!device) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    const command = await createCommand({
      deviceId,
      type,
      payload: req.body?.payload,
      createdBy: user.userId,
    });

    const gateway = getDeviceGateway();
    const delivered = gateway
      ? gateway.sendToDevice(deviceId, {
          type: 'DEVICE_COMMAND',
          commandId: command.id,
          commandType: command.type,
          payload: command.payload,
          createdAt: command.created_at,
        })
      : false;

    if (delivered) await markCommandSent(command.id);

    await createAuditLog({
      actorId: user.userId,
      deviceId,
      action: 'device.command.created',
      details: { command_id: command.id, type, delivered },
      ip: requestIp(req),
    });

    res.status(201).json({ command, delivered });
  })
);

adminRouter.post(
  '/:id/remote-control',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const deviceId = String(req.params.id || '');
    const action = readRequiredString(req.body?.action, 20);
    const reason = readOptionalString(req.body?.reason, 1000);

    if (action !== 'start' && action !== 'stop') {
      res.status(400).json({ error: "action must be 'start' or 'stop'." });
      return;
    }
    if (reason === null) {
      res.status(400).json({ error: 'reason must be a string (max 1000 chars).' });
      return;
    }

    const device = await getDevice(deviceId);
    if (!device) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    const gateway = getDeviceGateway();

    if (action === 'start') {
      const session = await createRemoteControlSession({
        deviceId,
        adminId: user.userId,
        reason,
      });

      const command = await createCommand({
        deviceId,
        type: 'remote_control_start',
        payload: { sessionId: session.id, reason: reason ?? null },
        createdBy: user.userId,
      });

      const delivered = gateway
        ? gateway.sendToDevice(deviceId, {
            type: 'REMOTE_CONTROL_START',
            commandId: command.id,
            sessionId: session.id,
            adminId: user.userId,
            reason: reason ?? null,
          })
        : false;

      if (delivered) await markCommandSent(command.id);

      await createAuditLog({
        actorId: user.userId,
        deviceId,
        action: 'device.remote_control.start',
        details: { session_id: session.id, reason: reason ?? null, delivered },
        ip: requestIp(req),
      });

      res.status(201).json({ session, command, delivered });
      return;
    }

    const closedSessions = await closeRemoteControlSessions({ deviceId });

    const command = await createCommand({
      deviceId,
      type: 'remote_control_stop',
      payload: { closed_sessions: closedSessions },
      createdBy: user.userId,
    });

    const delivered = gateway
      ? gateway.sendToDevice(deviceId, {
          type: 'REMOTE_CONTROL_STOP',
          commandId: command.id,
          adminId: user.userId,
        })
      : false;

    if (delivered) await markCommandSent(command.id);

    await createAuditLog({
      actorId: user.userId,
      deviceId,
      action: 'device.remote_control.stop',
      details: { closed_sessions: closedSessions, delivered },
      ip: requestIp(req),
    });

    res.json({ closed_sessions: closedSessions, command, delivered });
  })
);

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const deviceId =
      typeof req.query.device_id === 'string' && req.query.device_id.trim()
        ? req.query.device_id.trim()
        : undefined;
    const limit = readLimit(req.query.limit, 100, 500);

    const logs = await listAuditLogs({ deviceId, limit });
    res.json({ logs });
  })
);

adminRouter.post(
  '/admin-ws-token',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const token = signCallToken({
      id: user.userId,
      name: user.name || user.userId,
      role: user.role,
    }, (req as any).user?.sessionId);

    res.json({ token, expiresIn: 300 });
  })
);

adminRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const deviceId = String(req.params.id || '');

    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'group_id')) {
      res.status(400).json({ error: 'Provide group_id to update.' });
      return;
    }

    const rawGroupId = req.body?.group_id;
    let groupId: string | null;

    if (rawGroupId === null || rawGroupId === '') {
      groupId = null;
    } else if (
      typeof rawGroupId === 'string' &&
      rawGroupId.trim() &&
      rawGroupId.trim().length <= 100
    ) {
      groupId = rawGroupId.trim();
    } else {
      res.status(400).json({ error: 'group_id must be a string or null.' });
      return;
    }

    const device = await getDevice(deviceId);
    if (!device) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    if (groupId) {
      const group = await getGroup(groupId);
      if (!group) {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }
    }

    const previousGroupId = device.group_id ?? null;

    try {
      const updated = await assignDeviceGroup(deviceId, groupId);

      await createAuditLog({
        actorId: user.userId,
        deviceId,
        action: 'device.group_changed',
        details: {
          group_id: groupId,
          group_name: updated.group?.name ?? null,
          previous_group_id: previousGroupId,
        },
        ip: requestIp(req),
      });

      res.json({ device: updated });
    } catch (err) {
      if ((err as any)?.code === 'P2025') {
        res.status(404).json({ error: 'Device not found.' });
        return;
      }
      if ((err as any)?.code === 'P2003') {
        res.status(404).json({ error: 'Group not found.' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.get(
  '/:id/recovery-keys',
  asyncHandler(async (req, res) => {
    const user = actingUser(req);
    const deviceId = String(req.params.id || '');
    const device = await getDevice(deviceId);

    if (!device) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    const keys = await listRecoveryKeys(deviceId);

    await createAuditLog({
      actorId: user.userId,
      deviceId,
      action: 'device.recovery_key.viewed',
      details: { count: keys.length },
      ip: requestIp(req),
    });

    res.set('Cache-Control', 'no-store');
    res.json({ keys });
  })
);

adminRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const deviceId = String(req.params.id || '');
    const device = await getDevice(deviceId);

    if (!device) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    res.json({ device });
  })
);

// ─────────────────────────────────────────
// Agent API — /api/device
// ─────────────────────────────────────────

const ENROLL_RATE_LIMIT = 20;
const ENROLL_WINDOW_MS = 60_000;
const enrollAttempts: Map<string, number[]> = new Map();

function isEnrollmentRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - ENROLL_WINDOW_MS;
  const recent = (enrollAttempts.get(ip) || []).filter((t) => t > cutoff);

  if (recent.length >= ENROLL_RATE_LIMIT) {
    enrollAttempts.set(ip, recent);
    return true;
  }

  recent.push(now);
  enrollAttempts.set(ip, recent);
  return false;
}

agentRouter.post(
  '/enroll',
  asyncHandler(async (req, res) => {
    const ip = requestIp(req);

    if (isEnrollmentRateLimited(ip)) {
      res.status(429).json({ error: 'Too many enrollment attempts. Try again later.' });
      return;
    }

    const token = readRequiredString(req.body?.token, 500);
    const loginGrant = readRequiredString(req.body?.login_grant, 2000);
    const deviceKey = readRequiredString(req.body?.device_key, 200);
    const hostname = readRequiredString(req.body?.hostname, 200);
    const machineGuid = readRequiredString(req.body?.machine_guid, 200);
    const osName = readOptionalString(req.body?.os_name, 200);
    const osVersion = readOptionalString(req.body?.os_version, 200);
    const agentVersion = readOptionalString(req.body?.agent_version, 100);

    if (
      (!token && !loginGrant) ||
      !deviceKey ||
      !hostname ||
      !machineGuid ||
      osName === null ||
      osVersion === null ||
      agentVersion === null
    ) {
      res.status(400).json({ error: 'Invalid enrollment request.' });
      return;
    }

    const loginUserId = loginGrant ? verifyDeviceLoginGrant(loginGrant) : null;
    if (loginGrant && !loginUserId) {
      res.status(401).json({ error: 'Invalid or expired login grant.' });
      return;
    }

    try {
      const { device } = await enrollDevice({
        ...(loginUserId ? { login_user_id: loginUserId } : { token: token as string }),
        device_key: deviceKey,
        hostname,
        machine_guid: machineGuid,
        os_name: osName,
        os_version: osVersion,
        agent_version: agentVersion,
        ip,
      });

      res.status(201).json({
        device_id: device.id,
        device_token: signDeviceToken(device.id),
        expires_in: DEVICE_TOKEN_TTL_SECONDS,
      });
    } catch (err) {
      if (err instanceof DeviceBlockedError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof EnrollmentError) {
        res.status(401).json({ error: 'Invalid or expired enrollment token.' });
        return;
      }
      if ((err as any)?.code === 'P2002') {
        res.status(409).json({ error: 'Device identity conflict.' });
        return;
      }
      console.error('[Devices] enrollment failed:', err);
      res.status(500).json({ error: 'Enrollment failed.' });
    }
  })
);

agentRouter.post(
  '/login-grant',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json({
      grant: signDeviceLoginGrant(actingUser(req).userId),
      expires_in: DEVICE_LOGIN_GRANT_TTL_SECONDS,
    });
  })
);

agentRouter.post(
  '/user-login',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const grant = readRequiredString(req.body?.login_grant, 2000);
    const userId = grant ? verifyDeviceLoginGrant(grant) : null;

    // 400, not 401: the device token was fine, so the service mustn't re-enroll over this.
    if (!userId || !(await recordDeviceLogin(deviceId, userId, requestIp(req)))) {
      res.status(400).json({ error: 'Invalid or expired login grant.' });
      return;
    }

    res.json({ ok: true });
  })
);

agentRouter.post(
  '/token/refresh',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    res.json({
      device_token: signDeviceToken(deviceId),
      expires_in: DEVICE_TOKEN_TTL_SECONDS,
    });
  })
);

agentRouter.post(
  '/heartbeat',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const lastUserId = readOptionalString(req.body?.last_user_id, 100);
    const agentVersion = readOptionalString(req.body?.agent_version, 100);
    const bodyIp = readOptionalString(req.body?.ip, 100);

    if (lastUserId === null || agentVersion === null || bodyIp === null) {
      res.status(400).json({ error: 'Invalid heartbeat payload.' });
      return;
    }

    const result = await processHeartbeat(
      deviceId,
      {
        last_user_id: lastUserId,
        agent_version: agentVersion,
        ip: bodyIp ?? requestIp(req),
      },
      false
    );

    if (!result.ok) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    res.json({ ok: true, commands: result.commands });
  })
);

agentRouter.post(
  '/inventory',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const snapshot = req.body?.snapshot;

    if (!isJsonObject(snapshot)) {
      res.status(400).json({ error: 'snapshot must be a JSON object.' });
      return;
    }

    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'snapshot is too large (max 5 MB).' });
      return;
    }

    const saved = await saveInventory(deviceId, snapshot);
    res.status(201).json({
      ok: true,
      id: saved.id,
      collected_at: saved.collected_at,
    });
  })
);

agentRouter.get(
  '/policy',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const effective = await getEffectivePolicyForDevice(deviceId);

    if (!effective) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }

    res.json({ policy: effective.policy });
  })
);

agentRouter.get(
  '/software/:id/download',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const software = await getPackage(String(req.params.id || ''));

    if (!software || !(await deviceMayDownload(deviceId, software.id))) {
      res.status(404).json({ error: 'Package not found.' });
      return;
    }

    res.sendFile(software.id, { root: SOFTWARE_DIR });
  })
);

agentRouter.post(
  '/commands/:id/result',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const status = req.body?.status;

    if (status !== 'completed' && status !== 'failed') {
      res.status(400).json({ error: 'status must be completed or failed.' });
      return;
    }
    if (jsonSize(req.body?.result) > 16 * 1024) {
      res.status(413).json({ error: 'result is too large.' });
      return;
    }

    const saved = await ackCommand({
      deviceId,
      commandId: String(req.params.id || ''),
      status,
      result: req.body?.result,
    });

    if (!saved) {
      res.status(404).json({ error: 'Command not found.' });
      return;
    }
    res.json({ ok: true });
  })
);

// The request audit middleware in index.ts skips this path: the body is a secret.
agentRouter.post(
  '/recovery-key',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const protectorId = req.body?.protector_id;
    const recoveryPassword = req.body?.recovery_password;

    if (
      typeof protectorId !== 'string' ||
      !/^\{[0-9A-Fa-f-]{36}\}$/.test(protectorId) ||
      typeof recoveryPassword !== 'string' ||
      !/^\d{6}(-\d{6}){7}$/.test(recoveryPassword)
    ) {
      res.status(400).json({ error: 'Invalid recovery key.' });
      return;
    }

    await saveRecoveryKey(deviceId, protectorId, recoveryPassword);

    await createAuditLog({
      deviceId,
      action: 'device.recovery_key.stored',
      details: { protector_id: protectorId },
      ip: requestIp(req),
    });

    res.status(201).json({ ok: true });
  })
);

agentRouter.post(
  '/policy/status',
  requireDeviceToken,
  requireActiveDevice,
  asyncHandler(async (req, res) => {
    const deviceId = (req as any).device?.deviceId as string;
    const policyId = readRequiredString(req.body?.policy_id, 100);
    const policyVersion = readInt(req.body?.policy_version, 0, 1, 1_000_000);
    const status = readRequiredString(req.body?.status, 40);
    const applied = readBoolean(req.body?.applied, false);

    if (!policyId || policyVersion === null || policyVersion < 1) {
      res.status(400).json({ error: 'policy_id and policy_version are required.' });
      return;
    }
    if (!status || !POLICY_REPORT_STATUSES.has(status)) {
      res.status(400).json({
        error: 'status must be compliant, non_compliant, applied, or failed.',
      });
      return;
    }
    if (applied === null) {
      res.status(400).json({ error: 'applied must be a boolean.' });
      return;
    }
    if (jsonSize(req.body?.checks) > 256 * 1024 || jsonSize(req.body?.errors) > 256 * 1024) {
      res.status(413).json({ error: 'Policy status details are too large.' });
      return;
    }

    const policy = await getPolicy(policyId);
    if (!policy || policy.status !== 'active') {
      res.status(404).json({ error: 'Active policy not found.' });
      return;
    }

    try {
      const saved = await recordPolicyStatus({
        deviceId,
        policyId,
        policyVersion,
        status,
        applied,
        checks: req.body?.checks,
        errors: req.body?.errors,
      });

      res.status(201).json({
        ok: true,
        status: saved.status,
        checked_at: saved.checked_at,
      });
    } catch (err) {
      if ((err as any)?.code === 'P2003') {
        res.status(404).json({ error: 'Policy not found.' });
        return;
      }
      throw err;
    }
  })
);

export default adminRouter;
