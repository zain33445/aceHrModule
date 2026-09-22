/**
 * chat.gateway.ts — WebSocket gateway for real-time chat delivery.
 *
 * Responsibilities:
 *   - Accept connections at /chat-ws?userId=<id> (userId validated against the DB, matching
 *     this codebase's existing trust model — no signed user tokens exist yet).
 *   - Keep a registry Map<userId, Set<socket>> (a user may have several windows/devices).
 *   - Push MESSAGE events to participants when a message is posted (called from chat.routes).
 *   - Relay TYPING and READ signals between participants.
 *
 * Sending messages is done over REST (chat.routes) so attachments can ride along; this
 * gateway is delivery + presence-lite only. Mirrors the singleton pattern of
 * recording.gateway.ts. NOTE: recording.gateway owns server.on('upgrade') too and yields
 * the /chat-ws path to us (see the `else if` there).
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import prisma from '../prisma';
import { markRead, assertMemberAndGetParticipants } from '../services/chat.service';

const CHAT_PATH = '/chat-ws';

export class ChatGateway {
  private wss: WebSocketServer;
  private clients: Map<string, Set<WebSocket>> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== CHAT_PATH) return; // not ours — another gateway handles/destroys it

      const userId = url.searchParams.get('userId');
      if (!userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
        if (!user) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, userId));
      } catch (err) {
        console.error('[Chat WS] upgrade error:', err);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });

    console.log(`[Chat WS] gateway initialized (${CHAT_PATH})`);
  }

  private onConnection(ws: WebSocket, userId: string): void {
    if (!this.clients.has(userId)) this.clients.set(userId, new Set());
    this.clients.get(userId)!.add(ws);
    this.send(ws, { type: 'CONNECTED', userId });

    ws.on('message', (data: Buffer) => this.onMessage(userId, data).catch(() => {}));
    ws.on('close', () => {
      const set = this.clients.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.clients.delete(userId);
      }
    });
    ws.on('error', () => {});
  }

  private async onMessage(userId: string, data: Buffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const conversationId: string | undefined = msg.conversationId;
    if (!conversationId) return;

    if (msg.type === 'TYPING') {
      const participants = await assertMemberAndGetParticipants(conversationId, userId);
      this.broadcastToParticipants(
        participants.filter((id) => id !== userId),
        { type: 'TYPING', conversationId, userId }
      );
    } else if (msg.type === 'READ') {
      const participants = await assertMemberAndGetParticipants(conversationId, userId);
      await markRead(conversationId, userId);
      this.broadcastToParticipants(
        participants.filter((id) => id !== userId),
        { type: 'READ_RECEIPT', conversationId, userId }
      );
    }
  }

  /** Deliver a newly-posted message to every participant's live sockets. */
  broadcastMessage(participantIds: string[], message: unknown): void {
    this.broadcastToParticipants(participantIds, { type: 'MESSAGE', message });
  }

  /** Push a notification event to all of a user's connected sockets. */
  notifyUser(userId: string, notification: unknown): void {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const ws of set) this.send(ws, { type: 'NOTIFICATION', notification });
  }

  /** Check whether a user has any active WebSocket connection. */
  isUserConnected(userId: string): boolean {
    const set = this.clients.get(userId);
    return !!set && set.size > 0;
  }

  private broadcastToParticipants(userIds: string[], payload: unknown): void {
    for (const uid of userIds) {
      const set = this.clients.get(uid);
      if (!set) continue;
      for (const ws of set) this.send(ws, payload);
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}

let instance: ChatGateway | null = null;

export function initChatGateway(server: Server): ChatGateway {
  instance = new ChatGateway(server);
  return instance;
}

export function getChatGateway(): ChatGateway | null {
  return instance;
}
