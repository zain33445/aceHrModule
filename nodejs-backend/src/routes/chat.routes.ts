/**
 * chat.routes.ts — REST surface for the chat module.
 *
 * Sending is REST (so file uploads ride along as base64, matching the app's existing
 * upload style); real-time delivery + typing/read signals are handled by the WS gateway.
 * The acting user is identified by `user_id` (body or X-User-Id header), consistent with
 * the rest of this codebase's trust model.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import prisma from '../prisma';
import {
  ChatError,
  AttachmentMeta,
  getOrCreateDirect,
  createDepartmentGroup,
  postMessage,
  listConversations,
  getMessages,
  markRead,
  assertMemberAndGetParticipants,
} from '../services/chat.service';
import { getChatGateway } from '../gateways/chat.gateway';
import { createAndDeliver, NOTIFICATION_TYPES } from '../services/notification.service';

const router = Router();

const CHAT_UPLOADS_DIR = process.env.CHAT_UPLOADS_DIR
  ? path.resolve(process.env.CHAT_UPLOADS_DIR)
  : path.join(process.cwd(), 'uploads', 'chat');

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per file (body limit is 50MB)

function actingUserId(req: any): string | null {
  return (req.headers['x-user-id'] as string) || req.body?.user_id || req.query?.user_id || null;
}

function sanitizeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

/** Decode a base64 (or data-URL) attachment, write it to disk, return its DB metadata. */
function saveAttachment(a: { file_name: string; mime_type: string; data: string }): AttachmentMeta {
  const base64 = a.data.includes(',') ? a.data.slice(a.data.indexOf(',') + 1) : a.data;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new ChatError(400, 'Empty attachment');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new ChatError(413, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);

  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = path.join(CHAT_UPLOADS_DIR, dateStr);
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, `${randomUUID()}-${sanitizeName(a.file_name)}`);
  fs.writeFileSync(storagePath, buffer);

  return {
    file_name: sanitizeName(a.file_name),
    mime_type: a.mime_type || 'application/octet-stream',
    size_bytes: buffer.length,
    storage_path: storagePath,
  };
}

function handle(res: any, err: unknown) {
  if (err instanceof ChatError) return res.status(err.status).json({ error: err.message });
  console.error('[chat] error:', err);
  return res.status(500).json({ error: 'Chat operation failed' });
}

// ── Inbox & history ───────────────────────────────────────

router.get('/conversations', async (req, res) => {
  const userId = actingUserId(req);
  if (!userId) return res.status(401).json({ error: 'user_id required' });
  try {
    res.json(await listConversations(userId));
  } catch (err) {
    handle(res, err);
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  const userId = actingUserId(req);
  if (!userId) return res.status(401).json({ error: 'user_id required' });
  try {
    const before = req.query.before as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    res.json(await getMessages(req.params.id, userId, before, limit));
  } catch (err) {
    handle(res, err);
  }
});

// ── Open conversations ────────────────────────────────────

// Open (or reuse) a 1:1 direct chat.  Body: { user_id, other_user_id }
router.post('/direct', async (req, res) => {
  const userId = actingUserId(req);
  const { other_user_id } = req.body;
  if (!userId || !other_user_id) return res.status(400).json({ error: 'user_id and other_user_id required' });
  try {
    res.json(await getOrCreateDirect(userId, String(other_user_id)));
  } catch (err) {
    handle(res, err);
  }
});

// Create the group chat for a department (admin/HR only).  Body: { user_id, department_id }
router.post('/groups', async (req, res) => {
  const userId = actingUserId(req);
  const { department_id } = req.body;
  if (!userId || department_id == null) return res.status(400).json({ error: 'user_id and department_id required' });
  try {
    res.json(await createDepartmentGroup(userId, parseInt(department_id)));
  } catch (err) {
    handle(res, err);
  }
});

// ── Send & read ───────────────────────────────────────────

// Send a message.  Body: { user_id, text?, attachments?: [{file_name, mime_type, data(base64)}] }
router.post('/conversations/:id/messages', async (req, res) => {
  const userId = actingUserId(req);
  if (!userId) return res.status(401).json({ error: 'user_id required' });
  try {
    const { text } = req.body;
    const rawAttachments: any[] = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    const saved = rawAttachments.map(saveAttachment);

    const message = await postMessage(userId, req.params.id, text ?? null, saved);

    // Broadcast to every participant's live sockets (sender included, for multi-device).
    const participantIds = await assertMemberAndGetParticipants(req.params.id, userId);
    const gw = getChatGateway();
    gw?.broadcastMessage(participantIds, message);

    // Notify every recipient (DB record for the bell + live push via the WS gateway).
    // ponytail: one createAndDeliver per participant — fine for dept-sized groups; batch if groups get large.
    const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    for (const pid of participantIds) {
      if (pid === userId) continue;
      await createAndDeliver({
        userId: pid,
        type: NOTIFICATION_TYPES.NEW_MESSAGE,
        title: 'New Message',
        message: `${sender?.name ?? 'Someone'} sent you a message.`,
        link: '/chat',
      });
    }

    res.json(message);
  } catch (err) {
    handle(res, err);
  }
});

router.post('/conversations/:id/read', async (req, res) => {
  const userId = actingUserId(req);
  if (!userId) return res.status(401).json({ error: 'user_id required' });
  try {
    await markRead(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    handle(res, err);
  }
});

// ── Attachment download (participants only) ───────────────

router.get('/attachments/:id', async (req, res) => {
  const userId = actingUserId(req);
  if (!userId) return res.status(401).json({ error: 'user_id required' });
  try {
    const att = await prisma.chatAttachment.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { message: { select: { conversation_id: true } } },
    });
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    await assertMemberAndGetParticipants(att.message.conversation_id, userId); // 403 if not a member
    if (!fs.existsSync(att.storage_path)) return res.status(410).json({ error: 'File no longer available' });

    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${att.file_name}"`);
    fs.createReadStream(att.storage_path).pipe(res);
  } catch (err) {
    handle(res, err);
  }
});

export default router;
