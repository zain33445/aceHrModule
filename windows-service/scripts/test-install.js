'use strict';

// Offline self-check for the install helper. Registers nothing and runs no PowerShell.
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { restoreSettings, serviceXml } = require('../src/install');
const { LOCK_SCRIPT, lockOutcome } = require('../src/commands');
const { NamedPipeBridge } = require('../src/named-pipe');

(async () => {
  // The service runs as SYSTEM, which has no desktop to lock: it must act in the user's session.
  assert.ok(LOCK_SCRIPT.includes("-GroupId 'S-1-5-4'"), 'lock runs as the interactive user');
  assert.ok(LOCK_SCRIPT.includes('-AllowStartIfOnBatteries'), 'lock also works on battery');
  assert.ok(LOCK_SCRIPT.includes('LogonUI'), 'lock checks the PC really locked');
  assert.equal(lockOutcome(null).ok, true);
  assert.equal(lockOutcome({ code: 3 }).code, 'NO_USER_SIGNED_IN', 'no user is not reported as locked');
  assert.equal(lockOutcome({ code: 4 }).code, 'LOCK_FAILED', 'an unlocked PC is not reported as locked');
  assert.equal(lockOutcome({ code: 1, message: 'boom' }).message, 'boom');

  // A sign-in reaches the service over the real pipe.
  const bridge = new NamedPipeBridge({ pipePath: `\\\\.\\pipe\\acehrm-test-${process.pid}` });
  const received = new Promise((resolve) => bridge.once('agent:login', resolve));
  bridge.start();
  await new Promise((resolve) => bridge.once('listening', resolve));
  const client = net.connect(`\\\\.\\pipe\\acehrm-test-${process.pid}`);
  client.write(`${JSON.stringify({ type: 'agent:login', grant: 'signed-grant' })}\n`);
  assert.equal((await received).grant, 'signed-grant', 'the grant reaches the service');
  client.destroy();
  bridge.close();

  const xml = serviceXml({
    execPath: 'C:\\R&D\\node.exe',
    script: 'C:\\R&D\\src\\service.js',
    workingDirectory: 'C:\\R&D',
    logPath: 'C:\\R&D\\daemon',
    env: [{ name: 'ACEHRM_API_BASE', value: 'http://x/api?a=1&b=2' }]
  });
  assert.ok(xml.includes('<id>aceHRMDeviceService</id>'), 'service name matches the docs');
  assert.ok(xml.includes('<onfailure action="restart"'), 'Windows restarts it on failure');
  assert.ok(xml.includes('<argument>C:\\R&amp;D\\src\\service.js</argument>'), 'paths are escaped');
  assert.ok(xml.includes('value="http://x/api?a=1&amp;b=2"'), 'env values are escaped');
  assert.ok(!xml.includes('wrapper.js'), 'no extra wrapper process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acehrm-install-'));
  const file = path.join(dir, 'policy-ledger.json');

  assert.deepEqual(
    await restoreSettings(file, () => assert.fail('nothing to restore')),
    { restored: [], errors: [] },
    'no ledger means nothing to do'
  );

  fs.writeFileSync(file, JSON.stringify({ usb_storage: { deny_all: null }, screen_lock: { seconds: 60 } }));
  let result = await restoreSettings(file, async () => ({
    reverted: ['usb_storage'],
    errors: ['screen_lock: refused']
  }));
  assert.deepEqual(result, { restored: ['usb_storage'], errors: ['screen_lock: refused'] });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')),
    { screen_lock: { seconds: 60 } },
    'a failed setting keeps its original value'
  );

  result = await restoreSettings(file, async () => ({ reverted: ['screen_lock'], errors: [] }));
  assert.deepEqual(result.restored, ['screen_lock']);
  assert.ok(!fs.existsSync(file), 'an emptied ledger is removed');

  fs.writeFileSync(file, 'not json');
  result = await restoreSettings(file, () => assert.fail('a broken ledger must not be applied'));
  assert.equal(result.errors.length, 1, 'a broken ledger is reported');
  assert.ok(fs.existsSync(file), 'a broken ledger is kept for inspection');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('install self-check passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
