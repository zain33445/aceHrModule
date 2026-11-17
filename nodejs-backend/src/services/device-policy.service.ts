/**
 * Device policy definitions, assignments, and compliance reporting.
 *
 * Phase 2 currently supports one policy type: a Windows security baseline.
 * The service normalises every config before it is stored or sent to a device
 * so the Windows agent never receives unvalidated values that it interpolates
 * into PowerShell.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { resolveSecret } from '../config/env';
import prisma from '../prisma';

const RECOVERY_KEY = createHash('sha256')
  .update(
    resolveSecret(
      'DEVICE_RECOVERY_KEY_SECRET',
      'dev-only-device-recovery-key-secret-do-not-use-in-production'
    )
  )
  .digest();

/** AES-256-GCM, stored as base64 `iv.tag.ciphertext`. */
export function encryptRecoveryPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', RECOVERY_KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
}

export function decryptRecoveryPassword(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', RECOVERY_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export async function saveRecoveryKey(
  deviceId: string,
  protectorId: string,
  recoveryPassword: string
) {
  const encrypted_key = encryptRecoveryPassword(recoveryPassword);
  return prisma.deviceRecoveryKey.upsert({
    where: {
      device_id_protector_id: { device_id: deviceId, protector_id: protectorId },
    },
    create: { device_id: deviceId, protector_id: protectorId, encrypted_key },
    update: { encrypted_key },
    select: { id: true },
  });
}

export async function listRecoveryKeys(deviceId: string) {
  const rows = await prisma.deviceRecoveryKey.findMany({
    where: { device_id: deviceId },
    orderBy: { updated_at: 'desc' },
  });
  return rows.map((row) => ({
    protector_id: row.protector_id,
    recovery_password: decryptRecoveryPassword(row.encrypted_key),
    updated_at: row.updated_at,
  }));
}

export const SECURITY_BASELINE_TYPE = 'security_baseline';
export const POLICY_STATUSES = new Set(['draft', 'active', 'disabled']);
export const POLICY_REPORT_STATUSES = new Set([
  'compliant',
  'non_compliant',
  'applied',
  'failed',
]);

export type PolicyMode = 'audit' | 'enforce';
export type BitLockerMethod = 'XtsAes256' | 'XtsAes128' | 'Aes256' | 'Aes128';
export type FirewallProfile = 'domain' | 'private' | 'public';

export interface SecurityBaselineConfig {
  mode: PolicyMode;
  bitlocker: {
    enabled: boolean;
    encryption_method: BitLockerMethod;
  };
  firewall: {
    enabled: boolean;
    profiles: FirewallProfile[];
  };
  screen_lock: {
    enabled: boolean;
    timeout_minutes: number;
  };
  usb_storage: {
    enabled: boolean;
  };
  local_admin: {
    enabled: boolean;
    disable_builtin_administrator: boolean;
    remove_other_admins: boolean;
    allowed_admins: string[];
  };
  password_policy: {
    enabled: boolean;
    min_length: number;
    max_age_days: number;
    lockout_threshold: number;
  };
  windows_update: {
    enabled: boolean;
    auto_update: boolean;
    defer_quality_days: number;
    defer_feature_days: number;
  };
  web_filter: {
    enabled: boolean;
    blocked_domains: string[];
  };
  software_install: {
    enabled: boolean;
  };
  firewall_notifications: {
    enabled: boolean;
  };
  software_watch: {
    enabled: boolean;
    flagged_names: string[];
  };
}

export const DEFAULT_SECURITY_BASELINE: SecurityBaselineConfig = {
  mode: 'enforce',
  bitlocker: {
    enabled: true,
    encryption_method: 'XtsAes256',
  },
  firewall: {
    enabled: true,
    profiles: ['domain', 'private', 'public'],
  },
  screen_lock: {
    enabled: true,
    timeout_minutes: 10,
  },
  usb_storage: {
    enabled: true,
  },
  local_admin: {
    enabled: true,
    disable_builtin_administrator: true,
    remove_other_admins: false,
    allowed_admins: [],
  },
  password_policy: {
    enabled: true,
    min_length: 12,
    max_age_days: 90,
    lockout_threshold: 5,
  },
  windows_update: {
    enabled: true,
    auto_update: true,
    defer_quality_days: 0,
    defer_feature_days: 0,
  },
  web_filter: {
    enabled: false,
    blocked_domains: [],
  },
  software_install: {
    enabled: false,
  },
  firewall_notifications: {
    enabled: false,
  },
  software_watch: {
    enabled: false,
    flagged_names: [],
  },
};

export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(
  value: unknown,
  field: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  if (value === undefined || value === null) return fallback;
  if (!isRecord(value)) {
    throw new PolicyConfigError(`${field} must be an object.`);
  }
  return value;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new PolicyConfigError(`${field} must be a boolean.`);
  }
  return value;
}

function readInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PolicyConfigError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readMode(value: unknown, fallback: PolicyMode): PolicyMode {
  if (value === undefined || value === null) return fallback;
  if (value !== 'audit' && value !== 'enforce') {
    throw new PolicyConfigError("mode must be 'audit' or 'enforce'.");
  }
  return value;
}

function readBitLockerMethod(value: unknown, fallback: BitLockerMethod): BitLockerMethod {
  if (value === undefined || value === null) return fallback;
  const methods: BitLockerMethod[] = ['XtsAes256', 'XtsAes128', 'Aes256', 'Aes128'];
  if (typeof value !== 'string' || !methods.includes(value as BitLockerMethod)) {
    throw new PolicyConfigError(
      'bitlocker.encryption_method must be XtsAes256, XtsAes128, Aes256, or Aes128.'
    );
  }
  return value as BitLockerMethod;
}

function readProfiles(value: unknown, fallback: FirewallProfile[]): FirewallProfile[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) {
    throw new PolicyConfigError('firewall.profiles must be a non-empty array.');
  }
  const allowed: FirewallProfile[] = ['domain', 'private', 'public'];
  const profiles: FirewallProfile[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item as FirewallProfile)) {
      throw new PolicyConfigError(
        'firewall.profiles may only contain domain, private, and public.'
      );
    }
    if (!profiles.includes(item as FirewallProfile)) {
      profiles.push(item as FirewallProfile);
    }
  }
  return profiles;
}

function readStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PolicyConfigError(`${field} must be a list.`);
  }
  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new PolicyConfigError(`${field} may only contain text.`);
    }
    const item = raw.trim();
    if (!item) continue;
    if (item.length > maxLength) {
      throw new PolicyConfigError(`${field} entries must be at most ${maxLength} characters.`);
    }
    if (!items.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      items.push(item);
    }
  }
  if (items.length > maxItems) {
    throw new PolicyConfigError(`${field} may have at most ${maxItems} entries.`);
  }
  return items;
}

/** Accepts pasted URLs and stores bare domains, which also cover subdomains. */
function readDomains(value: unknown): string[] {
  const domains = readStringList(value, 'web_filter.blocked_domains', 200, 300).map((item) =>
    item
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '')
  );
  for (const domain of domains) {
    if (domain.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      throw new PolicyConfigError(`"${domain}" is not a valid website domain.`);
    }
  }
  const unique = [...new Set(domains)];
  // Device scripts carry this list on a command line, which has a hard size limit.
  if (unique.join(',').length > 8000) {
    throw new PolicyConfigError('web_filter.blocked_domains is too long.');
  }
  return unique;
}

function readAdminNames(value: unknown): string[] {
  const names = readStringList(value, 'local_admin.allowed_admins', 50, 128);
  for (const name of names) {
    if (!/^[\w .@\\-]+$/.test(name)) {
      throw new PolicyConfigError(`"${name}" is not a valid account name.`);
    }
  }
  return names;
}

export function normalizeSecurityBaselineConfig(
  input: unknown
): SecurityBaselineConfig {
  const raw = isRecord(input) ? input : {};
  if (input !== undefined && input !== null && !isRecord(input)) {
    throw new PolicyConfigError('config must be an object.');
  }

  const bitlocker = readObject(raw.bitlocker, 'bitlocker', {});
  const firewall = readObject(raw.firewall, 'firewall', {});
  const screenLock = readObject(raw.screen_lock, 'screen_lock', {});
  const usbStorage = readObject(raw.usb_storage, 'usb_storage', {});
  const localAdmin = readObject(raw.local_admin, 'local_admin', {});
  const passwordPolicy = readObject(raw.password_policy, 'password_policy', {});
  const windowsUpdate = readObject(raw.windows_update, 'windows_update', {});
  const webFilter = readObject(raw.web_filter, 'web_filter', {});
  const softwareInstall = readObject(raw.software_install, 'software_install', {});
  const firewallNotifications = readObject(raw.firewall_notifications, 'firewall_notifications', {});
  const softwareWatch = readObject(raw.software_watch, 'software_watch', {});

  const localAdminEnabled = readBoolean(
    localAdmin.enabled,
    'local_admin.enabled',
    DEFAULT_SECURITY_BASELINE.local_admin.enabled
  );
  const removeOtherAdmins = readBoolean(
    localAdmin.remove_other_admins,
    'local_admin.remove_other_admins',
    false
  );
  const allowedAdmins = readAdminNames(localAdmin.allowed_admins);
  if (localAdminEnabled && removeOtherAdmins && allowedAdmins.length === 0) {
    throw new PolicyConfigError(
      'Add at least one approved admin account before removing other administrators.'
    );
  }

  return {
    mode: readMode(raw.mode, DEFAULT_SECURITY_BASELINE.mode),
    bitlocker: {
      enabled: readBoolean(
        bitlocker.enabled,
        'bitlocker.enabled',
        DEFAULT_SECURITY_BASELINE.bitlocker.enabled
      ),
      encryption_method: readBitLockerMethod(
        bitlocker.encryption_method,
        DEFAULT_SECURITY_BASELINE.bitlocker.encryption_method
      ),
    },
    firewall: {
      enabled: readBoolean(
        firewall.enabled,
        'firewall.enabled',
        DEFAULT_SECURITY_BASELINE.firewall.enabled
      ),
      profiles: readProfiles(
        firewall.profiles,
        DEFAULT_SECURITY_BASELINE.firewall.profiles
      ),
    },
    screen_lock: {
      enabled: readBoolean(
        screenLock.enabled,
        'screen_lock.enabled',
        DEFAULT_SECURITY_BASELINE.screen_lock.enabled
      ),
      timeout_minutes: readInteger(
        screenLock.timeout_minutes,
        'screen_lock.timeout_minutes',
        DEFAULT_SECURITY_BASELINE.screen_lock.timeout_minutes,
        1,
        120
      ),
    },
    usb_storage: {
      enabled: readBoolean(
        usbStorage.enabled,
        'usb_storage.enabled',
        DEFAULT_SECURITY_BASELINE.usb_storage.enabled
      ),
    },
    local_admin: {
      enabled: localAdminEnabled,
      disable_builtin_administrator: readBoolean(
        localAdmin.disable_builtin_administrator,
        'local_admin.disable_builtin_administrator',
        DEFAULT_SECURITY_BASELINE.local_admin.disable_builtin_administrator
      ),
      remove_other_admins: removeOtherAdmins,
      allowed_admins: allowedAdmins,
    },
    password_policy: {
      enabled: readBoolean(
        passwordPolicy.enabled,
        'password_policy.enabled',
        DEFAULT_SECURITY_BASELINE.password_policy.enabled
      ),
      min_length: readInteger(
        passwordPolicy.min_length,
        'password_policy.min_length',
        DEFAULT_SECURITY_BASELINE.password_policy.min_length,
        8,
        32
      ),
      max_age_days: readInteger(
        passwordPolicy.max_age_days,
        'password_policy.max_age_days',
        DEFAULT_SECURITY_BASELINE.password_policy.max_age_days,
        0,
        365
      ),
      lockout_threshold: readInteger(
        passwordPolicy.lockout_threshold,
        'password_policy.lockout_threshold',
        DEFAULT_SECURITY_BASELINE.password_policy.lockout_threshold,
        0,
        20
      ),
    },
    windows_update: {
      enabled: readBoolean(
        windowsUpdate.enabled,
        'windows_update.enabled',
        DEFAULT_SECURITY_BASELINE.windows_update.enabled
      ),
      auto_update: readBoolean(
        windowsUpdate.auto_update,
        'windows_update.auto_update',
        DEFAULT_SECURITY_BASELINE.windows_update.auto_update
      ),
      defer_quality_days: readInteger(
        windowsUpdate.defer_quality_days,
        'windows_update.defer_quality_days',
        DEFAULT_SECURITY_BASELINE.windows_update.defer_quality_days,
        0,
        30
      ),
      defer_feature_days: readInteger(
        windowsUpdate.defer_feature_days,
        'windows_update.defer_feature_days',
        DEFAULT_SECURITY_BASELINE.windows_update.defer_feature_days,
        0,
        365
      ),
    },
    web_filter: {
      enabled: readBoolean(webFilter.enabled, 'web_filter.enabled', false),
      blocked_domains: readDomains(webFilter.blocked_domains),
    },
    software_install: {
      enabled: readBoolean(softwareInstall.enabled, 'software_install.enabled', false),
    },
    firewall_notifications: {
      enabled: readBoolean(firewallNotifications.enabled, 'firewall_notifications.enabled', false),
    },
    software_watch: {
      enabled: readBoolean(softwareWatch.enabled, 'software_watch.enabled', false),
      flagged_names: readStringList(
        softwareWatch.flagged_names,
        'software_watch.flagged_names',
        100,
        100
      ),
    },
  };
}

export function policyHash(policy: {
  id: string;
  version: number;
  type: string;
  config: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: policy.id,
        version: policy.version,
        type: policy.type,
        config: policy.config,
      })
    )
    .digest('hex');
}

function normalizeStoredPolicyConfig(value: unknown): SecurityBaselineConfig {
  try {
    return normalizeSecurityBaselineConfig(value);
  } catch {
    return { ...DEFAULT_SECURITY_BASELINE };
  }
}

function assertConfigSize(config: SecurityBaselineConfig): void {
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 64 * 1024) {
    throw new PolicyConfigError('config is too large.');
  }
}

export async function listPolicies() {
  const rows = await prisma.devicePolicy.findMany({
    orderBy: { updated_at: 'desc' },
    include: {
      _count: { select: { assignments: true, statuses: true } },
      assignments: {
        include: {
          device: { select: { id: true, hostname: true, status: true } },
          group: {
            select: {
              id: true,
              name: true,
              devices: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  return rows.map((row) => {
    const deviceIds = new Set<string>();
    for (const assignment of row.assignments) {
      if (assignment.device_id) deviceIds.add(assignment.device_id);
      if (assignment.group) {
        for (const device of assignment.group.devices) {
          deviceIds.add(device.id);
        }
      }
    }

    return {
      id: row.id,
      name: row.name,
      version: row.version,
      type: row.type,
      config: normalizeStoredPolicyConfig(row.config),
      status: row.status,
      created_by: row.created_by,
      approved_by: row.approved_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      assignment_count: row._count.assignments,
      status_count: row._count.statuses,
      device_count: deviceIds.size,
    };
  });
}

export async function getPolicy(id: string) {
  const row = await prisma.devicePolicy.findUnique({
    where: { id },
    include: {
      assignments: {
        orderBy: { created_at: 'asc' },
        include: {
          device: { select: { id: true, hostname: true, status: true } },
          group: {
            select: {
              id: true,
              name: true,
              _count: { select: { devices: true } },
            },
          },
        },
      },
      statuses: {
        orderBy: { checked_at: 'desc' },
        take: 100,
        include: {
          device: { select: { id: true, hostname: true, status: true } },
        },
      },
    },
  });

  if (!row) return null;

  return {
    ...row,
    config: normalizeStoredPolicyConfig(row.config),
    assignments: row.assignments.map((assignment) => ({
      ...assignment,
      target_type: assignment.device_id ? 'device' : 'group',
      target_name: assignment.device?.hostname ?? assignment.group?.name ?? 'Unknown',
      device_count: assignment.device_id
        ? 1
        : assignment.group?._count.devices ?? 0,
    })),
  };
}

export async function createPolicy(options: {
  name: string;
  config?: unknown;
  status?: string;
  createdBy?: string;
}) {
  const config = normalizeSecurityBaselineConfig(options.config);
  assertConfigSize(config);

  const status = options.status ?? 'draft';
  if (!POLICY_STATUSES.has(status)) {
    throw new PolicyConfigError('status must be draft, active, or disabled.');
  }

  return prisma.devicePolicy.create({
    data: {
      name: options.name,
      type: SECURITY_BASELINE_TYPE,
      config: config as any,
      status,
      created_by: options.createdBy ?? null,
      approved_by: status === 'active' ? options.createdBy ?? null : null,
    },
  });
}

export async function updatePolicy(
  id: string,
  changes: {
    name?: string;
    config?: unknown;
    status?: string;
  },
  actorId?: string
) {
  const data: Record<string, unknown> = {};

  if (changes.name !== undefined) data.name = changes.name;

  if (changes.config !== undefined) {
    const config = normalizeSecurityBaselineConfig(changes.config);
    assertConfigSize(config);
    data.config = config as any;
    data.version = { increment: 1 };
  }

  if (changes.status !== undefined) {
    if (!POLICY_STATUSES.has(changes.status)) {
      throw new PolicyConfigError('status must be draft, active, or disabled.');
    }
    data.status = changes.status;
    if (changes.status === 'active') {
      data.approved_by = actorId ?? null;
    }
  }

  return prisma.devicePolicy.update({
    where: { id },
    data,
  });
}

export async function deletePolicy(id: string) {
  const policy = await prisma.devicePolicy.findUnique({
    where: { id },
    select: { name: true, status: true },
  });

  if (!policy) return null;

  await prisma.devicePolicy.delete({ where: { id } });
  return policy;
}

export async function createPolicyAssignment(options: {
  policyId: string;
  groupId?: string | null;
  deviceId?: string | null;
  priority?: number;
  enabled?: boolean;
}) {
  const groupId = options.groupId ?? null;
  const deviceId = options.deviceId ?? null;

  if ((groupId && deviceId) || (!groupId && !deviceId)) {
    throw new PolicyConfigError('Provide exactly one of group_id or device_id.');
  }

  const policy = await prisma.devicePolicy.findUnique({
    where: { id: options.policyId },
    select: { id: true },
  });
  if (!policy) return { missing: 'policy' as const };

  if (groupId) {
    const group = await prisma.deviceGroup.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) return { missing: 'group' as const };
  }

  if (deviceId) {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true },
    });
    if (!device) return { missing: 'device' as const };
  }

  const priority = options.priority ?? 100;
  const enabled = options.enabled ?? true;

  const existing = await prisma.devicePolicyAssignment.findFirst({
    where: {
      policy_id: options.policyId,
      group_id: groupId,
      device_id: deviceId,
    },
  });

  if (existing) {
    return prisma.devicePolicyAssignment.update({
      where: { id: existing.id },
      data: { priority, enabled },
    });
  }

  return prisma.devicePolicyAssignment.create({
    data: {
      policy_id: options.policyId,
      group_id: groupId,
      device_id: deviceId,
      priority,
      enabled,
    },
  });
}

export async function deletePolicyAssignment(policyId: string, assignmentId: string) {
  const assignment = await prisma.devicePolicyAssignment.findFirst({
    where: { id: assignmentId, policy_id: policyId },
    select: { id: true },
  });

  if (!assignment) return false;

  await prisma.devicePolicyAssignment.delete({ where: { id: assignment.id } });
  return true;
}

export type EffectivePolicy = {
  policy: {
    id: string;
    name: string;
    type: string;
    version: number;
    config: SecurityBaselineConfig;
    hash: string;
    assignment_id: string;
    source: 'device' | 'group';
    group_id: string | null;
    priority: number;
  } | null;
};

export async function getEffectivePolicyForDevice(
  deviceId: string
): Promise<EffectivePolicy | null> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, group_id: true },
  });

  if (!device) return null;

  const assignments = await prisma.devicePolicyAssignment.findMany({
    where: {
      enabled: true,
      policy: {
        status: 'active',
        type: SECURITY_BASELINE_TYPE,
      },
      OR: [
        { device_id: deviceId },
        ...(device.group_id ? [{ group_id: device.group_id }] : []),
      ],
    },
    include: {
      policy: true,
    },
  });

  assignments.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aDevice = a.device_id ? 1 : 0;
    const bDevice = b.device_id ? 1 : 0;
    if (aDevice !== bDevice) return bDevice - aDevice;
    return a.created_at.getTime() - b.created_at.getTime();
  });

  for (const assignment of assignments) {
    let config: SecurityBaselineConfig;
    try {
      config = normalizeSecurityBaselineConfig(assignment.policy.config);
    } catch {
      continue;
    }

    return {
      policy: {
        id: assignment.policy.id,
        name: assignment.policy.name,
        type: assignment.policy.type,
        version: assignment.policy.version,
        config,
        hash: policyHash({
          id: assignment.policy.id,
          version: assignment.policy.version,
          type: assignment.policy.type,
          config,
        }),
        assignment_id: assignment.id,
        source: assignment.device_id ? 'device' : 'group',
        group_id: assignment.group_id ?? null,
        priority: assignment.priority,
      },
    };
  }

  return { policy: null };
}

export async function recordPolicyStatus(options: {
  deviceId: string;
  policyId: string;
  policyVersion: number;
  status: string;
  applied?: boolean;
  checks?: unknown;
  errors?: unknown;
}) {
  const status = POLICY_REPORT_STATUSES.has(options.status)
    ? options.status
    : 'failed';

  const data = {
    policy_version: options.policyVersion,
    status,
    applied: Boolean(options.applied),
    checks: (options.checks ?? null) as any,
    errors: (options.errors ?? null) as any,
    checked_at: new Date(),
  };

  return prisma.devicePolicyStatus.upsert({
    where: {
      device_id_policy_id: {
        device_id: options.deviceId,
        policy_id: options.policyId,
      },
    },
    create: {
      device_id: options.deviceId,
      policy_id: options.policyId,
      ...data,
    },
    update: data,
  });
}

export async function listPolicyStatuses(options: {
  policyId?: string;
  deviceId?: string;
  limit?: number;
}) {
  return prisma.devicePolicyStatus.findMany({
    where: {
      ...(options.policyId ? { policy_id: options.policyId } : {}),
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
    },
    orderBy: { checked_at: 'desc' },
    take: options.limit ?? 100,
    include: {
      device: { select: { id: true, hostname: true, status: true } },
      policy: { select: { id: true, name: true, version: true, status: true } },
    },
  });
}
