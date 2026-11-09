/**
 * recording.gateway.ts — WebSocket Gateway for Recording Control
 *
 * Handles bidirectional real-time communication between the backend and
 * Electron agents. The gateway:
 *   - Validates agent JWT tokens on WebSocket upgrade
 *   - Maintains a registry of connected agents
 *   - Sends commands: START_RECORDING, STOP_RECORDING, SCHEDULE, STATUS_REQUEST
 *   - Receives events: STATUS, CHUNK_UPLOADED, ERROR, PONG
 *
 * Architecture note: Designed as a singleton with a module-level instance.
 * Future upgrade path: Replace ws with WebRTC signalling or Socket.IO without
 * changing the broadcast/receive API surface.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import jwt from 'jsonwebtoken';
import { verifyAgentToken } from '../middleware/requireAgentToken';
import prisma from '../prisma';

const AGENT_SECRET = process.env.AGENT_JWT_SECRET || 'ace-agent-secret-change-in-prod';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export type WsMessageType =
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'SCHEDULE'
  | 'STATUS_REQUEST'
  | 'PING'
  | 'CONNECTED'
  | 'WEBRTC_OFFER'
  | 'WEBRTC_ANSWER'
  | 'WEBRTC_ICE_CANDIDATE'
  | 'CHUNK_ACK';

export interface WsCommand {
  type: WsMessageType;
  sessionId?: string;
  quality?: string;
  schedules?: ScheduleEntry[];
  userId?: string;
  adminId?: string;
  targetUserId?: string;
  offer?: any;
  answer?: any;
  candidate?: any;
  chunkIndex?: number;
}

export interface ScheduleEntry {
  id: number;
  cronExpr: string;
  action: 'start' | 'stop';
  enabled: boolean;
}

// ─────────────────────────────────────────
// Gateway Class
// ─────────────────────────────────────────

export class RecordingGateway {
  private wss: WebSocketServer;
  // Map<userId, WebSocket>
  private agents: Map<string, WebSocket> = new Map();
  // Map<adminId, WebSocket>
  private admins: Map<string, WebSocket> = new Map();
  // Latest agent error per userId (for status API / admin UI)
  private agentErrors: Map<string, { code: string; message: string; sessionId?: string; at: string }> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle HTTP → WebSocket upgrade requests
    server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      
      if (url.pathname === '/recording-ws') {
        // Auth via AUTH message after upgrade (token no longer in URL)
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.onPendingConnection(ws);
        });
      } else if (url.pathname === '/admin-recording-ws') {
        // Never log req.url — it carries the token. Pathname only.
        console.log(`[WS Gateway] Admin upgrade request received: ${url.pathname}`);

        const token = url.searchParams.get('token');
        if (token) {
          try {
            const decoded = jwt.verify(token, AGENT_SECRET) as any;
            if (decoded.role === 'admin-ws' || decoded.role === 'admin' || decoded.role === 'superadmin') {
              const adminId = decoded.sub;
              console.log(`[WS Gateway] Admin upgrade accepted for ${adminId}`);
              this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.onAdminConnection(ws, adminId);
              });
              return;
            }
          } catch {}
        } else {
          console.warn(`[WS Gateway] Admin upgrade rejected: missing token`);
        }
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      } else if (url.pathname === '/chat-ws') {
        // Owned by the chat gateway's own upgrade listener — do not touch.
        return;
      } else if (url.pathname === '/call-ws') {
        // Owned by the call gateway's own upgrade listener — do not touch.
        return;
      } else {
        console.warn(`[WS Gateway] Unknown upgrade path: ${url.pathname}`);
        socket.destroy();
      }
    });

    console.log('[WS Gateway] Recording WebSocket gateways initialized (/recording-ws and /admin-recording-ws)');
  }

  // ─────────────────────────────────────────
  // Pending / Auth Lifecycle
  // ─────────────────────────────────────────

  private pendingAgents: Map<WebSocket, NodeJS.Timeout> = new Map();

  private onPendingConnection(ws: WebSocket): void {
    // Send auth challenge
    this.send(ws, { type: 'AUTH_REQUIRED' });

    // Timeout — disconnect if no AUTH within 10s
    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.warn('[WS Gateway] Pending connection timed out — closing');
        ws.close(4001, 'Auth timeout');
      }
      this.pendingAgents.delete(ws);
    }, 10_000);
    this.pendingAgents.set(ws, timeout);

    const onMessage = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'AUTH') {
          if (!msg.token) {
            ws.close(4001, 'Missing token');
            return;
          }
          const agentInfo = verifyAgentToken(msg.token);
          if (!agentInfo) {
            ws.close(4001, 'Invalid token');
            return;
          }
          // Clean up pending state
          const t = this.pendingAgents.get(ws);
          if (t) clearTimeout(t);
          this.pendingAgents.delete(ws);
          ws.removeListener('message', onMessage);
          // Promote to authenticated agent
          this.onConnection(ws, agentInfo.userId);
        } else {
          ws.close(4001, 'First message must be AUTH');
        }
      } catch {
        ws.close(4001, 'Invalid auth message');
      }
    };

    ws.on('message', onMessage);
    ws.on('close', () => {
      const t = this.pendingAgents.get(ws);
      if (t) clearTimeout(t);
      this.pendingAgents.delete(ws);
    });
  }

  // ─────────────────────────────────────────
  // Connection Lifecycle
  // ─────────────────────────────────────────

  private onConnection(ws: WebSocket, userId: string): void {
    console.log(`[WS Gateway] Agent connected: ${userId}`);

    // Replace any stale connection for this user
    const existing = this.agents.get(userId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'Replaced by new connection');
    }
    this.agents.set(userId, ws);

    // Update last_seen in DB (fire-and-forget)
    prisma.agentToken
      .updateMany({ where: { user_id: userId }, data: { last_seen: new Date() } })
      .catch(() => {});

    // Send acknowledgement
    this.send(ws, { type: 'CONNECTED', userId });

    // Push current schedules to agent
    this.pushSchedules(ws, userId);

    // Session reconciliation: the agent sends STATUS {state, sessionId} right after
    // CONNECTED. Reconcile on the first STATUS; fall back to 'idle' after 5s.
    const conn = { reconciled: false, timer: undefined as NodeJS.Timeout | undefined };
    conn.timer = setTimeout(() => {
      if (conn.reconciled) return;
      conn.reconciled = true;
      console.log(`[WS Gateway] No STATUS from ${userId} within 5s — reconciling as idle`);
      this.reconcile(userId, 'idle', undefined);
    }, 5000);

    // Heartbeat — ping every 30s, auto-disconnect on missed pong
    let missedPongs = 0;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(heartbeat);
        return;
      }
      if (missedPongs >= 2) {
        console.warn(`[WS Gateway] Agent ${userId} missed 2 pongs — disconnecting`);
        ws.terminate();
        clearInterval(heartbeat);
        return;
      }
      missedPongs++;
      this.send(ws, { type: 'PING' });
    }, 30_000);

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PONG') {
          missedPongs = 0; // reset on valid pong
        } else {
          if (msg.type === 'STATUS') this.onAgentStatus(userId, conn, msg);
          this.handleAgentMessage(userId, msg);
        }
      } catch (err) {
        console.error('[WS Gateway] Failed to parse agent message:', err);
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      clearTimeout(conn.timer);
      
      const currentWs = this.agents.get(userId);
      if (currentWs === ws) {
        this.agents.delete(userId);
      } else {
        // A new connection has replaced this one
        console.log(`[WS Gateway] Old agent connection closed for ${userId}, but a new one is active. Skipping stop.`);
        return;
      }
      
      console.log(`[WS Gateway] Agent disconnected: ${userId} (${code})`);

      // Give the agent a few seconds to reconnect before we close the session
      setTimeout(() => {
        // If the agent has reconnected, abort the shutdown
        if (this.agents.get(userId)) {
          console.log(`[WS Gateway] Agent ${userId} reconnected. Aborting session stop.`);
          return;
        }

        import('../services/recording.service').then(async (RecordingService) => {
          // Double check again just in case
          if (this.agents.get(userId)) return;
          // Marks stopped, emits stopped:<id> for live viewers, requestAssembly for those with chunks.
          await RecordingService.stopActiveSessionsOf(userId);
        }).catch(console.error);
      }, 8000);
    });

    ws.on('error', (err) => {
      console.error(`[WS Gateway] Agent ${userId} socket error:`, err.message);
    });
  }

  // ─────────────────────────────────────────
  // Session Reconciliation
  // ─────────────────────────────────────────

  private onAgentStatus(userId: string, conn: { reconciled: boolean; timer?: NodeJS.Timeout }, msg: any): void {
    if (!conn.reconciled) {
      conn.reconciled = true;
      clearTimeout(conn.timer);
      this.reconcile(userId, String(msg.state ?? 'unknown'), msg.sessionId);
      return;
    }
    // Later STATUS: adopt the agent's session if it differs from the server's active one.
    if (msg.state === 'recording' && typeof msg.sessionId === 'string') {
      prisma.recordingSession
        .findFirst({ where: { user_id: userId, status: { in: ['pending', 'recording'] } }, orderBy: { created_at: 'desc' } })
        .then((active) => {
          if (!active || active.id !== msg.sessionId) this.reconcile(userId, 'recording', msg.sessionId);
        })
        .catch((err) => console.error(`[WS Gateway] STATUS check failed for ${userId}:`, err.message));
    }
  }

  /** Runs inside the per-user lock so it cannot race an admin start. */
  private reconcile(userId: string, state: string, sessionId: unknown): void {
    import('../services/recording.service').then(async (RS) => {
      const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (targetUser && (targetUser.role === 'admin' || targetUser.role === 'superadmin')) {
        console.log(`[WS Gateway] Skipping reconcile for admin ${userId}`);
        return;
      }
      await RS.withUserLock(userId, async () => {
        if (state === 'recording' && RS.isValidSessionId(sessionId)) {
          console.log(`[WS Gateway] Agent ${userId} is recording ${sessionId} — adopting`);
          await RS.adoptAgentSession(userId, sessionId);
        } else {
          // Re-attaches to an active session (re-sends START_RECORDING) or starts a new one.
          await RS.startSessionUnlocked(userId, userId, '720p');
        }
      });
    }).catch((err) => console.error(`[WS Gateway] Reconcile failed for ${userId}:`, err.message));
  }

  // ─────────────────────────────────────────
  // Incoming Message Handler
  // ─────────────────────────────────────────

  private handleAgentMessage(userId: string, msg: any): void {
    console.log(`[WS Gateway] ← ${userId}: ${msg.type}`);

    switch (msg.type) {
      case 'STATUS':
        // Agent reports its current recording state
        console.log(`[WS Gateway] Agent ${userId} state=${msg.state} session=${msg.sessionId ?? 'none'}`);
        // Clear stale permission errors once capture is healthy again
        if (msg.state === 'recording') {
          this.agentErrors.delete(userId);
        }
        break;

      case 'CHUNK_UPLOADED':
        console.log(`[WS Gateway] Chunk ${msg.chunkIndex} confirmed for session ${msg.sessionId}`);
        break;

      case 'WEBRTC_ANSWER':
      case 'WEBRTC_ICE_CANDIDATE':
      case 'WEBRTC_ERROR':
        // Route signaling message from Agent back to Admin
        if (msg.adminId) {
          const adminWs = this.admins.get(msg.adminId);
          if (adminWs && adminWs.readyState === WebSocket.OPEN) {
            this.send(adminWs, { ...msg, targetUserId: userId });
          } else {
            console.warn(`[WS Gateway] Admin ${msg.adminId} not connected for WebRTC signaling`);
          }
        }
        break;

      case 'ERROR':
        console.error(`[WS Gateway] Agent error from ${userId}: [${msg.code}] ${msg.message}`);
        // Persist for GET /status/:userId so admin sees it even without live WS
        this.agentErrors.set(userId, {
          code: String(msg.code ?? 'ERROR'),
          message: String(msg.message ?? 'Agent error'),
          sessionId: msg.sessionId,
          at: new Date().toISOString(),
        });
        // Fan out to all connected admins (admin-only visibility)
        for (const [, adminWs] of this.admins) {
          if (adminWs.readyState === WebSocket.OPEN) {
            this.send(adminWs, {
              type: 'AGENT_ERROR',
              targetUserId: userId,
              code: msg.code,
              message: msg.message,
              sessionId: msg.sessionId,
            });
          }
        }
        break;

      default:
        console.warn(`[WS Gateway] Unknown message type from ${userId}: ${msg.type}`);
    }
  }

  /** Latest recorded agent error for a user (or null). */
  getAgentError(userId: string): { code: string; message: string; sessionId?: string; at: string } | null {
    return this.agentErrors.get(userId) ?? null;
  }

  /** Clear a stored agent error (e.g. when admin retries start). */
  clearAgentError(userId: string): void {
    this.agentErrors.delete(userId);
  }

  // ─────────────────────────────────────────
  // Admin Connection Lifecycle
  // ─────────────────────────────────────────

  private onAdminConnection(ws: WebSocket, adminId: string): void {
    console.log(`[WS Gateway] Admin connected: ${adminId}`);

    const existing = this.admins.get(adminId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'Replaced by new connection');
    }
    this.admins.set(adminId, ws);

    this.send(ws, { type: 'CONNECTED', adminId });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleAdminMessage(adminId, msg);
      } catch (err) {
        console.error('[WS Gateway] Failed to parse admin message:', err);
      }
    });

    ws.on('close', (code, reason) => {
      if (this.admins.get(adminId) === ws) this.admins.delete(adminId);
      console.log(`[WS Gateway] Admin disconnected: ${adminId} (${code})`);
    });

    ws.on('error', (err) => {
      console.error(`[WS Gateway] Admin ${adminId} socket error:`, err.message);
    });
  }

  private handleAdminMessage(adminId: string, msg: any): void {
    console.log(`[WS Gateway] ← Admin ${adminId}: ${msg.type}`);

    switch (msg.type) {
      case 'WEBRTC_OFFER':
      case 'WEBRTC_ICE_CANDIDATE':
        // Route signaling message from Admin to target Agent
        if (msg.targetUserId) {
          const agentWs = this.agents.get(msg.targetUserId);
          if (agentWs && agentWs.readyState === WebSocket.OPEN) {
            this.send(agentWs, { ...msg, adminId }); // Inject adminId so agent knows who to reply to
          } else {
            console.warn(`[WS Gateway] Agent ${msg.targetUserId} not connected for WebRTC signaling`);
          }
        }
        break;
      default:
        console.warn(`[WS Gateway] Unknown message type from admin ${adminId}: ${msg.type}`);
    }
  }

  // ─────────────────────────────────────────
  // Push Schedules
  // ─────────────────────────────────────────

  private async pushSchedules(ws: WebSocket, userId: string): Promise<void> {
    try {
      const schedules = await prisma.recordingSchedule.findMany({
        where: { user_id: userId, enabled: true },
        select: { id: true, cron_expr: true, action: true, enabled: true },
      });

      const entries: ScheduleEntry[] = schedules.map((s) => ({
        id: s.id,
        cronExpr: s.cron_expr,
        action: s.action as 'start' | 'stop',
        enabled: s.enabled,
      }));

      this.send(ws, { type: 'SCHEDULE', schedules: entries });
    } catch (err) {
      console.error('[WS Gateway] Failed to push schedules:', err);
    }
  }

  // ─────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────

  /** Send a command to a specific agent. Returns true if agent is connected. */
  broadcast(userId: string, message: WsCommand): boolean {
    const ws = this.agents.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(`[WS Gateway] Cannot broadcast to ${userId} — not connected`);
      return false;
    }
    this.send(ws, message);
    console.log(`[WS Gateway] → ${userId}: ${message.type}`);
    return true;
  }

  /** Push updated schedule list to a specific agent */
  async pushSchedulesToAgent(userId: string): Promise<void> {
    const ws = this.agents.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      await this.pushSchedules(ws, userId);
    }
  }

  /** Check if a specific agent is currently connected */
  isConnected(userId: string): boolean {
    const ws = this.agents.get(userId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  /** Get list of all currently connected agent userIds */
  getConnectedAgents(): string[] {
    return Array.from(this.agents.keys()).filter((id) => {
      const ws = this.agents.get(id);
      return ws && ws.readyState === WebSocket.OPEN;
    });
  }

  // ─────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────

  private send(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

// ─────────────────────────────────────────
// Singleton Access
// ─────────────────────────────────────────

let _gateway: RecordingGateway | null = null;

export function initGateway(server: Server): RecordingGateway {
  _gateway = new RecordingGateway(server);
  return _gateway;
}

export function getGateway(): RecordingGateway | null {
  return _gateway;
}
