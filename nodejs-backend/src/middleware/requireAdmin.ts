/**
 * requireAdmin.ts — RBAC middleware for admin-only recording/monitoring endpoints.
 *
 * Authenticates with `Authorization: Bearer <user session token>` (same
 * verification path as requireUser) and then requires role admin/superadmin.
 * The legacy X-Admin-Id / admin_id / adminId identity claims are NOT accepted.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyUserToken, findSessionUser, TOKEN_EXPIRED_CODE } from './requireUser';

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Authentication required. Use Authorization: Bearer <token>.',
      code: TOKEN_EXPIRED_CODE,
    });
    return;
  }

  const payload = verifyUserToken(authHeader.substring(7));
  if (!payload?.sessionId) {
    res.status(401).json({ error: 'Invalid or expired token.', code: TOKEN_EXPIRED_CODE });
    return;
  }

  try {
    const user = await findSessionUser(payload.sessionId, payload.userId);
    if (!user) {
      res.status(401).json({ error: 'Session has ended.', code: TOKEN_EXPIRED_CODE });
      return;
    }
    if (user.status !== 'active') {
      res.status(403).json({ error: 'User account is not active.' });
      return;
    }
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      res.status(403).json({ error: 'Admin access required. Insufficient permissions.' });
      return;
    }

    (req as any).adminUser = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (err: any) {
    console.error('[requireAdmin] DB error:', err.message);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}
