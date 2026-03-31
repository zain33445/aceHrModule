import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all attendance logs
router.get('/', async (req, res) => {
  try {
    const logs = await prisma.attendanceLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 1000 // Limit for safety
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch attendance" });
  }
});

// Get user specific attendance logs
router.get('/:userId', async (req, res) => {
  try {
    const logs = await prisma.attendanceLog.findMany({
      where: { user_id: String(req.params.userId) },
      orderBy: { timestamp: 'desc' }
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user attendance" });
  }
});

// Salary and attendance report (The heavy lifter)
// Needs proper date filtering similar to old Python implementation
router.get('/report/salary-report', async (req, res) => {
  const { start_date, end_date } = req.query;
  
  try {
    // Fetch users and join LeaveBank and AttendanceRecords
    const users = await prisma.user.findMany({
      include: {
        attendance_records: {
            where: start_date && end_date ? {
                date: {
                    gte: new Date(start_date as string),
                    lte: new Date(end_date as string)
                }
            } : undefined
        },
        leaveBank: true
      }
    });

    // 0. Pre-fetch all deductions grouped by user
    const deductionWhere: any = {};
    if (start_date && end_date) {
      deductionWhere.date = {
        gte: new Date(start_date as string),
        lte: new Date(end_date as string)
      };
    }
    const groupedDeductions = await prisma.deduction.groupBy({
      by: ['user_id'],
      where: deductionWhere,
      _sum: { amount: true }
    });
    const deductionMap = new Map(groupedDeductions.map(d => [d.user_id, d._sum.amount || 0]));

    const report = await Promise.all(users.map(async (user) => {
      const records = user.attendance_records;
      
      // Filter for worked days (present, late, halfday)
      const workedRecords = records.filter(r => ['present', 'late', 'halfday'].includes(r.status));
      const daysWorked = workedRecords.length;

      const totalAllowedLeaves = user.leave_bank;
      const remainingLeaves = user.leaveBank && typeof user.leaveBank.leaves_remaining === 'number'
        ? user.leaveBank.leaves_remaining
        : totalAllowedLeaves;
      const paidLeavesUsed = totalAllowedLeaves - remainingLeaves;

      // Identify absences and paid leaves from records
      const absentDays = records.filter(r => r.status === 'absent').length;
      const leaveDays = records.filter(r => r.status === 'leave').length;

      const paidLeaveDates = records.filter(r => r.status === 'leave').map(r => r.date.toISOString().split('T')[0]);
      const unpaidAbsenceDates = records.filter(r => r.status === 'absent').map(r => r.date.toISOString().split('T')[0]);

      // Financials
      const deductions = deductionMap.get(user.id) || 0;
      const totalSalary = Math.max(0, user.monthly_salary - deductions);

      return {
        id: user.id,
        name: user.name,
        monthly_salary: user.monthly_salary,
        leave_bank: totalAllowedLeaves,
        days_worked: daysWorked,
        absent_days: absentDays + leaveDays,
        paid_leave_dates: paidLeaveDates,
        unpaid_absence_dates: unpaidAbsenceDates,
        paid_leaves_used: paidLeavesUsed,
        deductions: parseFloat(deductions.toFixed(2)),
        total_salary: parseFloat(totalSalary.toFixed(2)),
        remaining_leaves: remainingLeaves,
        period: {
          start: start_date || 'N/A',
          end: end_date || 'N/A'
        }
      };
    }));

    res.json(report);
  } catch (error) {
    console.error('Error generating salary report:', error);
    res.status(500).json({ error: "Failed to generate salary report" });
  }
});

export default router;
