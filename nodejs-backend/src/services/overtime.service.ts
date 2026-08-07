import prisma from '../prisma';
import { DisputeService } from './dispute.service';

export class OvertimeService {

  private static getUtcDateKey(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private static getCanonicalUtcDate(dateRaw: Date): Date {
    return new Date(`${this.getUtcDateKey(dateRaw)}T12:00:00.000Z`);
  }

  static async getEligibleDates(month: string, userId: string): Promise<string[]> {
    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const m = parseInt(monthStr) - 1;

    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const eligible: string[] = [];

    const startOfMonth = new Date(`${year}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000Z`);
    const endOfMonth = new Date(`${year}-${String(m + 1).padStart(2, '0')}-${daysInMonth}T23:59:59.999Z`);

    // Get existing OT requests for this user in this month
    const existingRequests = await prisma.overtimeRequest.findMany({
      where: {
        user_id: userId,
        date: { gte: startOfMonth, lte: endOfMonth },
        status: { in: ['pending', 'approved', 'paid'] }
      },
      select: { date: true }
    });
    const existingDates = new Set(existingRequests.map(r => this.getUtcDateKey(r.date)));

    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = this.getUtcDateKey(new Date(`${year}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00.000Z`));

      const alreadyRequested = existingDates.has(dateKey);

      if (!alreadyRequested) {
        eligible.push(dateKey);
      }
    }

    return eligible;
  }

  static async createRequest(userId: string, date: string, hoursWorked: number, reason?: string) {
    const canonicalDate = this.getCanonicalUtcDate(new Date(date));
    const dateKey = this.getUtcDateKey(canonicalDate);

    // Validate: date must be within current or previous month in Karachi timezone
    const nowKarachi = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }));
    const currentMonth = `${nowKarachi.getFullYear()}-${String(nowKarachi.getMonth() + 1).padStart(2, '0')}`;
    const prevMonthDate = new Date(nowKarachi.getFullYear(), nowKarachi.getMonth() - 1, 1);
    const prevMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
    const requestedMonth = dateKey.substring(0, 7);
    if (requestedMonth !== currentMonth && requestedMonth !== prevMonth) {
      throw new Error('Overtime can only be requested for the current or previous month');
    }

    const holiday = await prisma.holiday.findFirst({
      where: { date: canonicalDate }
    });
    const isHoliday = !!holiday;
    const dayOfWeek = canonicalDate.getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Check duplicate
    const existing = await prisma.overtimeRequest.findUnique({
      where: {
        user_id_date: { user_id: userId, date: canonicalDate }
      }
    });
    if (existing) {
      throw new Error('An overtime request already exists for this date');
    }

    // Validate hours
    if (!hoursWorked || hoursWorked <= 0 || hoursWorked > 24) {
      throw new Error('Hours worked must be between 1 and 24');
    }

    const request = await prisma.overtimeRequest.create({
      data: {
        user_id: userId,
        date: canonicalDate,
        hours_worked: hoursWorked,
        reason,
        is_weekend: isWeekend,
        is_holiday: isHoliday,
        holiday_name: holiday?.name || null
      },
      include: {
        user: { select: { id: true, name: true } }
      }
    });

    return request;
  }

  static async cancelRequest(requestId: number, userId: string) {
    const request = await prisma.overtimeRequest.findUnique({
      where: { id: requestId }
    });

    if (!request) throw new Error('Request not found');
    if (request.user_id !== userId) throw new Error('Unauthorized');
    if (request.status !== 'pending') throw new Error('Only pending requests can be cancelled');

    await prisma.overtimeRequest.update({
      where: { id: requestId },
      data: { status: 'cancelled' }
    });

    return { message: 'Request cancelled' };
  }

  static async approveRequest(requestId: number, approverId: string, multiplier?: number) {
    const request = await prisma.overtimeRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, name: true, monthly_salary: true } } }
    });

    if (!request) throw new Error('Request not found');
    if (request.status !== 'pending') throw new Error('Only pending requests can be approved');
    if (request.lead_status !== 'approved') throw new Error('Lead approval is required before admin action');

    const canonicalDate = this.getCanonicalUtcDate(request.date);
    const year = canonicalDate.getUTCFullYear();
    const month = canonicalDate.getUTCMonth();

    const effectiveWorkingDays = await DisputeService.getWorkingDaysInMonth(year, month);

    const monthlySalary = request.user.monthly_salary;
    const hourlyRate = monthlySalary / effectiveWorkingDays / 9;
    const finalMultiplier = multiplier ?? 1;
    const overtimePay = request.hours_worked * hourlyRate * finalMultiplier;

    const updated = await prisma.overtimeRequest.update({
      where: { id: requestId },
      data: {
        status: 'approved',
        hourly_rate: parseFloat(hourlyRate.toFixed(2)),
        overtime_pay: parseFloat(overtimePay.toFixed(2)),
        multiplier: finalMultiplier,
        approved_by: approverId,
        approved_at: new Date()
      },
      include: {
        user: { select: { id: true, name: true, monthly_salary: true } },
        approver: { select: { id: true, name: true } }
      }
    });

    return updated;
  }

  static async rejectRequest(requestId: number, approverId: string, reason?: string) {
    const request = await prisma.overtimeRequest.findUnique({
      where: { id: requestId }
    });

    if (!request) throw new Error('Request not found');
    if (request.status !== 'pending') throw new Error('Only pending requests can be rejected');
    if (request.lead_status !== 'approved') throw new Error('Lead approval is required before admin action');

    const updated = await prisma.overtimeRequest.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        rejection_reason: reason || null,
        approved_by: approverId,
        approved_at: new Date()
      },
      include: {
        user: { select: { id: true, name: true } },
        approver: { select: { id: true, name: true } }
      }
    });

    return updated;
  }

  static async markAsPaid(userId: string, date: Date) {
    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);

    await prisma.overtimeRequest.updateMany({
      where: {
        user_id: userId,
        date: { gte: startOfMonth, lte: endOfMonth },
        status: 'approved'
      },
      data: { status: 'paid' }
    });
  }

  static async getUserRequests(userId: string, month?: string) {
    const where: any = { user_id: userId };
    if (month) {
      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const m = parseInt(monthStr) - 1;
      where.date = {
        gte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000Z`),
        lte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-31T23:59:59.999Z`)
      };
    }

    return prisma.overtimeRequest.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        approver: { select: { id: true, name: true } }
      }
    });
  }

  static async getAllRequests(params: {
    month?: string;
    status?: string;
    leadStatus?: string;
    userId?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    const { month, status, leadStatus, userId, page = 1, limit = 20 } = params;

    if (userId && userId !== 'all') {
      where.user_id = userId;
    }
    if (status && status !== 'all') {
      where.status = status.includes(',') ? { in: status.split(',') } : status;
    }
    if (leadStatus && leadStatus !== 'all') {
      where.lead_status = leadStatus;
    }
    if (month) {
      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const m = parseInt(monthStr) - 1;
      where.date = {
        gte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000Z`),
        lte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-31T23:59:59.999Z`)
      };
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        orderBy: { date: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, name: true, monthly_salary: true } },
          approver: { select: { id: true, name: true } },
          leadApprover: { select: { id: true, name: true } }
        }
      }),
      prisma.overtimeRequest.count({ where })
    ]);

    return { records, total, page, limit };
  }

  static async getMonthlySummary(month: string) {
    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const m = parseInt(monthStr) - 1;

    const where = {
      date: {
        gte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000Z`),
        lte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-31T23:59:59.999Z`)
      }
    };

    const [requests, aggregation] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        include: {
          user: { select: { id: true, name: true } }
        },
        orderBy: { date: 'desc' }
      }),
      prisma.overtimeRequest.aggregate({
        where: { ...where, status: { in: ['approved', 'paid'] } },
        _sum: { hours_worked: true, overtime_pay: true },
        _count: true
      })
    ]);

    return {
      requests,
      summary: {
        totalRequests: requests.length,
        approvedPay: aggregation._sum.overtime_pay || 0,
        approvedHours: aggregation._sum.hours_worked || 0,
        pendingCount: requests.filter(r => r.status === 'pending').length,
        approvedCount: requests.filter(r => r.status === 'approved').length,
        paidCount: requests.filter(r => r.status === 'paid').length,
        rejectedCount: requests.filter(r => r.status === 'rejected').length
      }
    };
  }

  static async getUserMonthlyAggregation(userId: string, date: Date) {
    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);

    const result = await prisma.overtimeRequest.aggregate({
      where: {
        user_id: userId,
        date: { gte: startOfMonth, lte: endOfMonth },
        status: { in: ['approved', 'paid'] }
      },
      _sum: { overtime_pay: true, hours_worked: true }
    });

    return {
      overtime_pay: result._sum.overtime_pay || 0,
      overtime_hours: result._sum.hours_worked || 0
    };
  }

  static async getTeamRequests(leadId: string, month?: string, status?: string, page = 1, limit = 20) {
    const departments = await prisma.department.findMany({
      where: { lead_id: leadId },
      select: { id: true }
    });
    const deptIds = departments.map(d => d.id);

    const where: any = {
      user: { department_id: { in: deptIds } }
    };

    if (status && status !== 'all') {
      where.lead_status = status;
    }

    if (month) {
      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const m = parseInt(monthStr) - 1;
      where.date = {
        gte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000Z`),
        lte: new Date(`${year}-${String(m + 1).padStart(2, '0')}-31T23:59:59.999Z`)
      };
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        orderBy: { date: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, name: true, monthly_salary: true, department_id: true } },
          approver: { select: { id: true, name: true } },
          leadApprover: { select: { id: true, name: true } }
        }
      }),
      prisma.overtimeRequest.count({ where })
    ]);

    return { records, total, page, limit };
  }

  static async leadApprove(requestId: number, leadId: string, multiplier?: number, remarks?: string) {
    const request = await prisma.overtimeRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, name: true, monthly_salary: true, department_id: true } } }
    });

    if (!request) throw new Error('Request not found');
    if (request.lead_status !== 'pending') throw new Error('Request already processed by lead');

    // Verify the lead owns the department of the employee
    const dept = await prisma.department.findFirst({
      where: { lead_id: leadId, id: request.user.department_id! }
    });
    if (!dept) throw new Error('You are not the lead of this employee\'s department');

    const canonicalDate = this.getCanonicalUtcDate(request.date);
    const year = canonicalDate.getUTCFullYear();
    const month = canonicalDate.getUTCMonth();
    const effectiveWorkingDays = await DisputeService.getWorkingDaysInMonth(year, month);
    const monthlySalary = request.user.monthly_salary;
    const hourlyRate = monthlySalary / effectiveWorkingDays / 9;
    const finalMultiplier = multiplier ?? 1;
    const overtimePay = request.hours_worked * hourlyRate * finalMultiplier;

    const updated = await prisma.overtimeRequest.update({
      where: { id: requestId },
      data: {
        lead_status: 'approved',
        lead_approved_by: leadId,
        lead_approved_at: new Date(),
        lead_remarks: remarks || null,
        hourly_rate: parseFloat(hourlyRate.toFixed(2)),
        overtime_pay: parseFloat(overtimePay.toFixed(2)),
        multiplier: finalMultiplier
      },
      include: {
        user: { select: { id: true, name: true } },
        leadApprover: { select: { id: true, name: true } }
      }
    });

    return updated;
  }

  static async leadReject(requestId: number, leadId: string, remarks?: string) {
    const request = await prisma.overtimeRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, name: true, department_id: true } } }
    });

    if (!request) throw new Error('Request not found');
    if (request.lead_status !== 'pending') throw new Error('Request already processed by lead');

    const dept = await prisma.department.findFirst({
      where: { lead_id: leadId, id: request.user.department_id! }
    });
    if (!dept) throw new Error('You are not the lead of this employee\'s department');

    const updated = await prisma.overtimeRequest.update({
      where: { id: requestId },
      data: {
        lead_status: 'rejected',
        lead_approved_by: leadId,
        lead_approved_at: new Date(),
        lead_remarks: remarks || null,
        status: 'rejected'
      },
      include: {
        user: { select: { id: true, name: true } },
        leadApprover: { select: { id: true, name: true } }
      }
    });

    return updated;
  }
}
