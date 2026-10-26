/**
 * callrecording.service.ts — Storage and mixing of call audio recordings.
 *
 * Recording model
 * ---------------
 * The media plane is a peer-to-peer mesh, so the server never sees the audio.
 * Instead, every participant records its own mix (local microphone + all
 * remote audio) and uploads 30-second Opus/WebM chunks. Each participant's
 * file therefore contains the full conversation, which makes it robust: if one
 * participant drops mid-call, the others' files still cover the whole call.
 *
 * Recording starts automatically when the call is answered. Every participant
 * records their own mix and the in-call UI shows a recording indicator for as
 * long as it is running.
 *
 * Chunk format matches the existing screen-recording pipeline: the chunks are
 * binary-concatenated and then remuxed with FFmpeg to produce a valid file
 * with correct duration and cues.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import prisma from '../prisma';

const CALL_RECORDINGS_DIR =
  process.env.CALL_RECORDINGS_DIR || path.join(process.cwd(), 'uploads', 'calls');

/** Recordings older than this are deleted by the retention sweep. */
export const RECORDING_RETENTION_DAYS = 90;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function callDir(callId: string): string {
  return path.join(CALL_RECORDINGS_DIR, callId);
}

function participantDir(callId: string, userId: string): string {
  return path.join(callDir(callId), userId);
}

/** Absolute path of the chunk part file. */
function chunkPath(callId: string, userId: string, index: number): string {
  return path.join(participantDir(callId, userId), `${index}.part`);
}

/** Absolute path of the final (remuxed) recording for a participant. */
export function finalPath(callId: string, userId: string): string {
  return path.join(participantDir(callId, userId), 'recording.webm');
}

/**
 * Writes one uploaded chunk to disk.
 * Chunks are numbered per participant and are immutable once written.
 */
export async function saveChunk(
  callId: string,
  userId: string,
  chunkIndex: number,
  buffer: Buffer
): Promise<number> {
  ensureDir(participantDir(callId, userId));
  const file = chunkPath(callId, userId, chunkIndex);
  await fs.promises.writeFile(file, buffer);
  return buffer.length;
}

/**
 * Waits until the participant's chunk directory has stopped growing.
 *
 * The last chunk is uploaded when the client stops the recorder, which can
 * happen at the same moment the call ends. Assembling the file immediately
 * would then miss that final chunk, so the server waits for the uploads to go
 * quiet before it assembles.
 */
async function waitForChunks(
  callId: string,
  userId: string,
  quietMs = 1500,
  maxMs = 8000
): Promise<void> {
  const dir = participantDir(callId, userId);
  const started = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();

  while (Date.now() - started < maxMs) {
    let count = 0;
    try {
      count = fs.readdirSync(dir).filter((f) => f.endsWith('.part')).length;
    } catch {
      count = 0;
    }

    if (count !== lastCount) {
      lastCount = count;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Concatenates a participant's chunks and remuxes them into a playable file.
 * Returns the final file path, or null when there were no chunks.
 */
export async function finalizeParticipantRecording(
  callId: string,
  userId: string
): Promise<string | null> {
  const dir = participantDir(callId, userId);
  if (!fs.existsSync(dir)) return null;

  // Give the last upload a chance to land before assembling.
  await waitForChunks(callId, userId);

  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.part'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (parts.length === 0) return null;

  const rawPath = path.join(dir, 'raw.webm');
  const outPath = finalPath(callId, userId);

  // Binary concatenation works for MediaRecorder WebM chunks.
  const out = fs.openSync(rawPath, 'w');
  try {
    for (const part of parts) {
      const data = fs.readFileSync(path.join(dir, part));
      fs.writeSync(out, data, 0, data.length);
    }
  } finally {
    fs.closeSync(out);
  }

  const durationSec = await remux(rawPath, outPath);
  if (durationSec === null) {
    // FFmpeg could not read the stream — fall back to the raw concatenation.
    try { fs.copyFileSync(rawPath, outPath); } catch { /* best effort */ }
  }

  try { fs.unlinkSync(rawPath); } catch { /* best effort */ }

  // The individual chunks are no longer needed once the file is assembled.
  for (const part of parts) {
    try { fs.unlinkSync(path.join(dir, part)); } catch { /* best effort */ }
  }

  const size = fs.statSync(outPath).size;

  await prisma.callRecording.upsert({
    where: { id: `${callId}:${userId}` },
    create: {
      id: `${callId}:${userId}`,
      call_id: callId,
      user_id: userId,
      file_path: outPath,
      file_size: size,
      duration_sec: durationSec,
    },
    update: {
      file_path: outPath,
      file_size: size,
      duration_sec: durationSec,
    },
  });

  return outPath;
}

/** Remuxes a raw WebM into a valid file. Returns the duration in seconds. */
function remux(rawPath: string, outPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let ffmpegPath: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ffmpegPath = require('ffmpeg-static');
    } catch {
      // FFmpeg unavailable — fall back to the raw concatenation.
      try { fs.renameSync(rawPath, outPath); } catch { /* ignore */ }
      resolve(null);
      return;
    }

    const ffmpeg = spawn(ffmpegPath, ['-y', '-i', rawPath, '-c', 'copy', outPath]);

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[Call Recording] FFmpeg remux failed (code ${code}); using raw output.`);
        try {
          fs.copyFileSync(rawPath, outPath);
        } catch { /* ignore */ }
      }
      resolve(null);
    });

    ffmpeg.on('error', (err) => {
      console.warn(`[Call Recording] FFmpeg error: ${err.message}; using raw output.`);
      try { fs.copyFileSync(rawPath, outPath); } catch { /* ignore */ }
      resolve(null);
    });
  });
}

/** Lists the finished recordings for a call. */
export async function listCallRecordings(callId: string) {
  return prisma.callRecording.findMany({
    where: { call_id: callId },
    orderBy: { created_at: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  });
}

/**
 * Produces (and caches) a single mixed file for the whole call.
 *
 * Every participant already holds the full conversation, so the mix is only
 * needed when you want a single canonical file. The mixed file is written next
 * to the participant files as `_mixed.webm`.
 */
export async function getMixedRecording(callId: string): Promise<string | null> {
  const dir = callDir(callId);
  if (!fs.existsSync(dir)) return null;

  const mixedPath = path.join(dir, '_mixed.webm');
  if (fs.existsSync(mixedPath)) return mixedPath;

  const inputs = fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .map((name) => path.join(dir, name, 'recording.webm'))
    .filter((p) => fs.existsSync(p));

  if (inputs.length === 0) return null;

  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], mixedPath);
    return mixedPath;
  }

  const ffmpegPath = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('ffmpeg-static');
    } catch {
      return null;
    }
  })();

  if (!ffmpegPath) return inputs[0];

  await new Promise<void>((resolve) => {
    const args: string[] = ['-y'];
    for (const input of inputs) args.push('-i', input);

    const filter = `amix=inputs=${inputs.length}:duration=longest:dropout_transition=0`;
    args.push('-filter_complex', filter, '-c:a', 'libopus', mixedPath);

    const ffmpeg = spawn(ffmpegPath, args);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[Call Recording] mix failed (code ${code}); serving the first track.`);
        try { fs.copyFileSync(inputs[0], mixedPath); } catch { /* ignore */ }
      }
      resolve();
    });
    ffmpeg.on('error', () => {
      try { fs.copyFileSync(inputs[0], mixedPath); } catch { /* ignore */ }
      resolve();
    });
  });

  return fs.existsSync(mixedPath) ? mixedPath : null;
}

/**
 * Deletes recordings older than the retention window.
 * Called from the cron block in index.ts.
 */
export async function cleanupExpiredRecordings(
  retentionDays = RECORDING_RETENTION_DAYS
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expired = await prisma.callRecording.findMany({
    where: { created_at: { lt: cutoff } },
    select: { id: true, file_path: true, call_id: true },
  });

  for (const rec of expired) {
    try { fs.unlinkSync(rec.file_path); } catch { /* already gone */ }
    try {
      fs.rmSync(path.join(callDir(rec.call_id)), { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  if (expired.length > 0) {
    await prisma.callRecording.deleteMany({
      where: { id: { in: expired.map((r) => r.id) } },
    });
  }

  return expired.length;
}
