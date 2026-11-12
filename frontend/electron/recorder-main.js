/**
 * recorder-main.js — Recording Orchestrator (Main Process), recording v2
 *
 * Always-on, agent-driven recording (docs/recording-v2.md §8):
 *  - records while the current agent user's cached `record` flag is true;
 *  - one segment = one MediaRecorder run; new segment on start, every 60 min,
 *    at the recording-day boundary, on user switch, on watchdog restart and on
 *    capture source change;
 *  - every chunk is written durably (tmp → fsync → rename) into
 *    <userData>/recordings/v2/<userId>/<segmentId>/ BEFORE anything else, and
 *    is never overwritten or deleted until the server confirmed it (sync-v2.js);
 *  - folders directly under <userData>/recordings/<sessionId>/ are legacy
 *    (Phase 0 / older builds): they keep the old upload path below, untouched.
 */
import electronPkg from 'electron';
const { BrowserWindow, desktopCapturer, ipcMain, app, screen } = electronPkg;
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import {
  RECORDING_CHUNK_ENDPOINT, RECORDING_CHUNK_CHECK_ENDPOINT,
  RECORDING_FPS, RECORDING_PRESETS, RECORDING_TIMESLICE_MS,
  RECORDING_SEGMENT_MAX_MS, RECORDING_WATCHDOG_MS, RECORDING_RESTART_BACKOFF_CAP_MS,
  RECORDING_DISK_LOW_BYTES, RECORDING_DISK_RESUME_BYTES,
} from './config.js';
import { pruneOldRecordings, pruneV2Spool, RECORDING_RETENTION_MS, V2_SWEEP_INTERVAL_MS } from './local-retention.js';
import { recordingDateFor, nextBoundaryInstant, normalizeRule } from './recording-day.js';
import * as spool from './spool-v2.js';
import { initSyncV2, kickSync, getBacklog } from './sync-v2.js';
import { pickPrimarySource, serverNow } from './agent-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── legacy upload constants ──
const UPLOAD_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;
const STALE_TMP_MS = 60 * 60 * 1000;
const PARKED_RETRY_MS = 30 * 60 * 1000;
const _parked = []; // legacy chunks the server refused (4xx); retried every 30 min
let _uploadQueue = []; // [{ sessionId, chunkIndex, filePath }]
const _queuedPaths = new Set(); // file paths currently in _uploadQueue
let _isUploading = false;

// ── v2 state ──
let _state = 'idle'; // idle | starting | recording | stopping | permission_denied | disk_low | write_error | error
let _recorderWindow = null;
let _windowPromise = null; // single in-flight window creation
let _onStateChange = null;
let _getToken = null;
let _listenersReady = false;
let _warmupDone = false;

let _userId = null;       // agent user (owner of new segments)
let _record = false;      // cached `record` flag of that user
let _rule = null;         // cached recordingDay rule
let _loggedIn = false;    // renderer reported a signed-in user
let _seg = null;          // segment being recorded: { segmentId, userId, dir, startedAt, ... }
const _known = new Map();   // segmentId → meta, until closed on disk
const _closing = new Map(); // segmentId → meta, asked to stop (rotation)
const _waiters = new Map(); // segmentId → [resolve] waiting for 'segment-stopped'
const _pendingWrites = new Map(); // segmentId → Set<Promise>
let _intentionalStop = false;
let _quitting = false;
let _lastChunkAt = 0;
let _chunksInSeg = 0;
let _rotateAt = Infinity;
let _sourceId = null;
let _diskLow = false;
let _diskLowFromWrite = false; // _diskLow was raised by an ENOSPC chunk write, not by statfs (A1)
let _writeBlocked = null; // null | 'disk_low' | 'write_error': unwritten chunk bytes hit the cap, capture paused (A1)
let _clockOffset = 0;     // serverTime - local clock, from the last CONNECTED (A12)
let _diskFree = null;
let _statfsUnavailable = false;
let _restartTimer = null;
let _restartDelay = 0;
let _tickCount = 0;
let _ready = Promise.resolve(); // boot recovery of segments left open by a crash
let _chain = Promise.resolve();
let _reconcileQueued = false;
const _statusListeners = new Set();

// ─── Init ─────────────────────────────────
export function initRecorderMain(getToken, onStateChange) {
  _getToken = getToken;
  _onStateChange = onStateChange;
  if (_listenersReady) return;
  _listenersReady = true;

  initSyncV2({
    root: _v2Root(),
    // A3: only the segment owner's own token, never another user's.
    tokenFor: async (userId) => (await import('./ws-client.js')).getAgentTokenFor(userId),
    refresh: async (userId) => (await import('./ws-client.js')).refreshAgentToken(userId),
    log: logger,
  });
  _ready = spool.recoverOpenSegments(_v2Root())
    .then((n) => { if (n) logger.info(`[Recorder] Closed ${n} segment(s) left open by the previous run`); })
    .catch((err) => logger.error(`[Recorder] Segment recovery failed: ${err.message}`));

  _startRetentionSweep();
  _scanBacklog().catch((err) => logger.error(`[Recorder] Backlog scan failed: ${err.message}`));
  const parkedTimer = setInterval(() => {
    // _enqueue re-adds them (the path left _queuedPaths when it was parked).
    for (const item of _parked.splice(0)) _enqueue(item);
  }, PARKED_RETRY_MS);
  if (typeof parkedTimer.unref === 'function') parkedTimer.unref();

  const tick = setInterval(_tick, 10_000);
  if (typeof tick.unref === 'function') tick.unref();

  ipcMain.on('recording:chunk', (_e, msg) => _onChunk(msg || {}));

  ipcMain.on('recording:segment-started', (_e, { segmentId, mime, width, height } = {}) => {
    const meta = _known.get(segmentId);
    if (!meta) return;
    Object.assign(meta, { mime, width, height });
    spool.updateSegment(meta.dir, { mime, width, height })
      .catch((err) => logger.warn(`[Recorder] segment.json update failed: ${err.message}`));
    logger.info(`[Recorder] Segment ${segmentId} recording (${mime} ${width}x${height})`);
    if (_seg?.segmentId === segmentId) _setState('recording');
    _emitStatus();
  });

  ipcMain.on('recording:segment-stopped', (_e, { segmentId, lastSeq } = {}) => {
    _onSegmentStopped(segmentId, lastSeq).catch((err) => logger.error(`[Recorder] Segment close failed: ${err.message}`));
  });

  ipcMain.on('recording:capture-lost', (_e, { reason } = {}) => {
    logger.warn(`[Recorder] Capture lost: ${reason}`);
    _scheduleRestart(`capture lost (${reason})`, { graceful: true });
  });

  ipcMain.on('recording:error', (_e, { code, message, segmentId } = {}) => {
    logger.error(`[Recorder] Error [${code}]: ${message} (segment: ${segmentId})`);
    if (segmentId && _seg && segmentId !== _seg.segmentId) return; // an old segment's error
    if (code === 'PERMISSION_DENIED') _setState('permission_denied');
    // Forward to backend so the admin dashboard can see it (employee never sees this)
    _forwardErrorToGateway({ type: 'ERROR', code: code || 'START_FAILED', message: message || 'Recording failed' });
    _scheduleRestart(`${code || 'error'}: ${message}`, { graceful: true });
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

  _checkDisk();
  logger.info('[Recorder Main] Initialized (recording v2)');
}

function _forwardErrorToGateway(msg) {
  import('./ws-client.js').then(({ sendWsMessage }) => {
    sendWsMessage(msg);
  }).catch(err => logger.error(`[Recorder] Gateway error forward failed: ${err.message}`));
}

// ─── Policy / status API (called by ws-client / main.js) ───
/**
 * Who records and under which recording-day rule. Called from the cache at
 * boot, on user switch and on every protocol-2 CONNECTED.
 */
export function setRecordPolicy({ userId, record, recordingDay, clockOffsetMs }) {
  _userId = userId != null ? String(userId) : null;
  _record = !!record;
  _rule = normalizeRule(recordingDay);
  if (Number.isFinite(clockOffsetMs)) _clockOffset = clockOffsetMs;
  if (_seg) _rotateAt = _computeRotateAt(_seg);
  _requestReconcile('policy');
}

export function setLoggedIn(loggedIn) {
  const v = !!loggedIn;
  if (v === _loggedIn) return;
  _loggedIn = v;
  logger.info(`[Recorder] Logged-in flag → ${v}`);
  _emitStatus();
}

export function addStatusListener(fn) { _statusListeners.add(fn); }

export function getRecorderStatus() {
  const b = getBacklog();
  return {
    state: _state,
    segmentId: _seg?.segmentId ?? null,
    sessionId: _currentSessionId(),
    loggedIn: _loggedIn,
    backlogChunks: b.chunks,
    backlogBytes: b.bytes,
    diskFreeBytes: _diskFree,
  };
}

export function getRecordingState() {
  return { state: _state, sessionId: _currentSessionId(), segmentId: _seg?.segmentId ?? null };
}

function _currentSessionId() {
  return _seg ? spool.readRegisteredSessionSync(_seg.dir) : null;
}

function _emitStatus() {
  for (const fn of _statusListeners) { try { fn(); } catch { /* listener bug must not break recording */ } }
}

function _setState(s) {
  if (_state === s) return;
  _state = s;
  logger.info(`[Recorder] State → ${s}`);
  if (_onStateChange) { try { _onStateChange(s, _currentSessionId()); } catch { /* UI gone */ } }
  _emitStatus();
}

// ─── Preflight warm-up (no UI) ────────────
/**
 * Silently exercises desktopCapturer + a short getUserMedia capture inside
 * the hidden recorder window so any one-time OS/Chromium grant happens at
 * idle time.
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
    win.webContents.send('recording:warmup', { sourceId: _primarySource(sources).id });
    return true;
  } catch (err) {
    logger.warn(`[Recorder] Warm-up failed: ${err.message}`);
    return false;
  }
}

// ─── Legacy entry points ──────────────────
/** Recording v2 is agent-driven: server/scheduler start requests are ignored. */
export async function startRecording() {
  logger.warn('[Recorder] startRecording() ignored — recording v2 is agent-driven');
  return false;
}

export function stopRecording() {
  if (!_seg) return false;
  _serial(() => _stopSegment('stopRecording()'));
  return true;
}

/**
 * Stop the recorder and wait until the final chunk is on disk and the segment
 * is closed (or the timeout elapses). Used before app quit.
 */
export function flushAndStop(timeoutMs = 4000) {
  _quitting = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const stop = _serial(() => _stopSegment('quit', { timeoutMs: Math.max(500, timeoutMs - 500) }));
  return Promise.race([stop, _sleep(timeoutMs)])
    .then(() => Promise.race([Promise.allSettled(_allPending()), _sleep(1500)])) // a failing disk retries forever: bounded
    .then(() => {});
}

export async function handleWebRtcMessage(msg) {
  try {
    const win = await _ensureWindow();
    win.webContents.send('recording:webrtc-in', msg);
  } catch (err) {
    logger.error(`[Recorder] Failed to forward WebRTC message to renderer: ${err.message}`);
  }
}

// ─── Control loop ─────────────────────────
const _wantRecording = () => !_quitting && !!_userId && _record && !_diskLow && !_writeBlocked;
const _idleState = () => (_diskLow ? 'disk_low' : (_writeBlocked ?? 'idle'));
/** Capture source of the primary display (A14). */
const _primarySource = (sources) => pickPrimarySource(sources, screen.getPrimaryDisplay().id);

function _serial(fn) {
  const p = _chain.then(fn).catch((err) => logger.error(`[Recorder] Control step failed: ${err.message}`));
  _chain = p;
  return p;
}

function _requestReconcile(reason) {
  if (_reconcileQueued) return;
  _reconcileQueued = true;
  _serial(async () => {
    _reconcileQueued = false;
    await _ready;
    await _reconcileNow(reason);
  });
}

async function _reconcileNow(reason) {
  if (_wantRecording()) {
    if (!_seg) {
      if (!_restartTimer && _state !== 'stopping') await _beginSegment(reason, { newCapture: true });
    } else if (_seg.userId !== _userId) {
      await _beginSegment('user switch'); // same capture, new segment owned by the new user
    }
    return;
  }
  if (_seg || _closing.size) await _stopSegment(reason);
  if (!_quitting) _setState(_idleState());
}

const _serverNow = () => serverNow(_clockOffset);
const _computeRotateAt = (seg) => {
  const t = Date.parse(seg.startedAt);
  return Math.min(t + RECORDING_SEGMENT_MAX_MS, nextBoundaryInstant(t, _rule));
};

/** Start a new segment. With a segment already running this is a rotation (same stream). */
async function _beginSegment(reason, { newCapture = false } = {}) {
  await _ready;
  if (!_wantRecording()) return;
  try {
    if (!_seg) _setState('starting');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources?.length) throw new Error('No screen sources found');
    const win = await _ensureWindow();
    const { getDeviceId, resolveRecordingQuality } = await import('./ws-client.js');

    const startedAt = new Date(serverNow(_clockOffset)); // A12: server-corrected, the recording day follows server time
    const segmentId = crypto.randomUUID();
    const info = {
      segmentId,
      userId: _userId,
      recordingDate: recordingDateFor(startedAt, _rule),
      startedAt: startedAt.toISOString(),
      mime: null, width: null, height: null,
      deviceId: getDeviceId(),
    };
    const dir = spool.segmentDir(_v2Root(), _userId, segmentId);
    await spool.createSegment(dir, info);
    const meta = { ...info, dir };

    const prev = _seg;
    _known.set(segmentId, meta);
    if (prev) _closing.set(prev.segmentId, prev);
    _seg = meta;
    _chunksInSeg = 0;
    _lastChunkAt = Date.now(); // watchdog clock restarts with the segment
    _rotateAt = _computeRotateAt(meta);
    _sourceId = _primarySource(sources).id;

    win.webContents.send('recording:begin', {
      segmentId,
      sourceId: _sourceId,
      newCapture,
      timesliceMs: RECORDING_TIMESLICE_MS,
      maxFps: RECORDING_FPS,
      ...RECORDING_PRESETS[resolveRecordingQuality(_userId, info.recordingDate)],
    });
    logger.info(`[Recorder] New segment ${segmentId} (${reason}) user ${_userId} day ${info.recordingDate}${prev ? `, previous ${prev.segmentId} stopping` : ''}`);
    _emitStatus();
  } catch (err) {
    logger.error(`[Recorder] Begin segment failed (${reason}): ${err.message}`);
    _setState('error');
    _scheduleRestart(`begin failed: ${err.message}`);
  }
}

/** Ask the renderer to stop, wait for the final chunks, close the segment(s). */
async function _stopSegment(reason, { timeoutMs = 5000 } = {}) {
  const segs = [...(_seg ? [_seg] : []), ..._closing.values()];
  logger.info(`[Recorder] Stopping (${reason}), ${segs.length} segment(s)`);
  if (segs.length) _setState('stopping');
  _intentionalStop = true;
  try {
    const win = _recorderWindow && !_recorderWindow.isDestroyed() ? _recorderWindow : null;
    if (win) {
      const waits = segs.map((s) => _waitStopped(s.segmentId, timeoutMs));
      win.webContents.send('recording:stop', { release: true });
      await Promise.all(waits);
    }
    for (const s of segs) if (_known.has(s.segmentId)) await _closeFromDisk(s); // renderer silent: close what is on disk
  } finally {
    _seg = null;
    _closing.clear();
    _rotateAt = Infinity;
    _intentionalStop = false;
  }
  if (!_quitting) _setState(_idleState());
}

function _waitStopped(segmentId, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const list = _waiters.get(segmentId) || [];
    list.push(() => { clearTimeout(t); resolve(true); });
    _waiters.set(segmentId, list);
  });
}

/** Wait for a segment's in-flight chunk writes, but never forever: a failing disk retries indefinitely (A1). */
const _awaitWrites = (segmentId, ms = 10_000) => Promise.race([
  Promise.allSettled([...(_pendingWrites.get(segmentId) || [])]),
  _sleep(ms),
]);

async function _closeFromDisk(meta) {
  await _awaitWrites(meta.segmentId);
  try { await spool.closeSegment(meta.dir); } catch (err) { logger.error(`[Recorder] closeSegment failed: ${err.message}`); }
  _known.delete(meta.segmentId);
  _pendingWrites.delete(meta.segmentId);
  kickSync();
}

async function _onSegmentStopped(segmentId, lastSeq) {
  const meta = _known.get(segmentId);
  if (meta) {
    await _awaitWrites(segmentId); // last chunk durable first (late ones still raise lastSeq, A2)
    try { await spool.closeSegment(meta.dir, lastSeq); } catch (err) { logger.error(`[Recorder] closeSegment failed: ${err.message}`); }
    _known.delete(segmentId);
    _pendingWrites.delete(segmentId);
    logger.info(`[Recorder] Segment ${segmentId} closed (lastSeq ${lastSeq})`);
  }
  _closing.delete(segmentId);
  for (const done of _waiters.get(segmentId) || []) done();
  _waiters.delete(segmentId);
  if (_seg?.segmentId === segmentId) {
    _seg = null;
    if (!_intentionalStop) _scheduleRestart('recorder stopped unexpectedly');
  }
  kickSync();
}

// ─── Chunk handling ───────────────────────
function _allPending() {
  return [..._pendingWrites.values()].flatMap((s) => [...s]);
}

/** Unwritten chunk bytes at the cap -> pause capture; drained -> resume. Bytes are never dropped (A1). */
function _checkWriteBackpressure() {
  const pending = spool.pendingBytes();
  if (!_writeBlocked && pending >= spool.PENDING_CAP_BYTES) {
    _writeBlocked = spool.lastWriteError()?.code === 'ENOSPC' ? 'disk_low' : 'write_error';
    logger.error(`[Recorder] ${Math.round(pending / 1048576)} MB of chunks cannot be written — capture paused (${_writeBlocked})`);
    _requestReconcile('write backlog');
  } else if (_writeBlocked && pending === 0) {
    _writeBlocked = null;
    logger.info('[Recorder] Pending chunk writes drained — resuming recording');
    _requestReconcile('write backlog drained');
  }
}

/** Write durably (tmp, fsync, rename) as soon as the renderer hands it over; retried until it succeeds. */
function _onChunk({ segmentId, seq, capturedAt, durationMs, buffer }) {
  if (!buffer || !buffer.byteLength) return;
  _lastChunkAt = Date.now(); // liveness = chunks RECEIVED from the renderer, not written (A1)
  if (_seg?.segmentId === segmentId) {
    _chunksInSeg++;
    if (_chunksInSeg >= 2) _restartDelay = 0; // healthy again
  }
  const loggedOut = !_loggedIn;
  const data = Buffer.from(buffer);
  const set = _pendingWrites.get(segmentId) || new Set();
  _pendingWrites.set(segmentId, set);
  const p = (async () => {
    // A2: a segment no longer in memory (already closed) is found on disk and written into its own folder.
    let dir = _known.get(segmentId)?.dir ?? await spool.findSegmentDir(_v2Root(), segmentId);
    if (!dir) { // folder gone: a bare folder is rebuilt by the sync worker (A6)
      dir = spool.segmentDir(_v2Root(), _userId ?? '_', segmentId);
      logger.error(`[Recorder] Chunk for unknown segment ${segmentId} — written to ${dir}`);
    }
    const r = await spool.writeChunkReliable(dir, seq, data, { capturedAt, durationMs, loggedOut }, {
      onError: (err) => logger.error(`[Recorder] Chunk write failed (${segmentId}/${seq}): ${err.message} — will retry`),
      onDiskLow: () => { if (!_diskLow) { _diskLow = true; _diskLowFromWrite = true; logger.warn('[Recorder] Disk full (ENOSPC) — recording paused (disk_low)'); _requestReconcile('disk full'); } },
      onRecovered: () => { if (_diskLowFromWrite) { _diskLow = false; _diskLowFromWrite = false; logger.info('[Recorder] Chunk writes succeed again — resuming'); _requestReconcile('disk recovered'); } },
    });
    logger.info(`[Recorder] Chunk ${segmentId.slice(0, 8)}/${r.seq} → disk (${Math.round(r.bytes / 1024)}KB)${r.moved ? ` [seq ${seq} was taken]` : ''}`);
    kickSync();
  })()
    .catch((err) => logger.error(`[Recorder] Chunk lost (${segmentId}/${seq}): ${err.message}`))
    .finally(() => { set.delete(p); _checkWriteBackpressure(); });
  set.add(p);
  _checkWriteBackpressure();
}

// ─── Watchdog / restarts ──────────────────
function _scheduleRestart(reason, { graceful = false } = {}) {
  if (_restartTimer || _quitting || !_wantRecording()) return;
  const delay = _restartDelay;
  _restartDelay = Math.min(RECORDING_RESTART_BACKOFF_CAP_MS, Math.max(10_000, delay * 2));
  logger.warn(`[Recorder] Restart in ${Math.round(delay / 1000)}s — ${reason}`);
  if (_state === 'recording') _setState('starting');
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    _serial(() => _restartNow(reason, graceful));
  }, delay);
}

async function _restartNow(reason, graceful) {
  logger.warn(`[Recorder] RESTART (${reason})`);
  if (graceful && _recorderWindow && !_recorderWindow.isDestroyed()) {
    await _stopSegment(reason, { timeoutMs: 3000 });
  } else {
    // Renderer is hung or gone: close what is on disk, then rebuild the window.
    const segs = [...(_seg ? [_seg] : []), ..._closing.values()];
    _seg = null;
    _closing.clear();
    _destroyWindow();
    for (const s of segs) if (_known.has(s.segmentId)) await _closeFromDisk(s);
  }
  if (_wantRecording()) await _beginSegment(reason, { newCapture: true });
}

function _tick() {
  if (_quitting) return;
  _tickCount++;
  const now = Date.now();
  if (_seg && _state !== 'stopping') {
    if (now - _lastChunkAt > RECORDING_WATCHDOG_MS) {
      _scheduleRestart(`no chunk for ${Math.round(RECORDING_WATCHDOG_MS / 1000)}s`);
    } else if (_serverNow() >= _rotateAt) {
      _rotateAt = Infinity; // _beginSegment sets the next one
      _serial(() => _beginSegment('rotate'));
    }
  } else if (_wantRecording() && !_seg && !_restartTimer && _state !== 'stopping') {
    _requestReconcile('self-heal');
  }
  _checkWriteBackpressure();
  if (_tickCount % 6 === 0) {
    _checkDisk();
    _checkSource();
  }
}

/** Capture source vanished (display changed): start a new segment on a fresh capture. */
async function _checkSource() {
  if (!_seg || _state !== 'recording' || !_sourceId) return;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (sources?.length && !sources.some((s) => s.id === _sourceId)) {
      _scheduleRestart(`capture source ${_sourceId} is gone`, { graceful: true });
    }
  } catch (err) {
    logger.warn(`[Recorder] Source check failed: ${err.message}`);
  }
}

async function _checkDisk() {
  if (_statfsUnavailable) return;
  try {
    const st = await fs.promises.statfs(app.getPath('userData'));
    const free = Number(st.bavail) * Number(st.bsize);
    _diskFree = free;
    if (!_diskLow && free < RECORDING_DISK_LOW_BYTES) {
      _diskLow = true;
      logger.warn(`[Recorder] Free disk ${Math.round(free / 1048576)} MB < 2 GB — recording paused (disk_low)`);
      _requestReconcile('disk low');
    } else if (_diskLow && free >= RECORDING_DISK_RESUME_BYTES) {
      _diskLow = false;
      logger.info('[Recorder] Disk space recovered — resuming recording');
      _requestReconcile('disk recovered');
    }
  } catch (err) {
    _statfsUnavailable = true;
    logger.warn(`[Recorder] fs.statfs unavailable (${err.message}) — low-disk pause disabled`);
  }
}

// ─── Hidden BrowserWindow ─────────────────
function _windowAlive() {
  return !!_recorderWindow && !_recorderWindow.isDestroyed();
}

function _destroyWindow() {
  const w = _recorderWindow;
  _recorderWindow = null;
  if (w && !w.isDestroyed()) {
    w._aceIntentional = true; // its 'closed' event must not trigger another restart
    try { w.destroy(); } catch { /* already gone */ }
  }
}

function _ensureWindow() {
  if (_windowAlive()) return Promise.resolve(_recorderWindow);
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
      if (_recorderWindow === win) _recorderWindow = null;
      if (win._aceIntentional) return;
      logger.warn('[Recorder] Hidden window closed unexpectedly');
      _scheduleRestart('recorder window closed');
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      logger.error(`[Recorder] Renderer process gone: ${details?.reason}`);
      if (_recorderWindow === win) _destroyWindow(); // a dead window must not be reused
      _scheduleRestart(`render-process-gone (${details?.reason})`);
    });

    _recorderWindow = win; // published only once fully loaded
    logger.info('[Recorder] Hidden BrowserWindow created');
    return win;
  })().finally(() => { _windowPromise = null; });

  return _windowPromise;
}

// ─── Legacy chunk upload (folders written by Phase 0 / older builds) ───
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
    if (!d.isDirectory() || d.name === 'v2') continue; // v2 spool is handled by sync-v2.js
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
 * Every 10 minutes (and at start): delete synced local data past its
 * retention. Legacy folders: .ok-marked chunks older than 15 days. v2 spool:
 * fully synced + closed segments older than 15 days, or oldest first beyond
 * the 30 GB cap. Unsynced data is never deleted. Also re-checks free disk.
 */
function _startRetentionSweep() {
  const sweep = async () => {
    try {
      const { removedFiles, removedDirs } = await pruneOldRecordings(_recordingsDir());
      if (removedFiles || removedDirs) {
        logger.info(
          `[Recorder] Retention: removed ${removedFiles} synced legacy file(s) and ${removedDirs} empty session folder(s) older than ${Math.round(RECORDING_RETENTION_MS / 86400000)} days`
        );
      }
    } catch (err) { logger.warn(`[Recorder] Legacy retention sweep failed: ${err.message}`); }
    try {
      const r = await pruneV2Spool(_v2Root(), { skipSegmentIds: new Set(_known.keys()) });
      if (r.removedSegments) {
        logger.info(`[Recorder] Retention: removed ${r.removedSegments} fully synced v2 segment(s) (${Math.round(r.removedBytes / 1048576)} MB)`);
      }
    } catch (err) { logger.warn(`[Recorder] v2 retention sweep failed: ${err.message}`); }
    _checkDisk();
  };
  sweep();
  const timer = setInterval(sweep, V2_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// ─── Storage Helpers ──────────────────────
function _recordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
}

function _v2Root() {
  return spool.v2Root(_recordingsDir());
}

function _sessionDir(sid) {
  return path.join(_recordingsDir(), sid);
}

const _ownerCache = new Map(); // legacy sessionId → userId | null

/** Token of the user who recorded this legacy session; falls back to the current token. */
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

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
