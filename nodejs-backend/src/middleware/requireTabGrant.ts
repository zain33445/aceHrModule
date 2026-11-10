/**
 * requireTabGrant.ts — admin/superadmin, or a user holding ANY of the given tabs (user_tab_access).
 * Same Bearer-session verification path as requireRecordingAccess.
 */
import { Request, Response, NextFunction } from 'express';
import { verifyUserToken, findSessionUser, TOKEN_EXPIRED_CODE } from './requireUser';
import prisma from '../prisma';

export function requireAnyTabGrant(keys: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required. Use Authorization: Bearer <token>.', code: TOKEN_EXPIRED_CODE });
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
        const grant = await prisma.userTabAccess.findFirst({
          where: { user_id: user.id, tab_key: { in: keys } },
          select: { user_id: true },
        });
        if (!grant) {
          res.status(403).json({ error: 'Access required. Insufficient permissions.' });
          return;
        }
      }
      (req as any).adminUser = { id: user.id, name: user.name, role: user.role };
      next();
    } catch (err: any) {
      console.error('[requireAnyTabGrant] DB error:', err.message);
      res.status(500).json({ error: 'Authentication check failed.' });
    }
  };
}
