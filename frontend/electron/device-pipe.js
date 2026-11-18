// frontend/electron/device-pipe.js
// Minimal client for the aceHRM device service named pipe. Used in Phase 4 to
// let the Electron agent report presence/capabilities and receive remote-control
// requests forwarded by the service. Best-effort: failures never break the app.
// Login grants are not buffered (they expire); onConnected lets the app send a fresh one.

import net from 'node:net';

// Overridable (read at connect time) so tests can use a throwaway pipe.
const pipePath = () => process.env.ACEHRM_DEVICE_PIPE || '\\\\.\\pipe\\acehrm-device-service';

let socket = null;
let reconnectTimer = null;
let stopped = false;
let onRemoteControlStart = null;
let onRemoteControlStop = null;
let onConnected = null;

function send(obj) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch {
    // ignore
  }
}

function connect() {
  if (stopped) return;
  try {
    socket = net.connect(pipePath(), () => {
      send({ type: 'agent:status', status: 'running', capabilities: { screen_capture: true, input_control: false } });
      if (typeof onConnected === 'function') onConnected();
    });
  } catch {
    scheduleReconnect();
    return;
  }

  let buffer = '';
  socket.setEncoding('utf8'); // keeps multibyte chars split across chunks intact
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'bridge:hello') continue;
      if (msg.type === 'REMOTE_CONTROL_START') {
        if (typeof onRemoteControlStart === 'function') onRemoteControlStart(msg);
      } else if (msg.type === 'REMOTE_CONTROL_STOP') {
        if (typeof onRemoteControlStop === 'function') onRemoteControlStop(msg);
      }
    }
  });
  socket.on('close', () => {
    socket = null;
    scheduleReconnect();
  });
  socket.on('error', () => {
    try { socket.destroy(); } catch { /* already closed */ }
    socket = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

export function startDevicePipe(handlers) {
  onRemoteControlStart = handlers && handlers.onRemoteControlStart;
  onRemoteControlStop = handlers && handlers.onRemoteControlStop;
  onConnected = handlers && handlers.onConnected;
  connect();
}

export function stopDevicePipe() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { try { socket.destroy(); } catch { /* already closed */ } socket = null; }
}

/** Hands a signed-in user's grant to the service. Not held: grants expire, so the app re-requests one on connect. */
export function sendAgentLogin(grant) {
  send({ type: 'agent:login', grant });
}

export function sendAgentStatus(status) {
  send({ type: 'agent:status', status });
}
