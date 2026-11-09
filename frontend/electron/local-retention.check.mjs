// Run: node frontend/electron/local-retention.check.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { pruneOldRecordings, RECORDING_RETENTION_MS } from './local-retention.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'));
const sess = path.join(root, 'sess1');
fs.mkdirSync(sess);
const old = new Date(Date.now() - RECORDING_RETENTION_MS - 86400000);
const fresh = new Date();
const mk = (name, when) => {
  const f = path.join(sess, name);
  fs.writeFileSync(f, 'x');
  fs.utimesSync(f, when, when);
};
mk('chunk-00000.webm', old); mk('chunk-00000.webm.ok', old); // old + synced
mk('chunk-00001.webm', old);                                  // old + unsynced
mk('chunk-00002.webm', fresh); mk('chunk-00002.webm.ok', fresh); // new + synced

const r = await pruneOldRecordings(root);
const left = fs.readdirSync(sess).sort();
assert.deepStrictEqual(left, ['chunk-00001.webm', 'chunk-00002.webm', 'chunk-00002.webm.ok']);
assert.strictEqual(r.removedFiles, 1);
fs.rmSync(root, { recursive: true, force: true });
console.log('local-retention check passed');
