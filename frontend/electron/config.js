/**
 * config.js — Monitoring Configuration (Extended for Recording System)
 *
 * Central configuration for:
 *  - Existing monitoring (unchanged)
 *  - New recording system: WebSocket endpoint, chunk upload, quality profile
 */

// ─────────────────────────────────────────
// Existing Monitoring Config (unchanged)
// ─────────────────────────────────────────

export const TARGET_APPS = [
  'Plan Swift',
  'Ooma Office',
];

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../.env');

let envApiBase = 'https://api.theaceservices.site/api'; // fallback
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VITE_API_BASE=')) {
      envApiBase = trimmed.split('=')[1].trim();
      break;
    }
  }
}

export const API_BASE = envApiBase;
export const UPLOAD_ENDPOINT = `${API_BASE}/monitoring/screenshot`;
export const POLL_INTERVAL_MS = 30000; // 30 seconds (reduces tasklist CPU spikes)
export const HOURLY_SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;
export const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,
};
export const DEFAULT_USER_ID = null;

// ─────────────────────────────────────────
// Recording System Config (NEW)
// ─────────────────────────────────────────

// Derive WebSocket URL from API base (https → wss, http → ws)
// IMPORTANT: swap protocol first, then strip trailing /api suffix only
const wsBase = envApiBase
  .replace('https://', 'wss://') // upgrade to wss
  .replace('http://', 'ws://')   // or ws for local dev
  .replace(/\/api$/, '');        // strip trailing /api path only (avoids hitting api. subdomain)

export const WS_ENDPOINT = `${wsBase}/recording-ws`;

// Chunk upload endpoint
export const RECORDING_CHUNK_ENDPOINT = `${API_BASE}/recording/chunk`;

// Backlog check: which locally kept chunks the server already holds
export const RECORDING_CHUNK_CHECK_ENDPOINT = `${API_BASE}/recording/chunks/check`;

// Agent auth endpoint (to get/refresh agent JWT)
export const AGENT_AUTH_ENDPOINT = `${API_BASE}/recording/agent-auth`;

// Agent token storage filename (in app.getPath('userData'))
export const AGENT_TOKEN_FILE = 'agent-token.json';

// Recording quality profile
// Future: Add '1080p', '360p' options here
export const QUALITY_PROFILES = {
  '720p': { width: 1280, height: 720, videoBitsPerSecond: 1_500_000 },
};
export const DEFAULT_QUALITY = '720p';

// How often MediaRecorder fires ondataavailable (milliseconds)
export const RECORDING_CHUNK_INTERVAL_MS = 30_000; // 30 seconds (reduces IPC overhead)

// Retry config for chunk uploads
export const CHUNK_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 2000,
};

// ─────────────────────────────────────────
// Recording v2 (docs/recording-v2.md)
// ─────────────────────────────────────────

export const RECORDING_V2_SEGMENTS_ENDPOINT = `${API_BASE}/recording/v2/segments`;
export const recordingV2SegmentUrl = (segmentId, suffix = '') =>
  `${RECORDING_V2_SEGMENTS_ENDPOINT}/${encodeURIComponent(segmentId)}${suffix}`;

export const RECORDING_PROTOCOL = 2;
export const RECORDING_FPS = 5;                       // max capture frame rate
export const RECORDING_VIDEO_BPS = 600_000;           // VP8 target
export const RECORDING_TIMESLICE_MS = 10_000;         // one chunk per timeslice
export const RECORDING_MAX_WIDTH = 1280;
export const RECORDING_MAX_HEIGHT = 720;
export const RECORDING_SEGMENT_MAX_MS = 60 * 60 * 1000; // rotate segment hourly
export const RECORDING_WATCHDOG_MS = 3 * RECORDING_TIMESLICE_MS; // no chunk for 3 slices → restart
export const RECORDING_RESTART_BACKOFF_CAP_MS = 5 * 60 * 1000;
export const RECORDING_DISK_LOW_BYTES = 2 * 1024 ** 3;      // pause recording below this
export const RECORDING_DISK_RESUME_BYTES = 2.5 * 1024 ** 3; // resume above this (hysteresis)
export const RECORDING_STATUS_INTERVAL_MS = 60_000;
