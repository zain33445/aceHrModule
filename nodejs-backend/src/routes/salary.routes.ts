import { Router } from 'express';
import prisma from '../prisma';
import { OvertimeService } from '../services/overtime.service';

const router = Router();

// Get all salaries
router.get('/', async (req, res) => {
  try {
    const salaries = await prisma.salary.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });
    res.json(salaries);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch salaries" });
  }
});

// Bulk pay salaries for all active users for a month
router.post('/bulk-pay', async (req, res) => {
  const { date } = req.body;

  if (!date) return res.status(400).json({ error: 'Date is required' });

  try {
    const paymentDate = new Date(date);
    paymentDate.setDate(1); // Standardize to 1st of month

    // Get all users
    const users = await prisma.user.findMany({
      where: { role: 'employee' }
    });

    let paidCount = 0;

    for (const user of users) {
      // 1. Calculate deductions for this month
      const startOfMonth = new Date(paymentDate.getFullYear(), paymentDate.getMonth(), 1);
      const endOfMonth = new Date(paymentDate.getFullYear(), paymentDate.getMonth() + 1, 0, 23, 59, 59);

      const deductionAgg = await prisma.deduction.aggregate({
        where: {
          user_id: user.id,
          date: { gte: startOfMonth, lte: endOfMonth }
        },
        _sum: { amount: true }
      });

      const deductions = deductionAgg._sum.amount || 0;

      // 3. Get approved overtime pay for this month
      const otAgg = await OvertimeService.getUserMonthlyAggregation(user.id, paymentDate);
      const overtimePay = otAgg.overtime_pay;

      // 4. Mark approved overtime as paid
      if (overtimePay > 0) {
        await OvertimeService.markAsPaid(user.id, paymentDate);
      }

      const finalSalary = Math.max(0, user.monthly_salary - deductions + overtimePay);

      // 5. Check if already paid this month to avoid duplicates
      const existing = await prisma.salary.findFirst({
        where: {
          user_id: user.id,
          date: { gte: startOfMonth, lte: endOfMonth }
        }
      });

      if (!existing) {
        await prisma.salary.create({
          data: {
            user_id: user.id,
            date: paymentDate,
            base_salary: user.monthly_salary,
            deduction: deductions,
            overtime_pay: overtimePay,
            paid_salary: finalSalary
          }
        });
        paidCount++;
      }
    }

    res.json({ message: `Successfully processed ${paidCount} salaries for ${paymentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}` });
  } catch (error) {
    console.error('Failed to process bulk salary:', error);
    res.status(500).json({ error: 'Failed to process bulk salaries' });
  }
});

// Get salaries for a specific user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const salaries = await prisma.salary.findMany({
      where: { user_id: userId },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });
    res.json(salaries);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user salaries" });
  }
});

// Create a salary record
router.post('/', async (req, res) => {
  const { user_id, paid_salary, date, base_salary, deduction } = req.body;
  try {
    const salary = await prisma.salary.create({
      data: {
        user_id,
        paid_salary: parseFloat(paid_salary),
        date: new Date(date),
        // base_salary: parseFloat(base_salary),
        deduction: parseFloat(deduction),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Salary record created", salary });
  } catch (error) {
    res.status(500).json({ error: "Failed to create salary record" });
  }
});

// Update a salary record
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { paid_salary, date } = req.body;
  try {
    const salary = await prisma.salary.update({
      where: { id: parseInt(id) },
      data: {
        paid_salary: paid_salary ? parseFloat(paid_salary) : undefined,
        date: date ? new Date(date) : undefined
      },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Salary record updated", salary });
  } catch (error) {
    res.status(500).json({ error: "Failed to update salary record" });
  }
});

// Delete a salary record
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.salary.delete({
      where: { id: parseInt(id) }
    });
    res.json({ message: "Salary record deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete salary record" });
  }
});

export default router;