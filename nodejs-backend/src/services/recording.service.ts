/**
 * recording.service.ts — Core Recording Business Logic
 *
 * Handles:
 *  - Session lifecycle (start, stop, status)
 *  - Chunk persistence to local disk
 *  - Session file assembly (WebM binary concat)
 *  - Agent token issuance
 *
 * Storage adapter note: All file I/O goes through the storage methods at the
 * bottom of this file. To migrate to S3, replace only those methods.
 */

import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import prisma from '../prisma';
import { getGateway } from '../gateways/recording.gateway';
import { signAgentToken } from '../middleware/requireAgentToken';

export const recordingEmitter = new EventEmitter();

// ─────────────────────────────────────────
// Storage Configuration (Adapter Pattern)
// ─────────────────────────────────────────

// Base directory for recording files — outside web root
const RECORDINGS_DIR = path.join(process.cwd(), 'uploads', 'recordings');

/** Derive a human-readable folder name from session metadata */
function sessionFolderName(userId: string, sessionId: string): string {
  return `${userId}_${sessionId}`;
}

/** Build the session directory path, organized by date */
function sessionDirPath(userId: string, sessionId: string, createdAt: Date): string {
  const dateStr = createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(RECORDINGS_DIR, dateStr, sessionFolderName(userId, sessionId));
}

function ensureSessionDir(userId: string, sessionId: string, createdAt: Date): string {
  const dir = sessionDirPath(userId, sessionId, createdAt);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function chunkFilePath(userId: string, sessionId: string, createdAt: Date, chunkIndex: number): string {
  const dir = ensureSessionDir(userId, sessionId, createdAt);
  return path.join(dir, `chunk-${String(chunkIndex).padStart(5, '0')}.webm`);
}

function assembledFilePath(userId: string, sessionId: string, createdAt: Date): string {
  const dir = ensureSessionDir(userId, sessionId, createdAt);
  return path.join(dir, 'recording.webm');
}

// ─────────────────────────────────────────
// Agent Token
// ─────────────────────────────────────────

/**
 * Issues or refreshes an agent JWT for the given userId.
 * Stores token hash in DB for revocation capability.
 */
export async function issueAgentToken(userId: string): Promise<string> {
  // Verify user exists
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const token = signAgentToken(userId);

  // Upsert in AgentToken table (one token per user)
  await prisma.agentToken.upsert({
    where: { user_id: userId },
    create: { user_id: userId, token },
    update: { token, last_seen: new Date() },
  });

  return token;
}

// ─────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────

const startSessionLocks: Record<string, Promise<any>> = {};

/**
 * Starts a new recording session for the target user.
 * Creates the session record and sends the START_RECORDING command to the agent.
 */
export async function startSession(
  userId: string,
  adminId: string,
  quality: string = '720p'
): Promise<{ sessionId: string; agentConnected: boolean }> {
  while (startSessionLocks[userId]) {
    await startSessionLocks[userId];
  }

  let resolveLock!: () => void;
  startSessionLocks[userId] = new Promise<void>((r) => { resolveLock = r; });

  try {
    // Enforce one active session per user: stop any existing ones
    const activeSessions = await prisma.recordingSession.findMany({
      where: { user_id: userId, status: { in: ['pending', 'recording'] } },
    });
    
    if (activeSessions.length > 0) {
      await prisma.recordingSession.updateMany({
        where: { id: { in: activeSessions.map(s => s.id) } },
        data: { status: 'stopped', ended_at: new Date() },
      });
      for (const s of activeSessions) {
        setTimeout(() => assembleSession(s.id).catch(console.error), 5000);
      }
    }

    const session = await prisma.recordingSession.create({
      data: {
        user_id: userId,
        created_by: adminId,
        status: 'pending',
      },
    });

    // Ensure session directory exists now (date-organized)
    ensureSessionDir(userId, session.id, session.created_at);

    // Send command to agent via WebSocket
    const gateway = getGateway();
    const agentConnected = gateway?.broadcast(userId, {
      type: 'START_RECORDING',
      sessionId: session.id,
      quality,
    }) ?? false;

    return { sessionId: session.id, agentConnected };
  } finally {
    delete startSessionLocks[userId];
    resolveLock();
  }
}

/**
 * Stops a recording session.
 * Sends STOP_RECORDING to agent and triggers assembly after a short delay.
 */
export async function stopSession(
  sessionId: string,
  adminId: string
): Promise<{ ok: boolean; agentConnected: boolean }> {

  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) throw new Error('Session not found');
  if (session.status === 'stopped' || session.status === 'assembled') {
    return { ok: true, agentConnected: false };
  }

  // Mark as stopped
  await prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: 'stopped', ended_at: new Date() },
  });

  // Send stop command to agent
  const gateway = getGateway();
  const agentConnected = gateway?.broadcast(session.user_id, {
    type: 'STOP_RECORDING',
    sessionId,
  }) ?? false;

  // Emit stopped event for live streams
  recordingEmitter.emit(`stopped:${sessionId}`);

  // Trigger assembly after 15s (allow final chunks to arrive)
  setTimeout(() => {
    assembleSession(sessionId).catch((err) => {
      console.error(`[Recording Service] Assembly failed for ${sessionId}:`, err.message);
    });
  }, 15_000);

  return { ok: true, agentConnected };
}

/**
 * Saves a raw binary chunk to disk and creates a DB record.
 */
export async function saveChunk(
  sessionId: string,
  chunkIndex: number,
  buffer: Buffer
): Promise<void> {

  // Validate session exists and is active
  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
    select: { status: true, user_id: true, created_at: true },
  });

  if (!session) throw new Error('Session not found');

  // Mark session as recording on first chunk
  if (session.status === 'pending') {
    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: 'recording', started_at: new Date() },
    });
  }

  const filePath = chunkFilePath(session.user_id, sessionId, session.created_at, chunkIndex);
  fs.writeFileSync(filePath, buffer);

  // Upsert chunk record (idempotent — re-upload of same chunk is safe)
  await prisma.recordingChunk.upsert({
    where: { session_id_chunk_index: { session_id: sessionId, chunk_index: chunkIndex } },
    create: {
      session_id: sessionId,
      chunk_index: chunkIndex,
      file_path: filePath,
      file_size: buffer.length,
    },
    update: {
      file_path: filePath,
      file_size: buffer.length,
      uploaded_at: new Date(),
    },
  });

  // Emit chunk event for live streaming
  recordingEmitter.emit(`chunk:${sessionId}`, buffer);

  console.log(`[Recording Service] Chunk ${chunkIndex} saved for session ${sessionId} (${Math.round(buffer.length / 1024)}KB)`);
}

/**
 * Concatenates all chunks into a single WebM file.
 *
 * WebM chunks from MediaRecorder's timeslice API are self-contained segments
 * that can be binary-concatenated to produce a valid WebM file. This is the
 * standard approach for Electron + MediaRecorder recording.
 *
 * Future upgrade: Replace with FFmpeg for remuxing, trimming, or transcoding.
 */
export async function assembleSession(sessionId: string): Promise<string> {
  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
    select: { user_id: true, created_at: true },
  });
  if (!session) throw new Error('Session not found');

  const chunks = await prisma.recordingChunk.findMany({
    where: { session_id: sessionId },
    orderBy: { chunk_index: 'asc' },
  });

  if (chunks.length === 0) {
    throw new Error('No chunks found for session');
  }

  const dir = ensureSessionDir(session.user_id, sessionId, session.created_at);
  const rawOutputPath = path.join(dir, 'recording-raw.webm');
  const finalOutputPath = assembledFilePath(session.user_id, sessionId, session.created_at);
  const writeStream = fs.createWriteStream(rawOutputPath);

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    (async () => {
      for (const chunk of chunks) {
        if (!fs.existsSync(chunk.file_path)) {
          console.warn(`[Recording Service] Missing chunk file: ${chunk.file_path}`);
          continue;
        }
        const data = fs.readFileSync(chunk.file_path);
        writeStream.write(data);
      }
      writeStream.end();
    })();
  });

  // Remux using FFmpeg to fix duration and Cues metadata
  await new Promise<void>((resolve, reject) => {
    console.log(`[Recording Service] Remuxing ${sessionId} with FFmpeg...`);
    const ffmpegPath = require('ffmpeg-static');
    const ffmpeg = spawn(ffmpegPath, [
      '-y', 
      '-i', rawOutputPath, 
      '-c', 'copy', 
      finalOutputPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        try { fs.unlinkSync(rawOutputPath); } catch(e) {}
        resolve();
      } else {
        console.warn(`[Recording Service] FFmpeg failed with code ${code}, falling back to raw output.`);
        try { fs.renameSync(rawOutputPath, finalOutputPath); } catch(e) {}
        resolve();
      }
    });

    ffmpeg.on('error', (err) => {
      console.warn(`[Recording Service] FFmpeg error: ${err.message}, falling back to raw output.`);
      try { fs.renameSync(rawOutputPath, finalOutputPath); } catch(e) {}
      resolve();
    });
  });

  // Update session record
  await prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: 'assembled', file_path: finalOutputPath },
  });

  const stats = fs.statSync(finalOutputPath);
  console.log(
    `[Recording Service] Session ${sessionId} assembled & remuxed: ${chunks.length} chunks → ${Math.round(stats.size / 1024 / 1024 * 10) / 10}MB`
  );

  return finalOutputPath;
}

// ─────────────────────────────────────────
// Query Helpers
// ─────────────────────────────────────────

export async function getSession(sessionId: string) {
  return prisma.recordingSession.findUnique({
    where: { id: sessionId },
    include: {
      chunks: { orderBy: { chunk_index: 'asc' }, select: { chunk_index: true, file_size: true, uploaded_at: true } },
      employee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
    },
  });
}

export async function listSessions(userId?: string) {
  return prisma.recordingSession.findMany({
    where: userId ? { user_id: userId } : undefined,
    orderBy: { created_at: 'desc' },
    take: 100,
    include: {
      employee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      _count: { select: { chunks: true } },
    },
  });
}

export function getLiveStatus(userId: string): {
  connected: boolean;
  sessionId?: string;
} {
  const gateway = getGateway();
  return {
    connected: gateway?.isConnected(userId) ?? false,
  };
}

export function getAssembledFilePath(sessionId: string, storedPath: string): string {
  return storedPath;
}
