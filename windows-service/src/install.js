'use strict';

// Registers the service with WinSW directly. node-windows' own install path goes through a
// wscript "runas" helper that hangs when there is no desktop to answer it (logon scripts,
// SYSTEM, deployment tools), so only its bundled winsw.exe is used.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { SERVICE_DISPLAY_NAME, SERVICE_NAME, paths } = require('./config');
const { restoreMessage, revertSettings } = require('./policy');

const ROOT = path.join(__dirname, '..');
const DAEMON_DIR = path.join(ROOT, 'daemon');
const SERVICE_EXE = path.join(DAEMON_DIR, `${SERVICE_NAME}.exe`);
const STOP_WAIT_MS = 45_000;
const PASSED_ENV = ['ACEHRM_API_BASE', 'ACEHRM_DEVICE_DATA_DIR'];

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** WinSW runs node directly: restart on failure comes from Windows, not a second node process. */
function serviceXml({ execPath, script, workingDirectory, logPath, env = [] }) {
  const tag = (name, value) => `  <${name}>${escapeXml(value)}</${name}>`;
  return [
    '<service>',
    tag('id', SERVICE_NAME),
    tag('name', SERVICE_DISPLAY_NAME),
    tag('description', `${SERVICE_DISPLAY_NAME}: enrollment, policy, commands and local agent bridge`),
    tag('executable', execPath),
    tag('argument', '--max-old-space-size=256'),
    tag('argument', script),
    tag('workingdirectory', workingDirectory),
    tag('logpath', logPath),
    tag('logmode', 'rotate'),
    tag('stoptimeout', '30sec'),
    '  <onfailure action="restart" delay="10 sec"/>',
    tag('resetfailure', '1 hour'),
    ...env.map(
      ({ name, value }) => `  <env name="${escapeXml(name)}" value="${escapeXml(value)}"/>`
    ),
    '</service>',
    ''
  ].join('\r\n');
}

/**
 * Puts back everything the service changed, so uninstalling doesn't strand a machine on a
 * policy nothing manages any more. BitLocker is never in the ledger. Failed settings stay
 * in the file so a later attempt still knows the original values.
 */
async function restoreSettings(ledgerFile, revert = revertSettings) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { restored: [], errors: [] };
    return { restored: [], errors: [`Could not read ${ledgerFile}: ${err.message}`] };
  }

  const result = Object.keys(ledger).length ? await revert(ledger) : { reverted: [], errors: [] };
  const restored = Array.isArray(result?.reverted) ? result.reverted : [];
  for (const key of restored) delete ledger[key];
  if (Object.keys(ledger).length) fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  else fs.rmSync(ledgerFile, { force: true });
  return { restored, errors: Array.isArray(result?.errors) ? result.errors : [] };
}

const queryService = () => spawnSync('sc.exe', ['query', SERVICE_NAME], { encoding: 'utf8' });
const isInstalled = () => queryService().status === 0;
const winsw = (command) => execFileSync(SERVICE_EXE, [command], { stdio: 'inherit', timeout: 60_000 });

function waitUntilStopped() {
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (/STOPPED/.test(queryService().stdout || '')) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return false;
}

function install() {
  if (isInstalled()) {
    console.log(`${SERVICE_NAME} is already installed. Starting it...`);
    execFileSync('sc.exe', ['start', SERVICE_NAME], { stdio: 'ignore' });
    return;
  }

  const bundled = path.join(path.dirname(require.resolve('node-windows/package.json')), 'bin', 'winsw');
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.copyFileSync(path.join(bundled, 'winsw.exe'), SERVICE_EXE);
  fs.copyFileSync(path.join(bundled, 'winsw.exe.config'), `${SERVICE_EXE}.config`);
  fs.writeFileSync(
    path.join(DAEMON_DIR, `${SERVICE_NAME}.xml`),
    serviceXml({
      execPath: process.execPath,
      script: path.join(__dirname, 'service.js'),
      workingDirectory: ROOT,
      logPath: DAEMON_DIR,
      env: PASSED_ENV.filter((name) => process.env[name]).map((name) => ({
        name,
        value: process.env[name]
      }))
    })
  );

  winsw('install');
  winsw('start');
  console.log(`Installed and started ${SERVICE_NAME}.`);
}

async function uninstall() {
  if (isInstalled()) {
    if (!/STOPPED/.test(queryService().stdout || '')) {
      winsw('stop');
      // A running service would just re-apply the policy after the restore below.
      if (!waitUntilStopped()) throw new Error(`${SERVICE_NAME} did not stop, so nothing was changed`);
    }
  } else {
    console.log(`${SERVICE_NAME} is not installed.`);
  }

  const { restored, errors } = await restoreSettings(path.join(paths.stateDir, 'policy-ledger.json'));
  if (restored.length) console.log(`Restored settings: ${restored.join(', ')}`);
  for (const error of errors) {
    console.error(restoreMessage(error));
    process.exitCode = 1;
  }

  if (isInstalled()) {
    winsw('uninstall');
    console.log(`${SERVICE_NAME} was removed.`);
  }
  fs.rmSync(DAEMON_DIR, { recursive: true, force: true });
}

async function main() {
  const action = process.argv[2];
  if (action === 'install') install();
  else if (action === 'uninstall') await uninstall();
  else {
    console.error('Usage: node src/install.js <install|uninstall>');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${process.argv[2]} failed: ${err.message}`);
    console.error(
      err.code === 'MODULE_NOT_FOUND'
        ? 'The service files are incomplete: node_modules is missing from this folder.'
        : 'This needs an elevated (administrator) prompt.'
    );
    process.exitCode = 1;
  });
}

module.exports = { restoreSettings, serviceXml };
