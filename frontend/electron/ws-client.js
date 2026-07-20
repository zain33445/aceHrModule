/**
 * ws-client.js — WebSocket Client (Main Process)
 *
 * Maintains a persistent connection to the backend WebSocket gateway.
 * Uses Electron's built-in net.WebSocket (available since Electron 20+).
 * Handles: token auth, reconnect, command dispatch, and status reporting.
 */
import electronPkg from 'electron';
const { net, app } = electronPkg;
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { WS_ENDPOINT, AGENT_AUTH_ENDPOINT, AGENT_TOKEN_FILE } from './config.js';
import { startRecording, stopRecording, getRecordingState, handleWebRtcMessage } from './recorder-main.js';
import { applySchedules } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── State ────────────────────────────────
let _ws = null;
let _reconnectTimer = null;
let _reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60_000;
let _currentUserId = null;
let _agentToken = null;
let _isShuttingDown = false;

// ─── Token Storage ────────────────────────
function _tokenPath() {
  return path.join(app.getPath('userData'), AGENT_TOKEN_FILE);
}

function _loadToken() {
  try {
    const p = _tokenPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).token ?? null;
  } catch {}
  return null;
}

function _saveToken(token) {
  try { fs.writeFileSync(_tokenPath(), JSON.stringify({ token, savedAt: new Date().toISOString() })); }
  catch (err) { logger.error(`[WS Client] Token save failed: ${err.message}`); }
}

/** Returns the current agent JWT (injected into recorder-main) */
export function getAgentToken() { return _agentToken; }

// ─── Agent Auth ───────────────────────────
async function _fetchAgentToken(userId) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'POST', url: AGENT_AUTH_ENDPOINT });
      req.setHeader('Content-Type', 'application/json');
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.token ?? null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(JSON.stringify({ user_id: userId }));
      req.end();
    } catch { resolve(null); }
  });
}

// ─── Public Init ──────────────────────────
export async function initWsClient(userId) {
  _currentUserId = userId;
  _isShuttingDown = false;

  // Load cached token or fetch a new one
  _agentToken = _loadToken();
  if (!_agentToken && userId) {
    logger.info('[WS Client] No cached token — fetching from backend...');
    _agentToken = await _fetchAgentToken(userId);
    if (_agentToken) { _saveToken(_agentToken); logger.info('[WS Client] Agent token obtained and saved'); }
    else logger.warn('[WS Client] Could not obtain agent token — WS will connect unauthenticated');
  }

  _connect();
}

export function setWsUserId(userId) {
  if (userId === _currentUserId) return;
  _currentUserId = userId;
  // Refresh token for new user
  _fetchAgentToken(userId).then((token) => {
    if (token) { _agentToken = token; _saveToken(token); }
    _reconnect();
  });
}

export function shutdownWsClient() {
  _isShuttingDown = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  logger.info('[WS Client] Shut down');
}

// ─── Connection ───────────────────────────
function _connect() {
  if (_isShuttingDown) return;
  if (!_agentToken && !_currentUserId) {
    logger.info('[WS Client] No token or userId — waiting for login before connecting');
    return;
  }

  logger.info(`[WS Client] Connecting to ${WS_ENDPOINT}...`);

  try {
    _ws = new WebSocket(WS_ENDPOINT);

    _ws.addEventListener('open', () => {
      logger.info('[WS Client] Connected to recording gateway');
      _reconnectDelay = 5000; // reset backoff

      if (_agentToken) {
        sendWsMessage({ type: 'AUTH', token: _agentToken });
      }
    });

    _ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        _handleMessage(msg);
      } catch (err) {
        logger.error(`[WS Client] Bad message: ${err.message}`);
      }
    });

    _ws.addEventListener('close', (event) => {
      logger.warn(`[WS Client] Disconnected (${event.code}). Reconnecting in ${_reconnectDelay / 1000}s...`);
      _ws = null;
      if (!_isShuttingDown) _scheduleReconnect();
    });

    _ws.addEventListener('error', (event) => {
      logger.error(`[WS Client] Socket error occurred`);
    });
  } catch (err) {
    logger.error(`[WS Client] Connect failed: ${err.message}`);
    _scheduleReconnect();
  }

}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
    _connect();
  }, _reconnectDelay);
}

function _reconnect() {
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  _connect();
}

// ─── Message Handling ─────────────────────
function _handleMessage(msg) {
  logger.info(`[WS Client] ← ${msg.type}`);

  switch (msg.type) {
    case 'START_RECORDING':
      startRecording(msg.sessionId, msg.quality || '720p').then((ok) => {
        _sendStatus(ok ? 'recording' : 'error');
      });
      break;

    case 'STOP_RECORDING':
      stopRecording();
      _sendStatus('stopping');
      break;

    case 'SCHEDULE':
      if (Array.isArray(msg.schedules)) applySchedules(msg.schedules);
      break;

    case 'STATUS_REQUEST':
      _sendStatus();
      break;

    case 'WEBRTC_OFFER':
    case 'WEBRTC_ICE_CANDIDATE':
      handleWebRtcMessage(msg);
      break;

    case 'CHUNK_ACK':
      logger.info(`[WS Client] Chunk ${msg.chunkIndex} acknowledged for session ${msg.sessionId}`);
      break;

    case 'PING':
      sendWsMessage({ type: 'PONG' });
      break;

    case 'CONNECTED':
      logger.info('[WS Client] Gateway acknowledged connection');
      // Now that we're authenticated, send initial status
      _sendStatus();
      break;

    case 'AUTH_REQUIRED':
      logger.info('[WS Client] Gateway requires authentication');
      if (_agentToken) {
        sendWsMessage({ type: 'AUTH', token: _agentToken });
      } else if (_currentUserId) {
        _fetchAgentToken(_currentUserId).then((token) => {
          if (token) {
            _agentToken = token;
            _saveToken(token);
            sendWsMessage({ type: 'AUTH', token });
          } else {
            logger.error('[WS Client] Cannot authenticate — no agent token');
          }
        });
      }
      break;

    default:
      logger.warn(`[WS Client] Unknown message type: ${msg.type}`);
  }
}

// ─── Outbound Messages ────────────────────
function _sendStatus(overrideState) {
  const { state, sessionId } = getRecordingState();
  sendWsMessage({
    type: 'STATUS',
    state: overrideState ?? state,
    sessionId: sessionId ?? undefined,
    userId: _currentUserId,
  });
}

export function sendWsMessage(msg) {
  if (_ws && _ws.readyState === 1 /* OPEN */) {
    try { _ws.send(JSON.stringify(msg)); }
    catch (err) { logger.error(`[WS Client] Send failed: ${err.message}`); }
  }
}

/** Call this after a chunk upload completes to notify the gateway */
export function notifyChunkUploaded(sessionId, chunkIndex) {
  sendWsMessage({ type: 'CHUNK_UPLOADED', sessionId, chunkIndex });
}
