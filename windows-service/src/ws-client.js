'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const AUTH_CLOSE_CODES = new Set([4001, 4003, 4401, 4403]);
const AUTH_TIMEOUT_MS = 10_000;

class DeviceWsClient extends EventEmitter {
  constructor(options) {
    super();
    if (!options?.url) throw new Error('DeviceWsClient requires a url');
    if (typeof options.getToken !== 'function') throw new Error('DeviceWsClient requires getToken()');

    this._url = options.url;
    this._getToken = options.getToken;
    this._getStatus = options.getStatus || (() => ({}));
    this._onHeartbeat = options.onHeartbeat || null;
    this._onInventory = options.onInventory || null;
    this._logger = options.logger || null;
    this._heartbeatIntervalMs = options.heartbeatIntervalMs || 60_000;
    this._inventoryIntervalMs = options.inventoryIntervalMs || 900_000;
    this._reconnectBaseMs = options.reconnectBaseMs || 2_000;
    this._reconnectMaxMs = options.reconnectMaxMs || 60_000;

    this._ws = null;
    this._stopped = true;
    this._connected = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._authTimer = null;
    this._heartbeatTimer = null;
    this._inventoryTimer = null;
    this._initialTimers = [];
    this._heartbeatInFlight = false;
    this._inventoryInFlight = false;
    this._authFailureNotified = false;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._connected = false;
    this._clearReconnect();
    this._clearAuthTimer();
    this._stopTaskTimers();
    const socket = this._ws;
    this._ws = null;
    if (socket) {
      try { socket.removeAllListeners(); } catch {}
      try { socket.close(1000, 'service stopping'); } catch {}
    }
  }

  restart(reason) {
    if (this._stopped) return;
    this._logger?.info(`Restarting device WebSocket${reason ? ` (${reason})` : ''}`);
    this._clearReconnect();
    this._clearAuthTimer();
    this._stopTaskTimers();
    this._connected = false;
    const socket = this._ws;
    this._ws = null;
    if (socket) {
      try { socket.removeAllListeners(); } catch {}
      try { socket.terminate(); } catch {}
    }
    this._authFailureNotified = false;
    this._connect();
  }

  send(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    try {
      this._ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this._logger?.warn(`Device WebSocket send failed: ${err.message}`);
      return false;
    }
  }

  isConnected() {
    return this._connected;
  }

  _connect() {
    if (this._stopped) return;
    this._clearReconnect();
    this._clearAuthTimer();
    this._authFailureNotified = false;

    const token = this._getToken();
    if (!token) {
      this._logger?.warn('No device token is available; delaying device WebSocket connection');
      this._scheduleReconnect('no-token');
      return;
    }

    this._logger?.info(`Connecting device WebSocket to ${this._url}`);

    let socket;
    try {
      socket = new WebSocket(this._url, {
        handshakeTimeout: 15_000,
        maxPayload: 1024 * 1024
      });
    } catch (err) {
      this._logger?.warn(`Device WebSocket creation failed: ${err.message}`);
      this._scheduleReconnect('create-failed');
      return;
    }

    this._ws = socket;

    socket.on('open', () => {
      if (this._ws !== socket) return;
      const currentToken = this._getToken();
      if (!currentToken) {
        this._logger?.warn('No device token available at WebSocket open; reconnecting later');
        this._closeSocket(socket, 4001, 'no token');
        return;
      }

      this._logger?.info('Device WebSocket open; sending AUTH');
      try {
        socket.send(JSON.stringify({ type: 'AUTH', token: currentToken }));
      } catch (err) {
        this._logger?.warn(`Could not send device AUTH: ${err.message}`);
        this._closeSocket(socket, 4001, 'auth send failed');
        return;
      }

      this._authTimer = setTimeout(() => {
        if (this._ws !== socket || this._connected) return;
        this._logger?.warn('Device WebSocket did not receive CONNECTED in time');
        this._closeSocket(socket, 4000, 'auth timeout');
      }, AUTH_TIMEOUT_MS);
    });

    socket.on('message', (data) => {
      if (this._ws !== socket) return;
      this._handleRawMessage(data);
    });

    socket.on('close', (code) => {
      if (this._ws !== socket) return;
      this._ws = null;
      this._connected = false;
      this._clearAuthTimer();
      this._stopTaskTimers();

      if (this._stopped) return;

      if (AUTH_CLOSE_CODES.has(code)) {
        if (!this._authFailureNotified) {
          this._authFailureNotified = true;
          this._logger?.warn(`Device WebSocket authentication failed (close code ${code})`);
          this.emit('auth-expired', { reason: `socket-close-${code}` });
        }
        this._scheduleReconnect(`auth-close-${code}`);
        return;
      }

      this._logger?.warn(`Device WebSocket closed (code ${code}); will reconnect`);
      this.emit('disconnected', { code });
      this._scheduleReconnect(`close-${code}`);
    });

    socket.on('error', (err) => {
      if (this._ws !== socket) return;
      this._logger?.warn(`Device WebSocket error: ${err.message}`);
    });
  }

  _handleRawMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this._logger?.warn('Device WebSocket received invalid JSON');
      return;
    }

    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this._logger?.warn('Device WebSocket received a message without a type');
      return;
    }

    switch (message.type) {
      case 'CONNECTED':
      case 'AUTH_OK':
        this._connected = true;
        this._attempt = 0;
        this._authFailureNotified = false;
        this._clearAuthTimer();
        this._logger?.info('Device WebSocket authenticated');
        this._sendStatus();
        this._startTaskTimers();
        this.emit('connected', message);
        break;

      case 'PING':
        this.send({ type: 'PONG', id: message.id ?? null, ts: Date.now() });
        break;

      case 'PONG':
        break;

      case 'DEVICE_COMMAND': {
        const commandId = message.commandId ?? message.command_id ?? message.id ?? null;
        const commandType = message.commandType || message.command_type || null;
        this._logger?.info(
          `Received DEVICE_COMMAND ${commandId ?? '(no id)'} (${commandType || 'unknown'})`
        );
        this.emit('device-command', { commandId, type: commandType, payload: message.payload ?? null });

        if (commandId) {
          const ack = (status, code, messageText, result) => {
            this.send({
              type: 'DEVICE_COMMAND_ACK',
              commandId,
              command_id: commandId,
              status,
              code: code || null,
              message: messageText || null,
              result: result || null
            });
          };

          (async () => {
            if (typeof this._commandExecutor !== 'function') {
              ack('failed', 'NO_EXECUTOR', 'No command executor is configured');
              return;
            }
            try {
              const outcome = await this._commandExecutor(commandType, message.payload ?? null, commandId);
              if (outcome && outcome.ok) {
                ack('completed', null, outcome.message || 'Command completed', outcome.result);
              } else {
                ack(
                  'failed',
                  (outcome && outcome.code) || 'COMMAND_FAILED',
                  (outcome && outcome.message) || 'Command failed',
                  outcome && outcome.result
                );
              }
            } catch (err) {
              ack('failed', 'COMMAND_ERROR', err && err.message ? err.message : 'Command execution failed', null);
            }
          })();
        }
        break;
      }

      case 'REMOTE_CONTROL_START': {
        const sessionId = message.sessionId ?? message.session_id ?? null;
        const commandId = message.commandId ?? message.command_id ?? null;
        const adminId = message.adminId ?? message.admin_id ?? null;
        this._logger?.info(
          `Remote control start requested (session=${sessionId ?? '(none)'}, admin=${adminId ?? '(none)'})`
        );
        this.emit('remote-control-start', {
          sessionId,
          commandId,
          adminId,
          reason: message.reason ?? null
        });
        if (commandId) {
          this.send({
            type: 'DEVICE_COMMAND_ACK',
            commandId,
            command_id: commandId,
            status: 'completed',
            code: null,
            message: 'Remote control session delivered to agent',
            result: { session_id: sessionId, admin_id: adminId }
          });
        }
        break;
      }

      case 'REMOTE_CONTROL_STOP': {
        const commandId = message.commandId ?? message.command_id ?? null;
        const adminId = message.adminId ?? message.admin_id ?? null;
        this._logger?.info(`Remote control stop requested (admin=${adminId ?? '(none)'})`);
        this.emit('remote-control-stop', { commandId, adminId });
        if (commandId) {
          this.send({
            type: 'DEVICE_COMMAND_ACK',
            commandId,
            command_id: commandId,
            status: 'completed',
            code: null,
            message: 'Remote control session stopped',
            result: null
          });
        }
        break;
      }

      // The gateway sends this as a prompt on every new socket; AUTH already went out on open.
      case 'AUTH_REQUIRED':
        break;

      case 'AUTH_FAILED':
        this._handleAuthFailure(message.type);
        break;

      case 'ERROR':
        if (String(message.code || '').toUpperCase().includes('AUTH')) {
          this._handleAuthFailure(message.code || 'auth-error');
        } else {
          this._logger?.warn(`Device WebSocket server error: ${message.code || 'UNKNOWN'}`);
        }
        break;

      default:
        this._logger?.debug(`Device WebSocket ignored message type ${message.type}`);
        break;
    }
  }

  _handleAuthFailure(reason) {
    if (this._stopped || this._authFailureNotified) return;
    this._authFailureNotified = true;
    this._connected = false;
    this._logger?.warn(`Device WebSocket authentication rejected (${reason})`);
    this.emit('auth-expired', { reason });
    const socket = this._ws;
    if (socket) this._closeSocket(socket, 4401, 'auth rejected');
    else this._scheduleReconnect('auth-rejected');
  }

  _sendStatus() {
    const status = this._getStatus() || {};
    this.send({
      ...status,
      type: 'DEVICE_STATUS',
      ts: new Date().toISOString()
    });
  }

  _startTaskTimers() {
    this._stopTaskTimers();

    if (this._onHeartbeat) {
      this._initialTimers.push(setTimeout(() => this._runTask('heartbeat', this._onHeartbeat), 1_000));
      this._heartbeatTimer = setInterval(() => this._runTask('heartbeat', this._onHeartbeat), this._heartbeatIntervalMs);
    }

    if (this._onInventory) {
      this._initialTimers.push(setTimeout(() => this._runTask('inventory', this._onInventory), 5_000));
      this._inventoryTimer = setInterval(() => this._runTask('inventory', this._onInventory), this._inventoryIntervalMs);
    }
  }

  _stopTaskTimers() {
    for (const timer of this._initialTimers) clearTimeout(timer);
    this._initialTimers = [];
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._inventoryTimer) {
      clearInterval(this._inventoryTimer);
      this._inventoryTimer = null;
    }
  }

  async _runTask(name, task) {
    if (this._stopped || !this._connected) return;

    const inFlightKey = name === 'heartbeat' ? '_heartbeatInFlight' : '_inventoryInFlight';
    if (this[inFlightKey]) return;
    this[inFlightKey] = true;

    try {
      await task();
    } catch (err) {
      this._logger?.warn(`${name} task failed: ${err.message}`);
      this.emit('task-error', {
        task: name,
        message: err.message,
        status: err.status || null
      });
    } finally {
      this[inFlightKey] = false;
    }
  }

  _scheduleReconnect(reason) {
    if (this._stopped || this._reconnectTimer) return;

    const exponential = Math.min(
      this._reconnectMaxMs,
      this._reconnectBaseMs * (2 ** Math.min(this._attempt, 10))
    );
    const jittered = Math.max(500, Math.round(exponential * (0.8 + Math.random() * 0.4)));
    this._attempt += 1;

    this._logger?.info(
      `Device WebSocket reconnect in ${roundSeconds(jittered)}s (${reason})`
    );

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, jittered);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearAuthTimer() {
    if (this._authTimer) {
      clearTimeout(this._authTimer);
      this._authTimer = null;
    }
  }

  _closeSocket(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
    setTimeout(() => {
      if (this._ws === socket) {
        try { socket.terminate(); } catch {}
      }
    }, 2_000).unref?.();
  }
}

function roundSeconds(milliseconds) {
  return Math.round(milliseconds / 100) / 10;
}

module.exports = { DeviceWsClient };
