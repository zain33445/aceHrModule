/**
 * sync-v2.js — uploads the v2 spool (docs/recording-v2.md §6 + §8).
 *
 * Single lane, oldest segment first, never drops anything:
 *   register (if no `registered`) → PUT every chunk without `.ok`
 *   → POST close (with lostSeqs) once segment.json is closed and no `closed.ok`.
 * Chunks are read from disk at upload time. Idles until a protocol-2 server has
 * been seen (setSyncEnabled(true)); backlog stats are computed regardless.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { recordingV2SegmentUrl } from './config.js';
import { listSegmentDirs, readSegment, readJson, writeFileDurable, chunkFile, maxSeq } from './spool-v2.js';

// Plain-node importable: electron's `net` is loaded lazily by the default request, logging is injected.
const NOOP_LOG = { info() { }, warn() { }, error() { } };
const logger = {
  info: (m) => (_cfg?.log ?? NOOP_LOG).info(m),
  warn: (m) => (_cfg?.log ?? NOOP_LOG).warn(m),
  error: (m) => (_cfg?.log ?? NOOP_LOG).error(m),
};

const TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;
const PARK_MS = 30 * 60 * 1000;
const PERIODIC_MS = 60_000;
const FRESH_NO_META_MS = 30_000; // A8: a .webm younger than this may still be getting its <seq>.json
const STALE_SEGMENT_MS = 5 * 60_000; // A6: rebuilt segment whose newest file is older than this is treated as closed

// _cfg: { root, tokenFor(userId) → Promise<string|null>, refresh(userId) → Promise, request?, log? }
let _cfg = null;
let _enabled = false;
let _running = false;
let _again = false;
let _backlog = { chunks: 0, bytes: 0 };
const _parked = new Map(); // segment dir → { until (ms), reason }

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

/** Segment.json unreadable (A6): rebuild it from the folder (segmentId, userDir) and the chunk files. */
async function _rebuildSegment(dir, userDir, segmentId, files) {
  let first = Infinity;
  let newest = 0;
  for (const f of files) {
    if (!/^\d+\.webm$/.test(f)) continue;
    try {
      const st = await fs.promises.stat(path.join(dir, f));
      first = Math.min(first, st.mtimeMs);
      newest = Math.max(newest, st.mtimeMs);
      const m = await readJson(path.join(dir, f.replace(/\.webm$/, '.json')));
      const c = Date.parse(m?.capturedAt);
      if (Number.isFinite(c)) first = Math.min(first, c);
    } catch { /* moved */ }
  }
  if (!Number.isFinite(first)) { try { first = (await fs.promises.stat(dir)).mtimeMs; } catch { first = Date.now(); } }
  const startedAt = new Date(first).toISOString();
  const closed = newest > 0 && Date.now() - newest > STALE_SEGMENT_MS;
  const seg = {
    segmentId, userId: userDir, recordingDate: startedAt.slice(0, 10), startedAt,
    mime: null, width: null, height: null, deviceId: null,
    closed, lastSeq: closed ? await maxSeq(dir) : null, endedAt: closed ? new Date(newest).toISOString() : null,
    rebuilt: true,
  };
  logger.warn(`[SyncV2] ${segmentId}: segment.json unreadable — rebuilt from the folder (user ${userDir})`);
  try { await writeFileDurable(path.join(dir, 'segment.json'), JSON.stringify(seg)); } catch (err) { logger.warn(`[SyncV2] ${segmentId}: could not rewrite segment.json: ${err.message}`); }
  return seg;
}

/** Segments that still need something, oldest first. Finished ones cost one stat. */
async function _scan() {
  const out = [];
  let chunks = 0;
  let bytes = 0;
  for (const { dir, userDir, segmentId } of await listSegmentDirs(_cfg.root)) {
    if (await _exists(path.join(dir, 'closed.ok'))) continue;
    let files;
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    let seg = await readSegment(dir);
    if (!seg?.segmentId) seg = await _rebuildSegment(dir, userDir, segmentId, files);
    const names = new Set(files);
    const registered = names.has('registered');
    // A13: a closed segment that never produced a chunk is not worth a server session.
    if (seg.closed === true && !registered && !files.some((f) => /^\d+\.webm$/.test(f))) {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); logger.info(`[SyncV2] Removed empty segment ${seg.segmentId}`); } catch { /* retried next scan */ }
      continue;
    }
    const pending = [];
    let waiting = false;
    for (const f of files) {
      const m = /^(\d+)\.webm$/.exec(f);
      if (!m || names.has(`${f}.ok`)) continue;
      if (!names.has(`${m[1]}.json`)) { // A8: its metadata may still be in flight
        try { if (Date.now() - (await fs.promises.stat(path.join(dir, f))).mtimeMs < FRESH_NO_META_MS) { waiting = true; continue; } } catch { continue; }
      }
      pending.push(Number(m[1]));
    }
    pending.sort((a, b) => a - b);
    for (const seq of pending) {
      chunks++;
      try { bytes += (await fs.promises.stat(chunkFile(dir, seq))).size; } catch { /* moved */ }
    }
    out.push({ dir, seg, pending, registered, waiting });
  }
  _backlog = { chunks, bytes };
  out.sort((a, b) => String(a.seg.startedAt).localeCompare(String(b.seg.startedAt)));
  return out;
}

// A closed segment without closed.ok has work (the close call) unless a chunk is still being finalised.
const _hasWork = (w) => w.pending.length > 0 || (w.seg.closed === true && !w.waiting);

const _park = (dir, reason, ms = PARK_MS) => _parked.set(dir, { until: Date.now() + ms, reason });
export const getParked = () => [..._parked.keys()];

/** Parked for 30 min; a missing-token park ends as soon as the owner's token exists. */
async function _isParked(w) {
  const p = _parked.get(w.dir);
  if (!p) return false;
  if (p.reason === 'no_token') {
    if (await _cfg.tokenFor(w.seg.userId)) { _parked.delete(w.dir); return false; }
    return true;
  }
  if (p.until <= Date.now()) { _parked.delete(w.dir); return false; }
  return true;
}

async function _nextWork(segs) {
  for (const w of segs) if (_hasWork(w) && !(await _isParked(w))) return w;
  return null;
}

async function _drain() {
  let attempt = 0;
  for (;;) {
    const segs = await _scan();
    if (!_enabled) return;
    const work = await _nextWork(segs);
    if (!work) return;
    let r = 'retry';
    try { r = await _syncSegment(work); } catch (err) { logger.error(`[SyncV2] ${work.seg.segmentId}: ${err.message}`); }
    if (r === 'ok' || r === 'parked') { attempt = 0; continue; } // 'parked': _syncSegment parked it
    attempt++;
    const delay = _backoff(attempt);
    logger.warn(`[SyncV2] Segment ${work.seg.segmentId} not synced — retry in ${Math.round(delay / 1000)}s`);
    await _sleep(delay);
  }
}

/**
 * One pass over every segment that has work, oldest first, each attempted at most once, no backoff.
 * Runs regardless of setSyncEnabled (used by the checks); the background worker uses _drain.
 */
export async function syncPass() {
  if (!_cfg) return;
  for (const w of await _scan()) {
    if (!_hasWork(w) || await _isParked(w)) continue;
    try { await _syncSegment(w); } catch (err) { logger.error(`[SyncV2] ${w.seg.segmentId}: ${err.message}`); }
  }
}

/** @returns {Promise<{status:number, body:string}>} status 0 = network error / timeout */
async function _http(method, url, headers, body) {
  if (_cfg.request) {
    try { return await _cfg.request({ method, url, headers, body }); } catch { return { status: 0, body: '' }; }
  }
  const { default: electronPkg } = await import('electron');
  const { net } = electronPkg;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    try {
      const req = net.request({ method, url });
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
      timer = setTimeout(() => { try { req.abort(); } catch { /* finished */ } finish({ status: 0, body: '' }); }, TIMEOUT_MS);
      req.on('response', (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('error', () => finish({ status: 0, body: '' }));
        res.on('end', () => finish({ status: res.statusCode, body: text }));
      });
      req.on('error', () => finish({ status: 0, body: '' }));
      req.on('abort', () => finish({ status: 0, body: '' }));
      if (body) req.write(body);
      req.end();
    } catch { finish({ status: 0, body: '' }); }
  });
}

const _json = (res) => { try { const j = JSON.parse(res.body); return j && typeof j === 'object' ? j : null; } catch { return null; } };
const _is2xx = (res) => res.status >= 200 && res.status < 300;

/** Map a failed response to 'retry' | 'parked' (401 → token refresh for that user first). */
async function _fail(res, what, dir, userId) {
  if (res.status === 401) {
    try { await _cfg.refresh(userId); } catch (err) { logger.warn(`[SyncV2] Token refresh failed: ${err.message}`); }
    return 'retry';
  }
  if ([403, 409, 413, 422].includes(res.status)) { // A4: persistent refusals must not block newer segments
    logger.warn(`[SyncV2] ${what} refused (${res.status}) — segment parked for 30 min`);
    _park(dir, `http_${res.status}`);
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
  if (!token) { // A3: never fall back to someone else's token
    logger.warn(`[SyncV2] No token for user ${seg.userId} — segment ${seg.segmentId} parked until it appears`);
    _park(dir, 'no_token');
    return 'parked';
  }
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
      logger.error(`[SyncV2] Register rejected (400) for ${seg.segmentId}: ${res.body.slice(0, 200)}`);
      _park(dir, 'http_400');
      return 'parked';
    }
    if (!_is2xx(res)) return _fail(res, `Register ${seg.segmentId}`, dir, seg.userId);
    const j = _json(res);
    if (!j) { logger.warn(`[SyncV2] Register ${seg.segmentId}: 2xx without a JSON body (proxy / captive portal?)`); return 'retry'; }
    const sessionId = j.sessionId ?? '';
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
    if (!meta?.sha256) { // crash between the .webm and its .json: rebuild from the bytes (old enough, see _scan)
      let mtime = new Date().toISOString();
      try { mtime = (await fs.promises.stat(file)).mtime.toISOString(); } catch { /* now */ }
      // loggedOut is unknown here: null, never a made-up false (A8)
      meta = { capturedAt: mtime, durationMs: 0, ...(meta || {}), loggedOut: meta?.loggedOut ?? null, sha256: _sha(buf) };
      await writeFileDurable(metaFile, JSON.stringify(meta));
    }
    const headers = {
      ...auth,
      'Content-Type': 'application/octet-stream',
      'X-Chunk-Sha256': meta.sha256,
      'X-Captured-At': meta.capturedAt,
      'X-Duration-Ms': String(meta.durationMs ?? 0),
    };
    if (typeof meta.loggedOut === 'boolean') headers['X-Logged-Out'] = meta.loggedOut ? '1' : '0';
    const res = await _http('PUT', recordingV2SegmentUrl(seg.segmentId, `/chunks/${seq}`), headers, buf);
    if (_is2xx(res)) {
      const j = _json(res);
      if (j?.ok !== true) { // A5: only the server's own {ok:true} counts
        logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq}: 2xx without {ok:true} (proxy / captive portal?) — not marked uploaded`);
        return 'retry';
      }
      if (j.conflict) logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq}: server reported a conflict (it keeps both copies)`);
      await fs.promises.writeFile(`${file}.ok`, '');
      _backlog = { chunks: Math.max(0, _backlog.chunks - 1), bytes: Math.max(0, _backlog.bytes - buf.length) };
      continue;
    }
    if (res.status === 404 && /segment_not_registered/.test(res.body)) {
      logger.warn(`[SyncV2] Server does not know segment ${seg.segmentId} — re-registering`);
      await _unregister(dir);
      return 'retry';
    }
    if (res.status === 400) {
      const sha = _sha(buf);
      if (sha === meta.sha256) { // the server rejects bytes whose sha is right: retrying cannot help
        logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq} rejected (400) although its sha matches the file — segment parked`);
        _park(dir, 'http_400');
        return 'parked';
      }
      await writeFileDurable(metaFile, JSON.stringify({ ...meta, sha256: sha })); // stale sha in the .json
      logger.warn(`[SyncV2] Chunk ${seg.segmentId}/${seq} rejected (400, stale sha) — retrying with sha from disk`);
      return 'retry';
    }
    return _fail(res, `Chunk ${seg.segmentId}/${seq}`, dir, seg.userId);
  }

  if (seg.closed) {
    const lastSeq = Number.isInteger(seg.lastSeq) ? seg.lastSeq : -1;
    const lostSeqs = [];
    for (let i = 0; i <= lastSeq; i++) if (!(await _exists(chunkFile(dir, i)))) lostSeqs.push(i);
    if (lostSeqs.length) logger.warn(`[SyncV2] Segment ${seg.segmentId}: ${lostSeqs.length} chunk(s) missing locally → lostSeqs`);
    const res = await _http('POST', recordingV2SegmentUrl(seg.segmentId, '/close'), { ...auth, 'Content-Type': 'application/json' },
      JSON.stringify({ lastSeq, endedAt: seg.endedAt, lostSeqs }));
    if (res.status === 404 && /segment_not_registered/.test(res.body)) {
      await _unregister(dir);
      return 'retry';
    }
    if (!_is2xx(res)) return _fail(res, `Close ${seg.segmentId}`, dir, seg.userId);
    if (!_json(res)) { logger.warn(`[SyncV2] Close ${seg.segmentId}: 2xx without a JSON body — not marked closed`); return 'retry'; }
    await fs.promises.writeFile(path.join(dir, 'closed.ok'), '');
    logger.info(`[SyncV2] Segment ${seg.segmentId} closed on server`);
  }
  return 'ok';
}
