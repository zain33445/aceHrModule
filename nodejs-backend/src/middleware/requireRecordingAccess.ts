/**
 * requireRecordingAccess.ts — read access to recordings: admin/superadmin, or a
 * user holding the 'recording' tab (user_tab_access). Same Bearer-session
 * verification path as requireAdmin. Sets req.adminUser = { id, name, role }
 * (the id of whoever is viewing) for the handlers.
 */
import { Request, Response, NextFunction } from 'express';
import { verifyUserToken, findSessionUser, TOKEN_EXPIRED_CODE } from './requireUser';
import prisma from '../prisma';

export async function requireRecordingAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      const grant = await prisma.userTabAccess.findUnique({
        where: { user_id_tab_key: { user_id: user.id, tab_key: 'recording' } },
        select: { user_id: true },
      });
      if (!grant) {
        res.status(403).json({ error: 'Recording access required. Insufficient permissions.' });
        return;
      }
    }
    (req as any).adminUser = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (err: any) {
    console.error('[requireRecordingAccess] DB error:', err.message);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}
