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
    // Fetch users and join LeaveBank for actual leaves_remaining
    const users = await prisma.user.findMany({
      include: {
        attendance_logs: true,
        leaveBank: true // correct relation name for LeaveBank
      }
    });

    // 0. Pre-fetch all deductions grouped by user in a single query (fixes N+1 query issue)
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
      // 1. Smart Pivot: Group logs by day
      const logsByDay: Record<string, { checkIn: Date; checkOut: Date }> = {};
      
      user.attendance_logs.forEach(log => {
        const dateStr = log.timestamp.toISOString().split('T')[0];
        
        let startBound = start_date ? new Date(start_date as string) : new Date('2000-01-01');
        let endBound = end_date ? new Date(end_date as string) : new Date('2100-01-01');
        endBound.setHours(23, 59, 59, 999);

        if (log.timestamp >= startBound && log.timestamp <= endBound) {
            if (!logsByDay[dateStr]) {
                logsByDay[dateStr] = { checkIn: log.timestamp, checkOut: log.timestamp };
            } else {
                if (log.timestamp < logsByDay[dateStr].checkIn) {
                    logsByDay[dateStr].checkIn = log.timestamp;
                }
                if (log.timestamp > logsByDay[dateStr].checkOut) {
                    logsByDay[dateStr].checkOut = log.timestamp;
                }
            }
        }
      });

      const daysWorked = Object.keys(logsByDay).length;
      // Use actual leaves_remaining from LeaveBank if available
      const totalAllowedLeaves = user.leave_bank;
      const remainingLeaves = user.leaveBank && typeof user.leaveBank.leaves_remaining === 'number'
        ? user.leaveBank.leaves_remaining
        : totalAllowedLeaves;
      const paidLeavesUsed = totalAllowedLeaves - remainingLeaves;

      // Calculate Absences (for stats only, not for leave logic)
      let absentDays = 0;
      let paidLeaveDates: string[] = [];
      let unpaidAbsenceDates: string[] = [];
      if (start_date && end_date) {
        let current = new Date(start_date as string);
        const end = new Date(end_date as string);
        while (current <= end) {
          if (current.getDay() !== 0) {
            const currentStr = current.toISOString().split('T')[0];
            if (!logsByDay[currentStr] && current < new Date()) {
              absentDays++;
              // For display only, not for leave logic
              if (paidLeavesUsed > paidLeaveDates.length) {
                paidLeaveDates.push(currentStr);
              } else {
                unpaidAbsenceDates.push(currentStr);
              }
            }
          }
          current.setDate(current.getDate() + 1);
        }
      }

      // Financials — get total deductions from pre-fetched map
      const deductions = deductionMap.get(user.id) || 0;
      const totalSalary = Math.max(0, user.monthly_salary - deductions);

      return {
        id: user.id,
        name: user.name,
        monthly_salary: user.monthly_salary,
        leave_bank: totalAllowedLeaves,
        days_worked: daysWorked,
        absent_days: unpaidAbsenceDates.length + paidLeaveDates.length,
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
