/**
 * monitor.js — Monitoring Orchestrator
 * 
 * Runs a 1-second polling loop that:
 * 1. Detects if any target app is currently running
 * 2. On detect (first time) → Capture screenshot + Send 'check-in'
 * 3. Every hour while running → Capture screenshot + Send 'hourly'
 * 4. On close → Send 'check-out' (ends attendance mark)
 */

import { getRunningTargetApps } from './detector.js';
import { captureScreen } from './capture.js';
import { uploadScreenshot } from './uploader.js';
import { logger } from './logger.js';
import { POLL_INTERVAL_MS, DEFAULT_USER_ID, HOURLY_SCREENSHOT_INTERVAL_MS } from './config.js';

// Track currently active target app sessions
// Map<normalizedAppName, { startTime: Date, lastScreenshotTime: number, missingCount: number, originalName: string }>
const activeSessions = new Map();

// Configurable userId — can be set from main process
let currentUserId = DEFAULT_USER_ID;

/** Set the userId for monitoring uploads */
export function setUserId(userId) {
  currentUserId = userId;
  logger.info(`Monitor userId set to: ${userId}`);
}

/** Get current active sessions (for debugging/UI) */
export function getActiveSessions() {
  const sessions = {};
  for (const [appName, data] of activeSessions) {
    sessions[appName] = { 
        startTime: data.startTime.toISOString(),
        lastScreenshot: new Date(data.lastScreenshotTime).toISOString()
    };
  }
  return sessions;
}

let pollTimer = null;

/**
 * Start the monitoring loop.
 */
export function startMonitor() {
  if (pollTimer) {
    logger.warn('Monitor is already running');
    return;
  }

  logger.info('=== Desktop Monitor & Attendance Sync Started ===');
  logger.info(`Polling interval: ${POLL_INTERVAL_MS}ms`);
  logger.info(`Hourly screenshot interval: ${HOURLY_SCREENSHOT_INTERVAL_MS}ms`);

  pollTimer = setInterval(pollCycle, POLL_INTERVAL_MS);
}

/** Stop the monitoring loop. */
export function stopMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;

    // Log and send check-outs for any remaining active sessions
    for (const [appName, session] of activeSessions) {
      handleAppClosed(appName, session);
    }
    activeSessions.clear();

    logger.info('=== Desktop Monitor Stopped ===');
  }
}

/**
 * Single poll cycle.
 */
async function pollCycle() {
  try {
    const runningApps = await getRunningTargetApps();
    logger.debug(`[MONITOR] Running apps detected: ${runningApps.join(', ')}`);
    const now = Date.now();
    const CHECKOUT_THRESHOLD = 15; // Grace period threshold (15 polls/seconds)

    const runningNormalized = runningApps.map(app => app.toLowerCase());

    // --- 1. Handle newly detected apps (Check-in) ---
    for (let i = 0; i < runningApps.length; i++) {
      const appName = runningApps[i];
      const normalizedName = runningNormalized[i];

      if (!activeSessions.has(normalizedName)) {
        const startTime = new Date();
        activeSessions.set(normalizedName, { 
            startTime, 
            lastScreenshotTime: now,
            missingCount: 0,
            originalName: appName
        });

        logger.info(`[ATTENDANCE] Check-in detected [User: ${currentUserId}]: ${appName} started at ${startTime.toISOString()}`);
        
        // Initial screenshot + Check-in event
        // Delayed by 2 seconds to allow the application window to fully render
        setTimeout(() => {
          handleScreenshotEvent(appName, startTime, 'check-in');
        }, 10000);
      } 
      else {
        // --- 2. Handle hourly screenshots for existing sessions ---
        const session = activeSessions.get(normalizedName);
        
        // Reset missing count since it's detected again!
        session.missingCount = 0;

        if (now - session.lastScreenshotTime >= HOURLY_SCREENSHOT_INTERVAL_MS) {
            logger.info(`[MONITOR] Hourly screenshot trigger for ${session.originalName}`);
            session.lastScreenshotTime = now;
            handleScreenshotEvent(session.originalName, new Date(now), 'hourly');
        }
      }
    }

    // --- 3. Handle closed apps (Check-out) with Grace Period ---
    for (const [normalizedName, session] of activeSessions) {
      if (!runningNormalized.includes(normalizedName)) {
        session.missingCount = (session.missingCount || 0) + 1;

        if (session.missingCount >= CHECKOUT_THRESHOLD) {
            handleAppClosed(session.originalName, session);
            activeSessions.delete(normalizedName);
        }
      }
    }
  } catch (err) {
    logger.error(`Poll cycle error: ${err.message}`);
  }
}

/** Handle end of app activity (Check-out) */
async function handleAppClosed(appName, session) {
    const endTime = new Date();
    const durationMin = Math.round((endTime - session.startTime) / 60000);
    logger.info(`[ATTENDANCE] Check-out detected: ${appName} closed after ${durationMin} minutes`);

    // Send check-out event (no screenshot needed for checkout usually, but we send the timestamp)
    const payload = {
        userId: currentUserId,
        appName,
        timestamp: endTime.toISOString(),
        type: 'check-out'
    };

    await uploadScreenshot(payload);
}

/**
 * Handle a screenshot event (check-in or hourly)
 */
async function handleScreenshotEvent(appName, timestamp, type) {
  try {
    const screenshotBase64 = await captureScreen();
    logger.info(`[User: ${currentUserId}] Screenshot captured: ${Math.round(screenshotBase64.length / 1024)}KB`);

    const payload = {
      userId: currentUserId,
      appName,
      timestamp: timestamp.toISOString(),
      screenshotBase64: screenshotBase64 || null,
      type: type // 'check-in' or 'hourly'
    };

    await uploadScreenshot(payload);
  } catch (err) {
    logger.error(`Event failed (${type}) for ${appName}: ${err.message}`);
  }
}
