/**
 * notification-client.js — Main-process WebSocket for native push notifications.
 *
 * Connects to /chat-ws?userId=<id> and shows native OS notifications for:
 *   - MESSAGE events (chat messages from other users)
 *   - NOTIFICATION events (disputes, leaves, overtime, etc.)
 *
 * Runs in the Electron main process so it is always alive regardless of
 * which React tab is active.
 */

import { Notification, app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { API_BASE } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _ws = null;
let _userId = null;
let _reconnectTimer = null;
let _reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 30_000;
let _shuttingDown = false;

function _wsUrl() {
  const base = API_BASE
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    .replace(/\/api\/?$/, '');
  return `${base}/chat-ws?userId=${encodeURIComponent(_userId)}`;
}

function _showNotification(title, body, link) {
  if (!Notification.isSupported()) return;
  const iconDir = app.isPackaged ? 'dist' : 'public';
  const iconPath = path.join(__dirname, '..', iconDir, 'aceLogo.png');
  const n = new Notification({ title, body, icon: iconPath });
  n.on('click', () => {
    // Emit a custom event so main.js can focus the window
    process.emit('notification-click', link);
  });
  n.show();
}

function _connect() {
  if (_shuttingDown || !_userId) return;

  const url = _wsUrl();
  logger.info(`[Notify WS] Connecting to ${url}`);

  try {
    _ws = new WebSocket(url);

    _ws.addEventListener('open', () => {
      logger.info('[Notify WS] Connected');
      _reconnectDelay = 3000;
    });

    _ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        _handleMessage(msg);
      } catch { /* ignore malformed */ }
    });

    _ws.addEventListener('close', () => {
      _ws = null;
      if (!_shuttingDown) {
        _reconnectTimer = setTimeout(() => {
          _reconnectTimer = null;
          _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
          _connect();
        }, _reconnectDelay);
      }
    });

    _ws.addEventListener('error', () => {});
  } catch (err) {
    logger.error(`[Notify WS] Connect failed: ${err.message}`);
    _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _connect(); }, _reconnectDelay);
  }
}

function _handleMessage(msg) {
  switch (msg.type) {
    case 'MESSAGE':
      // No pop here — the server also emits a NOTIFICATION per recipient (single source of pops).
      // MESSAGE is for the renderer's ChatHub to render the thread live.
      break;
    case 'NOTIFICATION': {
      const n = msg.notification;
      _showNotification(n.title, n.message, n.link);
      break;
    }
    case 'CONNECTED':
      logger.info('[Notify WS] Gateway acknowledged');
      break;
    case 'PING':
      _ws?.send(JSON.stringify({ type: 'PONG' }));
      break;
  }
}

export function initNotificationClient(userId) {
  if (!userId) return;
  _userId = userId;
  _shuttingDown = false;
  _connect();
}

export function setNotificationUserId(userId) {
  if (userId === _userId) return;
  _userId = userId;
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  _connect();
}

export function shutdownNotificationClient() {
  _shuttingDown = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  logger.info('[Notify WS] Shut down');
}
