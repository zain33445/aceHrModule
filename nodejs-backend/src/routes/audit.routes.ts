import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get audit logs
router.get('/', async (req, res) => {
  const { limit = 100, page = 1 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  try {
    const logs = await prisma.auditLog.findMany({
      take: Number(limit),
      skip,
      include: {
        user: { select: { id: true, name: true, role: true } }
      },
      orderBy: { created_at: 'desc' }
    });
    
    const total = await prisma.auditLog.count();

    res.json({
      logs,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

export default router;
