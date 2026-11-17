/**
 * device.gateway.ts — WebSocket gateways for managed devices and admins.
 *
 * Two upgrade paths are owned here:
 *
 *   /device-ws        agents authenticate in-band with { type: 'AUTH', token }
 *                     (device JWTs never go in the URL, which is logged).
 *   /device-admin-ws  browsers connect with a short-lived ?token= ticket, or
 *                     fall back to the same in-band AUTH handshake.
 *
 * The recording gateway registers its upgrade listener first and destroys
 * unknown paths, so it explicitly yields both paths to this module.
 *
 * This gateway is transport only. It does not construct a Prisma client or
 * query the database at construction time, which keeps it testable without a
 * live database. Inbound device commands are acknowledged in the background.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import { verifyDeviceToken } from '../middleware/requireDeviceToken';
import { verifyUserToken } from '../middleware/requireUser';
import {
  ackCommand,
  getDeviceAccessStatus,
  processHeartbeat,
  touchDevice,
} from '../services/device.service';

const DEVICE_PATH = '/device-ws';
const ADMIN_PATH = '/device-admin-ws';

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;

interface DeviceSocketState {
  deviceId: string;
  ip?: string;
  missedPongs: number;
  heartbeat: NodeJS.Timeout;
}

interface AdminIdentity {
  userId: string;
  name?: string;
  role: string;
}

export class DeviceGateway {
  private wss: WebSocketServer;
  /** deviceId -> live socket. One device identity has one active socket. */
  private devices: Map<string, WebSocket> = new Map();
  private deviceStates: Map<WebSocket, DeviceSocketState> = new Map();
  /** adminId -> live sockets (an admin may have several tabs/windows). */
  private admins: Map<string, Set<WebSocket>> = new Map();
  private adminIds: Map<WebSocket, string> = new Map();
  private pendingTimeouts: Map<WebSocket, NodeJS.Timeout> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname === ADMIN_PATH) {
        const token = url.searchParams.get('token');

        if (token) {
          const identity = this.resolveAdminToken(token);
          if (!identity) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }

          this.wss.handleUpgrade(req, socket, head, (ws) =>
            this.onAdminConnection(ws, identity)
          );
          return;
        }

        // Fallback: in-band AUTH, used when the ticket cannot be put in a URL.
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onPendingAdmin(ws));
        return;
      }

      if (url.pathname !== DEVICE_PATH) {
        // Not ours. The recording/chat/call gateways handle or destroy it.
        return;
      }

      const ip = req.socket.remoteAddress ?? undefined;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onPendingDevice(ws, ip));
    });

    console.log(
      `[Device WS] gateway initialized (${DEVICE_PATH} and ${ADMIN_PATH})`
    );
  }

  // ─────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────

  private resolveAdminToken(token: string): AdminIdentity | null {
    const payload = verifyUserToken(token);
    if (!payload || payload.typ !== 'call') return null;
    if (payload.role !== 'admin' && payload.role !== 'superadmin') return null;

    return {
      userId: payload.userId,
      name: payload.name,
      role: payload.role,
    };
  }

  // ─────────────────────────────────────────
  // Device lifecycle
  // ─────────────────────────────────────────

  private onPendingDevice(ws: WebSocket, ip?: string): void {
    this.send(ws, { type: 'AUTH_REQUIRED' });

    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4001, 'Auth timeout');
      }
      this.pendingTimeouts.delete(ws);
    }, AUTH_TIMEOUT_MS);
    this.pendingTimeouts.set(ws, timeout);

    const onMessage = (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(4001, 'Invalid auth message');
        return;
      }

      if (msg.type !== 'AUTH') {
        ws.close(4001, 'First message must be AUTH');
        return;
      }

      const payload = verifyDeviceToken(String(msg.token || ''));
      if (!payload) {
        ws.close(4001, 'Invalid token');
        return;
      }

      const timer = this.pendingTimeouts.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingTimeouts.delete(ws);
      ws.removeListener('message', onMessage);

      this.promoteDevice(ws, payload.deviceId, ip);
    };

    ws.on('message', onMessage);
    ws.on('close', () => {
      const timer = this.pendingTimeouts.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingTimeouts.delete(ws);
    });
  }

  private promoteDevice(ws: WebSocket, deviceId: string, ip?: string): void {
    getDeviceAccessStatus(deviceId)
      .then((status) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (status === 'missing') {
          ws.close(4001, 'Device not found');
          return;
        }
        if (status === 'blocked') {
          ws.close(4003, 'Device disabled');
          return;
        }

        this.onDeviceConnection(ws, deviceId, ip);
      })
      .catch((err) => {
        console.error(`[Device WS] access check failed for ${deviceId}:`, err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, 'Device lookup failed');
        }
      });
  }

  private onDeviceConnection(ws: WebSocket, deviceId: string, ip?: string): void {
    const existing = this.devices.get(deviceId);
    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'Replaced by new connection');
    }
    this.devices.set(deviceId, ws);

    const heartbeat = setInterval(() => {
      const state = this.deviceStates.get(ws);
      if (!state || ws.readyState !== WebSocket.OPEN) return;

      if (state.missedPongs >= MAX_MISSED_PONGS) {
        console.warn(`[Device WS] ${deviceId} missed ${MAX_MISSED_PONGS} pongs — terminating`);
        ws.terminate();
        return;
      }

      state.missedPongs++;
      this.send(ws, { type: 'PING' });
    }, HEARTBEAT_INTERVAL_MS);

    this.deviceStates.set(ws, { deviceId, ip, missedPongs: 0, heartbeat });

    console.log(`[Device WS] Device connected: ${deviceId}`);
    this.send(ws, { type: 'CONNECTED', deviceId });
    this.broadcastToAdmins({
      type: 'DEVICE_STATUS',
      deviceId,
      status: 'online',
      at: new Date().toISOString(),
    });

    // Mark presence and push anything queued while the device was offline.
    processHeartbeat(deviceId, { ip })
      .then(({ ok, commands }) => {
        if (!ok) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4001, 'Device not found');
          }
          return;
        }
        for (const command of commands) {
          this.sendDeviceCommand(ws, command);
        }
      })
      .catch((err) => {
        console.error(`[Device WS] initial heartbeat failed for ${deviceId}:`, err);
      });

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'PONG') {
        const state = this.deviceStates.get(ws);
        if (state) state.missedPongs = 0;
        return;
      }

      if (msg.type === 'PING') {
        this.send(ws, { type: 'PONG' });
        return;
      }

      touchDevice(deviceId).catch(() => {});
      this.handleDeviceMessage(deviceId, msg);
    });

    ws.on('close', (code) => {
      const state = this.deviceStates.get(ws);
      if (state) clearInterval(state.heartbeat);
      this.deviceStates.delete(ws);

      if (this.devices.get(deviceId) === ws) {
        this.devices.delete(deviceId);
        console.log(`[Device WS] Device disconnected: ${deviceId} (${code})`);
        this.broadcastToAdmins({
          type: 'DEVICE_STATUS',
          deviceId,
          status: 'offline',
          at: new Date().toISOString(),
        });
      }
    });

    ws.on('error', (err) => {
      console.error(`[Device WS] Device ${deviceId} socket error:`, err.message);
    });
  }

  private handleDeviceMessage(deviceId: string, msg: any): void {
    switch (msg.type) {
      case 'DEVICE_COMMAND_ACK':
      case 'ACK': {
        const commandId = String(msg.commandId || '');
        if (commandId) {
          ackCommand({
            deviceId,
            commandId,
            status: msg.status ? String(msg.status) : undefined,
            result: msg.result,
          }).catch((err) =>
            console.error(`[Device WS] command ack failed for ${commandId}:`, err)
          );
        }
        this.broadcastToAdmins({
          ...msg,
          type: 'DEVICE_COMMAND_ACK',
          deviceId,
        });
        break;
      }

      case 'WEBRTC_ANSWER':
      case 'WEBRTC_ICE_CANDIDATE': {
        const outbound = { ...msg, deviceId };
        const adminId = msg.adminId ? String(msg.adminId) : '';
        if (adminId) {
          this.sendToAdmin(adminId, outbound);
        } else {
          this.broadcastToAdmins(outbound);
        }
        break;
      }

      case 'DEVICE_STATUS':
      case 'DEVICE_INVENTORY':
        this.broadcastToAdmins({ ...msg, deviceId });
        break;

      default:
        console.warn(`[Device WS] Unknown message type from ${deviceId}: ${msg.type}`);
    }
  }

  private sendDeviceCommand(ws: WebSocket, command: any): void {
    this.send(ws, {
      type: 'DEVICE_COMMAND',
      commandId: command.id,
      commandType: command.type,
      payload: command.payload ?? null,
      createdAt: command.created_at,
    });
  }

  // ─────────────────────────────────────────
  // Admin lifecycle
  // ─────────────────────────────────────────

  private onPendingAdmin(ws: WebSocket): void {
    this.send(ws, { type: 'AUTH_REQUIRED' });

    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4001, 'Auth timeout');
      }
      this.pendingTimeouts.delete(ws);
    }, AUTH_TIMEOUT_MS);
    this.pendingTimeouts.set(ws, timeout);

    const onMessage = (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(4001, 'Invalid auth message');
        return;
      }

      if (msg.type !== 'AUTH') {
        ws.close(4001, 'First message must be AUTH');
        return;
      }

      const identity = this.resolveAdminToken(String(msg.token || ''));
      if (!identity) {
        ws.close(4001, 'Invalid token');
        return;
      }

      const timer = this.pendingTimeouts.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingTimeouts.delete(ws);
      ws.removeListener('message', onMessage);

      this.onAdminConnection(ws, identity);
    };

    ws.on('message', onMessage);
    ws.on('close', () => {
      const timer = this.pendingTimeouts.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingTimeouts.delete(ws);
    });
  }

  private onAdminConnection(ws: WebSocket, identity: AdminIdentity): void {
    const { userId: adminId } = identity;

    if (!this.admins.has(adminId)) this.admins.set(adminId, new Set());
    this.admins.get(adminId)!.add(ws);
    this.adminIds.set(ws, adminId);

    console.log(`[Device WS] Admin connected: ${adminId}`);
    this.send(ws, { type: 'CONNECTED', adminId });

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'PING') {
        this.send(ws, { type: 'PONG' });
        return;
      }
      if (msg.type === 'PONG') return;

      this.handleAdminMessage(ws, adminId, msg);
    });

    ws.on('close', (code) => {
      this.adminIds.delete(ws);
      const set = this.admins.get(adminId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.admins.delete(adminId);
      }
      console.log(`[Device WS] Admin disconnected: ${adminId} (${code})`);
    });

    ws.on('error', (err) => {
      console.error(`[Device WS] Admin ${adminId} socket error:`, err.message);
    });
  }

  private handleAdminMessage(ws: WebSocket, adminId: string, msg: any): void {
    switch (msg.type) {
      case 'WEBRTC_OFFER':
      case 'WEBRTC_ICE_CANDIDATE':
      case 'REMOTE_CONTROL_STOP': {
        const targetDeviceId = String(msg.targetDeviceId || msg.deviceId || '');
        if (!targetDeviceId) {
          this.send(ws, {
            type: 'DEVICE_ERROR',
            message: 'targetDeviceId is required.',
          });
          return;
        }

        const delivered = this.sendToDevice(targetDeviceId, {
          ...msg,
          adminId,
          targetDeviceId,
          deviceId: targetDeviceId,
        });

        if (!delivered) {
          this.send(ws, {
            type: 'DEVICE_ERROR',
            targetDeviceId,
            message: 'Device is not connected.',
          });
        }
        break;
      }

      default:
        console.warn(`[Device WS] Unknown message type from admin ${adminId}: ${msg.type}`);
    }
  }

  // ─────────────────────────────────────────
  // Public API (used by REST routes / other gateways)
  // ─────────────────────────────────────────

  /** Sends a message to a device. Returns false when it is not connected. */
  sendToDevice(deviceId: string, message: object): boolean {
    const ws = this.devices.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    return this.send(ws, message);
  }

  /** Is the device currently connected to /device-ws? */
  isDeviceConnected(deviceId: string): boolean {
    const ws = this.devices.get(deviceId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /** Fan a message out to every connected admin socket. */
  broadcastToAdmins(message: object): void {
    for (const set of this.admins.values()) {
      for (const ws of set) {
        this.send(ws, message);
      }
    }
  }

  dispose(): void {
    for (const state of this.deviceStates.values()) {
      clearInterval(state.heartbeat);
    }
    this.deviceStates.clear();
    this.devices.clear();
    this.admins.clear();
    this.adminIds.clear();
    this.wss.close();
  }

  // ─────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────

  private sendToAdmin(adminId: string, message: object): void {
    const set = this.admins.get(adminId);
    if (!set) return;
    for (const ws of set) {
      this.send(ws, message);
    }
  }

  private send(ws: WebSocket, message: object): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}

let _gateway: DeviceGateway | null = null;

export function initDeviceGateway(server: Server): DeviceGateway {
  _gateway = new DeviceGateway(server);
  return _gateway;
}

export function getDeviceGateway(): DeviceGateway | null {
  return _gateway;
}
