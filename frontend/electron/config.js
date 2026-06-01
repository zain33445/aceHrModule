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
const wsBase = envApiBase
  .replace('/api', '')           // strip /api path
  .replace('https://', 'wss://') // upgrade to wss
  .replace('http://', 'ws://');  // or ws for local dev

export const WS_ENDPOINT = `${wsBase}/recording-ws`;

// Chunk upload endpoint
export const RECORDING_CHUNK_ENDPOINT = `${API_BASE}/recording/chunk`;

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
export const RECORDING_CHUNK_INTERVAL_MS = 10_000; // 10 seconds

// Retry config for chunk uploads
export const CHUNK_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 2000,
};
