'use strict';

// Offline self-check for policy decisions. Runs no PowerShell and changes nothing.
const assert = require('node:assert');
const {
  PolicyManager,
  RECHECK_AFTER_MS,
  adminPlan,
  buildApplyScript,
  buildRevertScript,
  evaluatePolicy,
  restoreMessage
} = require('../src/policy');

const off = { enabled: false };
const baseConfig = {
  mode: 'enforce',
  bitlocker: { enabled: false, encryption_method: 'XtsAes256' },
  firewall: { enabled: false, profiles: ['domain'] },
  screen_lock: { enabled: false, timeout_minutes: 10 },
  usb_storage: off,
  local_admin: { enabled: false, disable_builtin_administrator: true },
  password_policy: { enabled: false, min_length: 12, max_age_days: 90, lockout_threshold: 5 },
  windows_update: { enabled: false, auto_update: true, defer_quality_days: 0, defer_feature_days: 0 }
};
const config = (changes) => ({ ...baseConfig, ...changes });
const policy = (changes, hash = 'h1') => ({
  id: 'p1', name: 'P', version: 1, hash, config: config(changes)
});

function harness(initial) {
  const device = {
    usb_storage_deny_all: null,
    firewall_notifications: { domain: null, private: null, public: null },
    bitlocker: { available: true },
    ...initial
  };
  const calls = { apply: [], revert: [], posted: [] };
  let ledger = {};
  let clock = 1_000_000;
  const deps = {
    collect: async () => JSON.parse(JSON.stringify(device)),
    apply: async (cfg) => {
      calls.apply.push(cfg);
      if (cfg.usb_storage.enabled) device.usb_storage_deny_all = 1;
      if (cfg.firewall_notifications?.enabled) device.firewall_notifications = { domain: 1, private: 1, public: 1 };
      if (cfg.bitlocker.enabled) {
        device.bitlocker.protection_status = 'On';
        device.bitlocker.volume_status = 'FullyEncrypted';
        device.bitlocker.encryption_method = 'XtsAes256';
      }
      return { applied: true, errors: [] };
    },
    revert: async (entries) => {
      calls.revert.push(entries);
      if (deps.failRevert) return { reverted: [], errors: ['usb_storage: refused'] };
      if ('usb_storage' in entries) device.usb_storage_deny_all = entries.usb_storage.deny_all;
      if ('firewall_notifications' in entries) device.firewall_notifications = { ...entries.firewall_notifications };
      return { reverted: Object.keys(entries), errors: [] };
    },
    readRecoveryKeys: async () => {
      device.bitlocker.key_protectors = ['RecoveryPassword'];
      device.bitlocker.recovery_protector_ids = ['{k}'];
      return [{ protector_id: '{k}', recovery_password: 'secret' }];
    },
    request: async (url, opts) => {
      if (url.endsWith('/recovery-key') && deps.failEscrow) throw new Error('down');
      calls.posted.push({ url, body: opts.body });
      return { ok: true };
    },
    loadLedger: () => ledger,
    saveLedger: (next) => { ledger = JSON.parse(JSON.stringify(next)); },
    now: () => clock
  };
  const manager = new PolicyManager({
    config: { apiBase: 'http://x', paths: { stateDir: '.' } },
    credentials: { deviceToken: 't' },
    logger: { info() {}, warn() {} },
    deps
  });
  const lastStatus = () =>
    calls.posted.filter((p) => p.url.endsWith('/policy/status')).at(-1)?.body;
  return {
    manager, device, calls, deps, lastStatus,
    ledger: () => ledger,
    advance: (ms) => { clock += ms; }
  };
}

(async () => {
  // Options that used to be impossible to satisfy.
  let result = evaluatePolicy(
    config({ local_admin: { enabled: true, disable_builtin_administrator: false } }),
    { builtin_administrator: { disabled: false } }
  );
  assert.equal(result.checks.local_admin.ok, true, 'local admin report-only passes');

  const manualUpdates = config({
    windows_update: { enabled: true, auto_update: false, defer_quality_days: 0, defer_feature_days: 0 }
  });
  result = evaluatePolicy(manualUpdates, { windows_update: { no_auto_update: 1 } });
  assert.equal(result.checks.windows_update.ok, true, 'auto-update off can comply');
  result = evaluatePolicy(manualUpdates, { windows_update: { no_auto_update: 0 } });
  assert.equal(result.checks.windows_update.ok, false, 'auto-update off detects on');
  result = evaluatePolicy(manualUpdates, { windows_update: {} });
  assert.equal(result.checks.windows_update.ok, false, 'absent value is not "off"');

  // BitLocker method and recovery key are both checked.
  const bl = config({ bitlocker: { enabled: true, encryption_method: 'XtsAes256' } });
  const on = { protection_status: 'On', volume_status: 'FullyEncrypted' };
  result = evaluatePolicy(bl, {
    bitlocker: { ...on, encryption_method: 'Aes128', key_protectors: ['RecoveryPassword'] }
  });
  assert.equal(result.checks.bitlocker.ok, false, 'wrong method fails');
  result = evaluatePolicy(bl, {
    bitlocker: { ...on, encryption_method: 'XtsAes256', key_protectors: ['Tpm'] }
  });
  assert.equal(result.checks.bitlocker.ok, false, 'no recovery key fails');
  result = evaluatePolicy(bl, {
    bitlocker: { ...on, encryption_method: 'XtsAes256', key_protectors: ['Tpm', 'RecoveryPassword'] }
  });
  assert.equal(result.checks.bitlocker.ok, true, 'correct setup passes');

  // Generated scripts never re-create an existing registry key.
  const everything = config({
    firewall: { enabled: true, profiles: ['domain'] },
    screen_lock: { enabled: true, timeout_minutes: 10 },
    usb_storage: { enabled: true },
    windows_update: { enabled: true, auto_update: true, defer_quality_days: 0, defer_feature_days: 0 }
  });
  const unguarded = (script) =>
    script.split('\n').filter((line) => /New-Item\s/.test(line) && !line.includes('Test-Path'));
  if (process.platform === 'win32') {
    assert.deepEqual(unguarded(buildApplyScript(everything)), [], 'apply: unguarded New-Item');
  }
  assert.deepEqual(
    unguarded(buildRevertScript({ usb_storage: { deny_all: 0 }, screen_lock: { seconds: 300 } })),
    [],
    'revert: unguarded New-Item'
  );
  assert.throws(() => buildRevertScript({ usb_storage: { deny_all: '1; rm' } }), 'bad ledger value');

  // Admin removal can never leave a PC without a usable admin.
  const admins = (remove_other_admins, allowed_admins, disable_builtin_administrator = false) =>
    config({
      local_admin: { enabled: true, disable_builtin_administrator, remove_other_admins, allowed_admins }
    });
  const members = [
    { name: 'PC\\Administrator', object_class: 'User', sid: 'S-1-5-21-1-2-3-500', enabled: true },
    { name: 'PC\\it', object_class: 'User', sid: 'S-1-5-21-1-2-3-1001', enabled: true },
    { name: 'PC\\staff', object_class: 'User', sid: 'S-1-5-21-1-2-3-1002', enabled: true },
    { name: 'DOMAIN\\Domain Admins', object_class: 'Group', sid: 'S-1-5-21-9-9-9-512', enabled: null }
  ];
  let plan = adminPlan(admins(true, ['it']), { administrators: members });
  assert.deepEqual(plan.remove.map((m) => m.name), ['PC\\staff'], 'only unapproved users go');
  assert.equal(adminPlan(admins(true, ['PC\\IT']), { administrators: members }).remove.length, 1, 'name match');
  plan = adminPlan(admins(true, ['nobody']), { administrators: members });
  assert.ok(plan.error && !plan.remove.length, 'approved account missing: remove nobody');
  plan = adminPlan(admins(true, ['Administrator'], true), { administrators: members });
  assert.ok(plan.error && !plan.remove.length, 'approved account being disabled: remove nobody');
  plan = adminPlan(admins(true, ['it']), {
    administrators: members.map((m) => (m.name === 'PC\\it' ? { ...m, enabled: false } : m))
  });
  assert.ok(plan.error && !plan.remove.length, 'approved account disabled: remove nobody');
  plan = adminPlan(admins(true, ['it']), { administrators: [], administrators_error: 'bad' });
  assert.ok(plan.error && !plan.remove.length, 'unreadable group: remove nobody');
  result = evaluatePolicy(admins(true, ['it']), {
    administrators: members,
    builtin_administrator: { disabled: true }
  });
  assert.equal(result.checks.admin_accounts.ok, false, 'unapproved admin is reported');

  // Website blocklist must match exactly, per browser.
  const web = config({ web_filter: { enabled: true, blocked_domains: ['a.com'] } });
  const good = { chrome: ['a.com'], edge: ['a.com'], brave: ['a.com'], firefox: ['*://*.a.com/*'] };
  assert.equal(evaluatePolicy(web, { web_filter: good }).checks.web_filter.ok, true);
  assert.equal(
    evaluatePolicy(web, { web_filter: { ...good, edge: [] } }).checks.web_filter.ok,
    false,
    'missing browser is caught'
  );

  // Flagged software is matched case-insensitively and only reported.
  const watch = config({ software_watch: { enabled: true, flagged_names: ['teamviewer'] } });
  result = evaluatePolicy(watch, { installed_software: ['TeamViewer 15', 'Word'] });
  assert.equal(result.checks.software_watch.ok, false);
  assert.ok(result.checks.software_watch.detail.includes('TeamViewer 15'));
  assert.equal(evaluatePolicy(watch, { installed_software: ['Word'] }).compliant, true);

  // Device-sourced text can't reach the PowerShell source.
  const hostile = "x'; Remove-Item C:\\*; '";
  assert.ok(
    !buildRevertScript({ web_filter: { chrome: [hostile], edge: [], brave: [], firefox: [] } }).includes(hostile),
    'revert values are encoded'
  );
  assert.ok(
    !buildRevertScript({ admin_accounts: { sids: [hostile] } }).includes(hostile),
    'bad SID is dropped'
  );

  // Windows won't enable an account whose password breaks the active rule, so the rule goes first.
  const restore = buildRevertScript({
    local_admin: { sid: 'S-1-5-21-1-2-3-500', disabled: false },
    password_policy: { min_length: 0, max_age_days: 42, lockout_threshold: 0 }
  });
  assert.ok(
    restore.includes('net.exe accounts') &&
      restore.indexOf('net.exe accounts') < restore.indexOf('Enable-LocalUser'),
    'password rule is restored before the built-in Administrator'
  );

  // A password policy that can't be read must not look like a real value of 0.
  const unreadable = evaluatePolicy(
    config({ password_policy: { enabled: true, min_length: 12, max_age_days: 90, lockout_threshold: 5 } }),
    { password_policy: { error: 'Access is denied' } }
  ).checks.password_policy;
  assert.equal(unreadable.ok, false, 'unreadable password policy fails the check');
  assert.ok(unreadable.detail.includes('Could not read'), 'unreadable password policy says so');
  assert.ok(!unreadable.detail.includes('Minimum length 0'), 'no made-up password values');

  // The .msi block must cover admins too, which only DisableMSI=2 does.
  const msiCheck = (disable_msi) =>
    evaluatePolicy(config({ software_install: { enabled: true } }), {
      software_install: { disable_msi, disable_user_installs: 1 }
    }).checks.software_install.ok;
  assert.equal(msiCheck(2), true, 'DisableMSI=2 is compliant');
  assert.equal(msiCheck(1), false, 'DisableMSI=1 lets admins through, so it is not compliant');
  if (process.platform === 'win32') {
    assert.ok(
      buildApplyScript(config({ software_install: { enabled: true } })).includes('-Name DisableMSI -Value 2'),
      'the policy sets DisableMSI=2'
    );
  }

  // Hiding firewall notifications needs all three profile keys (Private is StandardProfile).
  const fwOn = config({ firewall_notifications: { enabled: true } });
  const fwCheck = (state) => evaluatePolicy(fwOn, { firewall_notifications: state }).checks.firewall_notifications.ok;
  assert.equal(fwCheck({ domain: 1, private: 1, public: 1 }), true, 'all profiles hidden is compliant');
  assert.equal(fwCheck({ domain: 1, private: 0, public: 1 }), false, 'one profile at 0 is not compliant');
  assert.equal(fwCheck({ domain: 1, private: 1, public: null }), false, 'a missing profile is not compliant');
  if (process.platform === 'win32') {
    const fwScript = buildApplyScript(fwOn);
    assert.ok(fwScript.includes('-Name DisableNotifications -Value 1'), 'the policy sets DisableNotifications=1');
    for (const profileKey of ['DomainProfile', 'StandardProfile', 'PublicProfile']) {
      assert.ok(fwScript.includes(profileKey), `${profileKey} is written`);
    }
  }

  // Restore failures read as plain language.
  const passwordBlocked = restoreMessage(
    "local_admin: Exception of type 'Microsoft.PowerShell.Commands.InvalidPasswordException' was thrown."
  );
  assert.ok(passwordBlocked.includes('built-in Administrator'), 'names the account');
  assert.ok(passwordBlocked.includes('password rule'), 'names the reason');
  assert.ok(!passwordBlocked.includes('Exception'), 'no raw exception text');
  assert.equal(
    restoreMessage('usb_storage: refused'),
    'Could not restore USB storage blocking: refused',
    'other settings get a readable name'
  );

  // Enforce, drift, re-enforce.
  let h = harness();
  const usb = policy({ usb_storage: { enabled: true } });
  await h.manager.sync(usb);
  assert.equal(h.lastStatus().status, 'applied');
  assert.deepEqual(h.ledger().usb_storage, { deny_all: null }, 'original value recorded');

  await h.manager.sync(usb);
  assert.equal(h.calls.apply.length, 1, 'no recheck inside the interval');

  h.device.usb_storage_deny_all = 0;
  h.advance(RECHECK_AFTER_MS + 1);
  await h.manager.sync(usb);
  assert.equal(h.calls.apply.length, 2, 'drift is re-enforced');
  assert.equal(h.device.usb_storage_deny_all, 1);
  assert.deepEqual(h.ledger().usb_storage, { deny_all: null }, 'drift keeps the original value');

  // Turning the setting off restores the original.
  h.advance(1);
  await h.manager.sync(policy({}, 'h2'));
  assert.equal(h.device.usb_storage_deny_all, null, 'setting off restores the device');
  assert.deepEqual(h.ledger(), {});

  // Firewall notification hiding is restored to the original values (absent stays absent).
  h = harness({ firewall_notifications: { domain: 0, private: null, public: 1 } });
  await h.manager.sync(policy({ firewall_notifications: { enabled: true } }));
  assert.deepEqual(h.device.firewall_notifications, { domain: 1, private: 1, public: 1 });
  assert.deepEqual(h.ledger().firewall_notifications, { domain: 0, private: null, public: 1 }, 'originals recorded');
  h.advance(1);
  await h.manager.sync(policy({}, 'h2'));
  assert.deepEqual(h.device.firewall_notifications, { domain: 0, private: null, public: 1 }, 'originals restored');
  assert.deepEqual(h.ledger(), {}, 'ledger entry is gone');

  // A failed restore reaches the admin instead of reading as compliant, then retries.
  h = harness();
  await h.manager.sync(usb);
  h.advance(1);
  h.deps.failRevert = true;
  const released = policy({}, 'h2');
  await h.manager.sync(released);
  assert.equal(h.lastStatus().status, 'failed', 'failed restore is not compliant');
  assert.ok(
    h.lastStatus().errors.includes('Could not restore USB storage blocking: refused'),
    'failed restore says what failed'
  );
  assert.ok('usb_storage' in h.ledger(), 'failed restore keeps the original value');
  h.deps.failRevert = false;
  h.advance(5 * 60 * 1000 + 1);
  await h.manager.sync(released);
  assert.equal(h.lastStatus().status, 'compliant', 'status clears once the restore works');
  assert.deepEqual(h.ledger(), {});

  // Audit mode never changes the device, and keeps the undo record.
  h = harness();
  await h.manager.sync(usb);
  h.advance(1);
  await h.manager.sync(policy({ mode: 'audit' }, 'h2'));
  assert.equal(h.calls.revert.length, 0, 'audit does not revert');
  assert.ok(h.ledger().usb_storage, 'audit keeps the ledger');

  // Removing the policy restores; retried if nothing is left to do it is a no-op.
  h.advance(RECHECK_AFTER_MS);
  await h.manager.sync(null);
  assert.equal(h.calls.revert.length, 1, 'no policy reverts');
  assert.equal(h.manager.getSummary(), null);
  await h.manager.sync(null);
  assert.equal(h.calls.revert.length, 1, 'nothing left to revert');

  // A malformed server answer must not undo anything.
  h = harness();
  await h.manager.sync(usb);
  h.advance(RECHECK_AFTER_MS);
  h.deps.request = async () => ({});
  await h.manager.syncFromServer();
  assert.equal(h.calls.revert.length, 0, 'malformed response is ignored');

  // An unreadable original is neither recorded nor enforced until it can be read.
  h = harness({ password_policy: { error: 'secedit failed' } });
  const rules = policy({ password_policy: { enabled: true, min_length: 12, max_age_days: 90, lockout_threshold: 5 } });
  await h.manager.sync(rules);
  assert.ok(!('password_policy' in h.ledger()), 'unreadable original is not recorded');
  assert.equal(h.calls.apply.at(-1).password_policy.enabled, false, 'unreadable setting is not enforced');
  assert.equal(rules.config.password_policy.enabled, true, 'policy config is not mutated');
  assert.equal(h.lastStatus().status, 'failed');
  assert.ok(h.lastStatus().errors.join(' ').includes('the password rules'), 'error names the setting');
  h.device.password_policy = { min_length: 0, max_age_days: 0, lockout_threshold: 0 };
  h.advance(5 * 60 * 1000 + 1);
  await h.manager.sync(rules);
  assert.deepEqual(h.ledger().password_policy, { min_length: 0, max_age_days: 0, lockout_threshold: 0 }, 'real original recorded once readable');
  assert.equal(h.calls.apply.at(-1).password_policy.enabled, true, 'enforced once readable');

  h = harness({ administrators_error: 'boom' });
  await h.manager.sync(policy({ local_admin: { enabled: true, disable_builtin_administrator: false, remove_other_admins: true } }));
  assert.ok(!('admin_accounts' in h.ledger()), 'unreadable admins are not recorded');
  assert.equal(h.calls.apply.at(-1).local_admin.remove_other_admins, false, 'admins are not removed blind');

  // Skipping local_admin must not make the built-in count as a usable admin for removal.
  h = harness({
    administrators: [
      { name: 'PC\Administrator', sid: 'S-1-5-21-1-500', object_class: 'User', enabled: true },
      { name: 'PC\bob', sid: 'S-1-5-21-1-1001', object_class: 'User', enabled: true }
    ]
  });
  await h.manager.sync(policy({
    local_admin: {
      enabled: true, disable_builtin_administrator: true, remove_other_admins: true,
      allowed_admins: ['Administrator']
    }
  }));
  assert.equal(h.calls.apply.at(-1).local_admin.disable_builtin_administrator, false, 'local_admin skipped');
  assert.equal(h.calls.apply.at(-1).local_admin.remove_other_admins, false, 'no removal against a changed config');

  // BitLocker: no encryption until the key is stored.
  h = harness();
  h.deps.failEscrow = true;
  const encrypt = policy({ bitlocker: { enabled: true, encryption_method: 'XtsAes256' } });
  await h.manager.sync(encrypt);
  assert.equal(h.calls.apply[0].bitlocker.enabled, false, 'escrow failure blocks encryption');
  assert.equal(h.lastStatus().status, 'failed');
  assert.ok(!JSON.stringify(h.lastStatus()).includes('secret'), 'status must not hold the key');

  h.deps.failEscrow = false;
  h.advance(RECHECK_AFTER_MS);
  await h.manager.sync(encrypt);
  assert.equal(h.calls.apply.at(-1).bitlocker.enabled, true, 'encrypts after escrow');
  assert.equal(h.lastStatus().status, 'applied');
  const uploads = () => h.calls.posted.filter((p) => p.url.endsWith('/recovery-key')).length;
  assert.equal(uploads(), 1);
  h.advance(RECHECK_AFTER_MS);
  await h.manager.sync(encrypt);
  assert.equal(uploads(), 1, 'key is not re-uploaded every check');
  assert.equal(h.ledger().bitlocker, undefined, 'BitLocker is never reverted');

  console.log('policy self-check passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
