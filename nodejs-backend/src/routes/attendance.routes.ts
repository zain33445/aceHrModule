import { Router } from 'express';
import prisma from '../prisma';
import { OvertimeService } from '../services/overtime.service';
import { DisputeService } from '../services/dispute.service';

const router = Router();

// ── GET / — all FP raw attendance logs ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const logs = await prisma.attendanceLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 1000
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// ── Static routes MUST come before the /:userId wildcard ───────────────────

// GET /today/:userId — active AttendanceRecord for dashboard punch buttons.
// Handles night-shift crossover: if no record exists for today but there is
// an open check-in from yesterday, that record is returned so the employee
// sees "Check Out" instead of "Check In".
router.get('/today/:userId', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const todayDate = new Date(`${todayStr}T12:00:00.000Z`);

    // 1. Check today's record first
    const todayRecord = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.params.userId, date: todayDate } }
    });

    if (todayRecord?.check_in_time) {
      return res.json(todayRecord);
    }

    // 2. No active check-in today → look for an open record from yesterday
    //    (covers night-shift workers who checked in yesterday evening)
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const yesterdayDate = new Date(`${yesterdayStr}T12:00:00.000Z`);

    const yesterdayRecord = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.params.userId, date: yesterdayDate } }
    });

    // Return yesterday's record only if it has a check-in but no check-out
    if (yesterdayRecord?.check_in_time && !yesterdayRecord.check_out_time) {
      return res.json(yesterdayRecord);
    }

    // 3. Fall back to today's record (could be null or pending)
    res.json(todayRecord || null);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch today's attendance" });
  }
});

// GET /report/salary-report — salary & attendance report
router.get('/report/salary-report', async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const users = await prisma.user.findMany({
      include: {
        attendance_records: {
          where: start_date && end_date
            ? {
                date: {
                  gte: new Date(start_date as string),
                  lte: new Date(end_date as string),
                },
              }
            : undefined,
        },
        leaveBank: true,
        ledger_entries: {
          where: {
            transaction_type: 'CONSUMPTION',
            ...(start_date && end_date
              ? {
                  created_at: {
                    gte: new Date(start_date as string),
                    lte: new Date(end_date as string),
                  },
                }
              : {}),
          },
        },
      },
    });

    const deductionWhere: any = {
      status: 'ACTIVE',
      type: { in: ['absent', 'late', 'half-day'] }
    };
    if (start_date && end_date) {
      deductionWhere.date = {
        gte: new Date(start_date as string),
        lte: new Date(end_date as string),
      };
    }
    const allDeductions = await prisma.deduction.findMany({
      where: deductionWhere,
      select: {
        user_id: true,
        type: true,
        date: true
      }
    });

    // Build per-user deduction rate multiplier using current working days
    const deductionRateMap = new Map<string, number>();
    const monthCache = new Map<string, number>();
    for (const d of allDeductions) {
      const monthKey = `${d.date.getFullYear()}-${d.date.getMonth()}`;
      if (!monthCache.has(monthKey)) {
        const workingDays = await DisputeService.getWorkingDaysInMonth(
          d.date.getFullYear(), d.date.getMonth()
        );
        monthCache.set(monthKey, workingDays);
      }
      const workingDays = monthCache.get(monthKey)!;
      let multiplier: number;
      switch (d.type) {
        case 'absent':   multiplier = 1; break;
        case 'late':     multiplier = 0.3; break;
        case 'half-day': multiplier = 0.5; break;
        default:         multiplier = 0;
      }
      deductionRateMap.set(
        d.user_id,
        (deductionRateMap.get(d.user_id) || 0) + multiplier / workingDays
      );
    }

    const report = await Promise.all(
      users.map(async user => {
        const records = user.attendance_records;

        const workedRecords = records.filter(r =>
          ['present', 'late', 'halfday'].includes(r.status)
        );
        const daysWorked = workedRecords.length;

        const remainingLeaves = user.leaveBank?.leaves_remaining || 0;
        const paidLeavesUsed = user.ledger_entries.reduce((sum, e) => {
          return sum + Math.abs(e.amount.toNumber());
        }, 0);
        const totalAllowedLeaves = remainingLeaves + paidLeavesUsed;
        const absentDays  = records.filter(r => r.status === 'absent').length;
        const leaveDays   = records.filter(r => r.status === 'leave').length;
        const paidLeaveDates    = records.filter(r => r.status === 'leave').map(r => r.date.toISOString().split('T')[0]);
        const unpaidAbsenceDates = records.filter(r => r.status === 'absent').map(r => r.date.toISOString().split('T')[0]);

        const deductionRate  = deductionRateMap.get(user.id) || 0;
        const deductions = deductionRate * user.monthly_salary;

        // Fetch overtime aggregation for the period
        let overtimePay = 0;
        let overtimeHours = 0;
        if (start_date && end_date) {
          try {
            const otAgg = await OvertimeService.getUserMonthlyAggregation(
              user.id,
              new Date(start_date as string)
            );
            overtimePay = otAgg.overtime_pay;
            overtimeHours = otAgg.overtime_hours;
          } catch (err) {
            // Silently continue if overtime service fails
          }
        }

        const totalSalary = Math.max(0, user.monthly_salary - deductions + overtimePay);

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
          overtime_pay: overtimePay,
          overtime_hours: overtimeHours,
          total_salary: parseFloat(totalSalary.toFixed(2)),
          remaining_leaves: remainingLeaves,
          period: {
            start: start_date || 'N/A',
            end:   end_date   || 'N/A',
          },
        };
      })
    );

    res.json(report);
  } catch (error) {
    console.error('Error generating salary report:', error);
    res.status(500).json({ error: 'Failed to generate salary report' });
  }
});

// POST /manual-punch — manual check-in / check-out from the employee dashboard
// Priority: FP (highest) > manual > monitoring (lowest)
// Handles night-shift crossover: check-out at 03:00 correctly targets the
// previous day's open record when today has no active check-in.
router.post('/manual-punch', async (req, res) => {
  try {
    const { userId, type } = req.body;
    if (!userId || !type || !['check-in', 'check-out'].includes(type)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Karachi',
    });

    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const todayDate = new Date(`${todayStr}T12:00:00.000Z`);

    // ── CHECK-IN ────────────────────────────────────────────────────────────
    if (type === 'check-in') {
      const existingRecord = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: userId, date: todayDate } },
      });

      if (!existingRecord) {
        await prisma.attendanceRecord.create({
          data: {
            user_id: userId,
            date: todayDate,
            check_in_time: timeStr,
            check_in_source: 'manual',
            status: 'present',
          },
        });
        return res.json({ success: true, message: 'Checked in manually', time: timeStr });
      }

      if (!existingRecord.check_in_source || existingRecord.check_in_source === 'monitoring') {
        await prisma.attendanceRecord.update({
          where: { id: existingRecord.id },
          data: { check_in_time: timeStr, check_in_source: 'manual' },
        });
        return res.json({ success: true, message: 'Updated to manual check-in', time: timeStr });
      }

      return res.status(400).json({
        error: 'Check-in already recorded by a higher-priority source (FP or manual)',
      });
    }

    // ── CHECK-OUT ───────────────────────────────────────────────────────────
    // Step 1: look for an open record on today's date
    let targetRecord = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: userId, date: todayDate } },
    });

    // Step 2: night-shift crossover — if today has no open check-in,
    //         check yesterday's record (e.g. check-in 17:00, check-out 03:00)
    if (!targetRecord?.check_in_time || targetRecord.check_out_time) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
      const yesterdayDate = new Date(`${yesterdayStr}T12:00:00.000Z`);

      const yesterdayRecord = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: userId, date: yesterdayDate } },
      });

      // Use yesterday's record if it has an open check-in
      if (yesterdayRecord?.check_in_time && !yesterdayRecord.check_out_time) {
        targetRecord = yesterdayRecord;
      }
    }

    if (!targetRecord?.check_in_time) {
      return res.status(400).json({
        error: 'No open check-in found for today or yesterday. Please check in first.',
      });
    }

    if (targetRecord.check_out_time) {
      return res.status(400).json({
        error: 'Already checked out for this shift.',
      });
    }

    if (!targetRecord.check_out_source || targetRecord.check_out_source === 'monitoring') {
      await prisma.attendanceRecord.update({
        where: { id: targetRecord.id },
        data: { check_out_time: timeStr, check_out_source: 'manual' },
      });
      return res.json({ success: true, message: 'Checked out manually', time: timeStr });
    }

    return res.status(400).json({
      error: 'Check-out already recorded by a higher-priority source (FP or manual)',
    });

  } catch (error) {
    console.error('Manual punch error:', error);
    res.status(500).json({ error: 'Failed to record manual punch' });
  }
});

// ── Wildcard — must be LAST ────────────────────────────────────────────────
// GET /:userId — FP raw attendance logs for a specific user
router.get('/:userId', async (req, res) => {
  try {
    const logs = await prisma.attendanceLog.findMany({
      where: { user_id: String(req.params.userId) },
      orderBy: { timestamp: 'desc' },
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user attendance' });
  }
});

export default router;
