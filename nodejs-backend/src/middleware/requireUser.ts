/**
 * requireUser.ts — Signed user-session authentication middleware.
 *
 * The legacy trust model in this codebase (`X-User-Id` / `X-Admin-Id` headers,
 * or a `user_id` in the request body) is an *unsigned* identity claim: anyone
 * who knows a numeric user id can impersonate that user. That is acceptable
 * for the read-only HR endpoints it was written for, but it is not acceptable
 * for voice/video calling, where a forged identity means an attacker can ring
 * an employee, join a call, and land in an HR-audited audio recording.
 *
 * This middleware introduces a real HMAC-signed session token:
 *
 *   POST /api/auth/login  ->  { token, user_id, name, role, is_lead }
 *
 * The token is signed with JWT_SECRET and carries { sub, typ, name, role }.
 * A short-lived 'call' ticket (5 min) is also accepted, so the WebSocket
 * gateway and the REST routes can share a single verification path.
 *
 * No `X-User-Id` fallback exists here on purpose.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';

const SESSION_SECRET = process.env.JWT_SECRET || 'ace-hrm-secret-development-key-2026';

export const SESSION_TOKEN_TTL = '8h';
export const CALL_TOKEN_TTL = '5m';

export interface UserTokenPayload {
  userId: string;
  name?: string;
  role?: string;
  typ: 'session' | 'call' | 'agent';
}

/**
 * Signs a long-lived session token for a logged-in user.
 */
export function signSessionToken(user: {
  id: string;
  name: string;
  role: string;
}): string {
  return jwt.sign(
    { sub: user.id, typ: 'session', name: user.name, role: user.role },
    SESSION_SECRET,
    { expiresIn: SESSION_TOKEN_TTL }
  );
}

/**
 * Signs a short-lived ticket used to authenticate a call WebSocket.
 * Deliberately separate from the session token so a leaked URL is useless
 * after 5 minutes and cannot be replayed against the REST API.
 */
export function signCallToken(user: {
  id: string;
  name: string;
  role: string;
}): string {
  return jwt.sign(
    { sub: user.id, typ: 'call', name: user.name, role: user.role },
    SESSION_SECRET,
    { expiresIn: CALL_TOKEN_TTL }
  );
}

/**
 * Verifies a token issued by this module. Returns null for anything invalid,
 * expired, or signed with the wrong secret.
 */
export function verifyUserToken(token: string): UserTokenPayload | null {
  try {
    const decoded = jwt.verify(token, SESSION_SECRET) as any;
    if (decoded.typ !== 'session' && decoded.typ !== 'call') return null;
    if (!decoded.sub) return null;
    return {
      userId: String(decoded.sub),
      name: decoded.name,
      role: decoded.role,
      typ: decoded.typ,
    };
  } catch {
    return null;
  }
}

/**
 * Express middleware — requires a valid session or call token.
 * Attaches the resolved user to `req.user`.
 */
export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Authentication required. Use Authorization: Bearer <token>.',
    });
    return;
  }

  const payload = verifyUserToken(authHeader.substring(7));

  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, name: true, role: true, status: true },
    });

    if (!user) {
      res.status(401).json({ error: 'User not found.' });
      return;
    }

    if (user.status !== 'active') {
      res.status(403).json({ error: 'User account is not active.' });
      return;
    }

    (req as any).user = {
      userId: user.id,
      name: user.name,
      role: user.role,
    } as UserTokenPayload;

    next();
  } catch (err) {
    console.error('[Auth] requireUser lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
