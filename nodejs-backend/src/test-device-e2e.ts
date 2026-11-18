/**
 * test-device-e2e.ts — live device-control REST + WebSocket test.
 *
 * Requires a running backend and a migrated database. It seeds and removes its
 * own admin/device rows, so it is safe to run against a development database.
 *
 * Run with:
 *   npm run test-device-e2e
 *
 * Optional:
 *   DEVICE_E2E_API_BASE=http://127.0.0.1:5051/api
 */

import { createHash } from 'crypto';
import WebSocket from 'ws';
import prisma from './prisma';
import { signSessionToken } from './middleware/requireUser';

const API_BASE = (process.env.DEVICE_E2E_API_BASE || 'http://127.0.0.1:5000/api').replace(
  /\/$/,
  ''
);
const WS_BASE = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

class SocketHarness {
  readonly ws: WebSocket;
  private messages: any[] = [];
  private waiters: Array<{
    predicate: (msg: any) => boolean;
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closeCode: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      this.drain();
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed with code ${code}`));
      }
    });
  }

  private drain() {
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      const index = this.messages.findIndex(waiter.predicate);
      if (index < 0) continue;
      const [msg] = this.messages.splice(index, 1);
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      i--;
    }
  }

  next(predicate: (msg: any) => boolean, timeoutMs = 5_000): Promise<any> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [msg] = this.messages.splice(index, 1);
      return Promise.resolve(msg);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('timed out waiting for socket message'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async waitForClose(timeoutMs = 5_000): Promise<number | null> {
    if (this.closeCode !== null) return this.closeCode;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeListener('close', onClose);
        reject(new Error('timed out waiting for socket close'));
      }, timeoutMs);
      const onClose = (code: number) => {
        clearTimeout(timer);
        resolve(code);
      };
      this.ws.once('close', onClose);
    });
  }

  send(message: object) {
    this.ws.send(JSON.stringify(message));
  }

  close() {
    try {
      this.ws.close(1000, 'test finished');
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\naceHRM — device control live test (${API_BASE})\n`);

  const stamp = Date.now();
  const adminId = `dev-e2e-admin-${stamp}`;
  const deviceKey = `dev-e2e-device-${stamp}`;
  const machineGuid = `dev-e2e-machine-${stamp}`;
  let deviceId: string | undefined;
  let groupId: string | undefined;
  let policyId: string | undefined;
  let overridePolicyId: string | undefined;
  let socket: SocketHarness | undefined;

  // requireUser checks a live session row, so tokens are signed after the user exists.
  const sessionToken = async (user: { id: string; name: string; role: string }) =>
    signSessionToken(user, (await prisma.userSession.create({ data: { user_id: user.id } })).id);
  let adminToken = '';

  try {
    await prisma.user.create({
      data: {
        id: adminId,
        username: adminId,
        name: 'Device E2E Admin',
        role: 'superadmin',
        status: 'active',
        email: `${adminId}@example.test`,
        password_hash: 'not-used',
      },
    });
    adminToken = await sessionToken({ id: adminId, name: 'Device E2E Admin', role: 'superadmin' });

    const health = await api('GET', '/devices', { token: adminToken });
    check('admin device list is reachable', health.status === 200, JSON.stringify(health));

    const enrollment = await api('POST', '/devices/enrollment-tokens', {
      token: adminToken,
      body: { expires_in_hours: 1, max_uses: 2 },
    });
    check(
      'admin can create an enrollment token',
      enrollment.status === 201 && typeof enrollment.body?.token === 'string',
      JSON.stringify(enrollment)
    );

    const enroll = await api('POST', '/device/enroll', {
      body: {
        token: enrollment.body?.token,
        device_key: deviceKey,
        hostname: 'DEV-E2E-PC',
        machine_guid: machineGuid,
        os_name: 'Windows 11',
        os_version: '10.0.26100',
        agent_version: 'e2e',
      },
    });
    deviceId = enroll.body?.device_id;
    const deviceToken = enroll.body?.device_token;
    check(
      'device enrolls and receives a device token',
      enroll.status === 201 && typeof deviceId === 'string' && typeof deviceToken === 'string',
      JSON.stringify(enroll)
    );

    const listed = await api('GET', '/devices', { token: adminToken });
    check(
      'enrolled device appears in the admin list',
      listed.status === 200 &&
        Array.isArray(listed.body?.devices) &&
        listed.body.devices.some((device: any) => device.id === deviceId),
      JSON.stringify(listed)
    );

    const heartbeat = await api('POST', '/device/heartbeat', {
      token: deviceToken,
      body: { last_user_id: 'e2e-user', agent_version: 'e2e' },
    });
    check('device heartbeat succeeds', heartbeat.status === 200, JSON.stringify(heartbeat));

    const inventory = await api('POST', '/device/inventory', {
      token: deviceToken,
      body: { snapshot: { os: 'Windows 11', cpu: 'E2E', memory_gb: 16 } },
    });
    check('device inventory is stored', inventory.status === 201, JSON.stringify(inventory));

    // Login-based enrollment: a signed-in user vouches for the PC they are on.
    const secondUserId = `dev-e2e-user-${stamp}`;
    await prisma.user.create({
      data: {
        id: secondUserId,
        username: secondUserId,
        name: 'Device E2E User',
        role: 'employee',
        status: 'active',
        email: `${secondUserId}@example.test`,
        password_hash: 'not-used',
      },
    });
    const secondToken = await sessionToken({ id: secondUserId, name: 'Device E2E User', role: 'employee' });
    const grantFor = async (token: string) =>
      (await api('POST', '/device/login-grant', { token })).body?.grant as string;

    const issued = await api('POST', '/device/login-grant', { token: secondToken });
    check(
      'any signed-in user can get a login grant',
      issued.status === 200 && typeof issued.body?.grant === 'string',
      JSON.stringify(issued)
    );
    check(
      'a device token cannot get a login grant',
      (await api('POST', '/device/login-grant', { token: deviceToken })).status === 401
    );

    const loginDevice = (extra: Record<string, unknown>) =>
      api('POST', '/device/enroll', {
        body: {
          device_key: `dev-e2e-login-${stamp}`,
          hostname: 'DEV-E2E-LOGIN-PC',
          machine_guid: `dev-e2e-login-machine-${stamp}`,
          ...extra,
        },
      });
    check('enrolling needs a grant or token', (await loginDevice({})).status === 400);
    check('a made-up grant cannot enroll', (await loginDevice({ login_grant: 'not-a-grant' })).status === 401);
    check('a session token is not a grant', (await loginDevice({ login_grant: secondToken })).status === 401);

    const loginEnroll = await loginDevice({ login_grant: issued.body?.grant });
    const loginDeviceId = loginEnroll.body?.device_id as string;
    const loginDeviceToken = loginEnroll.body?.device_token as string;
    check('a login grant enrolls the PC', loginEnroll.status === 201, JSON.stringify(loginEnroll));
    let row = await prisma.device.findUnique({ where: { id: loginDeviceId } });
    check(
      'the signed-in user is assigned to the PC',
      row?.assigned_user_id === secondUserId && row?.last_user_id === secondUserId,
      JSON.stringify(row)
    );

    const adminLogin = await api('POST', '/device/user-login', {
      token: loginDeviceToken,
      body: { login_grant: await grantFor(adminToken) },
    });
    row = await prisma.device.findUnique({ where: { id: loginDeviceId } });
    check(
      'a later sign-in updates the last user, not the owner',
      adminLogin.status === 200 && row?.assigned_user_id === secondUserId && row?.last_user_id === adminId,
      JSON.stringify(row)
    );
    check(
      'a made-up grant cannot change the last user',
      (await api('POST', '/device/user-login', { token: loginDeviceToken, body: { login_grant: 'nope' } })).status === 400
    );
    check(
      'a device must be authenticated to report a sign-in',
      (await api('POST', '/device/user-login', { body: { login_grant: await grantFor(adminToken) } })).status === 401
    );

    const adminDevices = await api('GET', '/devices', { token: adminToken });
    const listedLoginDevice = adminDevices.body?.devices?.find((d: any) => d.id === loginDeviceId);
    check(
      'admins see user names on the device',
      listedLoginDevice?.assigned_user_name === 'Device E2E User' &&
        listedLoginDevice?.last_user_name === 'Device E2E Admin',
      JSON.stringify(listedLoginDevice)
    );

    const inactiveGrant = await grantFor(secondToken);
    await prisma.user.update({ where: { id: secondUserId }, data: { status: 'inactive' } });
    check(
      'an inactive user cannot enroll a PC',
      (await api('POST', '/device/enroll', {
        body: {
          login_grant: inactiveGrant,
          device_key: `dev-e2e-inactive-${stamp}`,
          hostname: 'DEV-E2E-INACTIVE',
          machine_guid: `dev-e2e-inactive-machine-${stamp}`,
        },
      })).status === 401
    );
    check(
      'an inactive user cannot be reported on a PC',
      (await api('POST', '/device/user-login', { token: loginDeviceToken, body: { login_grant: inactiveGrant } })).status === 400
    );

    await prisma.device.delete({ where: { id: loginDeviceId } });
    await prisma.user.delete({ where: { id: secondUserId } });

    const createdGroup = await api('POST', '/devices/groups', {
      token: adminToken,
      body: {
        name: `DEV-E2E-Group-${stamp}`,
        description: 'Temporary group created by the live device test.',
      },
    });
    groupId = createdGroup.body?.group?.id;
    check(
      'admin can create a device group',
      createdGroup.status === 201 && typeof groupId === 'string',
      JSON.stringify(createdGroup)
    );

    const duplicateGroup = await api('POST', '/devices/groups', {
      token: adminToken,
      body: { name: `DEV-E2E-Group-${stamp}` },
    });
    check(
      'duplicate group names are rejected',
      duplicateGroup.status === 409,
      JSON.stringify(duplicateGroup)
    );

    const groups = await api('GET', '/devices/groups', { token: adminToken });
    check(
      'device group list includes counts',
      groups.status === 200 &&
        Array.isArray(groups.body?.groups) &&
        groups.body.groups.some(
          (group: any) =>
            group.id === groupId &&
            group.device_count === 0 &&
            typeof group.online_count === 'number'
        ),
      JSON.stringify(groups)
    );

    const assigned = await api('PATCH', `/devices/${deviceId}`, {
      token: adminToken,
      body: { group_id: groupId },
    });
    check(
      'admin can assign a device to a group',
      assigned.status === 200 && assigned.body?.device?.group_id === groupId,
      JSON.stringify(assigned)
    );

    const filtered = await api('GET', `/devices?group_id=${groupId}`, {
      token: adminToken,
    });
    check(
      'group filter returns the assigned device',
      filtered.status === 200 &&
        Array.isArray(filtered.body?.devices) &&
        filtered.body.devices.some((device: any) => device.id === deviceId),
      JSON.stringify(filtered)
    );

    const detail = await api('GET', `/devices/${deviceId}`, { token: adminToken });
    check(
      'device detail includes the group and latest inventory',
      detail.status === 200 &&
        detail.body?.device?.group?.id === groupId &&
        detail.body?.device?.inventory?.[0]?.snapshot?.os === 'Windows 11',
      JSON.stringify(detail)
    );

    const createdPolicy = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: `DEV-E2E-Policy-${stamp}`,
        config: { mode: 'audit', screen_lock: { timeout_minutes: 5 } },
      },
    });
    policyId = createdPolicy.body?.policy?.id;
    check(
      'admin can create a security baseline policy',
      createdPolicy.status === 201 &&
        typeof policyId === 'string' &&
        createdPolicy.body?.policy?.status === 'draft' &&
        createdPolicy.body?.policy?.config?.screen_lock?.timeout_minutes === 5 &&
        createdPolicy.body?.policy?.config?.firewall?.enabled === true,
      JSON.stringify(createdPolicy)
    );

    const invalidPolicy = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: `DEV-E2E-Policy-Invalid-${stamp}`,
        config: { screen_lock: { timeout_minutes: 0 } },
      },
    });
    check(
      'invalid security baseline values are rejected',
      invalidPolicy.status === 400,
      JSON.stringify(invalidPolicy)
    );

    const policyList = await api('GET', '/devices/policies', { token: adminToken });
    check(
      'policy list includes the new policy',
      policyList.status === 200 &&
        Array.isArray(policyList.body?.policies) &&
        policyList.body.policies.some((policy: any) => policy.id === policyId),
      JSON.stringify(policyList)
    );

    const noPolicy = await api('GET', '/device/policy', { token: deviceToken });
    check(
      'draft policies are not delivered to devices',
      noPolicy.status === 200 && noPolicy.body?.policy === null,
      JSON.stringify(noPolicy)
    );

    const activatedPolicy = await api('PATCH', `/devices/policies/${policyId}`, {
      token: adminToken,
      body: { status: 'active' },
    });
    check(
      'admin can activate and approve a policy',
      activatedPolicy.status === 200 &&
        activatedPolicy.body?.policy?.status === 'active' &&
        activatedPolicy.body?.policy?.approved_by === adminId,
      JSON.stringify(activatedPolicy)
    );

    const groupAssignment = await api(
      'POST',
      `/devices/policies/${policyId}/assignments`,
      { token: adminToken, body: { group_id: groupId } }
    );
    check(
      'admin can assign a policy to a device group',
      groupAssignment.status === 201 &&
        groupAssignment.body?.assignment?.group_id === groupId,
      JSON.stringify(groupAssignment)
    );

    const groupPolicy = await api('GET', '/device/policy', { token: deviceToken });
    check(
      'device receives the group policy with a stable hash',
      groupPolicy.status === 200 &&
        groupPolicy.body?.policy?.id === policyId &&
        groupPolicy.body?.policy?.source === 'group' &&
        typeof groupPolicy.body?.policy?.hash === 'string',
      JSON.stringify(groupPolicy)
    );

    const overridePolicy = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: `DEV-E2E-Policy-Override-${stamp}`,
        status: 'active',
        config: { mode: 'enforce', usb_storage: { enabled: false } },
      },
    });
    overridePolicyId = overridePolicy.body?.policy?.id;
    check(
      'admin can create an active device-specific policy',
      overridePolicy.status === 201 &&
        typeof overridePolicyId === 'string' &&
        overridePolicy.body?.policy?.status === 'active',
      JSON.stringify(overridePolicy)
    );

    const overrideAssignment = await api(
      'POST',
      `/devices/policies/${overridePolicyId}/assignments`,
      { token: adminToken, body: { device_id: deviceId, priority: 100 } }
    );
    check(
      'admin can assign a policy directly to a device',
      overrideAssignment.status === 201 &&
        overrideAssignment.body?.assignment?.device_id === deviceId,
      JSON.stringify(overrideAssignment)
    );

    const devicePolicy = await api('GET', '/device/policy', { token: deviceToken });
    check(
      'a device assignment wins over a group assignment at the same priority',
      devicePolicy.status === 200 &&
        devicePolicy.body?.policy?.id === overridePolicyId &&
        devicePolicy.body?.policy?.source === 'device',
      JSON.stringify(devicePolicy)
    );

    const reportedStatus = await api('POST', '/device/policy/status', {
      token: deviceToken,
      body: {
        policy_id: overridePolicyId,
        policy_version: overridePolicy.body?.policy?.version,
        status: 'compliant',
        applied: false,
        checks: { usb_storage: { ok: true } },
        errors: [],
      },
    });
    check(
      'device can report policy compliance',
      reportedStatus.status === 201 &&
        reportedStatus.body?.status === 'compliant',
      JSON.stringify(reportedStatus)
    );

    const noApprovedAdmin = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: 'e2e-no-approved-admin',
        config: { local_admin: { enabled: true, remove_other_admins: true } },
      },
    });
    check('removing admins requires an approved account', noApprovedAdmin.status === 400);

    const badDomain = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: 'e2e-bad-domain',
        config: { web_filter: { enabled: true, blocked_domains: ['"; Remove-Item C:\\*'] } },
      },
    });
    check('an invalid website domain is rejected', badDomain.status === 400);

    const restrictions = await api('POST', '/devices/policies', {
      token: adminToken,
      body: {
        name: 'e2e-restrictions',
        config: {
          web_filter: {
            enabled: true,
            blocked_domains: ['https://www.Facebook.com/feed', 'facebook.com', '', 'tiktok.com'],
          },
        },
      },
    });
    const savedConfig = restrictions.body?.policy?.config;
    check(
      'website entries are normalized and new restrictions stay off by default',
      restrictions.status === 201 &&
        JSON.stringify(savedConfig?.web_filter?.blocked_domains) ===
          JSON.stringify(['facebook.com', 'tiktok.com']) &&
        savedConfig?.local_admin?.remove_other_admins === false &&
        savedConfig?.software_install?.enabled === false &&
        savedConfig?.firewall_notifications?.enabled === false &&
        savedConfig?.software_watch?.enabled === false,
      JSON.stringify(savedConfig)
    );
    await api('DELETE', `/devices/policies/${restrictions.body?.policy?.id}`, {
      token: adminToken,
    });

    // Software deployment. Nothing here runs an installer.
    const uploadSoftware = async (query: string, bytes: Buffer, token = adminToken) => {
      const res = await fetch(`${API_BASE}/devices/software?${query}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const softwareBytes = Buffer.from('pretend installer bytes');

    const badKind = await uploadSoftware('name=Bad&filename=run.bat', softwareBytes);
    check('only .msi and .exe installers are accepted', badKind.status === 400);

    const noSwitch = await uploadSoftware('name=NoSwitch&filename=setup.exe', softwareBytes);
    check('an .exe installer must have a silent switch', noSwitch.status === 400);

    const deviceUpload = await uploadSoftware('name=X&filename=a.msi', softwareBytes, deviceToken as string);
    check('a device token cannot upload software', deviceUpload.status === 401 || deviceUpload.status === 403);

    const uploaded = await uploadSoftware('name=E2E%20App&filename=app.msi', softwareBytes);
    const softwareId = uploaded.body?.package?.id;
    check(
      'an admin can upload an installer and its hash is recorded',
      uploaded.status === 201 &&
        uploaded.body?.package?.size_bytes === softwareBytes.length &&
        uploaded.body?.package?.sha256 ===
          createHash('sha256').update(softwareBytes).digest('hex'),
      JSON.stringify(uploaded)
    );

    const download = () =>
      fetch(`${API_BASE}/device/software/${softwareId}/download`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      });

    check(
      'a device cannot download a package it was not told to install',
      (await download()).status === 404
    );

    const noTarget = await api('POST', `/devices/software/${softwareId}/install`, {
      token: adminToken,
      body: {},
    });
    check('an install needs a target', noTarget.status === 400);

    const installed = await api('POST', `/devices/software/${softwareId}/install`, {
      token: adminToken,
      body: { device_ids: [deviceId] },
    });
    check('an admin can request an install', installed.status === 201, JSON.stringify(installed));

    const beatWhileQueued = await api('POST', '/device/heartbeat', {
      token: deviceToken,
      body: {},
    });
    const installsAfterBeat = await api('GET', '/devices/software/installs', { token: adminToken });
    const installRow = installsAfterBeat.body?.installs?.find(
      (row: any) => row.device?.id === deviceId
    );
    check(
      'an HTTP heartbeat leaves a queued command for the socket',
      beatWhileQueued.status === 200 &&
        (beatWhileQueued.body?.commands ?? []).length === 0 &&
        installRow?.status === 'queued',
      JSON.stringify(installRow)
    );

    const fetched = await download();
    check(
      'a device with a pending install can download the exact file',
      fetched.status === 200 &&
        Buffer.from(await fetched.arrayBuffer()).equals(softwareBytes)
    );

    const badResult = await api('POST', `/device/commands/${installRow?.id}/result`, {
      token: deviceToken,
      body: { status: 'nonsense' },
    });
    check('an invalid install result is rejected', badResult.status === 400);

    const goodResult = await api('POST', `/device/commands/${installRow?.id}/result`, {
      token: deviceToken,
      body: { status: 'completed', result: { message: 'E2E App installed', exit_code: 0 } },
    });
    const finished = await api('GET', '/devices/software/installs', { token: adminToken });
    check(
      'an install result reaches the admin',
      goodResult.status === 200 &&
        finished.body?.installs?.[0]?.status === 'completed' &&
        finished.body?.installs?.[0]?.result?.exit_code === 0,
      JSON.stringify(finished.body?.installs?.[0])
    );

    check(
      'a finished install no longer allows the download',
      (await download()).status === 404
    );

    const softwareAudit = await prisma.deviceAuditLog.count({
      where: { device_id: deviceId, action: 'software.install_requested' },
    });
    check('install requests are audited', softwareAudit === 1);

    const softwareDeleted = await api('DELETE', `/devices/software/${softwareId}`, {
      token: adminToken,
    });
    check('an admin can delete a package', softwareDeleted.status === 200);

    const recoveryPassword = Array(8).fill('123456').join('-');
    const protectorId = '{11111111-2222-3333-4444-555555555555}';

    const badRecoveryKey = await api('POST', '/device/recovery-key', {
      token: deviceToken,
      body: { protector_id: protectorId, recovery_password: 'not-a-key' },
    });
    check('a malformed recovery key is rejected', badRecoveryKey.status === 400);

    const storedRecoveryKey = await api('POST', '/device/recovery-key', {
      token: deviceToken,
      body: { protector_id: protectorId, recovery_password: recoveryPassword },
    });
    check(
      'a device can store its recovery key',
      storedRecoveryKey.status === 201,
      JSON.stringify(storedRecoveryKey)
    );

    const recoveryRow = await prisma.deviceRecoveryKey.findFirst({
      where: { device_id: deviceId },
    });
    check(
      'the recovery key is encrypted at rest',
      Boolean(recoveryRow) && !recoveryRow!.encrypted_key.includes(recoveryPassword)
    );

    // The request audit middleware writes after the response finishes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leakedAudit = await prisma.auditLog.count({
      where: { details: { contains: recoveryPassword } },
    });
    check('the recovery key never reaches the request audit log', leakedAudit === 0);

    const leakedEnrollment = await prisma.auditLog.count({
      where: { details: { contains: String(enrollment.body?.token) } },
    });
    check('the enrollment token never reaches the request audit log', leakedEnrollment === 0);

    const redactionProbe = await api('POST', '/devices/policies', {
      token: adminToken,
      body: { name: 'audit-redaction-probe', password: 'redaction-probe-value' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leakedProbe = await prisma.auditLog.count({
      where: { details: { contains: 'redaction-probe-value' } },
    });
    const redactedProbe = await prisma.auditLog.count({
      where: { details: { contains: 'audit-redaction-probe' } },
    });
    check(
      'the request audit log redacts secret fields on any route',
      redactionProbe.status === 201 && leakedProbe === 0 && redactedProbe > 0
    );
    await api('DELETE', `/devices/policies/${redactionProbe.body?.policy?.id}`, {
      token: adminToken,
    });

    const deviceReadsKeys = await api('GET', `/devices/${deviceId}/recovery-keys`, {
      token: deviceToken,
    });
    check('a device token cannot read recovery keys', deviceReadsKeys.status === 401 || deviceReadsKeys.status === 403);

    const adminReadsKeys = await api('GET', `/devices/${deviceId}/recovery-keys`, {
      token: adminToken,
    });
    check(
      'an admin can read the decrypted recovery key',
      adminReadsKeys.status === 200 &&
        adminReadsKeys.body?.keys?.[0]?.recovery_password === recoveryPassword,
      String(adminReadsKeys.status)
    );

    const recoveryAudit = await prisma.deviceAuditLog.count({
      where: { device_id: deviceId, action: 'device.recovery_key.viewed' },
    });
    check('viewing a recovery key is audited', recoveryAudit === 1);

    const policyStatuses = await api(
      'GET',
      `/devices/policies/${overridePolicyId}/statuses`,
      { token: adminToken }
    );
    check(
      'policy compliance is visible to admins',
      policyStatuses.status === 200 &&
        Array.isArray(policyStatuses.body?.statuses) &&
        policyStatuses.body.statuses.some(
          (status: any) => status.device_id === deviceId && status.status === 'compliant'
        ),
      JSON.stringify(policyStatuses)
    );

    const detailWithPolicy = await api('GET', `/devices/${deviceId}`, {
      token: adminToken,
    });
    check(
      'device detail includes the latest policy status',
      detailWithPolicy.status === 200 &&
        Array.isArray(detailWithPolicy.body?.device?.policy_statuses) &&
        detailWithPolicy.body.device.policy_statuses.some(
          (status: any) => status.policy_id === overridePolicyId
        ),
      JSON.stringify(detailWithPolicy)
    );

    const policyAudit = await api('GET', '/devices/audit?limit=300', {
      token: adminToken,
    });
    check(
      'policy changes are audited',
      policyAudit.status === 200 &&
        Array.isArray(policyAudit.body?.logs) &&
        policyAudit.body.logs.some((log: any) => log.action === 'policy.created') &&
        policyAudit.body.logs.some((log: any) => log.action === 'policy.updated') &&
        policyAudit.body.logs.some(
          (log: any) => log.action === 'policy.assignment_changed'
        ),
      JSON.stringify(policyAudit)
    );

    const renamedGroup = await api('PATCH', `/devices/groups/${groupId}`, {
      token: adminToken,
      body: { name: `DEV-E2E-Group-Renamed-${stamp}` },
    });
    check(
      'admin can rename a device group',
      renamedGroup.status === 200 &&
        renamedGroup.body?.group?.name === `DEV-E2E-Group-Renamed-${stamp}`,
      JSON.stringify(renamedGroup)
    );

    const badGroup = await api('PATCH', `/devices/${deviceId}`, {
      token: adminToken,
      body: { group_id: '00000000-0000-0000-0000-000000000000' },
    });
    check(
      'assigning a missing group is rejected',
      badGroup.status === 404,
      JSON.stringify(badGroup)
    );

    const deletedGroup = await api('DELETE', `/devices/groups/${groupId}`, {
      token: adminToken,
    });
    check(
      'admin can delete a device group',
      deletedGroup.status === 200 &&
        deletedGroup.body?.unassigned_devices === 1,
      JSON.stringify(deletedGroup)
    );
    groupId = undefined;

    const ungrouped = await api('GET', `/devices/${deviceId}`, { token: adminToken });
    check(
      'deleting a group unassigns its devices',
      ungrouped.status === 200 && ungrouped.body?.device?.group_id === null,
      JSON.stringify(ungrouped)
    );

    const groupAudit = await api('GET', '/devices/audit?limit=200', {
      token: adminToken,
    });
    check(
      'group and assignment changes are audited',
      groupAudit.status === 200 &&
        Array.isArray(groupAudit.body?.logs) &&
        groupAudit.body.logs.some((log: any) => log.action === 'group.created') &&
        groupAudit.body.logs.some((log: any) => log.action === 'group.updated') &&
        groupAudit.body.logs.some((log: any) => log.action === 'group.deleted') &&
        groupAudit.body.logs.some((log: any) => log.action === 'device.group_changed'),
      JSON.stringify(groupAudit)
    );

    const command = await api('POST', `/devices/${deviceId}/commands`, {
      token: adminToken,
      body: { type: 'lock' },
    });
    check(
      'admin can queue a lock command',
      command.status === 201 && command.body?.command?.type === 'lock',
      JSON.stringify(command)
    );

    socket = new SocketHarness(`${WS_BASE}/device-ws`);
    const authRequired = await socket.next((msg) => msg.type === 'AUTH_REQUIRED');
    check('device socket requests authentication', authRequired.type === 'AUTH_REQUIRED');
    socket.send({ type: 'AUTH', token: deviceToken });
    const connected = await socket.next((msg) => msg.type === 'CONNECTED');
    check('device socket authenticates', connected.deviceId === deviceId, JSON.stringify(connected));

    const delivered = await socket.next(
      (msg) => msg.type === 'DEVICE_COMMAND' && msg.commandId === command.body?.command?.id
    );
    check(
      'queued command is delivered over the device socket',
      delivered.commandType === 'lock',
      JSON.stringify(delivered)
    );

    socket.send({
      type: 'DEVICE_COMMAND_ACK',
      commandId: delivered.commandId,
      status: 'completed',
      result: { ok: true },
    });
    await sleep(500);
    const acked = await prisma.deviceCommand.findUnique({
      where: { id: delivered.commandId },
    });
    check(
      'device command acknowledgement is persisted',
      acked?.status === 'completed',
      JSON.stringify(acked)
    );

    const audit = await api('GET', `/devices/audit?device_id=${deviceId}`, {
      token: adminToken,
    });
    check(
      'device audit trail contains enrolled and command events',
      audit.status === 200 &&
        Array.isArray(audit.body?.logs) &&
        audit.body.logs.some((log: any) => log.action === 'device.enrolled') &&
        audit.body.logs.some((log: any) => log.action === 'device.command.created'),
      JSON.stringify(audit)
    );

    await prisma.device.update({
      where: { id: deviceId },
      data: { status: 'disabled' },
    });

    const refresh = await api('POST', '/device/token/refresh', {
      token: deviceToken,
      body: {},
    });
    check('disabled device cannot refresh its token', refresh.status === 403, JSON.stringify(refresh));

    const blockedHeartbeat = await api('POST', '/device/heartbeat', {
      token: deviceToken,
      body: {},
    });
    check(
      'disabled device cannot heartbeat',
      blockedHeartbeat.status === 403,
      JSON.stringify(blockedHeartbeat)
    );

    const reenroll = await api('POST', '/device/enroll', {
      body: {
        token: enrollment.body?.token,
        device_key: deviceKey,
        hostname: 'DEV-E2E-PC',
        machine_guid: machineGuid,
        os_name: 'Windows 11',
        os_version: '10.0.26100',
        agent_version: 'e2e',
      },
    });
    check('disabled device cannot re-enroll', reenroll.status === 403, JSON.stringify(reenroll));

    const blockedSocket = new SocketHarness(`${WS_BASE}/device-ws`);
    await blockedSocket.next((msg) => msg.type === 'AUTH_REQUIRED');
    blockedSocket.send({ type: 'AUTH', token: deviceToken });
    const closeCode = await blockedSocket.waitForClose();
    check('disabled device socket is rejected with 4003', closeCode === 4003, String(closeCode));
  } finally {
    socket?.close();

    for (const id of [policyId, overridePolicyId]) {
      if (!id) continue;
      await prisma.devicePolicyStatus.deleteMany({ where: { policy_id: id } });
      await prisma.devicePolicy.deleteMany({ where: { id } });
    }

    if (groupId) {
      await prisma.deviceGroup.deleteMany({ where: { id: groupId } });
    }

    const existing = deviceId
      ? await prisma.device.findUnique({ where: { id: deviceId } })
      : await prisma.device.findFirst({ where: { device_key: deviceKey } });
    const cleanupDeviceId = existing?.id;

    if (cleanupDeviceId) {
      await prisma.deviceAuditLog.deleteMany({ where: { device_id: cleanupDeviceId } });
      await prisma.deviceCommand.deleteMany({ where: { device_id: cleanupDeviceId } });
      await prisma.deviceInventory.deleteMany({ where: { device_id: cleanupDeviceId } });
      await prisma.deviceRemoteSession.deleteMany({ where: { device_id: cleanupDeviceId } });
      await prisma.device.deleteMany({ where: { id: cleanupDeviceId } });
    }

    await prisma.deviceAuditLog.deleteMany({ where: { actor_id: adminId } });
    await prisma.deviceEnrollmentToken.deleteMany({ where: { created_by: adminId } });
    await prisma.auditLog.deleteMany({ where: { user_id: adminId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

main()
  .catch((err) => {
    console.error('Device live test crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failed > 0 || process.exitCode ? 1 : 0);
  });
