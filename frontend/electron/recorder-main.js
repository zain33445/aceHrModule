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
import { RECORDING_CHUNK_ENDPOINT, CHUNK_RETRY_CONFIG, DEFAULT_QUALITY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _recorderWindow = null;
let _state = 'idle'; // idle | starting | recording | stopping
let _sessionId = null;
let _uploadQueue = [];
let _isUploading = false;
let _onStateChange = null;
let _getToken = null;
let _listenersReady = false;

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
    _state = state === 'recording' ? 'recording' : 'idle';
    if (_onStateChange) _onStateChange(state, sessionId);
  });

  ipcMain.on('recording:error', (_e, { code, message }) => {
    logger.error(`[Recorder] Error [${code}]: ${message}`);
    _state = 'idle';
    if (_onStateChange) _onStateChange('error', _sessionId);
  });

  ipcMain.on('recording:webrtc-out', (_e, msg) => {
    import('./ws-client.js').then(({ sendWsMessage }) => {
      sendWsMessage(msg);
    }).catch(err => logger.error(`[Recorder] WebRTC WS send error: ${err.message}`));
  });

  logger.info('[Recorder Main] Initialized');
}

// ─── Public API ───────────────────────────
export async function startRecording(sessionId, quality = DEFAULT_QUALITY) {
  if (_state === 'recording') {
    logger.warn(`[Recorder] Already recording ${_sessionId}`);
    return false;
  }
  try {
    _sessionId = sessionId;
    _state = 'starting';
    _ensureSessionDir(sessionId);

    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources?.length) throw new Error('No screen sources found');

    const win = await _ensureWindow();
    win.webContents.send('recording:start', {
      sessionId,
      sourceId: sources[0].id,
      quality,
    });
    logger.info(`[Recorder] Start sent to renderer — session ${sessionId}`);
    return true;
  } catch (err) {
    logger.error(`[Recorder] Start failed: ${err.message}`);
    _state = 'idle';
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
