/**
 * live-hub.ts — viewer sockets, live streams and agent presence for live view
 * (docs/recording-v2.md §10-§11). Signalling only: media is peer-to-peer.
 *
 * The recording gateway owns the agent sockets and hands the hub three lookups
 * (HubHost); it forwards agent connect/close/status/LIVE_* events here and
 * routes `/admin-recording-ws` upgrades to onViewerConnection.
 */
import { WebSocket } from 'ws';
import crypto from 'crypto';
import prisma from '../prisma';
import { getIceServers } from '../services/turn.service';
import { hasRecordingAccess } from '../middleware/requireRecordingAccess';

export interface HubHost {
  agentSocket(userId: string): WebSocket | undefined; // OPEN sockets only
  agentStatus(userId: string): Record<string, unknown> | undefined; // latest v2 STATUS (flat)
}

export interface PresenceAgent {
  userId: string;
  name: string;
  department: string | null;
  connected: boolean;
  liveCapable: boolean;
  recording: boolean;
  loggedIn: boolean | null;
  state: string | null;
  viewers: number;
  version: string | null;
}

interface Viewer { id: string; adminId: string; ws: WebSocket; streams: Set<string>; missed: number; seq: number }
interface Stream { viewerId: string; userId: string; quality: string; createdAt: number }
interface Seen { protocol: number; version: string | null; goneAt: number | null }
interface UserInfo { name: string; department: string | null; admin: boolean }

const QUALITIES = ['grid', 'focus'];
const GONE_KEEP_MS = 60_000;
const DEBOUNCE_MS = 250;
const ACCESS_RECHECK_MS = 5 * 60_000; // S7: viewer access is re-checked this often
const MAX_STREAMS_PER_VIEWER = 32;
const maxViewersPerAgent = () => Math.max(1, parseInt(process.env.LIVE_MAX_VIEWERS_PER_AGENT || '4', 10) || 4);

export class LiveHub {
  private viewers = new Map<string, Viewer>();
  private streams = new Map<string, Stream>();
  private seen = new Map<string, Seen>();
  private users = new Map<string, UserInfo | null>();
  private timers = new Map<string, NodeJS.Timeout>();
  private seq = 0;

  constructor(private host: HubHost) {}

  // ───────── presence ─────────

  private async user(userId: string): Promise<UserInfo | null> {
    if (this.users.has(userId)) return this.users.get(userId)!;
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, role: true, department: { select: { name: true } } },
    }).catch(() => null);
    const info = u ? { name: u.name, department: u.department?.name ?? null, admin: u.role === 'admin' || u.role === 'superadmin' } : null;
    this.users.set(userId, info);
    return info;
  }

  private streamCount(userId: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.userId === userId) n++;
    return n;
  }

  private async presenceOf(userId: string): Promise<PresenceAgent | null> {
    const seen = this.seen.get(userId);
    if (!seen) return null;
    const connected = !!this.host.agentSocket(userId);
    if (!connected && (seen.goneAt === null || Date.now() - seen.goneAt > GONE_KEEP_MS)) return null;
    const u = await this.user(userId);
    if (!u || u.admin) return null;
    const st = this.host.agentStatus(userId);
    let state: string | null;
    let recording: boolean;
    if (seen.protocol === 2) {
      state = typeof st?.state === 'string' ? st.state : null;
      recording = state === 'recording';
    } else {
      const active = await prisma.recordingSession
        .count({ where: { user_id: userId, status: { in: ['pending', 'recording'] } } })
        .catch(() => 0);
      recording = active > 0;
      state = recording ? 'recording' : 'idle';
    }
    return {
      userId,
      name: u.name,
      department: u.department,
      connected,
      liveCapable: seen.protocol === 2,
      recording,
      loggedIn: seen.protocol === 2 && typeof st?.loggedIn === 'boolean' ? st.loggedIn : null,
      state,
      viewers: this.streamCount(userId),
      version: (typeof st?.version === 'string' ? st.version : null) ?? seen.version,
    };
  }

  /** Full snapshot: connected agents plus ones gone for less than 60 s. */
  async getPresence(): Promise<PresenceAgent[]> {
    const now = Date.now();
    for (const [id, s] of this.seen) if (s.goneAt !== null && now - s.goneAt > GONE_KEEP_MS && !this.host.agentSocket(id)) this.seen.delete(id);
    const all = await Promise.all([...this.seen.keys()].map((id) => this.presenceOf(id)));
    return all.filter((a): a is PresenceAgent => !!a);
  }

  /** Debounced per user: broadcast LIVE_PRESENCE_UPDATE to every viewer. */
  touch(userId: string): void {
    if (this.timers.has(userId)) return;
    this.timers.set(userId, setTimeout(async () => {
      this.timers.delete(userId);
      if (this.viewers.size === 0) return;
      const agent = await this.presenceOf(userId).catch(() => null);
      if (agent) for (const v of this.viewers.values()) this.send(v.ws, { type: 'LIVE_PRESENCE_UPDATE', agent });
    }, DEBOUNCE_MS));
  }

  // ───────── agent events (called by the gateway) ─────────

  onAgentConnect(userId: string, protocol: number, version?: string): void {
    this.users.delete(userId); // refresh name/department on reconnect
    this.seen.set(userId, { protocol, version: version ?? null, goneAt: null });
    this.touch(userId);
  }

  /** Socket closed or replaced: viewers learn their streams are over. */
  onAgentGone(userId: string, markGone = true): void {
    for (const [id, s] of this.streams) {
      if (s.userId !== userId) continue;
      const v = this.viewers.get(s.viewerId);
      if (v) { this.send(v.ws, { type: 'LIVE_ENDED', streamId: id, reason: 'agent_disconnected' }); v.streams.delete(id); }
      this.streams.delete(id);
    }
    const seen = this.seen.get(userId);
    if (seen && markGone) seen.goneAt = Date.now();
    this.touch(userId);
  }

  /** Agent LIVE_SIGNAL / LIVE_STATE → the owning viewer. */
  onAgentMessage(userId: string, msg: any): void {
    const stream = typeof msg.streamId === 'string' ? this.streams.get(msg.streamId) : undefined;
    if (!stream || stream.userId !== userId) {
      console.warn(`[LiveHub] dropped ${msg.type} from agent ${userId}: unknown or foreign stream`);
      return;
    }
    const v = this.viewers.get(stream.viewerId);
    if (!v) return;
    if (msg.type === 'LIVE_SIGNAL') {
      this.send(v.ws, { type: 'LIVE_SIGNAL', streamId: msg.streamId, description: msg.description, candidate: msg.candidate });
    } else if (msg.type === 'LIVE_STATE') {
      this.send(v.ws, { type: 'LIVE_STATE', streamId: msg.streamId, state: String(msg.state ?? '').slice(0, 40), error: typeof msg.error === 'string' ? msg.error.slice(0, 300) : undefined });
    }
  }

  /** Legacy WEBRTC_* relay: the admin's most recent viewer socket. */
  sendToAdmin(adminId: string, msg: object): boolean {
    let best: Viewer | undefined;
    for (const v of this.viewers.values()) if (v.adminId === adminId && v.ws.readyState === WebSocket.OPEN && (!best || v.seq > best.seq)) best = v;
    if (!best) return false;
    this.send(best.ws, msg);
    return true;
  }

  broadcastViewers(msg: object): void {
    for (const v of this.viewers.values()) this.send(v.ws, msg);
  }

  // ───────── viewer sockets ─────────

  onViewerConnection(ws: WebSocket, adminId: string, onLegacy: (adminId: string, msg: any) => void): void {
    const viewer: Viewer = { id: crypto.randomUUID(), adminId, ws, streams: new Set(), missed: 0, seq: ++this.seq };
    this.viewers.set(viewer.id, viewer);
    console.log(`[LiveHub] Viewer connected: ${viewer.id} (admin ${adminId}, ${this.viewers.size} total)`);

    this.send(ws, { type: 'CONNECTED', viewerId: viewer.id, adminId, iceServers: getIceServers().iceServers });
    this.getPresence().then((agents) => this.send(ws, { type: 'LIVE_PRESENCE', agents })).catch((err) => console.error('[LiveHub] presence failed:', err.message));

    const hb = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(hb);
      if (viewer.missed >= 2) {
        console.warn(`[LiveHub] Viewer ${viewer.id} missed 2 pongs — terminating`);
        clearInterval(hb);
        ws.terminate();
        return;
      }
      viewer.missed++;
      this.send(ws, { type: 'PING' });
    }, 30_000);

    // S7: a revoked grant / deactivated account must not keep a socket open.
    const access = setInterval(() => {
      hasRecordingAccess(adminId).then((ok) => {
        if (ok || ws.readyState !== WebSocket.OPEN) return;
        console.warn(`[LiveHub] Viewer ${viewer.id} (user ${adminId}) lost recording access — closing`);
        ws.close(4003, 'access revoked');
      }).catch((err) => console.error('[LiveHub] access recheck failed:', err.message));
    }, ACCESS_RECHECK_MS);

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return console.error('[LiveHub] Failed to parse viewer message'); }
      if (!msg || typeof msg.type !== 'string') return;
      this.onViewerMessage(viewer, msg, onLegacy).catch((err) => console.error('[LiveHub] viewer message failed:', err.message));
    });

    ws.on('close', () => {
      clearInterval(hb);
      clearInterval(access);
      this.viewers.delete(viewer.id);
      for (const id of viewer.streams) this.dropStream(id, true);
      console.log(`[LiveHub] Viewer disconnected: ${viewer.id}`);
    });
    ws.on('error', (err) => console.error(`[LiveHub] Viewer ${viewer.id} socket error:`, err.message));
  }

  private async onViewerMessage(v: Viewer, msg: any, onLegacy: (adminId: string, msg: any) => void): Promise<void> {
    switch (msg.type) {
      case 'PONG': v.missed = 0; return;
      case 'LIVE_SUBSCRIBE': return this.subscribe(v, msg);
      case 'LIVE_QUALITY':
      case 'LIVE_UNSUBSCRIBE':
      case 'LIVE_SIGNAL': {
        const stream = typeof msg.streamId === 'string' ? this.streams.get(msg.streamId) : undefined;
        if (!stream || stream.viewerId !== v.id) {
          console.warn(`[LiveHub] dropped ${msg.type} from viewer ${v.id}: unknown or foreign stream`);
          return;
        }
        const agent = this.host.agentSocket(stream.userId);
        if (msg.type === 'LIVE_UNSUBSCRIBE') return this.dropStream(msg.streamId, true);
        if (msg.type === 'LIVE_QUALITY') {
          if (!QUALITIES.includes(msg.quality)) return console.warn(`[LiveHub] dropped LIVE_QUALITY: bad quality`);
          stream.quality = msg.quality;
          if (agent) this.send(agent, { type: 'LIVE_QUALITY', streamId: msg.streamId, quality: msg.quality });
        } else if (agent) {
          this.send(agent, { type: 'LIVE_SIGNAL', streamId: msg.streamId, description: msg.description, candidate: msg.candidate });
        }
        return;
      }
      case 'WEBRTC_OFFER':
      case 'WEBRTC_ICE_CANDIDATE':
        return onLegacy(v.adminId, msg);
      default:
        console.warn(`[LiveHub] Unknown message type from viewer ${v.id}: ${msg.type}`);
    }
  }

  private async subscribe(v: Viewer, msg: any): Promise<void> {
    const userId = typeof msg.userId === 'string' ? msg.userId : '';
    if (!userId || !QUALITIES.includes(msg.quality)) return console.warn(`[LiveHub] dropped LIVE_SUBSCRIBE from ${v.id}: bad userId/quality`);
    const reject = (reason: string) => this.send(v.ws, { type: 'LIVE_REJECTED', userId, reason });

    if (!(await hasRecordingAccess(v.adminId))) return reject('not_allowed'); // S7: fresh check on every subscribe

    const info = await this.user(userId); // awaited first: every check below is synchronous (no cap race)
    const agent = this.host.agentSocket(userId);
    if (!agent) return reject('offline');
    if (this.seen.get(userId)?.protocol !== 2 || !info || info.admin) return reject('not_live_capable');
    if (this.streamCount(userId) >= maxViewersPerAgent() || v.streams.size >= MAX_STREAMS_PER_VIEWER) return reject('viewer_limit');
    if (v.ws.readyState !== WebSocket.OPEN) return;

    const streamId = crypto.randomUUID();
    this.streams.set(streamId, { viewerId: v.id, userId, quality: msg.quality, createdAt: Date.now() });
    v.streams.add(streamId);
    const ice = getIceServers().iceServers; // fresh credentials per stream (S12)
    this.send(agent, { type: 'LIVE_START', streamId, quality: msg.quality, iceServers: ice });
    this.send(v.ws, { type: 'LIVE_SUBSCRIBED', streamId, userId, quality: msg.quality, iceServers: ice });
    this.touch(userId);
  }

  /** Forget a stream; optionally tell its agent to stop. */
  private dropStream(streamId: string, stopAgent: boolean): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    this.viewers.get(s.viewerId)?.streams.delete(streamId);
    const agent = this.host.agentSocket(s.userId);
    if (stopAgent && agent) this.send(agent, { type: 'LIVE_STOP', streamId });
    this.touch(s.userId);
  }

  private send(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
