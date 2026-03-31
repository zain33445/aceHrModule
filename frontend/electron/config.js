/**
 * config.js — Monitoring Configuration
 * 
 * Central configuration for the desktop monitoring system.
 * Add new target apps to the TARGET_APPS array to monitor them.
 */

// List of process names to monitor (case-insensitive matching)
// Add more apps here as needed — just add the process name without .exe
export const TARGET_APPS = [
  'PlanSwift',
  'oomaphone',
  'chrome',
  'chatgpt'
];

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../.env');

let envApiBase = 'http://localhost:5000/api'; // fallback
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/VITE_API_BASE=(.*)/);
  if (match) envApiBase = match[1].trim();
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
  maxRetries: 3,
  baseDelayMs: 1000, // exponential backoff: 1s, 2s, 4s
};

// Default userId — will be overridden from app auth if available
export const DEFAULT_USER_ID = '15';
