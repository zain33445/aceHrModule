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
let _agentTokenUserId = null; // user the cached agent token was issued for
let _sessionToken = null;     // web session JWT, pushed from the renderer
let _refreshPromise = null;   // single-flight guard for refreshAgentToken()
let _isShuttingDown = false;
let _lastMessageAt = 0;
let _livenessTimer = null;
const LIVENESS_TIMEOUT_MS = 75_000; // server PINGs every 30s
const AGENT_AUTH_TIMEOUT_MS = 15_000;

// ─── Token Storage ────────────────────────
function _tokenPath() {
  return path.join(app.getPath('userData'), AGENT_TOKEN_FILE);
}

// One agent token per user who has signed in on this PC, so chunks recorded
// for a previous user still upload under that user's identity.
let _tokens = {}; // { [userId]: token }

/** Loads every cached token. Returns the userId that was current when saved. */
function _loadTokens() {
  try {
    const p = _tokenPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const lastUser = data?.userId != null ? String(data.userId) : null;
    _tokens = data?.tokens && typeof data.tokens === 'object'
      ? { ...data.tokens }
      : (data?.token && lastUser ? { [lastUser]: data.token } : {}); // pre-map format
    return lastUser;
  } catch { /* ignore */ }
  return null;
}

function _saveTokens() {
  try {
    fs.writeFileSync(_tokenPath(), JSON.stringify({
      tokens: _tokens,
      // Current pair kept at top level so an older agent build can still read it.
      token: _agentToken,
      userId: _agentTokenUserId,
      savedAt: new Date().toISOString(),
    }));
  } catch (err) { logger.error(`[WS Client] Token save failed: ${err.message}`); }
}

function _clearToken() {
  if (_agentTokenUserId) delete _tokens[_agentTokenUserId];
  _agentToken = null;
  _agentTokenUserId = null;
  _saveTokens();
}

/** Returns the current agent JWT (injected into recorder-main) */
export function getAgentToken() { return _agentToken; }

/** Agent token of a specific user (for chunks that user recorded), or null. */
export function getAgentTokenFor(userId) { return userId != null ? (_tokens[String(userId)] ?? null) : null; }

/** User the agent is currently authenticated as (owner of new recordings). */
export function getAgentUserId() { return _agentTokenUserId; }

/** Web session JWT of the logged-in user (needed to mint the agent token). */
export function setSessionToken(token) {
  _sessionToken = token ? String(token) : null;
  if (!_sessionToken || !_currentUserId) return;
  // Have a session token now: fetch an agent token if we have none for this user.
  if (!_agentToken || _agentTokenUserId !== String(_currentUserId)) {
    refreshAgentToken().then((ok) => { if (ok) _reconnect(); });
  }
}

// ─── Agent Auth ───────────────────────────
function _fetchAgentToken(userId) {
  if (!_sessionToken) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'POST', url: AGENT_AUTH_ENDPOINT });
      const timer = setTimeout(() => { try { req.abort(); } catch { /* ignore */ } resolve(null); }, AGENT_AUTH_TIMEOUT_MS);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${_sessionToken}`);
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            logger.warn(`[WS Client] agent-auth returned HTTP ${res.statusCode}`);
            return done(null);
          }
          try { done(JSON.parse(body).token ?? null); } catch { done(null); }
        });
      });
      req.on('error', () => done(null));
      req.write(JSON.stringify({ user_id: userId }));
      req.end();
    } catch { resolve(null); }
  });
}

/**
 * Fetch a fresh agent token for the current user using the session token.
 * Single-flight: concurrent callers share one request. On failure the existing
 * token (if any) is kept. Resolves true when a new token was obtained.
 */
export function refreshAgentToken() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    const userId = _currentUserId;
    if (!userId || !_sessionToken) return false;
    const token = await _fetchAgentToken(userId);
    if (!token) return false;
    const prevUser = _agentTokenUserId;
    _agentToken = token;
    _agentTokenUserId = String(userId);
    _tokens[_agentTokenUserId] = token;
    _saveTokens();
    logger.info('[WS Client] Agent token obtained and saved');
    if (prevUser && prevUser !== _agentTokenUserId) _onUserSwitch(prevUser);
    return true;
  })().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// ─── Public Init ──────────────────────────
export async function initWsClient(userId) {
  _currentUserId = userId;
  _isShuttingDown = false;

  // Load cached tokens; act as the given user, else the user last signed in.
  const lastUser = _loadTokens();
  const actAs = userId != null ? String(userId) : lastUser;
  if (actAs && _tokens[actAs]) { _agentToken = _tokens[actAs]; _agentTokenUserId = actAs; }
  if (!_agentToken && userId) {
    logger.info('[WS Client] No cached token — fetching from backend...');
    if (!(await refreshAgentToken())) {
      logger.warn('[WS Client] Could not obtain agent token — WS will connect unauthenticated');
    }
  }

  _connect();
}

export function setWsUserId(userId) {
  if (userId === _currentUserId) return;
  _currentUserId = userId;
  if (_agentToken && _agentTokenUserId === String(userId)) {
    // Already authenticated as this user: only (re)connect if not connected.
    if (!_ws || _ws.readyState > 1) _reconnect();
    return;
  }
  const cached = userId != null ? _tokens[String(userId)] : null;
  if (cached) {
    // This user signed in here before: switch to their cached token right away.
    const prevUser = _agentTokenUserId;
    _agentToken = cached;
    _agentTokenUserId = String(userId);
    _saveTokens();
    if (prevUser && prevUser !== _agentTokenUserId) _onUserSwitch(prevUser);
    _reconnect();
    return;
  }
  // Losing data is worse than misattribution: if the new token cannot be
  // fetched we keep the old one and keep recording.
  refreshAgentToken().then((ok) => {
    if (!ok) logger.warn('[WS Client] Could not fetch agent token for new user — keeping previous token');
    _reconnect();
  });
}

/**
 * A different user now owns this agent. The running recording belongs to the
 * previous user's session, so stop it (its final chunk is flushed and later
 * uploaded with that user's token); the server then starts a session for the
 * new user when we report 'idle'/'stopping' on reconnect.
 */
function _onUserSwitch(prevUser) {
  const { state, sessionId } = getRecordingState();
  logger.info(`[WS Client] User switched ${prevUser} → ${_agentTokenUserId}`);
  if (state === 'recording' || state === 'starting') {
    logger.info(`[WS Client] Stopping session ${sessionId} of previous user ${prevUser}`);
    stopRecording();
  }
}

export function shutdownWsClient() {
  _isShuttingDown = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_livenessTimer) { clearInterval(_livenessTimer); _livenessTimer = null; }
  const old = _ws;
  _ws = null; // detach first so the socket's own listeners ignore the close
  if (old) { try { old.close(); } catch { /* ignore */ } }
  logger.info('[WS Client] Shut down');
}

// ─── Connection ───────────────────────────
function _connect() {
  if (_isShuttingDown) return;
  if (_ws && _ws.readyState <= 1 /* CONNECTING | OPEN */) return;
  if (!_agentToken && !_currentUserId) {
    logger.info('[WS Client] No token or userId — waiting for login before connecting');
    return;
  }

  logger.info(`[WS Client] Connecting to ${WS_ENDPOINT}...`);

  try {
    const sock = new WebSocket(WS_ENDPOINT);
    _ws = sock;
    _lastMessageAt = Date.now();
    _ensureLivenessTimer();

    sock.addEventListener('open', () => {
      if (_ws !== sock) return;
      logger.info('[WS Client] Connected to recording gateway');
      _reconnectDelay = 5000; // reset backoff
      _lastMessageAt = Date.now();

      if (_agentToken) {
        sendWsMessage({ type: 'AUTH', token: _agentToken });
      }
    });

    sock.addEventListener('message', (event) => {
      if (_ws !== sock) return;
      _lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(event.data.toString());
        _handleMessage(msg);
      } catch (err) {
        logger.error(`[WS Client] Bad message: ${err.message}`);
      }
    });

    sock.addEventListener('close', (event) => {
      if (_ws !== sock) return; // a replaced socket closing must not touch current state
      _ws = null;
      if (_isShuttingDown) return;
      logger.warn(`[WS Client] Disconnected (${event.code}). Reconnecting in ${_reconnectDelay / 1000}s...`);
      if (event.code === 4001) {
        // Auth rejected: drop the cached agent token and try to mint a new one.
        // If that fails we keep recording locally and retry on the normal backoff.
        logger.warn('[WS Client] Auth rejected (4001) — refreshing agent token');
        _clearToken();
        refreshAgentToken().finally(_scheduleReconnect);
        return;
      }
      _scheduleReconnect();
    });

    sock.addEventListener('error', () => {
      if (_ws !== sock) return;
      logger.error('[WS Client] Socket error occurred');
    });
  } catch (err) {
    logger.error(`[WS Client] Connect failed: ${err.message}`);
    _ws = null;
    _scheduleReconnect();
  }
}

function _ensureLivenessTimer() {
  if (_livenessTimer) return;
  _livenessTimer = setInterval(() => {
    if (_isShuttingDown || !_ws || _ws.readyState !== 1) return;
    if (Date.now() - _lastMessageAt > LIVENESS_TIMEOUT_MS) {
      logger.warn('[WS Client] No message for 75s — assuming dead socket, reconnecting');
      _reconnect();
    }
  }, 15_000);
  if (typeof _livenessTimer.unref === 'function') _livenessTimer.unref();
}

function _scheduleReconnect() {
  if (_reconnectTimer || _isShuttingDown) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
    _connect();
  }, _reconnectDelay);
}

function _reconnect() {
  if (_isShuttingDown) return;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  const old = _ws;
  _ws = null; // detach first: the old socket's close listener then does nothing
  if (old) { try { old.close(); } catch { /* ignore */ } }
  _connect();
}

// ─── Message Handling ─────────────────────
function _handleMessage(msg) {
  logger.info(`[WS Client] ← ${msg.type}`);

  switch (msg.type) {
    case 'START_RECORDING':
      // Whatever the outcome, report the agent's REAL state so the server can
      // adopt the session we actually record into.
      startRecording(msg.sessionId, msg.quality || '720p').then(() => _sendStatus());
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
        refreshAgentToken().then((ok) => {
          if (ok) {
            sendWsMessage({ type: 'AUTH', token: _agentToken });
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
  } else if (msg?.type === 'ERROR') {
    // Queue-free best effort: log that admin won't see this until reconnect
    logger.warn(`[WS Client] Offline — could not forward ERROR ${msg.code} to gateway`);
  }
}

/** Call this after a chunk upload completes to notify the gateway */
export function notifyChunkUploaded(sessionId, chunkIndex) {
  sendWsMessage({ type: 'CHUNK_UPLOADED', sessionId, chunkIndex });
}
