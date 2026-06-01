/**
 * requireAdmin.ts — RBAC middleware for admin-only recording endpoints.
 *
 * Reads the admin's user_id from the X-Admin-Id header (or req.body.admin_id)
 * and verifies the user has role 'admin' or 'superadmin' in the DB.
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../prisma';

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const adminId =
    (req.headers['x-admin-id'] as string) || req.body?.admin_id || req.query?.adminId;

  if (!adminId) {
    res.status(401).json({ error: 'Admin authentication required. Provide X-Admin-Id header.' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: adminId } });

    if (!user) {
      res.status(401).json({ error: 'Admin user not found.' });
      return;
    }

    if (user.role !== 'admin' && user.role !== 'superadmin') {
      res.status(403).json({ error: 'Admin access required. Insufficient permissions.' });
      return;
    }

    // Attach admin user to request for downstream use
    (req as any).adminUser = user;
    next();
  } catch (err: any) {
    console.error('[requireAdmin] DB error:', err.message);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}
