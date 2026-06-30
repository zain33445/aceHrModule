import { Router } from 'express';
import prisma from '../prisma';
import { DisputeService } from '../services/dispute.service';

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
        take,
        include: {
          user: { select: { monthly_salary: true } }
        }
      }),
      prisma.deduction.count({ where })
    ]);

    // Pre-compute working days per month to avoid duplicate DB queries
    const monthKeys = new Set(deductions.map(d =>
      d.type !== 'leave' ? `${d.date.getFullYear()}-${d.date.getMonth()}` : ''
    ));
    const monthCache = new Map<string, number>();
    await Promise.all([...monthKeys].filter(Boolean).map(async (key) => {
      const [y, m] = key.split('-').map(Number);
      monthCache.set(key, await DisputeService.getWorkingDaysInMonth(y, m));
    }));

    // Recalculate amounts on-the-fly using current working days
    const records = deductions.map((d) => {
      const { user, ...rest } = d;
      let amount = d.amount;
      if (d.type !== 'leave') {
        const monthKey = `${d.date.getFullYear()}-${d.date.getMonth()}`;
        const workingDays = monthCache.get(monthKey)!;
        let multiplier: number;
        switch (d.type) {
          case 'absent':   multiplier = 1; break;
          case 'late':     multiplier = 0.3; break;
          case 'half-day': multiplier = 0.5; break;
          default:         multiplier = 0;
        }
        amount = parseFloat(((user.monthly_salary / workingDays) * multiplier).toFixed(2));
      }
      return { ...rest, amount };
    });

    res.json({
      records,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user deductions" });
  }
});

export default router;
