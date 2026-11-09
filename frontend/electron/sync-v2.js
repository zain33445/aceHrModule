/**
 * sync-v2.js — uploads the v2 spool (docs/recording-v2.md §6 + §8).
 *
 * Single lane, oldest segment first, never drops anything:
 *   register (if no `registered`) → PUT every chunk without `.ok`
 *   → POST close (with lostSeqs) once segment.json is closed and no `closed.ok`.
 * Chunks are read from disk at upload time. Idles until a protocol-2 server has
 * been seen (setSyncEnabled(true)); backlog stats are computed regardless.
 */
import electronPkg from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { recordingV2SegmentUrl } from './config.js';
import { listSegmentDirs, readSegment, readJson, writeFileDurable, chunkFile } from './spool-v2.js';

const { net } = electronPkg;

const TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;
const PARK_MS = 30 * 60 * 1000;
const PERIODIC_MS = 60_000;

let _cfg = null; // { root, tokenFor(userId) → Promise<string|null>, refresh() → Promise }
let _enabled = false;
let _running = false;
let _again = false;
let _backlog = { chunks: 0, bytes: 0 };
const _parked = new Map(); // segment dir → resume time (ms)

export function initSyncV2(cfg) {
  _cfg = cfg;
  const t = setInterval(kickSync, PERIODIC_MS);
  if (typeof t.unref === 'function') t.unref();
  kickSync();
}

/** Enable uploads (a protocol-2 CONNECTED was seen). */
export function setSyncEnabled(on) {
  if (on && !_enabled) logger.info('[SyncV2] Server speaks protocol 2 — upload enabled');
  _enabled = !!on;
  if (on) kickSync();
}

export const getBacklog = () => ({ ..._backlog });

export function kickSync() {
  if (!_cfg) return;
  if (_running) { _again = true; return; }
  _running = true;
  (async () => {
    do { _again = false; await _drain(); } while (_again);
  })()
    .catch((err) => logger.error(`[SyncV2] Worker crashed: ${err.message}`))
    .finally(() => { _running = false; });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _backoff = (attempt) => Math.round(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));
const _exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
const _sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Segments that still need something, oldest first. Finished ones cost one stat. */
async function _scan() {
  const out = [];
  let chunks = 0;
  let bytes = 0;
  for (const { dir } of await listSegmentDirs(_cfg.root)) {
    if (await _exists(path.join(dir, 'closed.ok'))) continue;
    const seg = await readSegment(dir);
    if (!seg?.segmentId) continue;
    let files;
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    const names = new Set(files);
    const pending = [];
    for (const f of files) {
      const m = /^(\d+)\.webm$/.exec(f);
      if (m && !names.has(`${f}.ok`)) pending.push(Number(m[1]));
    }
    pending.sort((a, b) => a - b);
    for (const seq of pending) {
      chunks++;
      try { bytes += (await fs.promises.stat(chunkFile(dir, seq))).size; } catch { /* moved */ }
    }
    out.push({ dir, seg, pending, registered: names.has('registered') });
  }
  _backlog = { chunks, bytes };
  out.sort((a, b) => String(a.seg.startedAt).localeCompare(String(b.seg.startedAt)));
  return out;
}

// A closed segment without closed.ok always has work (the close call).
const _hasWork = (w) => w.pending.length > 0 || w.seg.closed === true;

async function _drain() {
  let attempt = 0;
  for (;;) {
    const segs = await _scan();
    if (!_enabled) return;
    const now = Date.now();
    const work = segs.find((w) => (_parked.get(w.dir) ?? 0) <= now && _hasWork(w));
    if (!work) return;
    let r = 'retry';
    try { r = await _syncSegment(work); } catch (err) { logger.error(`[SyncV2] ${work.seg.segmentId}: ${err.message}`); }
    if (r === 'ok') { attempt = 0; continue; }
    if (r === 'parked') { _parked.set(work.dir, Date.now() + PARK_MS); attempt = 0; continue; }
    attempt++;
    const delay = _backoff(attempt);
    logger.warn(`[SyncV2] Segment ${work.seg.segmentId} not synced — retry in ${Math.round(delay / 1000)}s`);
    await _sleep(delay);
  }
}

/** @returns {Promise<{status:number, text:string}>} status 0 = network error / timeout */
function _http(method, url, headers, body) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    try {
      const req = net.request({ method, url });
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
      timer = setTimeout(() => { try { req.abort(); } catch { /* finished */ } finish({ status: 0, text: '' }); }, TIMEOUT_MS);
      req.on('response', (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('error', () => finish({ status: 0, text: '' }));
        res.on('end', () => finish({ status: res.statusCode, text }));
      });
      req.on('error', () => finish({ status: 0, text: '' }));
      req.on('abort', () => finish({ status: 0, text: '' }));
      if (body) req.write(body);
      req.end();
    } catch { finish({ status: 0, text: '' }); }
  });
}

/** Map a failed response to 'retry' | 'parked' (401 → token refresh first). */
async function _fail(res, what) {
  if (res.status === 401) {
    try { await _cfg.refresh(); } catch (err) { logger.warn(`[SyncV2] Token refresh failed: ${err.message}`); }
    return 'retry';
  }
  if (res.status === 403) {
    logger.warn(`[SyncV2] ${what} refused (403) — segment parked for 30 min`);
    return 'parked';
  }
  logger.warn(`[SyncV2] ${what} failed (HTTP ${res.status || 'network'})`);
  return 'retry';
}

async function _unregister(dir) {
  try { await fs.promises.unlink(path.join(dir, 'registered')); } catch { /* already gone */ }
}

async function _syncSegment({ dir, seg, pending, registered }) {
  const token = await _cfg.tokenFor(seg.userId);
  if (!token) { logger.warn(`[SyncV2] No token for user ${seg.userId} yet`); return 'retry'; }
  const auth = { Authorization: `Bearer ${token}` };

  if (!registered) {
    const res = await _http('PUT', recordingV2SegmentUrl(seg.segmentId), { ...auth, 'Content-Type': 'application/json' },
      JSON.stringify({
        startedAt: seg.startedAt,
        mime: seg.mime ?? 'video/webm',
        width: seg.width ?? null,
        height: seg.height ?? null,
        deviceId: seg.deviceId ?? null,
        recordingDate: seg.recordingDate,
      }));
    if (res.status === 400) {
      logger.error(`[SyncV2] Register rejected (400) for ${seg.segmentId}: ${res.text.slice(0, 200)}`);
      return 'parked';
    }
    if (res.status < 200 || res.status >= 300) return _fail(res, `Register ${seg.segmentId}`);
    let sessionId = '';
    try { sessionId = JSON.parse(res.text).sessionId ?? ''; } catch { /* keep empty */ }
    await writeFileDurable(path.join(dir, 'registered'), String(sessionId));
    logger.info(`[SyncV2] Segment ${seg.segmentId} registered (session ${sessionId})`);
  }

  for (const seq of pending) {
    const file = chunkFile(dir, seq);
    let buf;
    try { buf = await fs.promises.readFile(file); } catch (err) {
      if (err.code === 'ENOENT') continue; // gone: reported via lostSeqs on close
      return 'retry';
    }
    const metaFile = chunkFile(dir, seq, 'json');
    let meta = await readJson(metaFile);
    if (!meta?.sha256) { // crash between the .webm and its .json: rebuild from the bytes
      let mtime = new Date().toISOString();
      try { mtime = (await fs.promises.stat(file)).mtime.toISOString(); } catch { /* now */ }
      meta = { capturedAt: mtime, durationMs: 0, loggedOut: false, ...(meta || {}), sha256: _sha(buf) };
      await writeFileDurable(metaFile, JSON.stringify(meta));
    }
    const res = await _http('PUT', recordingV2SegmentUrl(seg.segmentId, `/chunks/${seq}`), {
      ...auth,
      'Content-Type': 'application/octet-stream',
      'X-Chunk-Sha256': meta.sha256,
      'X-Captured-At': meta.capturedAt,
      'X-Duration-Ms': String(meta.durationMs ?? 0),
      'X-Logged-Out': meta.loggedOut ? '1' : '0',
    }, buf);
    if (res.status >= 200 && res.status < 300) {
      if (/"conflict"\s*:\s*true/.test(res.text)) {
        logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq}: server reported a conflict (it keeps both copies)`);
      }
      await fs.promises.writeFile(`${file}.ok`, '');
      _backlog = { chunks: Math.max(0, _backlog.chunks - 1), bytes: Math.max(0, _backlog.bytes - buf.length) };
      continue;
    }
    if (res.status === 404 && /segment_not_registered/.test(res.text)) {
      logger.warn(`[SyncV2] Server does not know segment ${seg.segmentId} — re-registering`);
      await _unregister(dir);
      return 'retry';
    }
    if (res.status === 400) {
      // Corrupt in transit, or a stale sha in the .json: recompute from the file and retry.
      const sha = _sha(buf);
      if (sha !== meta.sha256) await writeFileDurable(metaFile, JSON.stringify({ ...meta, sha256: sha }));
      logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq} rejected (400, sha mismatch) — retrying with sha from disk`);
      return 'retry';
    }
    return _fail(res, `Chunk ${seg.segmentId}/${seq}`);
  }

  if (seg.closed) {
    const lastSeq = Number.isInteger(seg.lastSeq) ? seg.lastSeq : -1;
    const lostSeqs = [];
    for (let i = 0; i <= lastSeq; i++) if (!(await _exists(chunkFile(dir, i)))) lostSeqs.push(i);
    if (lostSeqs.length) logger.warn(`[SyncV2] Segment ${seg.segmentId}: ${lostSeqs.length} chunk(s) missing locally → lostSeqs`);
    const res = await _http('POST', recordingV2SegmentUrl(seg.segmentId, '/close'), { ...auth, 'Content-Type': 'application/json' },
      JSON.stringify({ lastSeq, endedAt: seg.endedAt, lostSeqs }));
    if (res.status === 404 && /segment_not_registered/.test(res.text)) {
      await _unregister(dir);
      return 'retry';
    }
    if (res.status < 200 || res.status >= 300) return _fail(res, `Close ${seg.segmentId}`);
    await fs.promises.writeFile(path.join(dir, 'closed.ok'), '');
    logger.info(`[SyncV2] Segment ${seg.segmentId} closed on server`);
  }
  return 'ok';
}
