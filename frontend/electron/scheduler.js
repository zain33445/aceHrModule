/**
 * scheduler.js — Cron-based Recording Scheduler (Main Process)
 *
 * Receives schedule entries from the WebSocket gateway and fires
 * start/stop recording commands at the defined times.
 *
 * Uses a lightweight built-in cron matcher — no external dependencies.
 * Runs a 1-minute tick via setInterval. Compatible with node-cron syntax.
 *
 * Future upgrade: Replace _matchesCron() with node-cron for full RFC support.
 */
import { logger } from './logger.js';
import { startRecording, stopRecording } from './recorder-main.js';

// ─── State ────────────────────────────────
let _schedules = [];  // [{ id, cronExpr, action:'start'|'stop', enabled }]
let _tickTimer = null;

// ─── Public API ───────────────────────────

/** Replace all schedules with the new list from the backend. */
export function applySchedules(schedules) {
  _schedules = (schedules ?? []).filter(s => s.enabled);
  logger.info(`[Scheduler] Applied ${_schedules.length} active schedules`);
  _schedules.forEach(s => logger.info(`[Scheduler]   id=${s.id} action=${s.action} cron="${s.cronExpr}"`));
  _ensureTick();
}

export function clearSchedules() {
  _schedules = [];
  logger.info('[Scheduler] All schedules cleared');
}

export function stopScheduler() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  logger.info('[Scheduler] Stopped');
}

// ─── Tick Engine ──────────────────────────

function _ensureTick() {
  if (_tickTimer) return;
  // Align to the next whole minute, then tick every 60s
  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    _tick(); // fire immediately at minute boundary
    _tickTimer = setInterval(_tick, 60_000);
  }, msUntilNextMinute);
  logger.info(`[Scheduler] Tick engine starting in ${Math.round(msUntilNextMinute / 1000)}s`);
}

function _tick() {
  if (_schedules.length === 0) return;
  const now = new Date();
  for (const schedule of _schedules) {
    if (!schedule.enabled) continue;
    if (_matchesCron(schedule.cronExpr, now)) {
      logger.info(`[Scheduler] Firing schedule id=${schedule.id} action=${schedule.action}`);
      _executeAction(schedule.action);
    }
  }
}

function _executeAction(action) {
  if (action === 'start') {
    // Session ID for scheduled recordings uses timestamp
    const sessionId = `sched-${Date.now()}`;
    startRecording(sessionId, '720p').catch(err =>
      logger.error(`[Scheduler] Start failed: ${err.message}`)
    );
  } else if (action === 'stop') {
    stopRecording();
  }
}

// ─── Cron Expression Parser ───────────────
/**
 * Matches a standard 5-field cron expression against a Date.
 * Fields: minute  hour  day-of-month  month  day-of-week
 * Supports: * (wildcard), exact values, comma lists, and ranges.
 * Example: "0 9 * * 1-5" → every weekday at 09:00
 */
function _matchesCron(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [fMin, fHour, fDOM, fMonth, fDOW] = fields;

  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1; // 1-12
  const dow = date.getDay();       // 0=Sun, 6=Sat

  return (
    _matchField(fMin, m, 0, 59) &&
    _matchField(fHour, h, 0, 23) &&
    _matchField(fDOM, dom, 1, 31) &&
    _matchField(fMonth, mon, 1, 12) &&
    _matchField(fDOW, dow, 0, 6)
  );
}

function _matchField(field, value, min, max) {
  if (field === '*') return true;
  // Handle comma-separated list: "1,3,5"
  for (const part of field.split(',')) {
    if (_matchPart(part.trim(), value, min, max)) return true;
  }
  return false;
}

function _matchPart(part, value, min, max) {
  // Range: "1-5"
  if (part.includes('-')) {
    const [lo, hi] = part.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  // Exact: "9"
  return parseInt(part, 10) === value;
}
