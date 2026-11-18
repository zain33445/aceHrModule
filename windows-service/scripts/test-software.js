'use strict';

// Offline self-check for software installs. Runs no installers and no PowerShell.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  describeExit,
  downloadVerified,
  installSoftware,
  installerCommand,
  parseArgs,
  runInstaller,
  trustSigner,
  TRUST_SCRIPT,
  validatePayload
} = require('../src/software');

const ID = '11111111-2222-3333-4444-555555555555';
const content = Buffer.from('pretend installer');
const sha256 = crypto.createHash('sha256').update(content).digest('hex');

(async () => {
  assert.deepEqual(parseArgs('/S /D="C:\\Program Files\\App"'), ['/S', '/D=', 'C:\\Program Files\\App']);
  assert.deepEqual(parseArgs('"/a b" /c'), ['/a b', '/c']);
  assert.deepEqual(parseArgs('& del C:\\*'), ['&', 'del', 'C:\\*'], 'no shell meaning, only plain args');

  assert.deepEqual(installerCommand('msi', 'f.msi', 'A=1'), {
    command: 'msiexec.exe',
    args: ['/i', 'f.msi', '/qn', '/norestart', 'A=1']
  });
  assert.deepEqual(installerCommand('exe', 'f.exe', '/S'), { command: 'f.exe', args: ['/S'] });

  assert.equal(describeExit(0).ok, true);
  assert.equal(describeExit(3010).restart_required, true);
  assert.equal(describeExit(1603).ok, false);

  assert.equal(validatePayload({ package_id: ID, sha256, kind: 'msi' }), null);
  assert.ok(validatePayload({ package_id: '../../evil', sha256, kind: 'msi' }), 'path in id');
  assert.ok(validatePayload({ package_id: ID, sha256, kind: 'bat' }), 'other file types');
  assert.ok(validatePayload({ package_id: ID, sha256: 'abc', kind: 'msi' }), 'bad hash');

  // The real runner, with Node standing in for an installer.
  const node = (script, ...extra) => ({
    command: process.execPath,
    args: ['-e', script, ...extra],
    cwd: os.tmpdir()
  });
  assert.deepEqual(await runInstaller(node('process.exit(0)')), { exitCode: 0 });
  assert.deepEqual(await runInstaller(node('process.exit(3010)')), { exitCode: 3010 });
  assert.deepEqual(await runInstaller(node('process.exit(1603)')), { exitCode: 1603 });
  assert.ok((await runInstaller({ command: 'no-such-installer.exe', args: [], cwd: os.tmpdir() })).startError);

  const marker = path.join(os.tmpdir(), `acehrm-shell-probe-${process.pid}`);
  const literal = await runInstaller(
    node('process.exit(process.argv[1] === "&" ? 7 : 1)', '&', 'echo', 'x', '>', marker)
  );
  assert.deepEqual(literal, { exitCode: 7 }, 'shell characters arrive as plain text');
  assert.equal(fs.existsSync(marker), false, 'no shell ran');

  // Real download and hash check against a local server.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acehrm-software-'));
  let seenAuth = null;
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    if (req.url === '/missing') res.writeHead(404).end();
    else res.end(content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const good = path.join(dir, 'good.msi');
  await downloadVerified({ url: `${base}/file`, token: 't', file: good, sha256 });
  assert.deepEqual(fs.readFileSync(good), content);
  assert.equal(seenAuth, 'Bearer t');
  await assert.rejects(
    downloadVerified({ url: `${base}/file`, token: 't', file: path.join(dir, 'bad.msi'), sha256: 'f'.repeat(64) }),
    /integrity/
  );
  await assert.rejects(
    downloadVerified({ url: `${base}/missing`, token: 't', file: path.join(dir, 'x.msi'), sha256 }),
    /404/
  );

  // Full flow with fake installer, using the real downloader.
  const harness = (runResult, overrides = {}) => {
    const calls = { run: [], lift: 0, restore: 0, reports: [], order: [] };
    const deps = {
      download: async (options) => { calls.order.push('download'); return downloadVerified(options); },
      ensureDir: (target) => fs.mkdirSync(target, { recursive: true }),
      trustSigner: async () => { calls.order.push('trust'); return { trusted: true, subject: 'CN=Vendor', thumbprint: 'AB' }; },
      liftBlock: async () => { calls.order.push('lift'); calls.lift += 1; return 2; },
      restoreBlock: async (value) => { calls.restore += 1; calls.restoredTo = value; },
      run: async (options) => {
        calls.order.push('run');
        calls.run.push(options);
        calls.existed = fs.existsSync(path.join(options.cwd, `${ID}.msi`));
        return runResult;
      },
      request: async (url, options) => { calls.reports.push({ url, body: options.body }); },
      ...overrides
    };
    const context = {
      config: { apiBase: `${base}/api`, paths: { stateDir: dir }, httpTimeoutMs: 1000 },
      getCredentials: () => ({ deviceToken: 't' })
    };
    return { calls, deps, context };
  };
  const payload = { package_id: ID, sha256, kind: 'msi', name: 'App', silent_args: '' };
  const leftover = path.join(dir, 'software', `${ID}.msi`);

  let h = harness({ exitCode: 3010 });
  let outcome = await installSoftware(payload, { ...h.context, commandId: 'c1' }, h.deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.restart_required, true);
  assert.equal(h.calls.existed, true, 'file was present for the installer');
  assert.equal(fs.existsSync(leftover), false, 'installer is deleted afterwards');
  assert.equal(h.calls.lift, 1);
  assert.deepEqual(h.calls.order, ['download', 'trust', 'lift', 'run'], 'signer is trusted after the hash check, before the install');
  assert.equal(h.calls.restore, 1, 'block is restored');
  assert.equal(h.calls.restoredTo, 2, 'block goes back to the value it had');
  assert.ok(h.calls.reports[0].url.endsWith('/device/commands/c1/result'));
  assert.equal(h.calls.reports[0].body.status, 'completed');

  h = harness({ exitCode: 1603 });
  outcome = await installSoftware(payload, { ...h.context, commandId: 'c2' }, h.deps);
  assert.equal(outcome.ok, false);
  assert.equal(h.calls.reports[0].body.status, 'failed');
  assert.equal(h.calls.restore, 1, 'block is restored after a failure');

  h = harness({ exitCode: 0 });
  outcome = await installSoftware(
    { ...payload, sha256: 'f'.repeat(64) },
    { ...h.context, commandId: 'c3' },
    h.deps
  );
  assert.equal(outcome.ok, false);
  assert.equal(h.calls.run.length, 0, 'a file failing its hash never runs');
  assert.equal(h.calls.lift, 0, 'block stays on when nothing will run');
  assert.equal(fs.existsSync(leftover), false, 'rejected file is deleted');

  // Trusting the signer is best effort: a failure never stops the install.
  h = harness({ exitCode: 0 }, { trustSigner: async () => { throw new Error('no powershell'); } });
  outcome = await installSoftware(payload, { ...h.context, commandId: 'c3b' }, h.deps);
  assert.equal(outcome.ok, true, 'install still succeeds when trusting fails');
  assert.equal(h.calls.run.length, 1);

  // The file path reaches PowerShell through the environment, not the script.
  assert.ok(TRUST_SCRIPT.includes('$env:ACEHRM_TRUST_FILE'));
  let seen = null;
  const trusted = await trustSigner('C:\\x y\\a.msi', async (script, env, timeoutMs) => {
    seen = { script, env, timeoutMs };
    return '{"trusted":false,"status":"NotSigned"}';
  });
  assert.deepEqual(trusted, { trusted: false, status: 'NotSigned' });
  assert.equal(seen.env.ACEHRM_TRUST_FILE, 'C:\\x y\\a.msi');
  assert.ok(!seen.script.includes('x y'), 'path is not in the script text');
  assert.ok(seen.timeoutMs >= 5 * 60_000, 'hashing a 2 GB installer needs a long timeout');

  // A duplicate delivery of one command installs once.
  h = harness({ exitCode: 0 });
  const first = installSoftware(payload, { ...h.context, commandId: 'c4' }, h.deps);
  const second = installSoftware(payload, { ...h.context, commandId: 'c4' }, h.deps);
  await Promise.all([first, second]);
  assert.equal(h.calls.run.length, 1, 'duplicate command is ignored');

  // Installs run strictly one at a time.
  let active = 0;
  let peak = 0;
  h = harness(null, {
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { exitCode: 0 };
    }
  });
  await Promise.all(
    ['c5', 'c6', 'c7'].map((commandId) =>
      installSoftware(payload, { ...h.context, commandId }, h.deps)
    )
  );
  assert.equal(peak, 1, 'installs never overlap');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('software self-check passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
