/**
 * requireDeviceToken.ts — signed device identity for the device REST + WS API.
 *
 * A device token is deliberately separate from both the user session token and
 * the legacy recording agent token. It carries:
 *
 *   { sub: <device id>, typ: 'device' }
 *
 * and is signed with DEVICE_JWT_SECRET (never AGENT_JWT_SECRET) with a 1 hour
 * TTL. Losing a device token therefore cannot be replayed against the HR API,
 * and the long-lived enrollment secret is only ever used once.
 *
 * In production the secret is mandatory. In development a clearly-labelled
 * fallback keeps local testing possible; it must never be used in production.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { resolveSecret } from '../config/env';
import { getDeviceAccessStatus } from '../services/device.service';

export const DEVICE_TOKEN_TTL_SECONDS = 3600;
const DEVICE_TOKEN_TTL = '1h';

const DEVICE_SECRET = resolveSecret(
  'DEVICE_JWT_SECRET',
  'ace-device-secret-development-only-not-for-production'
);

export interface DeviceTokenPayload {
  deviceId: string;
  typ: 'device';
}

/** Signs a short-lived device token. */
export function signDeviceToken(deviceId: string): string {
  return jwt.sign({ sub: deviceId, typ: 'device' }, DEVICE_SECRET, {
    expiresIn: DEVICE_TOKEN_TTL,
  });
}

/** Verifies a device token. Returns null for garbage, expired, or wrong-typed tokens. */
export function verifyDeviceToken(token: string): DeviceTokenPayload | null {
  try {
    const decoded = jwt.verify(token, DEVICE_SECRET) as any;
    if (decoded.typ !== 'device') return null;
    if (!decoded.sub) return null;
    return { deviceId: String(decoded.sub), typ: 'device' };
  } catch {
    return null;
  }
}

/**
 * A login grant is how a signed-in user vouches for the PC they are on. The app
 * gets one with its session and hands it to the local service, which can't
 * forge one, so the backend always learns the real user.
 */
export const DEVICE_LOGIN_GRANT_TTL_SECONDS = 300;

export function signDeviceLoginGrant(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'device-login-grant' }, DEVICE_SECRET, {
    expiresIn: DEVICE_LOGIN_GRANT_TTL_SECONDS,
  });
}

/** Returns the user id, or null for garbage, expired, or wrong-typed tokens. */
export function verifyDeviceLoginGrant(grant: string): string | null {
  try {
    const decoded = jwt.verify(grant, DEVICE_SECRET) as any;
    if (decoded.typ !== 'device-login-grant' || !decoded.sub) return null;
    return String(decoded.sub);
  } catch {
    return null;
  }
}

/** Express middleware — requires `Authorization: Bearer <device token>`. */
export function requireDeviceToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Device token required.' });
    return;
  }

  const payload = verifyDeviceToken(authHeader.substring(7));
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired device token.' });
    return;
  }

  (req as any).device = payload;
  next();
}

/**
 * Rejects devices that have been disabled, retired, or revoked after their
 * token was issued. Tokens are short-lived, but a blocked device must not be
 * able to keep refreshing or heartbeating for that hour.
 */
export async function requireActiveDevice(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const deviceId = (req as any).device?.deviceId as string | undefined;

  if (!deviceId) {
    res.status(401).json({ error: 'Device token required.' });
    return;
  }

  try {
    const status = await getDeviceAccessStatus(deviceId);

    if (status === 'missing') {
      res.status(401).json({ error: 'Device no longer exists.' });
      return;
    }

    if (status === 'blocked') {
      res.status(403).json({ error: 'Device has been disabled.' });
      return;
    }

    next();
  } catch (err) {
    console.error(`[device-auth] access check failed for ${deviceId}:`, err);
    res.status(500).json({ error: 'Device authorization check failed.' });
  }
}
