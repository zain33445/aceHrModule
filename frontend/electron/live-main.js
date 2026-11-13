/**
 * live-main.js — Live view engine orchestrator (Main Process), docs/recording-v2.md §12.
 *
 * A second hidden BrowserWindow (live-renderer/) owns live view: its own
 * desktop capture and one RTCPeerConnection per stream. It is fully
 * independent of the recorder window — nothing here touches recording state.
 *
 * Server → agent (via ws-client): LIVE_START / LIVE_QUALITY / LIVE_SCREEN / LIVE_STOP / LIVE_SIGNAL
 * Agent → server (via sendWsMessage): LIVE_SIGNAL / LIVE_STATE
 */
import electronPkg from 'electron';
const { BrowserWindow, desktopCapturer, ipcMain, app, screen } = electronPkg;
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { sourceForDisplay, nativeCaptureSize } from './agent-policy.js';
import { getActiveDisplayId, getScreens, onActiveDisplay } from './screen-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _win = null;
let _winPromise = null;       // single in-flight window creation
let _inited = false;
let _shuttingDown = false;
let _count = 0;               // open peers, reported by the renderer
const _streams = new Map();   // streamId -> pinned screen (0 = follow the cursor) the server believes is live
const _countListeners = new Set();

function _send(msg) {
  import('./ws-client.js')
    .then(({ sendWsMessage }) => sendWsMessage(msg))
    .catch((err) => logger.error(`[Live] WS send failed: ${err.message}`));
}

function _setCount(n) {
  if (n === _count) return;
  _count = n;
  for (const fn of _countListeners) { try { fn(n); } catch { /* listener bug must not break live */ } }
}

export function initLiveMain() {
  if (_inited) return;
  _inited = true;

  ipcMain.on('live:signal-out', (_e, m) => {
    if (!m?.streamId || !_streams.has(m.streamId)) return;
    _send({ type: 'LIVE_SIGNAL', streamId: m.streamId, ...(m.description ? { description: m.description } : { candidate: m.candidate }) });
  });

  ipcMain.on('live:state', (_e, m) => {
    if (!m?.streamId) return;
    if (m.state === 'closed' || m.state === 'failed') _streams.delete(m.streamId);
    _send({ type: 'LIVE_STATE', streamId: m.streamId, state: m.state, ...(m.error ? { error: m.error } : {}) });
  });

  // Follow-mode streams move with the shared cursor watcher (also used by the recorder).
  onActiveDisplay(() => {
    for (const [streamId, screenNo] of _streams) if (!screenNo) _pushSource(streamId, 0);
  });

  ipcMain.on('live:count', (_e, n) => _setCount(Number(n) || 0));
  logger.info('[Live] Initialized');
}

export function getLiveViewerCount() { return _count; }

/** fn(count) is called whenever the number of open live peers changes. */
export function addLiveCountListener(fn) { _countListeners.add(fn); }

/** Capture source for a pinned screen (1..N); 0, missing or nonexistent = follow the cursor display. */
function _resolveSource(sources, screenNo) {
  const primaryId = screen.getPrimaryDisplay().id;
  const pinned = screenNo >= 1 ? getScreens().find((x) => x.screen === screenNo) : null;
  const src = sourceForDisplay(sources, pinned ? pinned.displayId : getActiveDisplayId(), primaryId);
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(src?.display_id));
  return { sourceId: src.id, ...nativeCaptureSize(display) }; // capture at the screen's own physical size (fixed)
}

async function _pushSource(streamId, screenNo) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources?.length ? _resolveSource(sources, screenNo) : null;
    if (src && _streams.has(streamId) && _streams.get(streamId) === screenNo && _windowAlive()) _win.webContents.send('live:source', { streamId, ...src });
  } catch (err) {
    logger.warn(`[Live] Screen switch failed for ${streamId}: ${err.message}`);
  }
}

function _windowAlive() { return !!_win && !_win.isDestroyed(); }

/** The window is gone: tell the server each stream ended (viewers resubscribe). */
function _onWindowLost(why) {
  const ids = [..._streams.keys()];
  _streams.clear();
  _win = null;
  _setCount(0);
  if (_shuttingDown) return;
  if (ids.length) logger.warn(`[Live] Engine lost (${why}) with ${ids.length} stream(s)`);
  for (const streamId of ids) _send({ type: 'LIVE_STATE', streamId, state: 'closed', error: 'live engine restarted' });
}

function _ensureWindow() {
  if (_windowAlive()) return Promise.resolve(_win);
  if (_winPromise) return _winPromise;

  _winPromise = (async () => {
    const htmlPath = app.isPackaged
      ? path.join(app.getAppPath(), 'electron', 'live-renderer', 'live.html')
      : path.join(__dirname, 'live-renderer', 'live.html');

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

    win.on('closed', () => { if (_win === win) _onWindowLost('window closed'); });
    win.webContents.on('render-process-gone', (_e, details) => {
      logger.error(`[Live] Renderer process gone: ${details?.reason}`);
      if (_win === win) {
        _onWindowLost(`render-process-gone ${details?.reason}`);
        if (!win.isDestroyed()) win.destroy(); // a dead window must not be reused
      }
    });

    _win = win; // published only once fully loaded
    logger.info('[Live] Hidden BrowserWindow created');
    return win;
  })().finally(() => { _winPromise = null; });

  return _winPromise;
}

/** Handles LIVE_START / LIVE_QUALITY / LIVE_STOP / LIVE_SIGNAL from the server. */
export async function handleLiveMessage(msg) {
  const streamId = msg?.streamId;
  if (!streamId) return;
  try {
    if (msg.type === 'LIVE_START') {
      const screenNo = Number.isInteger(msg.screen) && msg.screen > 0 ? msg.screen : 0;
      _streams.set(streamId, screenNo);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources?.length) throw new Error('No screen sources found');
      const win = await _ensureWindow();
      if (!_streams.has(streamId)) return; // stopped while the window was starting
      win.webContents.send('live:start', { streamId, quality: msg.quality, iceServers: msg.iceServers || [], ..._resolveSource(sources, screenNo) }); // A14: primary display fallback
      return;
    }
    if (msg.type === 'LIVE_SCREEN') {
      if (!_streams.has(streamId)) return;
      const screenNo = Number.isInteger(msg.screen) && msg.screen > 0 ? msg.screen : 0;
      _streams.set(streamId, screenNo);
      await _pushSource(streamId, screenNo);
      return;
    }
    if (msg.type === 'LIVE_STOP') _streams.delete(streamId);
    if (!_windowAlive()) return; // nothing running: stop/quality/signal have no target
    const channel = { LIVE_QUALITY: 'live:quality', LIVE_STOP: 'live:stop', LIVE_SIGNAL: 'live:signal' }[msg.type];
    if (!channel) return;
    const { type: _t, ...payload } = msg;
    _win.webContents.send(channel, payload);
  } catch (err) {
    logger.error(`[Live] ${msg.type} failed: ${err.message}`);
    if (msg.type === 'LIVE_START') {
      _streams.delete(streamId);
      _send({ type: 'LIVE_STATE', streamId, state: 'failed', error: err.message });
    }
  }
}

/**
 * Socket gone: the server ends the streams on its side, so close the peers
 * locally without reporting (nobody to hear it). Viewers resubscribe.
 */
export function closeAllLive() {
  _streams.clear();
  if (!_windowAlive()) return;
  try { _win.webContents.send('live:stop-all'); } catch { /* window going away */ }
}

export function shutdownLive() {
  _shuttingDown = true;
  _streams.clear();
  if (_windowAlive()) { try { _win.destroy(); } catch { /* ignore */ } }
  _win = null;
}
