/**
 * uploader.js — Server Upload Module
 * 
 * Sends monitoring data (screenshot + metadata) to the backend via HTTP POST.
 * Uses Electron's net module. Includes retry logic with exponential backoff.
 */

import electronPkg from 'electron';
const { net } = electronPkg;
import { UPLOAD_ENDPOINT, RETRY_CONFIG } from './config.js';
import { logger } from './logger.js';

/**
 * Upload monitoring data to the server with retry.
 * @param {object} payload - { userId, appName, timestamp, screenshotBase64 }
 * @returns {Promise<boolean>} true if upload succeeded
 */
export async function uploadScreenshot(payload) {
  const { maxRetries, baseDelayMs } = RETRY_CONFIG;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const success = await doUpload(payload);
      if (success) {
        logger.info(`Upload succeeded for ${payload.appName} (attempt ${attempt})`);
        return true;
      }
    } catch (err) {
      logger.error(`Upload attempt ${attempt}/${maxRetries} failed: ${err.message}`);
    }

    // Wait before retrying (exponential backoff: 1s, 2s, 4s)
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.info(`Retrying upload in ${delay}ms...`);
      await sleep(delay);
    }
  }

  logger.error(`Upload failed after ${maxRetries} attempts for ${payload.appName}`);
  return false;
}

/**
 * Perform the actual HTTP POST using Electron's net module.
 * @param {object} payload 
 * @returns {Promise<boolean>}
 */
function doUpload(payload) {
  return new Promise((resolve, reject) => {
    try {
      const body = JSON.stringify(payload);

      const request = net.request({
        method: 'POST',
        url: UPLOAD_ENDPOINT,
      });

      request.setHeader('Content-Type', 'application/json');

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(true);
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${data}`));
          }
        });
      });

      request.on('error', (err) => {
        reject(new Error(`Network error: ${err.message}`));
      });

      request.write(body);
      request.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Simple sleep utility */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
