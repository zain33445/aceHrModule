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
import { randomUUID } from 'crypto';
import { WS_ENDPOINT, AGENT_AUTH_ENDPOINT, AGENT_TOKEN_FILE, RECORDING_PROTOCOL, RECORDING_STATUS_INTERVAL_MS } from './config.js';
import { handleWebRtcMessage, setRecordPolicy, getRecorderStatus, addStatusListener } from './recorder-main.js';
import { handleLiveMessage, getLiveViewerCount, addLiveCountListener, closeAllLive } from './live-main.js';
import { setSyncEnabled } from './sync-v2.js';
import { loadStore, saveStore, mergeConnected } from './token-store.js';
import { decideRecording, clockOffset } from './agent-policy.js';
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
const _refreshes = new Map(); // userId -> in-flight refreshAgentToken(); one per user, never shared across users
let _clockOffsetMs = 0;       // serverTime - local clock, from the last CONNECTED (A12)
let _isShuttingDown = false;
let _lastMessageAt = 0;
let _livenessTimer = null;
const LIVENESS_TIMEOUT_MS = 75_000; // server PINGs every 30s
const AGENT_AUTH_TIMEOUT_MS = 15_000;
const REPLACED_BACKOFF_MS = 5 * 60_000; // after close 4002 (replaced by another agent of this user)
const CLOCK_SKEW_WARN_MS = 60_000;
let _statusTimer = null;
let _statusHooked = false;
let _warnedOldServer = false;
let _deviceId = null;

// ─── Token Storage ────────────────────────
function _tokenPath() {
  return path.join(app.getPath('userData'), AGENT_TOKEN_FILE);
}

// One agent token per user who has signed in on this PC, so chunks recorded
// for a previous user still upload under that user's identity.
let _tokens = {}; // { [userId]: token }
// Recording policy per user, from the last protocol-2 CONNECTED, so recording
// can start at boot even when the server is unreachable.
let _policies = {}; // { [userId]: { record: boolean, recordingDay: {boundaryMinutes, shiftStartMinutes} } }

/** Loads every cached token (main file, else .bak). Returns the userId that was current when saved. */
function _loadTokens() {
  try {
    const p = _tokenPath();
    const { data, from } = loadStore(p);
    if (from !== 'main' && fs.existsSync(p)) {
      // A7: keep the unreadable file for a human; it is never overwritten.
      try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      logger.warn(`[WS Client] ${AGENT_TOKEN_FILE} unreadable — ${from === 'bak' ? 'recovered from .bak' : 'starting empty'}`);
    }
    if (!data) return null;
    const lastUser = data.userId != null ? String(data.userId) : null;
    _tokens = data.tokens && typeof data.tokens === 'object'
      ? { ...data.tokens }
      : (data.token && lastUser ? { [lastUser]: data.token } : {}); // pre-map format
    _policies = data.policies && typeof data.policies === 'object' ? { ...data.policies } : {};
    return lastUser;
  } catch { /* ignore */ }
  return null;
}

function _saveTokens() {
  try {
    saveStore(_tokenPath(), {
      tokens: _tokens,
      policies: _policies,
      // Current pair kept at top level so an older agent build can still read it.
      token: _agentToken,
      userId: _agentTokenUserId,
      savedAt: new Date().toISOString(),
    });
  } catch (err) { logger.error(`[WS Client] Token save failed: ${err.message}`); }
}

function _clearToken() {
  if (_agentTokenUserId) delete _tokens[_agentTokenUserId];
  _agentToken = null;
  _agentTokenUserId = null;
  _saveTokens();
}

/** Stable per-install id, persisted once in userData/device-id. */
export function getDeviceId() {
  if (_deviceId) return _deviceId;
  const p = path.join(app.getPath('userData'), 'device-id');
  try { _deviceId = fs.readFileSync(p, 'utf8').trim(); } catch { /* first run */ }
  if (!_deviceId) {
    _deviceId = randomUUID();
    try { fs.writeFileSync(p, _deviceId, { flag: 'wx' }); }
    catch { try { _deviceId = fs.readFileSync(p, 'utf8').trim() || _deviceId; } catch { /* keep generated */ } }
  }
  return _deviceId;
}

/**
 * Tell the recorder who records. The decision belongs to the user who is signed in now (A9): a user
 * without a cached token + server-confirmed policy is NOT recorded, and is never attributed to the
 * previous user's token.
 */
function _applyPolicy() {
  const u = _currentUserId != null ? String(_currentUserId) : _agentTokenUserId;
  if (!u) return; // nobody known yet (token lost on 4001): keep recording as-is rather than stopping
  const d = decideRecording({ userId: u, tokens: _tokens, policies: _policies });
  if (!d.record) logger.info(`[WS Client] Not recording: ${d.reason}`);
  setRecordPolicy({ userId: u, record: d.record, recordingDay: _policies[u]?.recordingDay, clockOffsetMs: _clockOffsetMs });
}

/** serverTime - local clock (ms) from the last CONNECTED; add to Date.now() for server time. */
export function getClockOffsetMs() { return _clockOffsetMs; }

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
 * Fetch a fresh agent token for `userId` (default: the current user) using the session token.
 * Single-flight PER USER: concurrent callers for the same user share one request, a refresh for
 * user A never satisfies a request for user B. Only the signed-in user can be refreshed (the
 * session token is theirs). On failure the existing token (if any) is kept. Resolves true on success.
 */
export function refreshAgentToken(userId = _currentUserId) {
  const uid = userId != null ? String(userId) : null;
  if (!uid || !_sessionToken || uid !== String(_currentUserId)) return Promise.resolve(false);
  const running = _refreshes.get(uid);
  if (running) return running;
  const p = (async () => {
    const token = await _fetchAgentToken(uid);
    if (!token) return false;
    _tokens[uid] = token;
    const prevUser = _agentTokenUserId;
    if (uid === String(_currentUserId)) { _agentToken = token; _agentTokenUserId = uid; }
    _saveTokens();
    logger.info('[WS Client] Agent token obtained and saved');
    if (prevUser && prevUser !== _agentTokenUserId) _onUserSwitch(prevUser);
    else _applyPolicy();
    return true;
  })().finally(() => { _refreshes.delete(uid); });
  _refreshes.set(uid, p);
  return p;
}

// ─── Public Init ──────────────────────────
export async function initWsClient(userId) {
  _currentUserId = userId;
  _isShuttingDown = false;

  // Load cached tokens; act as the given user, else the user last signed in.
  const lastUser = _loadTokens();
  const actAs = userId != null ? String(userId) : lastUser;
  if (actAs && _tokens[actAs]) { _agentToken = _tokens[actAs]; _agentTokenUserId = actAs; }
  if (!_statusHooked) { _statusHooked = true; addStatusListener(() => _sendStatus()); addLiveCountListener(() => _sendStatus()); }
  _applyPolicy(); // records from boot using the cached flag, even offline
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
  // A9: a user we have no token/policy for is not recorded (and never under the previous user's
  // identity) until their token arrives and the server confirms their policy. Segments already on
  // disk keep their owner and upload with that owner's token.
  _applyPolicy();
  refreshAgentToken().then((ok) => {
    if (!ok) logger.warn('[WS Client] Could not fetch agent token for new user — recording paused for them');
    _reconnect();
  });
}

/**
 * A different user now owns this agent. The recorder rotates to a new segment
 * owned by the new user (the old segment keeps its owner and uploads with that
 * user's token); a user the server has never seen has no cached policy, so it is
 * not recorded until its first CONNECTED.
 */
function _onUserSwitch(prevUser) {
  logger.info(`[WS Client] User switched ${prevUser} -> ${_agentTokenUserId}`);
  _applyPolicy();
}

export function shutdownWsClient() {
  _isShuttingDown = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_livenessTimer) { clearInterval(_livenessTimer); _livenessTimer = null; }
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  closeAllLive();
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

      if (_agentToken) _sendAuth();
      if (!_statusTimer) {
        _statusTimer = setInterval(() => _sendStatus(), RECORDING_STATUS_INTERVAL_MS);
        if (typeof _statusTimer.unref === 'function') _statusTimer.unref();
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
      closeAllLive(); // the server ended our streams with the socket
      if (_isShuttingDown) return;
      if (event.code === 4002) {
        // Another agent of the same user (e.g. a second PC) replaced us. Coming
        // straight back would replace it in turn, forever. Recording and uploads
        // carry on meanwhile — only the control socket waits.
        logger.warn(`[WS Client] Replaced by another agent signed in as this user — reconnecting in ${REPLACED_BACKOFF_MS / 60000} min`);
        _scheduleReconnect(REPLACED_BACKOFF_MS);
        return;
      }
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

function _scheduleReconnect(delayOverride) {
  if (_reconnectTimer || _isShuttingDown) return;
  const delay = typeof delayOverride === 'number' ? delayOverride : _reconnectDelay;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (typeof delayOverride !== 'number') _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
    _connect();
  }, delay);
}

function _reconnect() {
  if (_isShuttingDown) return;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  closeAllLive();
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
    case 'STOP_RECORDING':
      // Recording v2 is agent-driven: the server no longer starts/stops it.
      logger.info(`[WS Client] Ignoring ${msg.type} - recording is agent-driven (protocol 2)`);
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

    case 'LIVE_START':
    case 'LIVE_QUALITY':
    case 'LIVE_STOP':
    case 'LIVE_SIGNAL':
      handleLiveMessage(msg);
      break;

    case 'CHUNK_ACK':
      logger.info(`[WS Client] Chunk ${msg.chunkIndex} acknowledged for session ${msg.sessionId}`);
      break;

    case 'PING':
      sendWsMessage({ type: 'PONG' });
      break;

    case 'CONNECTED':
      _onConnected(msg);
      break;

    case 'AUTH_REQUIRED':
      logger.info('[WS Client] Gateway requires authentication');
      if (_agentToken) {
        _sendAuth();
      } else if (_currentUserId) {
        refreshAgentToken().then((ok) => {
          if (ok) {
            _sendAuth();
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
function _sendAuth() {
  sendWsMessage({
    type: 'AUTH',
    token: _agentToken,
    protocol: RECORDING_PROTOCOL,
    deviceId: getDeviceId(),
    version: app.getVersion(),
  });
}

/** CONNECTED {protocol:2, userId, record, recordingDay, serverTime} (docs/recording-v2.md section 5). */
function _onConnected(msg) {
  logger.info('[WS Client] Gateway acknowledged connection');
  if (msg.protocol === RECORDING_PROTOCOL) {
    setSyncEnabled(true);
    const t = typeof msg.serverTime === 'number' ? msg.serverTime : Date.parse(msg.serverTime);
    if (Number.isFinite(t)) {
      _clockOffsetMs = clockOffset(t);
      const skew = Date.now() - t;
      const line = `[WS Client] Clock skew vs server: ${(skew / 1000).toFixed(1)}s`;
      if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) logger.warn(line); else logger.info(line);
    }
    const uid = String(msg.userId ?? _agentTokenUserId ?? '');
    if (uid) {
      _policies[uid] = mergeConnected(_policies[uid], msg); // A11: a missing recordingDay keeps the cached rule
      _saveTokens();
      if (uid === (_currentUserId != null ? String(_currentUserId) : _agentTokenUserId)) _applyPolicy();
    }
  } else if (!_warnedOldServer) {
    // Old server: keep recording locally into the v2 spool, upload nothing
    // (sync idles). New recordings never fall back to the v1 protocol.
    _warnedOldServer = true;
    logger.warn('[WS Client] Server did not answer with protocol 2 - recording locally, v2 upload disabled until the server is upgraded');
  }
  _sendStatus();
}

function _sendStatus() {
  sendWsMessage({
    type: 'STATUS',
    ...getRecorderStatus(),
    liveViewers: getLiveViewerCount(),
    userId: _currentUserId,
    version: app.getVersion(),
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
