/**
 * config.js — Monitoring Configuration
 * 
 * Central configuration for the desktop monitoring system.
 * Add new target apps to the TARGET_APPS array to monitor them.
 */

// List of process names to monitor (case-insensitive matching)
// Add more apps here as needed — just add the process name without .exe
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
  // Match only lines that are NOT commented out with #
  const lines = envContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VITE_API_BASE=')) {
      envApiBase = trimmed.split('=')[1].trim();
      break;
    }
  }
}

// Backend API endpoint for uploading monitoring data
export const API_BASE = envApiBase;
export const UPLOAD_ENDPOINT = `${API_BASE}/monitoring/screenshot`;

// Polling interval in milliseconds (1 second)
export const POLL_INTERVAL_MS = 1000;

// Interval for repeating screenshots while an app is active (10 minutes)
export const HOURLY_SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;

// Retry configuration for failed uploads
export const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000, // exponential backoff: 1s, 2s, 4s
};

// Default userId — will be null until overridden from app auth
export const DEFAULT_USER_ID = null;
