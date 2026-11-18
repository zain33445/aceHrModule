/**
 * requireRole.ts — role gate for authenticated user routes.
 *
 * Must be placed after `requireUser`, which attaches the verified identity to
 * `req.user`. Unlike requireAdmin.ts this never trusts an unsigned header.
 */

import { Request, Response, NextFunction } from 'express';

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as { userId?: string; role?: string } | undefined;

    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    if (!user.role || !roles.includes(user.role)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    next();
  };
}
