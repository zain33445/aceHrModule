'use strict';
// Live test in Windows Sandbox: runs scripts/sandbox-harness.js as SYSTEM against the
// dist-service payload (policy PowerShell, signer trust, service install/uninstall).
// Needs Windows Pro/Enterprise with the Sandbox feature and `wsb`; no host admin rights.
// `wsb exec` returns no stdout, so the harness writes C:\\out\result.txt to a mapped folder.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fail = (msg) => { console.error(msg); process.exit(1); };
if (process.platform !== 'win32') fail('test-sandbox needs Windows (Windows Sandbox).');

const wsb = (...args) => execFileSync('wsb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try { wsb('--version'); } catch { fail('`wsb` (Windows Sandbox CLI) was not found. Enable Windows Sandbox and use Windows 11 24H2 or later.'); }

const root = path.join(__dirname, '..');
const payload = path.join(root, 'dist-service');
const stale = () => {
  const names = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort();
  const dist = path.join(payload, 'src');
  if (!fs.existsSync(dist)) return true;
  const src = path.join(root, 'src');
  return JSON.stringify(names(src)) !== JSON.stringify(names(dist)) ||
    names(src).some((n) => !fs.readFileSync(path.join(src, n)).equals(fs.readFileSync(path.join(dist, n))));
};
if (stale()) fail('dist-service/ is missing or out of date with src/. Run `npm run build-payload` first.');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acehrm-sandbox-'));
const folder = (host, sandbox, readOnly) =>
  `<MappedFolder><HostFolder>${host}</HostFolder><SandboxFolder>${sandbox}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
const config = `<Configuration><Networking>Disable</Networking><MappedFolders>${[
  folder(payload, 'C:\\svc_ro', true),
  folder(__dirname, 'C:\\harness', true),
  folder(out, 'C:\\out', false)
].join('')}</MappedFolders></Configuration>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (id, command) => wsb('exec', '--id', id, '-r', 'System', '-c', command);

(async () => {
  let id = null;
  let ok = false;
  try {
    console.log('Starting Windows Sandbox (1-3 minutes)...');
    id = JSON.parse(wsb('start', '--raw', '-c', config)).Id;
    if (!id) throw new Error('wsb start returned no Id');

    for (let attempt = 1; ; attempt++) {
      try { exec(id, 'cmd.exe /c xcopy C:\\svc_ro C:\\svc /E /I /Q /Y'); break; }
      catch (err) { if (attempt >= 60) throw new Error(`Sandbox never became ready: ${err.message}`); await sleep(5000); }
    }
    try { exec(id, 'C:\\svc\\node.exe C:\\harness\\sandbox-harness.js'); }
    catch (err) { console.error(`harness process: ${err.message.trim()}`); }

    const resultFile = path.join(out, 'result.txt');
    const result = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
    console.log(result || 'No result.txt was produced.');
    ok = result.trim().split(/\r?\n/).pop() === 'DONE ALL PASSED';
  } catch (err) {
    console.error(err.message);
  } finally {
    if (id) { try { wsb('stop', '--id', id); } catch (err) { console.error(`wsb stop failed: ${err.message.trim()}`); } }
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (ok) console.log('test-sandbox passed');
  process.exit(ok ? 0 : 1);
})();
