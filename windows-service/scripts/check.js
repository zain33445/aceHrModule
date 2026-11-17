'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const searchRoots = [path.join(projectRoot, 'src'), __dirname];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.js')) files.push(target);
  }
}

for (const root of searchRoots) {
  if (fs.existsSync(root)) walk(root);
}

if (!files.length) {
  console.error('No JavaScript files found to check.');
  process.exit(1);
}

let failures = 0;

for (const file of files) {
  const relative = path.relative(projectRoot, file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`ok   ${relative}`);
  } else {
    failures += 1;
    console.error(`FAIL ${relative}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

if (failures) {
  console.error(`\n${failures} file(s) failed the syntax check.`);
  process.exit(1);
}

console.log(`\n${files.length} file(s) passed the syntax check.`);
