'use strict';

// Stages windows-service/dist-service for the Windows installer.
// See frontend/build/SERVICE-INSTALL.md for what the payload contains.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.error('build-payload must run on Windows (it bundles node.exe and winsw.exe).');
  process.exit(1);
}

const svc = path.join(__dirname, '..');
const stage = path.join(svc, 'dist-service');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);

execSync('npm install --omit=dev --no-audit --no-fund', { cwd: svc, stdio: 'inherit', shell: true });

fs.copyFileSync(path.join(svc, 'package.json'), path.join(stage, 'package.json'));
fs.cpSync(path.join(svc, 'src'), path.join(stage, 'src'), { recursive: true });
fs.cpSync(path.join(svc, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(stage, 'node.exe'));

const cmd = (action) =>
  ['@echo off', 'setlocal', `"%~dp0node.exe" "%~dp0src\\install.js" ${action}`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
fs.writeFileSync(path.join(stage, 'install-service.cmd'), cmd('install'));
fs.writeFileSync(path.join(stage, 'uninstall-service.cmd'), cmd('uninstall'));

for (const rel of ['node_modules/ws', 'node_modules/node-windows/bin/winsw/winsw.exe']) {
  if (!fs.existsSync(path.join(stage, rel))) {
    console.error(`Payload is missing ${rel}`);
    process.exit(1);
  }
}
console.log(`Service payload ready: ${stage}`);
