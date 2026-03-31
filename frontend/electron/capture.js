/**
 * capture.js — Screenshot Capture Module
 * 
 * Uses Electron's desktopCapturer to grab the primary screen
 * and returns a base64-encoded PNG string.
 */

import electronPkg from 'electron';
const { desktopCapturer, screen } = electronPkg;
import { logger } from './logger.js';

/**
 * Capture the primary display as a base64-encoded PNG.
 * @returns {Promise<string|null>} Base64 PNG string, or null on failure
 */
export async function captureScreen() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    // Default to scaled down resolution (1280x720 approx if 16:9) to save space
    // We maintain aspect ratio based on primary screen height/width
    const aspectRatio = primaryDisplay.size.width / primaryDisplay.size.height;
    const targetHeight = 720;
    const targetWidth = Math.round(targetHeight * aspectRatio);

    // Get all screen sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // Requesting a smaller thumbnailSize is the first line of defense for compression
      thumbnailSize: { width: targetWidth, height: targetHeight },
    });

    if (!sources || sources.length === 0) {
      logger.warn('No screen sources found for capture');
      return null;
    }

    // Use the first (primary) screen source
    const primarySource = sources[0];
    const thumbnail = primarySource.thumbnail;

    if (!thumbnail || thumbnail.isEmpty()) {
      logger.warn('Captured thumbnail is empty');
      return null;
    }

    // Convert to base64 JPEG with quality = 40 (often puts 720p well under 100KB)
    // toJPEG is vastly more space efficient than toPNG
    const base64 = thumbnail.toJPEG(40).toString('base64');
    return base64;
  } catch (err) {
    logger.error(`Screenshot capture failed: ${err.message}`);
    return null;
  }
}
