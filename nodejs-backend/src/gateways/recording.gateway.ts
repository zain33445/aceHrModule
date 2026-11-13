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
import { verifyAgentToken } from '../middleware/requireAgentToken';
import { verifyViewerToken } from '../middleware/requireUser';
import prisma from '../prisma';
import { ruleForUser } from '../services/recording-day';
import { LiveHub, PresenceAgent } from './live-hub';

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
  | 'RECORDING_SETTINGS'
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

/** Close code sent to an agent socket replaced by a newer one of the same user. */
export const AGENT_REPLACED_CLOSE_CODE = 4002;

export class RecordingGateway {
  private wss: WebSocketServer;
  // Map<userId, WebSocket>
  private agents: Map<string, WebSocket> = new Map();
  // Viewer sockets, live streams and presence (admin / HR live view)
  private hub: LiveHub;
  // Latest agent error per userId (for status API / admin UI)
  private agentErrors: Map<string, { code: string; message: string; sessionId?: string; at: string }> = new Map();
  // Protocol of the currently connected agent per user (1 = legacy, 2 = agent-driven v2)
  private agentMeta: Map<string, { protocol: number; deviceId?: string; version?: string }> = new Map();
  // Latest v2 STATUS per user (kept after disconnect so the UI can show "last seen")
  private v2Status: Map<string, { status: Record<string, unknown>; lastStatusAt: string }> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.hub = new LiveHub({
      agentSocket: (userId) => {
        const ws = this.agents.get(userId);
        return ws && ws.readyState === WebSocket.OPEN ? ws : undefined;
      },
      agentStatus: (userId) => this.v2Status.get(userId)?.status,
    });

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
            // S8: viewer tickets are signed with the session secret (typ 'viewer'); agent-secret tokens never work here.
            const adminId = verifyViewerToken(token);
            if (adminId) {
              console.log(`[WS Gateway] Admin upgrade accepted for ${adminId}`);
              this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.hub.onViewerConnection(ws, adminId, (id, msg) => this.handleAdminMessage(id, msg));
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
          const protocol = msg.protocol === 2 ? 2 : 1;
          this.onConnection(ws, agentInfo.userId, protocol, {
            deviceId: typeof msg.deviceId === 'string' ? msg.deviceId.slice(0, 100) : undefined,
            version: typeof msg.version === 'string' ? msg.version.slice(0, 40) : undefined,
          });
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

  private onConnection(ws: WebSocket, userId: string, protocol = 1, info: { deviceId?: string; version?: string } = {}): void {
    console.log(`[WS Gateway] Agent connected: ${userId} (protocol ${protocol}${info.version ? `, v${info.version}` : ''})`);

    // Replace any stale connection for this user. 4002 tells a 1.11.5+ agent it
    // was replaced by another agent of the same user (e.g. signed in on a second
    // PC) so it backs off for minutes instead of reconnecting in 5s and
    // replacing that agent back (endless ping-pong).
    // ponytail: one control socket per user; key agents by device in Phase 1.
    const existing = this.agents.get(userId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      console.warn(`[WS Gateway] Agent ${userId} connected again — replacing the previous connection (another device signed in as the same user?)`);
      existing.close(AGENT_REPLACED_CLOSE_CODE, 'Replaced by another agent of the same user');
      this.hub.onAgentGone(userId, false); // its live streams end; the new connection takes over presence
    }
    this.agents.set(userId, ws);
    this.agentMeta.set(userId, { protocol, ...info });
    this.hub.onAgentConnect(userId, protocol, info.version);

    // Update last_seen in DB (fire-and-forget)
    prisma.agentToken
      .updateMany({ where: { user_id: userId }, data: { last_seen: new Date() } })
      .catch(() => {});

    const conn = { reconciled: false, timer: undefined as NodeJS.Timeout | undefined };
    if (protocol === 2) {
      // v2: agent-driven. No schedules, no reconcile/adopt, no START/STOP — just the CONNECTED payload.
      conn.reconciled = true;
      this.sendConnectedV2(ws, userId);
    } else {
      // Send acknowledgement
      this.send(ws, { type: 'CONNECTED', userId });

      // Push current schedules to agent
      this.pushSchedules(ws, userId);

      // Session reconciliation: the agent sends STATUS {state, sessionId} right after
      // CONNECTED. Reconcile on the first STATUS; fall back to 'idle' after 5s.
      conn.timer = setTimeout(() => {
        if (conn.reconciled) return;
        conn.reconciled = true;
        console.log(`[WS Gateway] No STATUS from ${userId} within 5s — reconciling as idle`);
        this.reconcile(userId, 'idle', undefined);
      }, 5000);
    }

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
        } else if (typeof msg.type === 'string' && msg.type.startsWith('LIVE_')) {
          if (protocol === 2) this.hub.onAgentMessage(userId, msg);
          else console.warn(`[WS Gateway] Ignoring ${msg.type} from protocol-1 agent ${userId}`);
        } else {
          if (msg.type === 'STATUS') {
            if (protocol === 2) this.storeV2Status(userId, msg);
            else this.onAgentStatus(userId, conn, msg);
          }
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
        this.agentMeta.delete(userId);
        this.hub.onAgentGone(userId);
      } else {
        // A new connection has replaced this one
        console.log(`[WS Gateway] Old agent connection closed for ${userId}, but a new one is active. Skipping stop.`);
        return;
      }
      
      console.log(`[WS Gateway] Agent disconnected: ${userId} (${code})`);

      // v2 sessions live on the agent's segments, not on the socket: a disconnect stops nothing.
      if (protocol === 2) return;

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
  // Protocol 2
  // ─────────────────────────────────────────

  private async sendConnectedV2(ws: WebSocket, userId: string): Promise<void> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
      const rule = await ruleForUser(userId);
      const { getRecordingQuality } = await import('../services/recording-v2.service'); // lazy: avoids an import cycle
      this.send(ws, {
        type: 'CONNECTED',
        userId,
        protocol: 2,
        record: !!user && user.status === 'active' && user.role !== 'admin' && user.role !== 'superadmin',
        recordingDay: rule,
        quality: await getRecordingQuality(),
        serverTime: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error(`[WS Gateway] CONNECTED lookup failed for ${userId}:`, err.message);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Lookup failed'); // agent reconnects with backoff
    }
  }

  private storeV2Status(userId: string, msg: any): void {
    const str = (v: unknown, n = 100) => (typeof v === 'string' ? v.slice(0, n) : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const prev = this.v2Status.get(userId)?.status;
    this.v2Status.set(userId, {
      status: {
        state: str(msg.state, 40),
        segmentId: str(msg.segmentId, 64),
        sessionId: str(msg.sessionId, 64),
        loggedIn: typeof msg.loggedIn === 'boolean' ? msg.loggedIn : null,
        backlogChunks: num(msg.backlogChunks),
        backlogBytes: num(msg.backlogBytes),
        diskFreeBytes: num(msg.diskFreeBytes),
        version: str(msg.version, 40),
        screens: typeof msg.screens === 'number' && Number.isInteger(msg.screens) && msg.screens >= 1 && msg.screens <= 16 ? msg.screens : 1,
        liveViewers: num(msg.liveViewers), // agent's own count; informational, not authoritative
      },
      lastStatusAt: new Date().toISOString(),
    });
    const cur = this.v2Status.get(userId)!.status;
    if (!prev || prev.state !== cur.state || prev.loggedIn !== cur.loggedIn || prev.version !== cur.version || prev.screens !== cur.screens) this.hub.touch(userId);
  }

  /** Presence snapshot for the live grid (same data as LIVE_PRESENCE). */
  getLivePresence(): Promise<PresenceAgent[]> {
    return this.hub.getPresence();
  }

  /** Every agent seen since boot: connection, protocol and the latest v2 STATUS (flat). */
  getAgentsStatus(): Record<string, unknown>[] {
    const ids = new Set<string>([...this.agents.keys(), ...this.v2Status.keys()]);
    return [...ids].map((userId) => {
      const meta = this.agentMeta.get(userId);
      const st = this.v2Status.get(userId);
      return {
        userId,
        connected: this.isConnected(userId),
        protocol: meta?.protocol ?? (st ? 2 : null),
        deviceId: meta?.deviceId ?? null,
        ...(st?.status ?? {}),
        lastStatusAt: st?.lastStatusAt ?? null,
      };
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
          if (!this.hub.sendToAdmin(String(msg.adminId), { ...msg, targetUserId: userId })) {
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
        this.hub.broadcastViewers({
          type: 'AGENT_ERROR',
          targetUserId: userId,
          code: msg.code,
          message: msg.message,
          sessionId: msg.sessionId,
        });
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
    if (this.agentMeta.get(userId)?.protocol === 2 && (message.type === 'START_RECORDING' || message.type === 'STOP_RECORDING')) {
      console.log(`[WS Gateway] Not sending ${message.type} to protocol-2 agent ${userId} (agent-driven)`);
      return true;
    }
    this.send(ws, message);
    console.log(`[WS Gateway] → ${userId}: ${message.type}`);
    return true;
  }

  /** Tell every connected protocol-2 agent the current recording quality (applied from its next recording day). */
  async pushRecordingSettings(): Promise<void> {
    const { getRecordingQuality } = await import('../services/recording-v2.service');
    const quality = await getRecordingQuality();
    for (const [userId, ws] of this.agents) {
      if (this.agentMeta.get(userId)?.protocol === 2 && ws.readyState === WebSocket.OPEN) this.send(ws, { type: 'RECORDING_SETTINGS', quality });
    }
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
