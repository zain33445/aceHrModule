/** token-store.js — atomic persistence for agent tokens/policies (dependency-free; token-store.check.mjs). */
import fs from 'fs';

const parse = (file) => {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : null; } catch { return null; }
};

/** Main file, else the .bak (A7). */
export function loadStore(file) {
  const main = parse(file);
  if (main) return { data: main, from: 'main' };
  const bak = parse(`${file}.bak`);
  if (bak) return { data: bak, from: 'bak' };
  return { data: null, from: null };
}

/** tmp -> rename. The previous main becomes .bak only if it parses (garbage never poisons the .bak). */
export function saveStore(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (parse(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ } }
  fs.renameSync(tmp, file);
}

/** New policy from a CONNECTED message; a missing recordingDay keeps the previous rule (A11). */
export function mergeConnected(prev, msg) {
  return {
    record: !!msg?.record,
    recordingDay: msg?.recordingDay ?? prev?.recordingDay ?? null,
  };
}
