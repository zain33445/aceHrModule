import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// GET /api/leave-summary?department_id=2
// Per-employee leave report: remaining, used and accrual rate per leave type, plus totals.
router.get('/', async (req, res) => {
  try {
    const { department_id } = req.query;
    const deptFilter =
      department_id && department_id !== 'all'
        ? parseInt(department_id as string)
        : null;

    const [leaveTypes, users, leaveBanks, leaveRequests, policies] = await Promise.all([
      prisma.leaveType.findMany({ orderBy: { id: 'asc' } }),
      prisma.user.findMany({
        where: deptFilter ? { department_id: deptFilter } : {},
        select: {
          id: true,
          name: true,
          status: true,
          department_id: true,
          department: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.leaveBank.findMany(),
      prisma.leaveRequest.findMany({
        where: { status: 'APPROVED' },
        select: { user_id: true, leave_type_id: true, days_consumed: true },
      }),
      prisma.employeeLeavePolicy.findMany({
        where: { effective_to: null },
        select: { user_id: true, leave_type_id: true, accrual_rate: true },
      }),
    ]);

    const key = (userId: string, typeId: number | string) => `${userId}_${typeId}`;

    const remainingMap = new Map<string, number>();
    for (const lb of leaveBanks) {
      remainingMap.set(key(lb.user_id, lb.leave_type_id), lb.leaves_remaining || 0);
    }

    const usedMap = new Map<string, number>();
    for (const lr of leaveRequests) {
      if (lr.leave_type_id === null) continue;
      const k = key(lr.user_id, lr.leave_type_id);
      const days = Number(lr.days_consumed) || 0;
      usedMap.set(k, (usedMap.get(k) || 0) + days);
    }

    const accrualMap = new Map<string, number>();
    for (const p of policies) {
      accrualMap.set(key(p.user_id, p.leave_type_id), Number(p.accrual_rate) || 0);
    }

    const employees = users.map((user) => {
      const rows = leaveTypes.map((lt) => {
        const k = key(user.id, lt.id);
        return {
          leave_type_id: lt.id,
          name: lt.name,
          remaining: Number(Number(remainingMap.get(k) || 0).toFixed(2)),
          used: Number(Number(usedMap.get(k) || 0).toFixed(2)),
          accrual_rate: Number(Number(accrualMap.get(k) || 0).toFixed(2)),
        };
      });

      const totals = {
        remaining: Number(rows.reduce((s, r) => s + r.remaining, 0).toFixed(2)),
        used: Number(rows.reduce((s, r) => s + r.used, 0).toFixed(2)),
        accrual: Number(rows.reduce((s, r) => s + r.accrual_rate, 0).toFixed(2)),
      };

      return {
        id: user.id,
        name: user.name,
        status: user.status,
        department_id: user.department_id,
        department: user.department?.name || '',
        types: rows,
        totals,
      };
    });

    res.json({ leaveTypes, employees });
  } catch (error) {
    console.error('Failed to generate leave summary:', error);
    res.status(500).json({ error: 'Failed to generate leave summary' });
  }
});

export default router;