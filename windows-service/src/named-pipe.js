'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

class NamedPipeBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.pipePath || !options.pipePath.startsWith('\\\\.\\pipe\\')) {
      throw new Error('NamedPipeBridge requires a local named-pipe path');
    }

    this._pipePath = options.pipePath;
    this._pipeName = options.pipePath.slice('\\\\.\\pipe\\'.length);
    this._logger = options.logger || null;
    this._maxLineBytes = options.maxLineBytes || 1024 * 1024;
    this._maxClients = options.maxClients || 8;
    this._server = null;
    this._clients = new Set();
  }

  get clientCount() {
    return this._clients.size;
  }

  start() {
    if (this._server) return this._server;

    this._server = net.createServer({ allowHalfOpen: false }, (socket) => {
      this._handleConnection(socket);
    });

    this._server.on('listening', () => {
      this._logger?.info(`Agent bridge listening on ${this._pipePath}`);
      this.emit('listening');
    });

    this._server.on('error', (err) => {
      this._logger?.error(`Agent bridge error: ${err.message}`);
      this.emit('bridge-error', err);
    });

    this._server.on('close', () => {
      this._logger?.info('Agent bridge closed');
      this.emit('closed');
    });

    // The service runs as SYSTEM and the app as a normal user, who couldn't write
    // to the default pipe. Nothing sent here is trusted: the backend checks grants.
    this._server.listen({ path: this._pipePath, readableAll: true, writableAll: true });
    return this._server;
  }

  close() {
    const server = this._server;
    this._server = null;

    for (const socket of this._clients) {
      try { socket.destroy(); } catch {}
    }
    this._clients.clear();

    if (server) {
      try { server.close(); } catch {}
    }
  }

  sendToAgent(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('sendToAgent requires a JSON object');
    }

    const line = `${JSON.stringify(message)}\n`;
    let sent = 0;

    for (const socket of this._clients) {
      if (socket.destroyed || !socket.writable) continue;
      try {
        socket.write(line);
        sent += 1;
      } catch (err) {
        this._logger?.warn(`Agent bridge write failed: ${err.message}`);
      }
    }

    return sent;
  }

  _handleConnection(socket) {
    if (this._clients.size >= this._maxClients) {
      this._logger?.warn('Agent bridge rejected a connection: client limit reached');
      socket.destroy();
      return;
    }

    socket.setEncoding('utf8');
    this._clients.add(socket);

    this._logger?.info(`Agent bridge client connected (${this._clients.size} total)`);
    this.emit('client-connected');

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;

      if (buffer.length > this._maxLineBytes) {
        this._write(socket, { type: 'bridge:error', error: 'message_too_large' });
        buffer = '';
        socket.destroy();
        return;
      }

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) this._handleLine(socket, line);
        newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      this._logger?.warn(`Agent bridge client error: ${err.message}`);
    });

    socket.on('close', () => {
      this._clients.delete(socket);
      this._logger?.info(`Agent bridge client disconnected (${this._clients.size} remaining)`);
      this.emit('client-disconnected');
    });

    this._write(socket, {
      type: 'bridge:hello',
      pipe: this._pipeName,
      protocol: 1,
      ts: new Date().toISOString()
    });
  }

  _handleLine(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._write(socket, { type: 'bridge:error', error: 'invalid_json' });
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      this._write(socket, { type: 'bridge:error', error: 'invalid_message' });
      return;
    }

    switch (message.type) {
      case 'ping':
        this._write(socket, { type: 'pong', id: message.id ?? null, ts: new Date().toISOString() });
        break;

      case 'agent:status':
        this._ack(socket, message);
        this.emit('agent:status', message);
        break;

      case 'agent:inventory':
        this._ack(socket, message);
        this.emit('agent:inventory', message);
        break;

      case 'agent:login':
        this._ack(socket, message);
        this.emit('agent:login', message);
        break;

      default:
        this._logger?.warn(`Agent bridge received unsupported message type ${message.type}`);
        this._write(socket, {
          type: 'bridge:error',
          id: message.id ?? null,
          error: 'unsupported_type',
          received_type: message.type
        });
        break;
    }
  }

  _ack(socket, message) {
    this._write(socket, {
      type: 'bridge:ack',
      id: message.id ?? null,
      received: message.type,
      ts: new Date().toISOString()
    });
  }

  _write(socket, message) {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this._logger?.warn(`Agent bridge write failed: ${err.message}`);
    }
  }
}

module.exports = { NamedPipeBridge };
