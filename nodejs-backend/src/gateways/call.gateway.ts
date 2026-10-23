/**
 * call.gateway.ts — WebSocket gateway for voice & video call signalling.
 *
 * This is a *signalling* server only. It never touches media: the audio and
 * video travel directly between peers over WebRTC, and this gateway relays the
 * SDP offers/answers and ICE candidates needed to establish those peer
 * connections.
 *
 * Topology is a full mesh: every participant holds one RTCPeerConnection per
 * remote participant. To make that work, the server must be the single source
 * of truth for *who is in the call* — so peer membership lives here, keyed by
 * a `peer_id` that is assigned when a participant joins.
 *
 *   - Accepts connections at /call-ws?token=<token>
 *   - The token is a short-lived signed ticket (5 min) or a session/agent JWT
 *   - Assigns a peer_id per participant and broadcasts membership changes
 *   - Relays CALL_SIGNAL (offer / answer / ICE candidate) between peers,
 *     authorising that the sender is actually part of the call
 *   - Relays CALL_MEDIA_STATE so peers can render mute/camera indicators
 *
 * Note: recording.gateway.ts and chat.gateway.ts also listen for 'upgrade'.
 * They must yield the /call-ws path, otherwise the recording gateway (which
 * destroys unknown paths) will kill the socket before it gets here.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import prisma from '../prisma';
import { verifyUserToken } from '../middleware/requireUser';
import { verifyAgentToken } from '../middleware/requireAgentToken';
import {
  activateCall,
  endCallSession,
  isParticipant,
  markParticipantLeft,
  upsertParticipantPeer,
} from '../services/call.service';
import { finalizeParticipantRecording } from '../services/callrecording.service';

const CALL_PATH = '/call-ws';

/** Set CALL_DEBUG=1 to trace the signalling messages in the server log. */
const CALL_DEBUG = process.env.CALL_DEBUG === '1';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;
const AUTH_TIMEOUT_MS = 10_000;
/** How often ringing calls are checked for timeouts. */
const RING_SWEEP_INTERVAL_MS = 15_000;
/** How long a call may ring before it is considered missed. */
const RING_TIMEOUT_MS = 30_000;

export interface CallPeer {
  peerId: string;
  userId: string;
  name: string;
  ws: WebSocket;
}

interface ActiveCall {
  callId: string;
  startedBy: string;
  status: 'ringing' | 'active' | 'ended';
  peers: Map<string, CallPeer>;
  createdAt: number;
  /** Recording consent state. All-or-nothing: one decline aborts the recording. */
  recording: {
    requested: boolean;
    consented: Set<string>;
    declined: Set<string>;
  };
}

interface SocketState {
  userId: string;
  name: string;
  role: string;
  callId: string | null;
  peerId: string | null;
  isAlive: boolean;
  pending: boolean;
}

/** Public shape of a peer, safe to send to other clients. */
interface PublicPeer {
  peerId: string;
  userId: string;
  name: string;
}

export class CallGateway {
  private wss: WebSocketServer;
  /** userId -> live sockets (a user may have several windows/devices). */
  private clients: Map<string, Set<WebSocket>> = new Map();
  private states: Map<WebSocket, SocketState> = new Map();
  /** callId -> live call state. */
  private calls: Map<string, ActiveCall> = new Map();
  private heartbeat: NodeJS.Timeout;
  private sweepTimer: NodeJS.Timeout;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== CALL_PATH) return; // not ours — another gateway handles it

      const token = url.searchParams.get('token');

      if (!token) {
        // No ticket in the URL — fall back to the in-band AUTH handshake
        // (used by the Electron agent, which must not put long-lived
        // credentials in a URL that may be logged).
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onPendingConnection(ws));
        return;
      }

      const identity = this.resolveIdentity(token);
      if (!identity) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onConnection(ws, identity.userId, identity.name, identity.role)
      );
    });

    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweepRingingCalls(), RING_SWEEP_INTERVAL_MS);

    console.log(`[Call WS] gateway initialized (${CALL_PATH})`);
  }

  // ── Identity ─────────────────────────────────────────────

  /**
   * Accepts a call ticket, a session token, or an agent token.
   * Returns the identity or null when the token is invalid/expired.
   */
  private resolveIdentity(
    token: string
  ): { userId: string; name: string; role: string } | null {
    const userToken = verifyUserToken(token);
    if (userToken) {
      return {
        userId: userToken.userId,
        name: userToken.name || userToken.userId,
        role: userToken.role || 'employee',
      };
    }

    const agentToken = verifyAgentToken(token);
    if (agentToken) {
      return { userId: agentToken.userId, name: agentToken.userId, role: 'agent' };
    }

    return null;
  }

  // ── Connection lifecycle ─────────────────────────────────

  private onPendingConnection(ws: WebSocket): void {
    const state: SocketState = {
      userId: '',
      name: '',
      role: '',
      callId: null,
      peerId: null,
      isAlive: true,
      pending: true,
    };
    this.states.set(ws, state);

    this.send(ws, { type: 'AUTH_REQUIRED' });

    const timer = setTimeout(() => {
      if (this.states.get(ws)?.pending) {
        ws.close(4001, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type !== 'AUTH') {
        ws.close(4001, 'First message must be AUTH');
        return;
      }

      const identity = this.resolveIdentity(String(msg.token || ''));
      if (!identity) {
        ws.close(4001, 'Invalid token');
        return;
      }

      clearTimeout(timer);
      state.pending = false;
      state.userId = identity.userId;
      state.name = identity.name;
      state.role = identity.role;

      this.registerClient(ws, identity.userId);
      this.send(ws, { type: 'CONNECTED', userId: identity.userId });
      this.sendPendingIncomingCalls(identity.userId);
    });
  }

  private onConnection(
    ws: WebSocket,
    userId: string,
    name: string,
    role: string
  ): void {
    const state: SocketState = {
      userId,
      name,
      role,
      callId: null,
      peerId: null,
      isAlive: true,
      pending: false,
    };
    this.states.set(ws, state);
    this.registerClient(ws, userId);

    this.send(ws, { type: 'CONNECTED', userId, name });

    this.sendPendingIncomingCalls(userId);

    ws.on('message', (data: Buffer) => {
      this.onMessage(ws, data).catch((err) =>
        console.error('[Call WS] message handler failed:', err)
      );
    });

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('close', () => {
      this.cleanupSocket(ws);
    });

    ws.on('error', () => {
      /* the close handler performs the cleanup */
    });
  }

  private registerClient(ws: WebSocket, userId: string): void {
    if (!this.clients.has(userId)) this.clients.set(userId, new Set());
    this.clients.get(userId)!.add(ws);
  }

  // ── Message handling ─────────────────────────────────────

  private async onMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const state = this.states.get(ws);
    if (!state || state.pending) return;

    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'PING':
        this.send(ws, { type: 'PONG' });
        break;

      case 'PONG':
        state.isAlive = true;
        break;

      case 'CALL_JOIN':
        await this.handleJoin(ws, state, String(msg.callId || ''));
        break;

      case 'CALL_SIGNAL':
        this.handleSignal(state, msg);
        break;

      case 'CALL_MEDIA_STATE':
        this.handleMediaState(state, msg);
        break;

      case 'CALL_LEAVE':
        await this.handleLeave(ws, state, String(msg.callId || ''));
        break;

      case 'CALL_END':
        await this.handleEnd(state, String(msg.callId || ''));
        break;

      case 'CALL_RECORD_REQUEST':
        this.handleRecordRequest(state);
        break;

      case 'CALL_RECORD_CONSENT':
        this.handleRecordConsent(state, !!msg.consent);
        break;

      case 'CALL_RECORD_STOP':
        this.handleRecordStop(state);
        break;

      default:
        break;
    }
  }

  /**
   * Joins a call. The server is authoritative about membership, so on join we
   * publish the full peer list to the joiner and notify everyone else.
   *
   * The joiner is the *offerer* towards every peer that was already present,
   * which keeps the initial connection free of offer collisions.
   */
  private async handleJoin(
    ws: WebSocket,
    state: SocketState,
    callId: string
  ): Promise<void> {
    if (!callId) return;

    const session = await prisma.callSession.findUnique({
      where: { id: callId },
      select: { id: true, status: true, started_by: true, max_participants: true },
    });

    if (!session || session.status === 'ended') {
      this.send(ws, { type: 'CALL_ERROR', callId, message: 'Call no longer exists.' });
      return;
    }

    const allowed = await isParticipant(callId, state.userId);
    if (!allowed) {
      this.send(ws, { type: 'CALL_ERROR', callId, message: 'You are not part of this call.' });
      return;
    }

    // A user may only be in one call per connection — drop any previous one.
    if (state.callId && state.callId !== callId) {
      await this.handleLeave(ws, state, state.callId);
    }

    let call = this.calls.get(callId);
    if (!call) {
      call = {
        callId,
        startedBy: session.started_by,
        status: session.status,
        peers: new Map(),
        createdAt: Date.now(),
        recording: { requested: false, consented: new Set(), declined: new Set() },
      };
      this.calls.set(callId, call);
    }

    // The peer id identifies the *participant*, not the connection. When the
    // same person reconnects (a new socket, a second tab) their peer id is
    // kept, so the other participants' peer connections stay valid. Handing
    // out a new id would silently invalidate that peer's signalling — the
    // server would drop every offer and answer it sent.
    let existing: CallPeer | undefined;
    for (const peer of call.peers.values()) {
      if (peer.userId === state.userId) {
        existing = peer;
        break;
      }
    }

    if (!existing && call.peers.size >= session.max_participants) {
      this.send(ws, { type: 'CALL_ERROR', callId, message: 'This call is full.' });
      return;
    }

    const peerId = existing ? existing.peerId : this.generatePeerId();
    const peer: CallPeer = existing || {
      peerId,
      userId: state.userId,
      name: state.name,
      ws,
    };
    peer.ws = ws;
    peer.userId = state.userId;
    peer.name = state.name || peer.name;
    call.peers.set(peerId, peer);

    const isNewPeer = !existing;

    state.callId = callId;
    state.peerId = peerId;

    await upsertParticipantPeer(callId, state.userId, peerId);

    const isHost = session.started_by === state.userId;

    if (!isHost) {
      // A callee joining means they accepted the invitation: the call is now
      // live and the call-log row becomes "answered".
      call.status = 'active';
      await activateCall(callId, [state.userId]);
    }

    const others: PublicPeer[] = Array.from(call.peers.values())
      .filter((p) => p.peerId !== peerId)
      .map((p) => ({ peerId: p.peerId, userId: p.userId, name: p.name }));

    this.send(ws, {
      type: 'CALL_JOINED',
      callId,
      selfPeerId: peerId,
      peers: others,
    });

    // Tell the others about a *new* participant. A participant that is
    // rejoining is already known to them, and announcing it again would
    // make them rebuild connections that are working.
    if (isNewPeer) {
      this.broadcastToCall(
        call,
        {
          type: 'CALL_PEER_JOINED',
          callId,
          peer: { peerId, userId: state.userId, name: state.name },
        },
        peerId
      );
    }

    console.log(
      `[Call WS] ${state.userId} joined ${callId} as ${peerId} (${call.peers.size} peers)`
    );
  }

  /**
   * Relays an SDP offer/answer or ICE candidate to a specific peer.
   * The server does not interpret the payload — it only authorises and routes.
   */
  private handleSignal(state: SocketState, msg: any): void {
    const callId = String(msg.callId || '');
    const toPeerId = String(msg.toPeerId || '');
    if (!callId || !toPeerId) return;

    const call = this.calls.get(callId);
    if (!call) return;

    // Authorisation: the sender must actually be a peer of this call.
    if (!state.peerId || !call.peers.has(state.peerId)) {
      if (CALL_DEBUG) {
        console.log(
          `[Call WS][debug] DROPPED ${msg.signalType} from unknown peer ${state.peerId}`
        );
      }
      return;
    }

    const target = call.peers.get(toPeerId);
    if (!target) {
      if (CALL_DEBUG) {
        console.log(
          `[Call WS][debug] DROPPED ${msg.signalType} - unknown target ${toPeerId}`
        );
      }
      return;
    }

    this.send(target.ws, {
      type: 'CALL_SIGNAL',
      callId,
      fromPeerId: state.peerId,
      signalType: msg.signalType,
      payload: msg.payload,
    });  }

  /** Broadcasts a participant's mic/camera state to the rest of the call. */
  private handleMediaState(state: SocketState, msg: any): void {
    const callId = String(msg.callId || '');
    if (!callId || !state.peerId) return;

    const call = this.calls.get(callId);
    if (!call) return;
    if (!call.peers.has(state.peerId)) return;

    this.broadcastToCall(
      call,
      {
        type: 'CALL_MEDIA_STATE',
        callId,
        peerId: state.peerId,
        userId: state.userId,
        mic: !!msg.mic,
        cam: !!msg.cam,
      },
      state.peerId
    );
  }

  private async handleLeave(
    ws: WebSocket,
    state: SocketState,
    callId: string
  ): Promise<void> {
    if (!callId) return;

    const call = this.calls.get(callId);
    if (call && state.peerId && call.peers.has(state.peerId)) {
      call.peers.delete(state.peerId);
      this.broadcastToCall(call, {
        type: 'CALL_PEER_LEFT',
        callId,
        peerId: state.peerId,
        userId: state.userId,
      });
    }

    state.callId = null;
    state.peerId = null;

    await markParticipantLeft(callId, state.userId);

    if (call && call.peers.size === 0) {
      await this.finalizeCall(callId);
    }
  }

  /** Ends the call for everyone. Only the host (or an admin) may do this. */
  private async handleEnd(state: SocketState, callId: string): Promise<void> {
    if (!callId) return;

    const call = this.calls.get(callId);
    if (!call) return;

    const isAdmin = state.role === 'admin' || state.role === 'superadmin';
    if (call.startedBy !== state.userId && !isAdmin) {
      const ownPeer = state.peerId ? call.peers.get(state.peerId) : undefined;
      this.send(ownPeer?.ws, {
        type: 'CALL_ERROR',
        callId,
        message: 'Only the host can end this call.',
      });
      return;
    }

    this.broadcastToCall(call, { type: 'CALL_ENDED', callId, reason: 'ended_by_host' });
    await this.finalizeCall(callId);
  }

  // ── Public API (used by the REST routes) ─────────────────

  /**
   * Pushes any call that is still ringing for this user.
   *
   * The ringing notice is normally pushed the moment the call is created, but
   * the client may connect afterwards (first sign-in of the day, a reconnect
   * mid-ring, a late-joining browser tab). Without this, the invite would
   * silently never be seen.
   */
  private async sendPendingIncomingCalls(userId: string): Promise<void> {
    try {
      const pending = await prisma.callSession.findMany({
        where: {
          status: 'ringing',
          started_by: { not: userId },
          participants: { some: { user_id: userId, left_at: null } },
        },
        select: {
          id: true,
          started_by_user: { select: { id: true, name: true } },
        },
        take: 5,
      });

      for (const call of pending) {
        this.sendToUser(userId, {
          type: 'CALL_INCOMING',
          callId: call.id,
          from: { userId: call.started_by_user.id, name: call.started_by_user.name },
        });
      }
    } catch (err) {
      console.error('[Call WS] could not list pending incoming calls:', err);
    }
  }

  /**
   * Pushes an incoming-call notice to every live socket of the callee.
   */
  ringCall(callId: string, from: { userId: string; name: string }, targetUserIds: string[]): void {
    for (const userId of targetUserIds) {
      this.sendToUser(userId, {
        type: 'CALL_INCOMING',
        callId,
        from: { userId: from.userId, name: from.name },
      });
    }
  }

  /** Tells the caller that their invite was declined. */
  notifyDeclined(callId: string, calleeUserId: string, hostUserId: string): void {
    this.sendToUser(hostUserId, { type: 'CALL_DECLINED', callId, calleeUserId });
  }

  /**
   * Ends a call for everyone and cleans up the live state.
   * Used by the REST route, which has no WebSocket of its own.
   */
  async endCall(callId: string, byUserId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;

    this.broadcastToCall(call, { type: 'CALL_ENDED', callId, reason: 'ended_by_host' });
    await this.finalizeCall(callId);
  }

  /** Tells the callee that the caller hung up before they answered. */
  notifyCancelled(callId: string, hostUserId: string, targetUserIds: string[]): void {
    for (const userId of targetUserIds) {
      this.sendToUser(userId, { type: 'CALL_CANCELLED', callId, hostUserId });
    }
  }

  /** Is the user currently connected to the call gateway? */
  isUserConnected(userId: string): boolean {
    const set = this.clients.get(userId);
    return !!set && set.size > 0;
  }

  /** Live calls the given user is currently a peer of. */
  getActiveCallIdsForUser(userId: string): string[] {
    const ids: string[] = [];
    for (const [callId, call] of this.calls) {
      for (const peer of call.peers.values()) {
        if (peer.userId === userId) {
          ids.push(callId);
          break;
        }
      }
    }
    return ids;
  }

  // ── Recording consent ───────────────────────────────────

  /**
   * The host asks to start recording. Every participant — including the host —
   * must consent, because a recording that captures someone's voice without
   * their agreement is not defensible for an HR system.
   */
  private handleRecordRequest(state: SocketState): void {
    if (!state.callId || !state.peerId) return;

    const call = this.calls.get(state.callId);
    if (!call) return;

    const isAdmin = state.role === 'admin' || state.role === 'superadmin';
    if (call.startedBy !== state.userId && !isAdmin) {
      this.send(call.peers.get(state.peerId)?.ws, {
        type: 'CALL_ERROR',
        callId: state.callId,
        message: 'Only the host can start a recording.',
      });
      return;
    }

    if (call.recording.requested) return;

    call.recording.requested = true;
    call.recording.consented = new Set();
    call.recording.declined = new Set();

    // The requester consents implicitly — they pressed the button.
    call.recording.consented.add(state.peerId);

    this.broadcastToCall(
      call,
      {
        type: 'CALL_RECORD_CONSENT_REQUEST',
        callId: state.callId,
        requestedBy: state.userId,
      },
      state.peerId
    );

    this.maybeStartRecording(call);
  }

  /** A participant answered the consent prompt. */
  private handleRecordConsent(state: SocketState, consent: boolean): void {
    if (!state.callId || !state.peerId) return;

    const call = this.calls.get(state.callId);
    if (!call || !call.recording.requested) return;
    if (!call.peers.has(state.peerId)) return;

    if (consent) {
      call.recording.consented.add(state.peerId);
    } else {
      call.recording.declined.add(state.peerId);
      // One decline aborts the whole recording.
      this.broadcastToCall(call, {
        type: 'CALL_RECORD_ABORT',
        callId: state.callId,
        reason: 'declined',
        declinedBy: state.userId,
      });
      call.recording.requested = false;
      call.recording.consented = new Set();
      call.recording.declined = new Set();
      prisma.callSession
        .updateMany({
          where: { id: state.callId },
          data: { is_recording: false, recording_consent: false },
        })
        .catch(() => {});
      return;
    }

    this.maybeStartRecording(call);
  }

  /** Starts the recording once every participant has consented. */
  private maybeStartRecording(call: ActiveCall): void {
    if (!call.recording.requested) return;
    if (call.recording.consented.size < call.peers.size) return;

    this.broadcastToCall(call, {
      type: 'CALL_RECORD_START',
      callId: call.callId,
    });

    prisma.callSession
      .updateMany({
        where: { id: call.callId },
        data: { is_recording: true, recording_consent: true },
      })
      .catch((err) => console.error('[Call WS] failed to flag the recording:', err));
  }

  /** Stops the recording for everyone. */
  private handleRecordStop(state: SocketState): void {
    if (!state.callId) return;

    const call = this.calls.get(state.callId);
    if (!call) return;

    this.broadcastToCall(call, { type: 'CALL_RECORD_STOP', callId: state.callId });

    call.recording.requested = false;
    call.recording.consented = new Set();
    call.recording.declined = new Set();

    prisma.callSession
      .updateMany({
        where: { id: state.callId },
        data: { is_recording: false },
      })
      .catch(() => {});
  }

  // ── Internals ────────────────────────────────────────────

  private async finalizeCall(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) {
      call.status = 'ended';
      this.calls.delete(callId);
    }
    try {
      await endCallSession(callId);
    } catch (err) {
      console.error('[Call WS] failed to end call session:', err);
    }

    // Assemble whatever audio was uploaded into playable files.
    try {
      const participants = await prisma.callParticipant.findMany({
        where: { call_id: callId },
        select: { user_id: true },
      });
      for (const p of participants) {
        await finalizeParticipantRecording(callId, p.user_id);
      }
    } catch (err) {
      console.error('[Call WS] failed to finalise call recordings:', err);
    }
  }

  private cleanupSocket(ws: WebSocket): void {
    const state = this.states.get(ws);
    if (!state) return;
    this.states.delete(ws);

    const set = this.clients.get(state.userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.clients.delete(state.userId);
    }

    if (state.callId && state.peerId) {
      const call = this.calls.get(state.callId);
      if (call && call.peers.has(state.peerId)) {
        // Only give up the peer if this socket still owns it. A participant
        // can have more than one socket (a second tab, a reconnect), and they
        // share the peer id — removing it here would take the live
        // connection's peer away and its signalling would be dropped.
        const peer = call.peers.get(state.peerId);
        if (peer && peer.ws === ws) {
          call.peers.delete(state.peerId);
          this.broadcastToCall(call, {
            type: 'CALL_PEER_LEFT',
            callId: state.callId,
            peerId: state.peerId,
            userId: state.userId,
          });
          markParticipantLeft(state.callId, state.userId).catch(() => {});
          if (call.peers.size === 0) {
            this.finalizeCall(state.callId).catch(() => {});
          }
        }
      }
    }
  }

  private pingAll(): void {
    for (const [ws, state] of this.states) {
      if (state.pending) continue;
      if (!state.isAlive) {
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      this.send(ws, { type: 'PING' });
    }
  }

  /**
   * Ends calls that have been ringing for too long without anybody accepting.
   * The call-log rows are already `missed` by default, so this only has to
   * close the session and tell the remaining peers.
   */
  private sweepRingingCalls(): void {
    const now = Date.now();
    for (const [callId, call] of Array.from(this.calls)) {
      if (call.status !== 'ringing') continue;
      if (now - call.createdAt < RING_TIMEOUT_MS) continue;

      this.broadcastToCall(call, { type: 'CALL_ENDED', callId, reason: 'no_answer' });
      this.finalizeCall(callId).catch((err) =>
        console.error('[Call WS] failed to expire ringing call:', err)
      );
    }
  }

  private broadcastToCall(call: ActiveCall, payload: unknown, exceptPeerId?: string): void {
    for (const peer of call.peers.values()) {
      if (exceptPeerId && peer.peerId === exceptPeerId) continue;
      this.send(peer.ws, payload);
    }
  }

  private sendToUser(userId: string, payload: unknown): void {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const ws of set) this.send(ws, payload);
  }

  private send(ws: WebSocket | undefined, payload: unknown): void {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      if (CALL_DEBUG) {
        const p = payload as any;
        console.log(
          `[Call WS][debug] -> ${p?.type || '?'}` +
            (p?.callId ? ` call=${p.callId.slice(0, 6)}` : '') +
            (p?.signalType ? ` ${p.signalType} ${p.fromPeerId}->${p.selfPeerId ?? ''}` : '') +
            (p?.peer ? ` peer=${p.peer.userId}/${p.peer.peerId.slice(-4)}` : '') +
            (p?.selfPeerId ? ` self=${p.selfPeerId.slice(-4)}` : '') +
            (p?.peers ? ` peers=[${p.peers.map((x: any) => x.userId).join(',')}]` : '')
        );
      }
      ws.send(JSON.stringify(payload));
    }
  }

  private generatePeerId(): string {
    return `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweepTimer);
  }
}

let instance: CallGateway | null = null;

export function initCallGateway(server: Server): CallGateway {
  instance = new CallGateway(server);
  return instance;
}

export function getCallGateway(): CallGateway | null {
  return instance;
}
