'use strict';
// Live check of the service's PowerShell pieces inside Windows Sandbox (run as SYSTEM).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const SVC = 'C:\\svc';
const OUT = 'C:\\out\\result.txt';
const policy = require(path.join(SVC, 'src', 'policy.js'));
const software = require(path.join(SVC, 'src', 'software.js'));

const log = [];
let failures = 0;
const say = (s) => { log.push(s); fs.writeFileSync(OUT, log.join('\n') + '\n'); };
const check = (name, ok, detail = '') => { if (!ok) failures++; say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();

const off = { enabled: false };
const config = {
  mode: 'enforce',
  bitlocker: { enabled: false, encryption_method: 'XtsAes256' },
  firewall: { enabled: false, profiles: ['domain'] },
  screen_lock: { enabled: false, timeout_minutes: 10 },
  usb_storage: off,
  local_admin: { enabled: false, disable_builtin_administrator: true },
  password_policy: { enabled: false, min_length: 12, max_age_days: 90, lockout_threshold: 5 },
  windows_update: { enabled: false, auto_update: true, defer_quality_days: 0, defer_feature_days: 0 },
  firewall_notifications: { enabled: true }
};

async function firewallNotifications() {
  const domainKey = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsFirewall\\DomainProfile';
  // Registry trap guard: a pre-existing sibling value must survive apply and revert.
  ps(`New-Item -Path '${domainKey}' -Force | Out-Null; New-ItemProperty -Path '${domainKey}' -Name EnableFirewall -Value 1 -PropertyType DWord -Force | Out-Null; New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsFirewall\\PublicProfile' -Force | Out-Null; New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsFirewall\\PublicProfile' -Name DisableNotifications -Value 0 -PropertyType DWord -Force | Out-Null`);

  const before = await policy.collectPolicyState();
  say('state before: ' + JSON.stringify(before.firewall_notifications));
  check('collect reads pre-set public=0, others null',
    before.firewall_notifications?.public === 0 && before.firewall_notifications?.domain == null && before.firewall_notifications?.private == null,
    JSON.stringify(before.firewall_notifications));
  check('non-compliant before apply', policy.evaluatePolicy(config, before).checks.firewall_notifications?.ok === false);

  const keys = policy.managedKeys(config);
  const previous = Object.fromEntries(keys.map((k) => [k, policy.capturePrevious(k, before)]));
  const applied = await policy.applyPolicy(config, before);
  check('apply succeeded', applied.applied === true, JSON.stringify(applied));

  const after = await policy.collectPolicyState();
  check('all three profiles = 1 after apply', JSON.stringify(after.firewall_notifications) === JSON.stringify({ domain: 1, private: 1, public: 1 }), JSON.stringify(after.firewall_notifications));
  check('compliant after apply', policy.evaluatePolicy(config, after).checks.firewall_notifications?.ok === true);
  check('sibling EnableFirewall survived apply', ps(`(Get-ItemProperty '${domainKey}').EnableFirewall`) === '1');

  const reverted = await policy.revertSettings(previous);
  check('revert reported success', (reverted.errors || []).length === 0 && (reverted.reverted || []).includes('firewall_notifications'), JSON.stringify(reverted));
  const restored = await policy.collectPolicyState();
  check('originals restored (null removed, public back to 0)',
    restored.firewall_notifications?.public === 0 && restored.firewall_notifications?.domain == null && restored.firewall_notifications?.private == null,
    JSON.stringify(restored.firewall_notifications));
  check('sibling EnableFirewall survived revert', ps(`(Get-ItemProperty '${domainKey}').EnableFirewall`) === '1');
}

async function signerTrust() {
  const signed = path.join(SVC, 'node.exe');
  const res = await software.trustSigner(signed);
  say('trust signed: ' + JSON.stringify(res));
  check('signed installer -> trusted', res.trusted === true && /^[0-9A-F]{40}$/i.test(String(res.thumbprint || '')));
  const inStore = ps(`[bool](Get-ChildItem Cert:\\LocalMachine\\TrustedPublisher | Where-Object Thumbprint -eq '${res.thumbprint}')`);
  check('cert present in LocalMachine\\TrustedPublisher', inStore === 'True', inStore);
  const again = await software.trustSigner(signed);
  check('second trust of same signer is fine', again.trusted === true, JSON.stringify(again));

  const unsignedFile = 'C:\\out\\unsigned setup (1).exe';
  fs.writeFileSync(unsignedFile, 'MZ not really an installer');
  const un = await software.trustSigner(unsignedFile);
  say('trust unsigned: ' + JSON.stringify(un));
  check('unsigned file -> not trusted, no throw', un.trusted === false);

  const quoted = "C:\\out\\it's $(evil).exe";
  fs.writeFileSync(quoted, 'MZ');
  let ok = true, msg = '';
  try { const r = await software.trustSigner(quoted); msg = JSON.stringify(r); ok = r.trusted === false; } catch (e) { ok = false; msg = e.message; }
  check('path with quote and $() handled safely', ok, msg);
}

function serviceInstall() {
  const run = (a) => { try { return execFileSync('cmd.exe', ['/c', path.join(SVC, `${a}-service.cmd`)], { encoding: 'utf8' }); } catch (e) { return `EXIT ${e.status}: ${e.stdout}${e.stderr}`; } };
  say('install output: ' + run('install').trim().slice(-600));
  const q = ps(`(Get-Service aceHRMDeviceService -ErrorAction SilentlyContinue | Select-Object Status,StartType | ConvertTo-Json -Compress)`);
  check('service registered', q.includes('"Status"'), q);
  const acct = ps(`(Get-CimInstance Win32_Service -Filter "Name='aceHRMDeviceService'").StartName`);
  check('service runs as LocalSystem', /LocalSystem/i.test(acct), acct);
  say('uninstall output: ' + run('uninstall').trim().slice(-600));
  const gone = ps(`[bool](Get-Service aceHRMDeviceService -ErrorAction SilentlyContinue)`);
  check('service removed after uninstall', gone === 'False', gone);
}

(async () => {
  say(`whoami: ${ps('whoami')}  node ${process.version}`);
  const only = process.argv[2];
  for (const [name, fn] of [['firewall_notifications', firewallNotifications], ['signer trust', signerTrust], ['service install', serviceInstall]].filter(([n]) => !only || n === only)) {
    say(`--- ${name}`);
    try { await fn(); } catch (e) { check(`${name} threw`, false, e.stack); }
  }
  say(failures ? `DONE ${failures} FAILED` : 'DONE ALL PASSED');
})();
