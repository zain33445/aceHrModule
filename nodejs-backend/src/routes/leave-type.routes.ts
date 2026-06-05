import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all leave types
router.get('/', async (req, res) => {
  try {
    const types = await prisma.leaveType.findMany({ orderBy: { name: 'asc' } });
    res.json(types);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leave types' });
  }
});

export default router;
