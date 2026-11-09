/**
 * recorder-main.js — Recording Orchestrator (Main Process)
 * Manages the hidden BrowserWindow, chunk I/O, and chunk upload queue.
 *
 * Durability rules (chunks must never be lost):
 *  - a chunk is written to `<name>.tmp`, fsynced, then renamed into place
 *    BEFORE it is queued for upload;
 *  - the queue holds file paths only (the file is read at upload time);
 *  - uploads retry forever with exponential backoff;
 *  - after a 2xx an empty `<chunk>.ok` marker is written; chunks are never
 *    deleted here (local-retention.js removes old synced ones);
 *  - on startup every chunk without a marker is re-queued.
 */
import electronPkg from 'electron';
const { BrowserWindow, desktopCapturer, ipcMain, app } = electronPkg;
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { RECORDING_CHUNK_ENDPOINT, RECORDING_CHUNK_CHECK_ENDPOINT, DEFAULT_QUALITY, RECORDING_CHUNK_INTERVAL_MS } from './config.js';
import { pruneOldRecordings, RETENTION_SWEEP_INTERVAL_MS, RECORDING_RETENTION_MS } from './local-retention.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;
const STALE_TMP_MS = 60 * 60 * 1000;
const PARKED_RETRY_MS = 30 * 60 * 1000;
const _parked = []; // chunks the server refused (4xx); retried every 30 min

let _recorderWindow = null;
let _windowPromise = null; // single in-flight window creation
let _state = 'idle'; // idle | starting | recording | stopping | permission_denied
let _sessionId = null;
let _uploadQueue = []; // [{ sessionId, chunkIndex, filePath }]
const _queuedPaths = new Set(); // file paths currently in _uploadQueue
const _pendingWrites = new Set(); // in-flight chunk writes (for flushAndStop)
const _stopWaiters = new Set();
let _isUploading = false;
let _onStateChange = null;
let _getToken = null;
let _listenersReady = false;
let _warmupDone = false;
let _startRetries = 0;
const MAX_START_RETRIES = 3;

// ─── Init ─────────────────────────────────
export function initRecorderMain(getToken, onStateChange) {
  _getToken = getToken;
  _onStateChange = onStateChange;
  if (_listenersReady) return;
  _listenersReady = true;

  _startRetentionSweep();
  _scanBacklog().catch((err) => logger.error(`[Recorder] Backlog scan failed: ${err.message}`));
  const parkedTimer = setInterval(() => {
    // _enqueue re-adds them (the path left _queuedPaths when it was parked).
    for (const item of _parked.splice(0)) _enqueue(item);
  }, PARKED_RETRY_MS);
  if (typeof parkedTimer.unref === 'function') parkedTimer.unref();

  ipcMain.on('recording:chunk', (_e, { sessionId, chunkIndex, buffer }) => {
    const p = _handleChunk(sessionId, chunkIndex, Buffer.from(buffer))
      .catch((err) => logger.error(`[Recorder] Chunk write failed: ${err.message}`))
      .finally(() => _pendingWrites.delete(p));
    _pendingWrites.add(p);
  });

  ipcMain.on('recording:state', (_e, { state, sessionId }) => {
    logger.info(`[Recorder] State → ${state} (session: ${sessionId})`);
    if (state !== 'recording' && sessionId && _sessionId && sessionId !== _sessionId) {
      // An OLD recorder finishing must not reset the state of the new session.
      logger.info(`[Recorder] Ignoring '${state}' from previous session ${sessionId}`);
      return;
    }
    if (state === 'recording') {
      _state = 'recording';
      _startRetries = 0; // success — reset silent retry budget
    } else {
      _state = 'idle';
    }
    if (_onStateChange) _onStateChange(state, sessionId);
    if (state !== 'recording' && _stopWaiters.size) {
      // Resolve flushAndStop() once the final chunk is on disk.
      Promise.allSettled([..._pendingWrites]).then(() => {
        for (const done of [..._stopWaiters]) done();
      });
    }
  });

  ipcMain.on('recording:error', (_e, { code, message, sessionId }) => {
    const sid = sessionId || _sessionId;
    const isPermission = code === 'PERMISSION_DENIED';
    logger.error(`[Recorder] Error [${code}]: ${message} (session: ${sid})`);

    // Silent retry — never show UI to the end user
    if (isPermission && sid && _startRetries < MAX_START_RETRIES) {
      _startRetries++;
      const delay = 2000 * _startRetries;
      logger.warn(`[Recorder] Permission error — silent retry ${_startRetries}/${MAX_START_RETRIES} in ${delay}ms`);
      _state = 'starting';
      if (_onStateChange) _onStateChange('starting', sid);
      setTimeout(() => {
        startRecording(sid, DEFAULT_QUALITY, { retry: true }).catch((err) => {
          logger.error(`[Recorder] Silent retry failed: ${err.message}`);
        });
      }, delay);
      return;
    }

    _state = isPermission ? 'permission_denied' : 'idle';
    if (_onStateChange) _onStateChange(isPermission ? 'permission_denied' : 'error', sid);

    // Forward to backend so the admin dashboard can see it (employee never sees this)
    _forwardErrorToGateway({
      type: 'ERROR',
      code: code || 'START_FAILED',
      message: message || 'Recording failed',
      sessionId: sid ?? undefined,
    });
  });

  ipcMain.on('recording:warmup-result', (_e, ok) => {
    _warmupDone = !!ok;
    logger.info(`[Recorder] Capture warm-up ${ok ? 'succeeded' : 'failed'}`);
  });

  ipcMain.on('recording:webrtc-out', (_e, msg) => {
    import('./ws-client.js').then(({ sendWsMessage }) => {
      sendWsMessage(msg);
    }).catch(err => logger.error(`[Recorder] WebRTC WS send error: ${err.message}`));
  });

  logger.info('[Recorder Main] Initialized');
}

function _forwardErrorToGateway(msg) {
  import('./ws-client.js').then(({ sendWsMessage }) => {
    sendWsMessage(msg);
  }).catch(err => logger.error(`[Recorder] Gateway error forward failed: ${err.message}`));
}

// ─── Preflight warm-up (no UI) ────────────
/**
 * Silently exercises desktopCapturer + a short getUserMedia capture inside
 * the hidden recorder window so any one-time OS/Chromium grant happens at
 * idle time — not during an admin-initiated live session.
 */
export async function warmupCapture() {
  if (_warmupDone) return true;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources?.length) {
      logger.warn('[Recorder] Warm-up: no screen sources');
      return false;
    }
    const win = await _ensureWindow();
    win.webContents.send('recording:warmup', { sourceId: sources[0].id });
    // Result arrives via recording:warmup-result (async)
    return true;
  } catch (err) {
    logger.warn(`[Recorder] Warm-up failed: ${err.message}`);
    return false;
  }
}

// ─── Public API ───────────────────────────
/**
 * @param {string} sessionId
 * @param {string} [quality]
 * @param {{ retry?: boolean }} [opts] retry: internal silent retry of the same
 *   session (bypasses the "already starting" guard).
 */
export async function startRecording(sessionId, quality = DEFAULT_QUALITY, opts = {}) {
  if (_state === 'recording') {
    logger.warn(`[Recorder] Already recording ${_sessionId}`);
    return false;
  }
  if (_state === 'starting' && _sessionId === sessionId && !opts.retry) {
    logger.warn(`[Recorder] Start already in progress for ${sessionId}`);
    return false;
  }
  try {
    // New session id ⇒ fresh retry budget (silent retries keep the same session)
    if (_sessionId !== sessionId) _startRetries = 0;
    _sessionId = sessionId;
    _state = 'starting';
    await fs.promises.mkdir(_sessionDir(sessionId), { recursive: true });

    // Remember who this session belongs to, so its chunks upload with that
    // user's token even after someone else signs in on this PC.
    await _writeOwner(sessionId);

    // Chunk numbering continues after whatever is already on disk.
    const startIndex = await _nextChunkIndex(sessionId);

    // Ensure capture path is warm before the real start (silent, no UI)
    if (!_warmupDone) {
      await warmupCapture().catch(() => {});
    }

    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources?.length) throw new Error('No screen sources found');

    const win = await _ensureWindow();
    win.webContents.send('recording:start', {
      sessionId,
      sourceId: sources[0].id,
      quality,
      chunkIntervalMs: RECORDING_CHUNK_INTERVAL_MS,
      startIndex,
    });
    logger.info(`[Recorder] Start sent to renderer — session ${sessionId} (startIndex ${startIndex})`);
    return true;
  } catch (err) {
    logger.error(`[Recorder] Start failed: ${err.message}`);
    _state = 'idle';
    _forwardErrorToGateway({
      type: 'ERROR',
      code: 'START_FAILED',
      message: err.message,
      sessionId,
    });
    if (_onStateChange) _onStateChange('error', sessionId);
    return false;
  }
}

export function stopRecording() {
  if (_state !== 'recording' && _state !== 'starting') return false;
  _state = 'stopping';
  if (_recorderWindow && !_recorderWindow.isDestroyed()) {
    _recorderWindow.webContents.send('recording:stop');
    return true;
  }
  _state = 'idle';
  return false;
}

/**
 * Stop the recorder and wait until the renderer reports it stopped and the
 * final chunk is on disk (or the timeout elapses). Used before app quit so the
 * in-progress segment is not lost.
 */
export function flushAndStop(timeoutMs = 4000) {
  if (_state !== 'recording' && _state !== 'starting') {
    return Promise.allSettled([..._pendingWrites]).then(() => {});
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      _stopWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    _stopWaiters.add(done);
    if (!stopRecording()) done();
  });
}

export function getRecordingState() {
  return { state: _state, sessionId: _sessionId };
}

export async function handleWebRtcMessage(msg) {
  try {
    const win = await _ensureWindow();
    win.webContents.send('recording:webrtc-in', msg);
  } catch (err) {
    logger.error(`[Recorder] Failed to forward WebRTC message to renderer: ${err.message}`);
  }
}

// ─── Hidden BrowserWindow ─────────────────
function _ensureWindow() {
  if (_recorderWindow && !_recorderWindow.isDestroyed()) return Promise.resolve(_recorderWindow);
  if (_windowPromise) return _windowPromise; // concurrent callers share one creation

  _windowPromise = (async () => {
    const htmlPath = app.isPackaged
      ? path.join(app.getAppPath(), 'electron', 'recorder-renderer', 'recorder.html')
      : path.join(__dirname, 'recorder-renderer', 'recorder.html');

    const win = new BrowserWindow({
      width: 400, height: 80,
      show: false, skipTaskbar: true, frame: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });

    try {
      await win.loadFile(htmlPath);
    } catch (err) {
      if (!win.isDestroyed()) win.destroy();
      throw err;
    }

    win.on('closed', () => {
      logger.warn('[Recorder] Hidden window closed unexpectedly');
      if (_recorderWindow === win) _recorderWindow = null;
      if (_state === 'recording') { _state = 'idle'; if (_onStateChange) _onStateChange('error', _sessionId); }
    });

    _recorderWindow = win; // published only once fully loaded
    logger.info('[Recorder] Hidden BrowserWindow created');
    return win;
  })().finally(() => { _windowPromise = null; });

  return _windowPromise;
}

// ─── Chunk Handling ───────────────────────
async function _exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/** Write durably (tmp → fsync → rename), THEN enqueue for upload. */
async function _handleChunk(sessionId, chunkIndex, buffer) {
  if (!buffer || buffer.length === 0) return;
  await fs.promises.mkdir(_sessionDir(sessionId), { recursive: true });

  // Never overwrite an existing chunk: take the next free index instead.
  let idx = chunkIndex;
  while (await _exists(_chunkPath(sessionId, idx))) idx++;
  if (idx !== chunkIndex) logger.warn(`[Recorder] Chunk ${chunkIndex} already on disk — stored as ${idx}`);

  const filePath = _chunkPath(sessionId, idx);
  const tmpPath = `${filePath}.tmp`;
  const fh = await fs.promises.open(tmpPath, 'w');
  try {
    await fh.writeFile(buffer);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmpPath, filePath);
  logger.info(`[Recorder] Chunk ${idx} → disk (${Math.round(buffer.length / 1024)}KB)`);
  _enqueue({ sessionId, chunkIndex: idx, filePath });
}

function _enqueue(item) {
  if (_queuedPaths.has(item.filePath)) return;
  _queuedPaths.add(item.filePath);
  _uploadQueue.push(item);
  _drainQueue();
}

function _backoffDelay(attempt) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% jitter
}

async function _drainQueue() {
  if (_isUploading || _uploadQueue.length === 0) return;
  _isUploading = true;
  try {
    while (_uploadQueue.length > 0) {
      const item = _uploadQueue[0];
      let attempt = 0;
      for (;;) {
        let result = 'fail';
        try {
          result = await _upload(item);
        } catch (err) {
          logger.error(`[Recorder] Upload threw for chunk ${item.chunkIndex}: ${err.message}`);
        }
        if (result === 'ok') {
          try {
            await fs.promises.writeFile(`${item.filePath}.ok`, '');
          } catch (err) {
            logger.error(`[Recorder] Could not write .ok marker for chunk ${item.chunkIndex}: ${err.message}`);
          }
          break;
        }
        if (result === 'missing') {
          logger.error(`[Recorder] Chunk file vanished, cannot upload: ${item.filePath}`);
          break;
        }
        if (result === 'rejected') {
          // Item-specific refusal (403 wrong owner, 400, 413…): park it so it
          // cannot block every later chunk. It stays on disk without a .ok
          // marker and is retried later — never dropped.
          _parked.push(item);
          logger.warn(`[Recorder] Chunk ${item.chunkIndex} (${item.sessionId}) rejected by server — parked for a later retry`);
          break;
        }
        // 401: get a fresh agent token, then retry (backoff keeps growing so a
        // refresh that keeps failing cannot turn into a hot loop).
        if (result === 'unauthorized') {
          try {
            const { refreshAgentToken } = await import('./ws-client.js');
            await refreshAgentToken();
          } catch (err) {
            logger.warn(`[Recorder] Token refresh failed: ${err.message}`);
          }
        }
        attempt++;
        const delay = _backoffDelay(attempt);
        logger.warn(`[Recorder] Chunk ${item.chunkIndex} (${item.sessionId}) not uploaded (${result}) — retry in ${Math.round(delay / 1000)}s`);
        await _sleep(delay);
      }
      _uploadQueue.shift();
      _queuedPaths.delete(item.filePath);
    }
  } finally {
    _isUploading = false;
  }
  // Something may have been enqueued while we were finishing.
  if (_uploadQueue.length > 0) _drainQueue();
}

/** @returns {Promise<'ok'|'fail'|'unauthorized'|'rejected'|'missing'>} */
async function _upload({ sessionId, chunkIndex, filePath }) {
  let buffer;
  try {
    buffer = await fs.promises.readFile(filePath);
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : 'fail';
  }
  const token = await _tokenForSession(sessionId);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    try {
      const { net } = electronPkg;
      const url = `${RECORDING_CHUNK_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&chunkIndex=${chunkIndex}`;
      const req = net.request({ method: 'POST', url });
      req.setHeader('Content-Type', 'application/octet-stream');
      if (token) req.setHeader('Authorization', `Bearer ${token}`);
      timer = setTimeout(() => {
        try { req.abort(); } catch { /* already finished */ }
        settle('fail');
      }, UPLOAD_TIMEOUT_MS);
      req.on('response', (res) => {
        res.on('data', () => { });
        res.on('error', () => settle('fail'));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) settle('ok');
          else if (res.statusCode === 401) settle('unauthorized');
          else if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 408 && res.statusCode !== 429) settle('rejected');
          else settle('fail'); // 5xx / 408 / 429: server-wide, back off and retry in order
        });
      });
      req.on('error', () => settle('fail'));
      req.on('abort', () => settle('fail'));
      req.write(buffer);
      req.end();
    } catch { settle('fail'); }
  });
}

/** Re-queue every chunk on disk that has no `.ok` marker (oldest session first). */
async function _scanBacklog() {
  // The agent token is loaded after init; without it the server check (and any
  // upload) is impossible, so wait for it instead of queuing everything blind.
  while (!_getToken?.()) await _sleep(5000);
  const root = _recordingsDir();
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch { return; }

  const sessions = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const st = await fs.promises.stat(path.join(root, d.name));
      sessions.push({ name: d.name, mtimeMs: st.mtimeMs });
    } catch { /* skip */ }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let queued = 0;
  for (const s of sessions) {
    const dir = path.join(root, s.name);
    let files;
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    const names = new Set(files);
    const pending = [];
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        // Stale half-written file from a crash: it was never queued, drop it.
        try {
          const st = await fs.promises.stat(path.join(dir, f));
          if (Date.now() - st.mtimeMs > STALE_TMP_MS) await fs.promises.unlink(path.join(dir, f));
        } catch { /* ignore */ }
        continue;
      }
      const m = /^chunk-(\d+)\.webm$/.exec(f);
      if (m && !names.has(`${f}.ok`)) pending.push({ idx: Number(m[1]), file: f });
    }
    pending.sort((a, b) => a.idx - b.idx);
    if (!pending.length) continue;

    // Ask the server which of these it already holds, so a first run of this
    // version does not re-send days of chunks the old agent already uploaded.
    const check = await _checkWithServer(s.name, dir, pending);
    if (!check && !names.has('owner')) {
      // Folder from an older agent build (no owner file) and the server cannot
      // tell us what it already has (offline, or a backend without
      // /chunks/check). The old agent already uploaded most of these, so do not
      // blindly re-send days of video: keep them on disk (no .ok marker, never
      // deleted) and check again on the next start.
      logger.warn(`[Recorder] Backlog: ${pending.length} chunk(s) of legacy session ${s.name} deferred — server check unavailable`);
      continue;
    }
    if (check && check.owned === false) {
      // Recorded while another user was signed in on this PC: our token would be
      // refused. Kept on disk (no .ok marker, never deleted); retried next start.
      logger.warn(`[Recorder] Backlog: session ${s.name} belongs to another user — skipped (${pending.length} chunk(s) kept on disk)`);
      continue;
    }
    const have = new Set(check?.have ?? []);
    for (const p of pending) {
      const filePath = path.join(dir, p.file);
      if (have.has(p.idx)) {
        try { await fs.promises.writeFile(`${filePath}.ok`, ''); continue; } catch { /* fall through: upload it */ }
      }
      _enqueue({ sessionId: s.name, chunkIndex: p.idx, filePath });
      queued++;
    }
    if (have.size) logger.info(`[Recorder] Backlog: ${have.size} chunk(s) of ${s.name} already on server — marked uploaded`);
  }
  if (queued) logger.info(`[Recorder] Backlog: queued ${queued} unsynced chunk(s) for upload`);
}

/** sha256 of the first and last 64 KB — same as the server's chunkFingerprint(). */
async function _fingerprint(filePath) {
  const SPAN = 64 * 1024;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const h = crypto.createHash('sha256');
    const head = Buffer.alloc(Math.min(SPAN, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > SPAN) {
      const tailLen = Math.min(SPAN, size - SPAN);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
    return { size, fp: h.digest('hex') };
  } finally {
    await fh.close();
  }
}

/**
 * POST /recording/chunks/check for one session's backlog.
 * @returns {Promise<{owned:boolean, have:number[]}|null>} null when the check
 *   could not be made (offline, old server) — caller then uploads everything.
 */
async function _checkWithServer(sessionId, dir, pending) {
  const token = await _tokenForSession(sessionId);
  if (!token) return null;
  const chunks = [];
  for (const p of pending.slice(0, 2000)) {
    try { chunks.push({ index: p.idx, ...(await _fingerprint(path.join(dir, p.file))) }); } catch { /* unreadable: just upload */ }
  }
  if (!chunks.length) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { req.abort(); } catch { /* ignore */ } finish(null); }, 30_000);
    const { net } = electronPkg;
    const req = net.request({ method: 'POST', url: RECORDING_CHUNK_CHECK_ENDPOINT });
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', `Bearer ${token}`);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null);
        try {
          const data = JSON.parse(body);
          finish({ owned: data.owned !== false, have: Array.isArray(data.have) ? data.have : [] });
        } catch { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    req.write(JSON.stringify({ sessionId, chunks }));
    req.end();
  });
}

// ─── Local retention ──────────────────────
/**
 * Delete locally spooled chunks that are synced (.ok marker) and older than
 * the retention window, on startup and every few hours. The session currently
 * being recorded is never touched; unsynced chunks are never deleted.
 */
function _startRetentionSweep() {
  const sweep = () => {
    pruneOldRecordings(_recordingsDir(), { skipSessionId: _sessionId })
      .then(({ removedFiles, removedDirs }) => {
        if (removedFiles || removedDirs) {
          logger.info(
            `[Recorder] Retention: removed ${removedFiles} synced local file(s) and ${removedDirs} empty session folder(s) older than ${Math.round(RECORDING_RETENTION_MS / 86400000)} days`
          );
        }
      })
      .catch((err) => logger.warn(`[Recorder] Retention sweep failed: ${err.message}`));
  };
  sweep();
  const timer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// ─── Storage Helpers ──────────────────────
function _recordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
}

function _sessionDir(sid) {
  return path.join(_recordingsDir(), sid);
}

function _chunkPath(sid, idx) {
  return path.join(_sessionDir(sid), `chunk-${String(idx).padStart(5, '0')}.webm`);
}

const _ownerCache = new Map(); // sessionId → userId | null

/** Records the signed-in agent user as owner of a session folder (first writer wins). */
async function _writeOwner(sessionId) {
  try {
    const { getAgentUserId } = await import('./ws-client.js');
    const userId = getAgentUserId();
    if (!userId) return;
    await fs.promises.writeFile(path.join(_sessionDir(sessionId), 'owner'), String(userId), { flag: 'wx' });
    _ownerCache.set(sessionId, String(userId));
  } catch (err) {
    if (err.code !== 'EEXIST') logger.warn(`[Recorder] Could not record session owner: ${err.message}`);
  }
}

/** Token of the user who recorded this session; falls back to the current token. */
async function _tokenForSession(sessionId) {
  let owner = _ownerCache.get(sessionId);
  if (owner === undefined) {
    try { owner = (await fs.promises.readFile(path.join(_sessionDir(sessionId), 'owner'), 'utf8')).trim() || null; }
    catch { owner = null; } // folders from older builds have no owner file
    _ownerCache.set(sessionId, owner);
  }
  if (owner) {
    const { getAgentTokenFor } = await import('./ws-client.js');
    const t = getAgentTokenFor(owner);
    if (t) return t;
  }
  return _getToken?.();
}

/** max existing chunk index in the session folder + 1 (0 when none). */
async function _nextChunkIndex(sid) {
  let max = -1;
  try {
    for (const f of await fs.promises.readdir(_sessionDir(sid))) {
      const m = /^chunk-(\d+)\.webm(\.tmp|\.ok)?$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no folder yet */ }
  return max + 1;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
