'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const { requestJson } = require('./http');
const { writeSecureJson } = require('./identity');

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 60_000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const RECHECK_AFTER_MS = 15 * 60 * 1000;
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const INSTALLER_POLICY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer';
// Group Policy keys per profile; Private is stored as StandardProfile.
const FIREWALL_POLICY_ROOT = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsFirewall';
const FIREWALL_POLICY_KEYS = {
  domain: `${FIREWALL_POLICY_ROOT}\\DomainProfile`,
  private: `${FIREWALL_POLICY_ROOT}\\StandardProfile`,
  public: `${FIREWALL_POLICY_ROOT}\\PublicProfile`
};
const WEB_FILTER_KEYS = {
  chrome: 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome\\URLBlocklist',
  edge: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\URLBlocklist',
  brave: 'HKLM:\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\URLBlocklist',
  firefox: 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\WebsiteFilter\\Block'
};

/** The exact blocklist each browser should hold. Firefox uses match patterns. */
function webFilterTargets(domains) {
  return {
    chrome: domains,
    edge: domains,
    brave: domains,
    firefox: domains.map((domain) => `*://*.${domain}/*`)
  };
}

const sameList = (a, b) =>
  JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/**
 * Who to take out of Administrators. Refuses to remove anyone unless an approved
 * account would still be a usable admin afterwards, so a PC can't be locked out.
 * Only user accounts are removed; groups and the built-in account are left alone.
 */
function adminPlan(config, state) {
  if (!Array.isArray(state.administrators) || state.administrators_error) {
    return { remove: [], error: 'Could not read the Administrators group; nobody was removed.' };
  }

  const allowed = (config.local_admin.allowed_admins || []).map((name) => name.toLowerCase());
  const isAllowed = (member) => {
    const full = String(member.name || '').toLowerCase();
    return allowed.includes(full) || allowed.includes(full.split('\\').pop());
  };
  const isBuiltin = (member) => /-500$/.test(String(member.sid || ''));

  const usable = state.administrators.filter(
    (member) =>
      isAllowed(member) &&
      member.enabled !== false &&
      !(isBuiltin(member) && config.local_admin.disable_builtin_administrator)
  );
  if (!usable.length) {
    return {
      remove: [],
      error: 'None of the approved accounts is an enabled admin on this PC; nobody was removed.'
    };
  }

  return {
    remove: state.administrators.filter(
      (member) =>
        String(member.object_class).toLowerCase() === 'user' &&
        !isAllowed(member) &&
        !isBuiltin(member) &&
        /^S-1-[\d-]+$/.test(String(member.sid || ''))
    ),
    error: null
  };
}

function normalizeBool(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function normalizeInt(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bitLockerProtected(state) {
  const protection = String(state?.protection_status || '').toLowerCase();
  const volume = String(state?.volume_status || '').toLowerCase();
  return (
    (protection === 'on' || protection === '1' || protection === 'true') &&
    volume !== 'fullydecrypted'
  );
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );

  const text = String(stdout || '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function collectPolicyState() {
  if (process.platform !== 'win32') {
    return { platform: process.platform, unsupported: true };
  }

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'function Get-RegInt([string]$path, [string]$name) {',
    '  $p = Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { return $null }',
    '  return [int]$p.$name',
    '}',
    'function Get-RegList([string]$path) {',
    '  $item = Get-Item -Path $path -ErrorAction SilentlyContinue',
    '  if (-not $item) { return }',
    '  $item.GetValueNames() | Where-Object { $_ } | ForEach-Object { [string]$item.GetValue($_) }',
    '}',
    '$bitlocker = $null',
    'try {',
    '  $bl = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop',
    '  $protectors = @($bl.KeyProtector | ForEach-Object { [string]$_.KeyProtectorType })',
    '  $bitlocker = [pscustomobject]@{',
    '    available = $true',
    '    protection_status = [string]$bl.ProtectionStatus',
    '    volume_status = [string]$bl.VolumeStatus',
    '    encryption_percentage = [double]$bl.EncryptionPercentage',
    '    key_protectors = $protectors',
    '    encryption_method = [string]$bl.EncryptionMethod',
    '    recovery_protector_ids = @($bl.KeyProtector | Where-Object { [string]$_.KeyProtectorType -eq "RecoveryPassword" } | ForEach-Object { [string]$_.KeyProtectorId })',
    '  }',
    '} catch {',
    '  $bitlocker = [pscustomobject]@{ available = $false; error = [string]$_.Exception.Message }',
    '}',
    '$firewall = @(Get-NetFirewallProfile | ForEach-Object {',
    '  [pscustomobject]@{ name = [string]$_.Name; enabled = [bool]$_.Enabled }',
    '})',
    '$screenLock = Get-RegInt "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" "InactivityTimeoutSecs"',
    '$usbDenyAll = Get-RegInt "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\RemovableStorageDevices" "Deny_All"',
    '$builtinAdmin = $null',
    '$a = Get-CimInstance -ClassName Win32_UserAccount -Filter "LocalAccount=True AND SID LIKE \'%-500\'" -ErrorAction SilentlyContinue | Select-Object -First 1',
    'if ($a) { $builtinAdmin = [pscustomobject]@{ name = [string]$a.Name; disabled = [bool]$a.Disabled; sid = [string]$a.SID } }',
    '$admins = @()',
    '$adminsError = $null',
    'try {',
    '  $group = Get-LocalGroup -SID "S-1-5-32-544" -ErrorAction Stop',
    '  $admins = @(Get-LocalGroupMember -Group $group -ErrorAction Stop | ForEach-Object {',
    '    $enabled = $null',
    '    if ([string]$_.PrincipalSource -eq "Local" -and [string]$_.ObjectClass -eq "User") {',
    '      $localUser = Get-LocalUser -SID $_.SID -ErrorAction SilentlyContinue',
    '      if ($localUser) { $enabled = [bool]$localUser.Enabled }',
    '    }',
    '    [pscustomobject]@{ name = [string]$_.Name; object_class = [string]$_.ObjectClass; source = [string]$_.PrincipalSource; sid = [string]$_.SID; enabled = $enabled }',
    '  })',
    '} catch { $admins = @(); $adminsError = [string]$_.Exception.Message }',
    '$installed = @(Get-ItemProperty @(',
    '  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '  "Registry::HKEY_USERS\\*\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
    ') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { [string]$_.DisplayName } | Sort-Object -Unique)',
    '$password = $null',
    '$tmp = Join-Path $env:TEMP ("acehrm-sec-" + [guid]::NewGuid().ToString() + ".inf")',
    'try {',
    '  & secedit.exe /export /cfg $tmp | Out-Null',
    '  $content = Get-Content $tmp -ErrorAction Stop',
    '  function Get-SecValue([string]$key) {',
    '    $pattern = "^\\s*" + [regex]::Escape($key) + "\\s*="',
    '    $line = $content | Where-Object { $_ -match $pattern } | Select-Object -First 1',
    '    if (-not $line) { return $null }',
    '    return ($line -replace "^\\s*[^=]+=\\s*", "").Trim()',
    '  }',
    '  $password = [pscustomobject]@{',
    '    min_length = [int](Get-SecValue "MinimumPasswordLength")',
    '    max_age_days = [int](Get-SecValue "MaximumPasswordAge")',
    '    lockout_threshold = [int](Get-SecValue "LockoutBadCount")',
    '    lockout_duration = [int](Get-SecValue "LockoutDuration")',
    '    lockout_window = [int](Get-SecValue "ResetLockoutCount")',
    '  }',
    '} catch {',
    '  $password = [pscustomobject]@{ error = [string]$_.Exception.Message }',
    '} finally {',
    '  Remove-Item $tmp -Force -ErrorAction SilentlyContinue',
    '}',
    '$au = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU"',
    '$wuRoot = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"',
    '$wuService = Get-Service -Name wuauserv -ErrorAction SilentlyContinue',
    '[pscustomobject]@{',
    '  platform = "windows"',
    '  bitlocker = $bitlocker',
    '  firewall = @($firewall)',
    '  screen_lock_seconds = $screenLock',
    '  usb_storage_deny_all = $usbDenyAll',
    '  builtin_administrator = $builtinAdmin',
    '  administrators = @($admins)',
    '  administrators_error = $adminsError',
    '  installed_software = @($installed)',
    `  web_filter = [pscustomobject]@{ chrome = @(Get-RegList "${WEB_FILTER_KEYS.chrome}"); edge = @(Get-RegList "${WEB_FILTER_KEYS.edge}"); brave = @(Get-RegList "${WEB_FILTER_KEYS.brave}"); firefox = @(Get-RegList "${WEB_FILTER_KEYS.firefox}") }`,
    `  software_install = [pscustomobject]@{ disable_msi = Get-RegInt "${INSTALLER_POLICY}" "DisableMSI"; disable_user_installs = Get-RegInt "${INSTALLER_POLICY}" "DisableUserInstalls" }`,
    `  firewall_notifications = [pscustomobject]@{ ${Object.entries(FIREWALL_POLICY_KEYS).map(([name, keyPath]) => `${name} = Get-RegInt "${keyPath}" "DisableNotifications"`).join('; ')} }`,
    '  password_policy = $password',
    '  windows_update = [pscustomobject]@{',
    '    no_auto_update = Get-RegInt $au "NoAutoUpdate"',
    '    au_options = Get-RegInt $au "AUOptions"',
    '    scheduled_install_day = Get-RegInt $au "ScheduledInstallDay"',
    '    scheduled_install_time = Get-RegInt $au "ScheduledInstallTime"',
    '    defer_quality = Get-RegInt $wuRoot "DeferQualityUpdates"',
    '    defer_quality_days = Get-RegInt $wuRoot "DeferQualityUpdatesPeriodInDays"',
    '    defer_feature = Get-RegInt $wuRoot "DeferFeatureUpdates"',
    '    defer_feature_days = Get-RegInt $wuRoot "DeferFeatureUpdatesPeriodInDays"',
    '    service_status = if ($wuService) { [string]$wuService.Status } else { $null }',
    '    start_type = if ($wuService) { [string]$wuService.StartType } else { $null }',
    '  }',
    '  collected_at = (Get-Date).ToUniversalTime().ToString("o")',
    '} | ConvertTo-Json -Depth 8 -Compress'
  ].join('\n');

  return runPowerShell(script);
}

function evaluatePolicy(config, state) {
  const checks = {};

  if (config.firewall.enabled) {
    const profiles = new Map(
      (Array.isArray(state.firewall) ? state.firewall : []).map((profile) => [
        String(profile.name || '').toLowerCase(),
        normalizeBool(profile.enabled)
      ])
    );
    const missing = config.firewall.profiles.filter(
      (profile) => profiles.get(profile) !== true
    );
    checks.firewall = {
      enabled: true,
      ok: missing.length === 0,
      detail: missing.length
        ? `Disabled or missing profiles: ${missing.join(', ')}`
        : `Enabled profiles: ${config.firewall.profiles.join(', ')}`
    };
  }

  if (config.screen_lock.enabled) {
    const seconds = normalizeInt(state.screen_lock_seconds, 0);
    const target = config.screen_lock.timeout_minutes * 60;
    checks.screen_lock = {
      enabled: true,
      ok: seconds > 0 && seconds <= target,
      detail: seconds > 0
        ? `Machine inactivity limit is ${Math.round(seconds / 60)} minutes`
        : 'Machine inactivity limit is not configured'
    };
  }

  if (config.usb_storage.enabled) {
    const denied = normalizeInt(state.usb_storage_deny_all, 0) === 1;
    checks.usb_storage = {
      enabled: true,
      ok: denied,
      detail: denied ? 'Removable storage is blocked by policy' : 'Removable storage is not blocked'
    };
  }

  if (config.bitlocker.enabled) {
    const protectedVolume = bitLockerProtected(state.bitlocker);
    const hasRecoveryKey = (state.bitlocker?.key_protectors || []).includes('RecoveryPassword');
    const actualMethod = state.bitlocker?.encryption_method;
    const wrongMethod =
      protectedVolume && actualMethod !== config.bitlocker.encryption_method;
    let detail = `System drive protection is ${state.bitlocker?.protection_status || 'on'} (${actualMethod})`;
    if (state.bitlocker?.error) detail = state.bitlocker.error;
    else if (!protectedVolume) detail = 'System drive BitLocker protection is not enabled';
    else if (wrongMethod) {
      detail = `Drive uses ${actualMethod}, policy requires ${config.bitlocker.encryption_method}. Changing method needs a manual decrypt and re-encrypt.`;
    } else if (!hasRecoveryKey) detail = 'System drive has no recovery key protector';
    checks.bitlocker = {
      enabled: true,
      ok: protectedVolume && hasRecoveryKey && !wrongMethod,
      detail
    };
  }

  if (config.local_admin.enabled) {
    const admin = state.builtin_administrator;
    const disabled = admin
      ? normalizeBool(admin.disabled)
      : false;
    checks.local_admin = {
      enabled: true,
      ok: disabled || !config.local_admin.disable_builtin_administrator,
      detail: admin
        ? disabled
          ? 'Built-in Administrator is disabled'
          : 'Built-in Administrator is enabled'
        : 'Built-in Administrator account was not found',
      administrators: Array.isArray(state.administrators)
        ? state.administrators
        : []
    };
  }

  if (config.password_policy.enabled) {
    const policy = state.password_policy || { error: 'no data was collected' };
    const minLength = normalizeInt(policy.min_length, 0);
    const maxAge = normalizeInt(policy.max_age_days, 0);
    const lockout = normalizeInt(policy.lockout_threshold, 0);
    const maxAgeOk =
      config.password_policy.max_age_days <= 0
        ? maxAge <= 0
        : maxAge > 0 && maxAge <= config.password_policy.max_age_days;
    const lockoutOk =
      config.password_policy.lockout_threshold <= 0
        ? lockout === 0
        : lockout > 0 && lockout <= config.password_policy.lockout_threshold;
    const ok =
      !policy.error && minLength >= config.password_policy.min_length && maxAgeOk && lockoutOk;
    checks.password_policy = {
      enabled: true,
      ok,
      detail: policy.error
        ? `Could not read the password policy: ${policy.error}`
        : `Minimum length ${minLength}, max age ${maxAge}, lockout ${lockout}`
    };
  }

  if (config.windows_update.enabled) {
    const update = state.windows_update || {};
    const wantAuto = config.windows_update.auto_update;
    const autoOk = wantAuto
      ? normalizeInt(update.no_auto_update, 1) === 0 &&
        normalizeInt(update.au_options, 0) === 4 &&
        String(update.start_type || '').toLowerCase() === 'automatic'
      : normalizeInt(update.no_auto_update, 0) === 1;
    const deferOk =
      normalizeInt(update.defer_quality_days, 0) === config.windows_update.defer_quality_days &&
      normalizeInt(update.defer_feature_days, 0) === config.windows_update.defer_feature_days;
    const ok = autoOk && deferOk;
    checks.windows_update = {
      enabled: true,
      ok,
      detail: ok
        ? `Automatic updates are ${wantAuto ? 'on' : 'off'} and deferrals match`
        : 'Automatic updates, update service, or deferral settings are not compliant'
    };
  }

  if (config.local_admin.enabled && config.local_admin.remove_other_admins) {
    const plan = adminPlan(config, state);
    const names = plan.remove.map((member) => member.name).join(', ');
    checks.admin_accounts = {
      enabled: true,
      ok: !plan.error && plan.remove.length === 0,
      detail:
        plan.error ||
        (names ? `Unapproved administrators: ${names}` : 'Only approved accounts are administrators')
    };
  }

  if (config.web_filter?.enabled) {
    const targets = webFilterTargets(config.web_filter.blocked_domains);
    const stale = Object.keys(targets).filter(
      (browser) => !sameList(state.web_filter?.[browser], targets[browser])
    );
    checks.web_filter = {
      enabled: true,
      ok: stale.length === 0,
      detail: stale.length
        ? `Website blocklist is not applied for: ${stale.join(', ')}`
        : `${config.web_filter.blocked_domains.length} website(s) blocked in Chrome, Edge, Brave and Firefox`
    };
  }

  if (config.software_install?.enabled) {
    // DisableMSI=1 only stops non-admins; 2 stops everyone.
    const ok =
      normalizeInt(state.software_install?.disable_msi, 0) === 2 &&
      normalizeInt(state.software_install?.disable_user_installs, 0) === 1;
    checks.software_install = {
      enabled: true,
      ok,
      detail: ok
        ? 'Windows Installer (.msi) installs are blocked for everyone'
        : '.msi installs are not fully blocked'
    };
  }

  if (config.firewall_notifications?.enabled) {
    const ok = Object.keys(FIREWALL_POLICY_KEYS).every(
      (name) => normalizeInt(state.firewall_notifications?.[name], 0) === 1
    );
    checks.firewall_notifications = {
      enabled: true,
      ok,
      detail: ok
        ? 'Firewall block notifications are hidden on all profiles'
        : 'Firewall block notifications are not hidden on every profile'
    };
  }

  if (config.software_watch?.enabled) {
    const flagged = config.software_watch.flagged_names.map((name) => name.toLowerCase());
    const found = (Array.isArray(state.installed_software) ? state.installed_software : []).filter(
      (name) => flagged.some((item) => String(name).toLowerCase().includes(item))
    );
    checks.software_watch = {
      enabled: true,
      ok: found.length === 0,
      detail: found.length
        ? `Flagged software installed: ${found.slice(0, 25).join(', ')}`
        : 'No flagged software found'
    };
  }

  return {
    compliant: Object.values(checks).every((check) => check.ok),
    checks
  };
}

// New-Item -Force on an existing registry key wipes its values and subkeys,
// so it must only ever run when the key is missing.
const ENSURE_REG_KEY = [
  'function Ensure-RegKey([string]$path) {',
  '  if (-not (Test-Path $path)) { New-Item -Path $path -Force -ErrorAction Stop | Out-Null }',
  '}',
  // Replaces only the browser's own blocklist key, never its parent policy key.
  'function Set-RegList([string]$path, $items) {',
  '  if (Test-Path $path) { Remove-Item -Path $path -Recurse -Force -ErrorAction Stop }',
  '  $list = @($items | Where-Object { $_ })',
  '  if (-not $list.Count) { return }',
  '  Ensure-RegKey $path',
  '  $i = 1',
  '  foreach ($item in $list) {',
  '    New-ItemProperty -Path $path -Name ([string]$i) -Value ([string]$item) -PropertyType String -Force -ErrorAction Stop | Out-Null',
  '    $i++',
  '  }',
  '}'
];

/** Base64 keeps device or admin text out of the PowerShell source entirely. */
function psJson(value) {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))`;
}

function buildApplyScript(config, state = {}) {
  if (process.platform !== 'win32') return null;

  const lines = [
    "$ErrorActionPreference='Continue'",
    '$errors = New-Object System.Collections.Generic.List[string]',
    ...ENSURE_REG_KEY
  ];

  if (config.firewall.enabled) {
    const profiles = config.firewall.profiles
      .map((profile) => profile.charAt(0).toUpperCase() + profile.slice(1))
      .join(',');
    lines.push(
      'try {',
      `  Set-NetFirewallProfile -Profile ${profiles} -Enabled True -ErrorAction Stop | Out-Null`,
      '} catch { $errors.Add("firewall: $($_.Exception.Message)") }'
    );
  }

  if (config.screen_lock.enabled) {
    const seconds = config.screen_lock.timeout_minutes * 60;
    lines.push(
      'try {',
      '  $path = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"',
      '  Ensure-RegKey $path',
      `  New-ItemProperty -Path $path -Name InactivityTimeoutSecs -Value ${seconds} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      '} catch { $errors.Add("screen_lock: $($_.Exception.Message)") }'
    );
  }

  if (config.usb_storage.enabled) {
    lines.push(
      'try {',
      '  $path = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\RemovableStorageDevices"',
      '  Ensure-RegKey $path',
      '  New-ItemProperty -Path $path -Name Deny_All -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null',
      '} catch { $errors.Add("usb_storage: $($_.Exception.Message)") }'
    );
  }

  if (config.bitlocker.enabled) {
    const method = config.bitlocker.encryption_method;
    lines.push(
      'try {',
      '  $bitlocker = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop',
      '  if ([string]$bitlocker.VolumeStatus -eq "FullyDecrypted") {',
      `    $params = @{ MountPoint = $env:SystemDrive; EncryptionMethod = "${method}"; UsedSpaceOnly = $true; TpmProtector = $true }`,
      '    if ((Get-Command Enable-BitLocker -ErrorAction SilentlyContinue).Parameters.ContainsKey("SkipHardwareTest")) { $params.SkipHardwareTest = $true }',
      '    Enable-BitLocker @params -ErrorAction Stop | Out-Null',
      '  }',
      '} catch { $errors.Add("bitlocker: $($_.Exception.Message)") }'
    );
  }

  if (config.local_admin.enabled && config.local_admin.disable_builtin_administrator) {
    lines.push(
      'try {',
      '  $builtin = Get-CimInstance -ClassName Win32_UserAccount -Filter "LocalAccount=True AND SID LIKE \'%-500\'" -ErrorAction Stop | Select-Object -First 1',
      '  if ($builtin -and -not $builtin.Disabled) {',
      '    Disable-LocalUser -SID $builtin.SID -ErrorAction Stop | Out-Null',
      '  }',
      '} catch { $errors.Add("local_admin: $($_.Exception.Message)") }'
    );
  }

  if (config.password_policy.enabled) {
    const minLength = config.password_policy.min_length;
    const maxAge =
      config.password_policy.max_age_days <= 0
        ? 'unlimited'
        : String(config.password_policy.max_age_days);
    const lockout = config.password_policy.lockout_threshold;
    lines.push(
      'try {',
      `  & net.exe accounts /minpwlen:${minLength} /maxpwage:${maxAge} /lockoutthreshold:${lockout}${lockout > 0 ? ' /lockoutduration:15 /lockoutwindow:15' : ''} | Out-Null`,
      '  if ($LASTEXITCODE -ne 0) { throw "net accounts exited with $LASTEXITCODE" }',
      '} catch { $errors.Add("password_policy: $($_.Exception.Message)") }'
    );
  }

  if (config.windows_update.enabled) {
    const noAuto = config.windows_update.auto_update ? 0 : 1;
    const deferQuality = config.windows_update.defer_quality_days;
    const deferFeature = config.windows_update.defer_feature_days;
    lines.push(
      'try {',
      '  $auPath = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU"',
      '  $wuPath = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"',
      '  Ensure-RegKey $auPath',
      '  Ensure-RegKey $wuPath',
      `  New-ItemProperty -Path $auPath -Name NoAutoUpdate -Value ${noAuto} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      ...(config.windows_update.auto_update
        ? [
            '  New-ItemProperty -Path $auPath -Name AUOptions -Value 4 -PropertyType DWord -Force -ErrorAction Stop | Out-Null',
            '  New-ItemProperty -Path $auPath -Name ScheduledInstallDay -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null',
            '  New-ItemProperty -Path $auPath -Name ScheduledInstallTime -Value 3 -PropertyType DWord -Force -ErrorAction Stop | Out-Null',
            '  Set-Service -Name wuauserv -StartupType Automatic -ErrorAction Stop | Out-Null',
            '  Start-Service -Name wuauserv -ErrorAction Stop | Out-Null'
          ]
        : []),
      `  New-ItemProperty -Path $wuPath -Name DeferQualityUpdates -Value ${deferQuality > 0 ? 1 : 0} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      `  New-ItemProperty -Path $wuPath -Name DeferQualityUpdatesPeriodInDays -Value ${deferQuality} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      `  New-ItemProperty -Path $wuPath -Name DeferFeatureUpdates -Value ${deferFeature > 0 ? 1 : 0} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      `  New-ItemProperty -Path $wuPath -Name DeferFeatureUpdatesPeriodInDays -Value ${deferFeature} -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      '} catch { $errors.Add("windows_update: $($_.Exception.Message)") }'
    );
  }

  if (config.local_admin.enabled && config.local_admin.remove_other_admins) {
    for (const member of adminPlan(config, state).remove) {
      lines.push(
        'try {',
        `  Remove-LocalGroupMember -SID "${ADMINISTRATORS_SID}" -Member "${member.sid}" -ErrorAction Stop`,
        `} catch { $errors.Add("admin_accounts: ${member.sid}: $($_.Exception.Message)") }`
      );
    }
  }

  if (config.web_filter?.enabled) {
    const targets = webFilterTargets(config.web_filter.blocked_domains);
    lines.push(
      'try {',
      `  $domains = ${psJson({ items: targets.chrome })}`,
      `  $patterns = @($domains.items | Where-Object { $_ } | ForEach-Object { "*://*.$_/*" })`,
      `  Set-RegList "${WEB_FILTER_KEYS.chrome}" $domains.items`,
      `  Set-RegList "${WEB_FILTER_KEYS.edge}" $domains.items`,
      `  Set-RegList "${WEB_FILTER_KEYS.brave}" $domains.items`,
      `  Set-RegList "${WEB_FILTER_KEYS.firefox}" $patterns`,
      '} catch { $errors.Add("web_filter: $($_.Exception.Message)") }'
    );
  }

  if (config.software_install?.enabled) {
    lines.push(
      'try {',
      `  Ensure-RegKey "${INSTALLER_POLICY}"`,
      `  New-ItemProperty -Path "${INSTALLER_POLICY}" -Name DisableMSI -Value 2 -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      `  New-ItemProperty -Path "${INSTALLER_POLICY}" -Name DisableUserInstalls -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null`,
      '} catch { $errors.Add("software_install: $($_.Exception.Message)") }'
    );
  }

  if (config.firewall_notifications?.enabled) {
    lines.push(
      'try {',
      ...Object.values(FIREWALL_POLICY_KEYS).flatMap((keyPath) => [
        `  Ensure-RegKey "${keyPath}"`,
        `  New-ItemProperty -Path "${keyPath}" -Name DisableNotifications -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null`
      ]),
      '} catch { $errors.Add("firewall_notifications: $($_.Exception.Message)") }'
    );
  }

  lines.push(
    '[pscustomobject]@{',
    '  applied = ($errors.Count -eq 0)',
    '  errors = @($errors)',
    '  applied_at = (Get-Date).ToUniversalTime().ToString("o")',
    '} | ConvertTo-Json -Depth 4 -Compress'
  );

  return lines.join('\n');
}

async function applyPolicy(config, state) {
  const script = buildApplyScript(config, state);
  if (!script) {
    return { applied: false, errors: ['Policy enforcement is only supported on Windows.'] };
  }

  return runPowerShell(script);
}

const POLICIES_SYSTEM = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const REMOVABLE_STORAGE = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\RemovableStorageDevices';
const WU_ROOT = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';
const WU_AU = `${WU_ROOT}\\AU`;
const FIREWALL_PROFILES = { domain: 'Domain', private: 'Private', public: 'Public' };
const START_TYPES = new Set(['Automatic', 'Manual', 'Disabled']);

/**
 * Settings this policy changes on the device, as undoable units. BitLocker is
 * deliberately absent: decrypting a drive because a policy changed is never safe.
 */
function managedKeys(config) {
  const keys = [];
  if (config.firewall.enabled) {
    keys.push(...config.firewall.profiles.map((profile) => `firewall.${profile}`));
  }
  if (config.screen_lock.enabled) keys.push('screen_lock');
  if (config.usb_storage.enabled) keys.push('usb_storage');
  if (config.local_admin.enabled && config.local_admin.disable_builtin_administrator) {
    keys.push('local_admin');
  }
  if (config.local_admin.enabled && config.local_admin.remove_other_admins) {
    keys.push('admin_accounts');
  }
  if (config.password_policy.enabled) keys.push('password_policy');
  if (config.windows_update.enabled) keys.push('windows_update');
  if (config.web_filter?.enabled) keys.push('web_filter');
  if (config.software_install?.enabled) keys.push('software_install');
  if (config.firewall_notifications?.enabled) keys.push('firewall_notifications');
  return keys;
}

/** Copy of `config` with one managed setting switched off (the original is not mutated). */
function withoutSetting(config, key) {
  if (key.startsWith('firewall.')) {
    const profiles = config.firewall.profiles.filter((p) => `firewall.${p}` !== key);
    return { ...config, firewall: { ...config.firewall, profiles, enabled: profiles.length > 0 } };
  }
  if (key === 'local_admin') {
    return {
      ...config,
      // Also no removal: adminPlan's lock-out guard depends on disable_builtin_administrator.
      local_admin: { ...config.local_admin, disable_builtin_administrator: false, remove_other_admins: false }
    };
  }
  if (key === 'admin_accounts') {
    return { ...config, local_admin: { ...config.local_admin, remove_other_admins: false } };
  }
  return { ...config, [key]: { ...config[key], enabled: false } };
}

/** What a setting looked like before the service first managed it. Null = nothing to restore. */
function capturePrevious(key, state) {
  if (key.startsWith('firewall.')) {
    const name = key.slice('firewall.'.length);
    const profile = (Array.isArray(state.firewall) ? state.firewall : []).find(
      (item) => String(item.name || '').toLowerCase() === name
    );
    return profile ? { enabled: normalizeBool(profile.enabled) } : null;
  }
  switch (key) {
    case 'screen_lock':
      return { seconds: state.screen_lock_seconds ?? null };
    case 'usb_storage':
      return { deny_all: state.usb_storage_deny_all ?? null };
    case 'local_admin':
      return state.builtin_administrator
        ? {
            sid: state.builtin_administrator.sid,
            disabled: normalizeBool(state.builtin_administrator.disabled)
          }
        : null;
    case 'password_policy':
      return state.password_policy && !state.password_policy.error
        ? { ...state.password_policy }
        : null;
    case 'windows_update':
      return state.windows_update ? { ...state.windows_update } : null;
    case 'admin_accounts':
      return Array.isArray(state.administrators) && !state.administrators_error
        ? {
            sids: state.administrators
              .filter((member) => String(member.object_class).toLowerCase() === 'user')
              .map((member) => member.sid)
          }
        : null;
    case 'web_filter':
      return state.web_filter ? { ...state.web_filter } : null;
    case 'software_install':
      return state.software_install ? { ...state.software_install } : null;
    case 'firewall_notifications':
      return state.firewall_notifications ? { ...state.firewall_notifications } : null;
    default:
      return null;
  }
}

const RESTORE_LABELS = {
  'firewall.domain': 'the domain firewall profile',
  'firewall.private': 'the private firewall profile',
  'firewall.public': 'the public firewall profile',
  screen_lock: 'the screen lock timeout',
  usb_storage: 'USB storage blocking',
  local_admin: 'the built-in Administrator',
  admin_accounts: 'local administrator accounts',
  password_policy: 'the password rules',
  windows_update: 'Windows Update settings',
  web_filter: 'website blocking',
  software_install: '.msi install blocking',
  firewall_notifications: 'firewall notification hiding'
};

/** Turns a raw `key: exception` restore error into something an admin can act on. */
function restoreMessage(error) {
  const text = String(error);
  const split = text.indexOf(':');
  const key = split > 0 ? text.slice(0, split) : text;
  const detail = split > 0 ? text.slice(split + 1).trim() : '';
  if (key === 'local_admin' && /InvalidPassword/i.test(detail)) {
    return 'Could not re-enable the built-in Administrator: its password does not meet the active password rule. Set a compliant password for it, or relax the rule.';
  }
  const label = RESTORE_LABELS[key] || key;
  return detail ? `Could not restore ${label}: ${detail}` : `Could not restore ${label}`;
}

function psInt(value) {
  if (value === null || value === undefined) return '$null';
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('Invalid value in policy ledger');
  return String(parsed);
}

function revertLines(key, previous) {
  if (!previous) return [];

  if (key.startsWith('firewall.')) {
    const profile = FIREWALL_PROFILES[key.slice('firewall.'.length)];
    if (!profile) return [];
    return [
      `  Set-NetFirewallProfile -Profile ${profile} -Enabled ${previous.enabled ? 'True' : 'False'} -ErrorAction Stop | Out-Null`
    ];
  }

  const reg = (keyPath, name, value) => `  Restore-Reg "${keyPath}" "${name}" ${psInt(value)}`;

  switch (key) {
    case 'screen_lock':
      return [reg(POLICIES_SYSTEM, 'InactivityTimeoutSecs', previous.seconds)];
    case 'usb_storage':
      return [reg(REMOVABLE_STORAGE, 'Deny_All', previous.deny_all)];
    case 'local_admin':
      if (previous.disabled || !/^S-1-5-21-[\d-]+-500$/.test(String(previous.sid))) return [];
      return [`  Enable-LocalUser -SID '${previous.sid}' -ErrorAction Stop | Out-Null`];
    case 'password_policy': {
      const threshold = normalizeInt(previous.lockout_threshold, 0);
      const maxAge = normalizeInt(previous.max_age_days, 0);
      const args = [
        `/minpwlen:${psInt(normalizeInt(previous.min_length, 0))}`,
        `/maxpwage:${maxAge > 0 ? psInt(maxAge) : 'unlimited'}`,
        `/lockoutthreshold:${psInt(threshold)}`
      ];
      if (threshold > 0 && previous.lockout_duration > 0 && previous.lockout_window > 0) {
        args.push(
          `/lockoutduration:${psInt(previous.lockout_duration)}`,
          `/lockoutwindow:${psInt(previous.lockout_window)}`
        );
      }
      return [
        `  & net.exe accounts ${args.join(' ')} | Out-Null`,
        '  if ($LASTEXITCODE -ne 0) { throw "net accounts exited with $LASTEXITCODE" }'
      ];
    }
    case 'windows_update': {
      const lines = [
        reg(WU_AU, 'NoAutoUpdate', previous.no_auto_update),
        reg(WU_AU, 'AUOptions', previous.au_options),
        reg(WU_AU, 'ScheduledInstallDay', previous.scheduled_install_day),
        reg(WU_AU, 'ScheduledInstallTime', previous.scheduled_install_time),
        reg(WU_ROOT, 'DeferQualityUpdates', previous.defer_quality),
        reg(WU_ROOT, 'DeferQualityUpdatesPeriodInDays', previous.defer_quality_days),
        reg(WU_ROOT, 'DeferFeatureUpdates', previous.defer_feature),
        reg(WU_ROOT, 'DeferFeatureUpdatesPeriodInDays', previous.defer_feature_days)
      ];
      if (START_TYPES.has(previous.start_type)) {
        lines.push(
          `  Set-Service -Name wuauserv -StartupType ${previous.start_type} -ErrorAction Stop | Out-Null`
        );
      }
      return lines;
    }
    case 'admin_accounts': {
      const sids = (previous.sids || []).filter((sid) => /^S-1-[\d-]+$/.test(String(sid)));
      if (!sids.length) return [];
      return [
        `  foreach ($sid in @(${sids.map((sid) => `'${sid}'`).join(', ')})) {`,
        `    try { Add-LocalGroupMember -SID "${ADMINISTRATORS_SID}" -Member $sid -ErrorAction Stop }`,
        '    catch [Microsoft.PowerShell.Commands.MemberExistsException] {}',
        '    catch [Microsoft.PowerShell.Commands.PrincipalNotFoundException] {}',
        '  }'
      ];
    }
    case 'web_filter':
      return [
        `  $previous = ${psJson(previous)}`,
        ...Object.entries(WEB_FILTER_KEYS).map(
          ([browser, keyPath]) => `  Set-RegList "${keyPath}" $previous.${browser}`
        )
      ];
    case 'software_install':
      return [
        reg(INSTALLER_POLICY, 'DisableMSI', previous.disable_msi),
        reg(INSTALLER_POLICY, 'DisableUserInstalls', previous.disable_user_installs)
      ];
    case 'firewall_notifications':
      return Object.entries(FIREWALL_POLICY_KEYS).map(([name, keyPath]) =>
        reg(keyPath, 'DisableNotifications', previous[name])
      );
    default:
      return [];
  }
}

function buildRevertScript(entries) {
  const lines = [
    "$ErrorActionPreference='Continue'",
    '$errors = New-Object System.Collections.Generic.List[string]',
    '$reverted = New-Object System.Collections.Generic.List[string]',
    ...ENSURE_REG_KEY,
    'function Restore-Reg([string]$path, [string]$name, $value) {',
    '  if ($null -eq $value) {',
    '    if (Test-Path $path) { Remove-ItemProperty -Path $path -Name $name -Force -ErrorAction SilentlyContinue }',
    '  } else {',
    '    Ensure-RegKey $path',
    '    New-ItemProperty -Path $path -Name $name -Value $value -PropertyType DWord -Force -ErrorAction Stop | Out-Null',
    '  }',
    '}'
  ];

  // Windows won't enable an account whose password breaks the active rule, so the rule goes first.
  const ordered = Object.entries(entries).sort(
    ([a], [b]) => (b === 'password_policy') - (a === 'password_policy')
  );
  for (const [key, previous] of ordered) {
    lines.push(
      'try {',
      ...revertLines(key, previous),
      `  $reverted.Add("${key}")`,
      `} catch { $errors.Add("${key}: $($_.Exception.Message)") }`
    );
  }

  lines.push(
    '[pscustomobject]@{ reverted = @($reverted); errors = @($errors) } | ConvertTo-Json -Depth 4 -Compress'
  );
  return lines.join('\n');
}

async function revertSettings(entries) {
  return runPowerShell(buildRevertScript(entries));
}

/** Adds a recovery protector if the drive has none. The output holds secrets: never log it. */
async function readRecoveryKeys() {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$isRecovery = { [string]$_.KeyProtectorType -eq "RecoveryPassword" }',
    '$volume = Get-BitLockerVolume -MountPoint $env:SystemDrive',
    'if (-not @($volume.KeyProtector | Where-Object $isRecovery).Count) {',
    '  Add-BitLockerKeyProtector -MountPoint $env:SystemDrive -RecoveryPasswordProtector -WarningAction SilentlyContinue | Out-Null',
    '  $volume = Get-BitLockerVolume -MountPoint $env:SystemDrive',
    '}',
    '$keys = @($volume.KeyProtector | Where-Object $isRecovery | ForEach-Object {',
    '  [pscustomobject]@{ protector_id = [string]$_.KeyProtectorId; recovery_password = [string]$_.RecoveryPassword }',
    '})',
    'ConvertTo-Json -InputObject $keys -Compress'
  ].join('\n');

  const keys = await runPowerShell(script);
  return Array.isArray(keys) ? keys : [];
}

class PolicyManager {
  constructor(options) {
    this._config = options.config;
    this._getCredentials =
      options.getCredentials || (() => options.credentials);
    this._logger = options.logger;
    this._lastHash = null;
    this._lastStatus = null;
    this._lastCheckedAt = null;
    this._lastAttemptAt = 0;
    this._inFlight = false;
    this._ledger = null;
    this._escrowed = new Set();

    const ledgerFile = () => path.join(this._config.paths.stateDir, 'policy-ledger.json');
    this._deps = {
      collect: collectPolicyState,
      apply: applyPolicy,
      revert: revertSettings,
      readRecoveryKeys,
      request: requestJson,
      loadLedger: () => JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')),
      saveLedger: (ledger) => writeSecureJson(ledgerFile(), ledger, this._logger),
      now: Date.now,
      ...options.deps
    };
  }

  getSummary() {
    if (!this._lastStatus) return null;
    return {
      policy_id: this._lastStatus.policy_id,
      policy_version: this._lastStatus.policy_version,
      status: this._lastStatus.status,
      checked_at: this._lastCheckedAt
    };
  }

  async syncFromServer() {
    const credentials = this._getCredentials();
    if (!credentials?.deviceToken || this._inFlight) return;

    let payload;
    try {
      payload = await this._deps.request(`${this._config.apiBase}/device/policy`, {
        method: 'GET',
        token: credentials.deviceToken,
        timeoutMs: this._config.httpTimeoutMs
      });
    } catch (err) {
      if (err.status === 401) throw err;
      this._logger?.warn(`Policy fetch failed: ${err.message}`);
      return;
    }

    // Only an explicit "no policy" answer may undo settings, never an odd response.
    if (!payload || !('policy' in payload)) return;
    await this.sync(payload.policy);
  }

  _getLedger() {
    if (this._ledger) return this._ledger;
    try {
      this._ledger = this._deps.loadLedger() || {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this._logger?.warn(`Policy ledger could not be read: ${err.message}`);
      }
      this._ledger = {};
    }
    return this._ledger;
  }

  /** Restores every setting in the ledger that isn't in `wanted`. Returns what changed and what failed. */
  async _revertStale(wanted) {
    const ledger = this._getLedger();
    const stale = Object.fromEntries(
      Object.entries(ledger).filter(([key]) => !wanted.includes(key))
    );
    if (!Object.keys(stale).length) return { restored: 0, errors: [] };

    const result = await this._deps.revert(stale);
    const reverted = Array.isArray(result?.reverted) ? result.reverted : [];
    for (const key of reverted) delete ledger[key];
    if (reverted.length) {
      this._deps.saveLedger(ledger);
      this._logger?.info(`Policy settings restored: ${reverted.join(', ')}`);
    }
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    for (const error of errors) {
      this._logger?.warn(`Policy restore failed: ${error}`);
    }
    return { restored: reverted.length, errors };
  }

  async _releaseAll() {
    this._lastHash = null;
    this._lastStatus = null;
    this._lastCheckedAt = null;

    const now = this._deps.now();
    if (!Object.keys(this._getLedger()).length) return;
    if (now - this._lastAttemptAt < RETRY_AFTER_MS) return;

    this._inFlight = true;
    this._lastAttemptAt = now;
    try {
      await this._revertStale([]);
    } catch (err) {
      this._logger?.warn(`Policy restore failed: ${err.message}`);
    } finally {
      this._inFlight = false;
    }
  }

  /**
   * The recovery key must reach the server before encryption starts. Returns
   * { error, changed }. Errors are written by hand because a PowerShell or JSON
   * failure message could quote the key.
   */
  async _escrowRecoveryKeys(credentials, state) {
    if (state.bitlocker?.available !== true) return { error: null, changed: false };

    const known = state.bitlocker.recovery_protector_ids || [];
    if (known.length && known.every((id) => this._escrowed.has(id))) {
      return { error: null, changed: false };
    }

    const refused = 'BitLocker will not be enabled until the key is stored';
    let keys;
    try {
      keys = await this._deps.readRecoveryKeys();
    } catch {
      return { error: `bitlocker: could not create or read the recovery key; ${refused}`, changed: false };
    }
    if (!keys.length) {
      return { error: `bitlocker: drive has no recovery key; ${refused}`, changed: false };
    }

    try {
      for (const key of keys) {
        await this._deps.request(`${this._config.apiBase}/device/recovery-key`, {
          method: 'POST',
          token: credentials.deviceToken,
          body: key,
          timeoutMs: this._config.httpTimeoutMs
        });
        this._escrowed.add(key.protector_id);
      }
    } catch (err) {
      if (err.status === 401) throw err;
      return {
        error: `bitlocker: server did not store the recovery key (${err.status || 'network error'}); ${refused}`,
        changed: true
      };
    }
    return { error: null, changed: true };
  }

  async sync(policy) {
    const credentials = this._getCredentials();
    if (this._inFlight || !credentials?.deviceToken) return;
    if (!policy) {
      await this._releaseAll();
      return;
    }

    const now = this._deps.now();
    const samePolicy = this._lastHash === policy.hash;
    const settled =
      this._lastStatus?.status === 'compliant' ||
      this._lastStatus?.status === 'applied';
    const wait = settled ? RECHECK_AFTER_MS : RETRY_AFTER_MS;
    if (samePolicy && now - this._lastAttemptAt < wait) return;

    this._inFlight = true;
    this._lastAttemptAt = now;

    try {
      this._logger?.info(
        `Applying policy ${policy.name} v${policy.version} (${policy.config.mode})`
      );

      const enforcing = policy.config.mode === 'enforce';
      let state = await this._deps.collect();
      let applied = false;
      const applyErrors = [];
      let applyConfig = policy.config;

      if (enforcing) {
        // Record the original values before anything changes, so they can be undone.
        const wanted = managedKeys(policy.config);
        const ledger = this._getLedger();
        const newKeys = wanted.filter((key) => !(key in ledger));
        for (const key of newKeys) {
          const previous = capturePrevious(key, state);
          if (previous !== null) {
            ledger[key] = previous;
          } else {
            // Never enforce what cannot be undone: skip it and retry on the next check.
            applyConfig = withoutSetting(applyConfig, key);
            applyErrors.push(
              `Could not read the original ${RESTORE_LABELS[key] || key}, so it was not changed; it will be retried on the next check.`
            );
          }
        }
        if (newKeys.length) this._deps.saveLedger(ledger);

        const restore = await this._revertStale(wanted);
        let changed = restore.restored > 0;
        applyErrors.push(...restore.errors.map(restoreMessage));

        if (policy.config.bitlocker.enabled) {
          const escrow = await this._escrowRecoveryKeys(credentials, state);
          changed = changed || escrow.changed;
          if (escrow.error) {
            applyErrors.push(escrow.error);
            applyConfig = {
              ...applyConfig,
              bitlocker: { ...policy.config.bitlocker, enabled: false }
            };
          }
        }

        if (changed) state = await this._deps.collect();
      }

      let evaluation = evaluatePolicy(policy.config, state);

      if (!evaluation.compliant && enforcing) {
        const applyResult = await this._deps.apply(applyConfig, state);
        applied = Boolean(applyResult?.applied);
        if (Array.isArray(applyResult?.errors)) applyErrors.push(...applyResult.errors);
        state = await this._deps.collect();
        evaluation = evaluatePolicy(policy.config, state);
      }

      const status = applyErrors.length > 0
        ? 'failed'
        : evaluation.compliant
          ? applied
            ? 'applied'
            : 'compliant'
          : 'non_compliant';

      const errors = applyErrors.length
        ? applyErrors
        : evaluation.compliant
          ? []
          : Object.entries(evaluation.checks)
              .filter(([, check]) => !check.ok)
              .map(([name, check]) => `${name}: ${check.detail}`);

      await this._deps.request(`${this._config.apiBase}/device/policy/status`, {
        method: 'POST',
        token: credentials.deviceToken,
        body: {
          policy_id: policy.id,
          policy_version: policy.version,
          status,
          applied,
          checks: evaluation.checks,
          errors
        },
        timeoutMs: this._config.httpTimeoutMs
      });

      this._lastHash = policy.hash;
      this._lastStatus = {
        policy_id: policy.id,
        policy_version: policy.version,
        status
      };
      this._lastCheckedAt = new Date().toISOString();

      this._logger?.info(
        `Policy ${policy.name} v${policy.version} reported as ${status}`
      );
    } catch (err) {
      if (err.status === 401) throw err;
      this._logger?.warn(`Policy sync failed: ${err.message}`);
    } finally {
      this._inFlight = false;
    }
  }
}

module.exports = {
  PolicyManager,
  RECHECK_AFTER_MS,
  adminPlan,
  applyPolicy,
  buildApplyScript,
  buildRevertScript,
  capturePrevious,
  collectPolicyState,
  evaluatePolicy,
  managedKeys,
  restoreMessage,
  revertSettings
};
