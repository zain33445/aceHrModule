import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get deductions for a specific user with pagination and filters
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate, type, page = 1, limit = 20 } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const where: any = { user_id: userId };
  
  if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate as string),
      lte: new Date(endDate as string)
    };
  }

  if (type && type !== 'all') {
    where.type = type;
  }

  try {
    const [deductions, total] = await Promise.all([
      prisma.deduction.findMany({
        where,
        orderBy: {
          date: 'desc'
        },
        skip,
        take
      }),
      prisma.deduction.count({ where })
    ]);

    res.json({
      records: deductions,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user deductions" });
  }
});

export default router;
