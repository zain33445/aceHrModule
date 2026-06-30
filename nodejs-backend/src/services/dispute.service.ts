import prisma from '../prisma';
import { DISPUTE_STATUS, ACTION_TYPES } from '../constants/dispute.constants';
import { DisputeWorkflow } from './dispute.workflow';

export class DisputeService {
  // Helper to get active working days in a month (excluding weekends and holidays)
  public static async getWorkingDaysInMonth(year: number, month: number): Promise<number> {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let workingDays = 0;
    for (let i = 1; i <= daysInMonth; i++) {
      const dayOfWeek = new Date(year, month, i).getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        workingDays++;
      }
    }

    const startOfMonth = new Date(`${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00.000Z`);
    const endOfMonth = new Date(`${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}T23:59:59.999Z`);

    const holidays = await prisma.holiday.findMany({
      where: {
        date: { gte: startOfMonth, lte: endOfMonth }
      },
      select: { date: true }
    });

    let holidayCount = 0;
    for (const h of holidays) {
      const dayOfWeek = h.date.getUTCDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        holidayCount++;
      }
    }

    const effectiveWorkingDays = workingDays - holidayCount;
    return effectiveWorkingDays > 0 ? effectiveWorkingDays : 30;
  }

  // Calculate deduction amount based on category
  public static async calculateDeductionAmount(category: string, employeeSalary: number, date: Date): Promise<number> {
    const workingDays = await this.getWorkingDaysInMonth(date.getFullYear(), date.getMonth());

    switch (category) {
      case 'absent':
        return employeeSalary / workingDays;
      case 'late':
        return (employeeSalary / workingDays) * 0.3;
      case 'half-day':
        return (employeeSalary / workingDays) * 0.5;
      case 'leave':
        return employeeSalary / workingDays;
      default:
        return 0;
    }
  }

  // Recalculate deduction totals on-the-fly using current working days (including holidays)
  public static async getEffectiveDeductionsTotal(userId: string, startDate: Date, endDate: Date): Promise<number> {
    const deductions = await prisma.deduction.findMany({
      where: {
        user_id: userId,
        date: { gte: startDate, lte: endDate },
        status: 'ACTIVE'
      },
      include: {
        user: { select: { monthly_salary: true } }
      }
    });

    const monthCache = new Map<string, number>();
    let total = 0;

    for (const d of deductions) {
      if (d.type === 'leave') continue;

      const monthKey = `${d.date.getFullYear()}-${d.date.getMonth()}`;
      if (!monthCache.has(monthKey)) {
        const workingDays = await this.getWorkingDaysInMonth(
          d.date.getFullYear(),
          d.date.getMonth()
        );
        monthCache.set(monthKey, workingDays);
      }

      const workingDays = monthCache.get(monthKey)!;
      let multiplier: number;
      switch (d.type) {
        case 'absent':  multiplier = 1; break;
        case 'late':    multiplier = 0.3; break;
        case 'half-day': multiplier = 0.5; break;
        default:        multiplier = 0;
      }

      total += (d.user.monthly_salary / workingDays) * multiplier;
    }

    return total;
  }

  // Get all disputes for a user
  static async getUserDisputes(userId: string) {
    return prisma.dispute.findMany({
      where: { req_by: userId, is_deleted: false },
      include: {
        requester: { select: { id: true, name: true } },
        leadApprover: { select: { id: true, name: true } },
        adminApprover: { select: { id: true, name: true } },
        history: { orderBy: { created_at: 'desc' } }
      },
      orderBy: { date_of_req: 'desc' }
    });
  }

  // Get all disputes for admin
  static async getAdminDisputes(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [records, total] = await Promise.all([
      prisma.dispute.findMany({
        where: { is_deleted: false },
        include: {
          requester: { select: { id: true, name: true, department: true } },
          leadApprover: { select: { id: true, name: true } },
          adminApprover: { select: { id: true, name: true } },
          hrApprover: { select: { id: true, name: true } }
        },
        orderBy: { date_of_req: 'desc' },
        skip,
        take: limit
      }),
      prisma.dispute.count({ where: { is_deleted: false } })
    ]);
    return { records, total };
  }

  // Get team disputes for a lead
  static async getTeamDisputes(leadId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const departments = await prisma.department.findMany({
      where: { lead_id: leadId },
      select: { id: true }
    });
    const deptIds = departments.map(d => d.id);

    const where = {
      requester: { department_id: { in: deptIds } },
      is_deleted: false
    };

    const [records, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        include: {
          requester: { select: { id: true, name: true, department: true } },
          leadApprover: { select: { id: true, name: true } }
        },
        orderBy: { date_of_req: 'desc' },
        skip,
        take: limit
      }),
      prisma.dispute.count({ where })
    ]);
    return { records, total };
  }

  // Create a new dispute
  static async createDispute(data: {
    user_id: string;
    dispute_date: Date;
    category: string;
    description: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.create({
        data: {
          req_by: data.user_id,
          dispute_date: data.dispute_date,
          category: data.category || 'other',
          description: data.description,
          date_of_req: new Date(),
          status: DISPUTE_STATUS.PENDING,
          lead_status: DISPUTE_STATUS.PENDING,
          admin_status: DISPUTE_STATUS.PENDING,
          final_status: DISPUTE_STATUS.PENDING
        }
      });

      await tx.disputeHistory.create({
        data: {
          dispute_id: dispute.id,
          actor_id: data.user_id,
          action: ACTION_TYPES.CREATED,
          remarks: 'Dispute submitted'
        }
      });

      return dispute;
    });
  }

  // Lead Approval
  static async leadApprove(disputeId: number, leadId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new Error('Dispute not found');

      if (!DisputeWorkflow.canTransition(dispute.final_status, ACTION_TYPES.LEAD_APPROVED)) {
        throw new Error('Invalid workflow transition');
      }

      const finalStatus = DisputeWorkflow.computeFinalStatus(DISPUTE_STATUS.APPROVED, dispute.admin_status, dispute.hr_status);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          lead_status: DISPUTE_STATUS.APPROVED,
          lead_approved_by: leadId,
          lead_approved_at: new Date(),
          lead_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus // for backward compatibility
        }
      });

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: leadId,
          action: ACTION_TYPES.LEAD_APPROVED,
          remarks
        }
      });

      await tx.notification.create({
        data: {
          user_id: dispute.req_by,
          type: 'dispute_partially_approved',
          message: `Your dispute for ${new Date(dispute.dispute_date).toLocaleDateString()} was approved by your Team Lead.`
        }
      });

      return updated;
    });
  }

  // Lead Rejection
  static async leadReject(disputeId: number, leadId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new Error('Dispute not found');

      const finalStatus = DisputeWorkflow.computeFinalStatus(DISPUTE_STATUS.REJECTED, dispute.admin_status, dispute.hr_status);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          lead_status: DISPUTE_STATUS.REJECTED,
          lead_approved_by: leadId,
          lead_approved_at: new Date(),
          lead_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus
        }
      });

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: leadId,
          action: ACTION_TYPES.LEAD_REJECTED,
          remarks
        }
      });

      return updated;
    });
  }

  // Admin Approval (Final)
  static async adminApprove(disputeId: number, adminId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { id: disputeId },
        include: { requester: true }
      });
      if (!dispute) throw new Error('Dispute not found');

      const finalStatus = DisputeWorkflow.computeFinalStatus(dispute.lead_status, DISPUTE_STATUS.APPROVED, dispute.hr_status);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          admin_status: DISPUTE_STATUS.APPROVED,
          admin_approved_by: adminId,
          admin_approved_at: new Date(),
          admin_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus,
          approved_by: adminId,
          date_of_approve: new Date()
        }
      });

      // Idempotent Salary Restoration
      if (finalStatus === DISPUTE_STATUS.APPROVED && !dispute.salary_restored) {
        const startOfDay = new Date(dispute.dispute_date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(dispute.dispute_date);
        endOfDay.setHours(23, 59, 59, 999);

        const deduction = await tx.deduction.findFirst({
          where: {
            user_id: dispute.req_by,
            date: { gte: startOfDay, lte: endOfDay },
            type: dispute.category
          }
        });

        if (deduction) {
          // await tx.deduction.delete({ where: { id: deduction.id } });
          await tx.deduction.update({ where: { id: deduction.id }, data: { status: 'REVERSED' } });
          await tx.dispute.update({
            where: { id: disputeId },
            data: { salary_restored: true }
          });
        }
      }

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: adminId,
          action: ACTION_TYPES.ADMIN_APPROVED,
          remarks
        }
      });

      await tx.notification.create({
        data: {
          user_id: dispute.req_by,
          type: 'dispute_approved',
          message: `Your dispute for ${new Date(dispute.dispute_date).toLocaleDateString()} has been fully approved by Admin.`
        }
      });

      return updated;
    });
  }

  // HR Approval (Final)
  static async hrApprove(disputeId: number, hrId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { id: disputeId },
        include: { requester: true }
      });
      if (!dispute) throw new Error('Dispute not found');

      const finalStatus = DisputeWorkflow.computeFinalStatus(dispute.lead_status, dispute.admin_status, DISPUTE_STATUS.APPROVED);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          hr_status: DISPUTE_STATUS.APPROVED,
          hr_approved_by: hrId,
          hr_approved_at: new Date(),
          hr_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus,
          approved_by: hrId,
          date_of_approve: new Date()
        }
      });

      // Idempotent Salary Restoration
      if (finalStatus === DISPUTE_STATUS.APPROVED && !dispute.salary_restored) {
        const startOfDay = new Date(dispute.dispute_date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(dispute.dispute_date);
        endOfDay.setHours(23, 59, 59, 999);

        const deduction = await tx.deduction.findFirst({
          where: {
            user_id: dispute.req_by,
            date: { gte: startOfDay, lte: endOfDay },
            type: dispute.category
          }
        });

        if (deduction) {
          await tx.deduction.update({ where: { id: deduction.id }, data: { status: 'REVERSED' } });
          await tx.dispute.update({
            where: { id: disputeId },
            data: { salary_restored: true }
          });
        }
      }

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: hrId,
          action: ACTION_TYPES.HR_APPROVED,
          remarks
        }
      });

      await tx.notification.create({
        data: {
          user_id: dispute.req_by,
          type: 'dispute_approved',
          message: `Your dispute for ${new Date(dispute.dispute_date).toLocaleDateString()} has been approved by HR.`
        }
      });

      return updated;
    });
  }

  // HR Rejection
  static async hrReject(disputeId: number, hrId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new Error('Dispute not found');

      const finalStatus = DisputeWorkflow.computeFinalStatus(dispute.lead_status, dispute.admin_status, DISPUTE_STATUS.REJECTED);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          hr_status: DISPUTE_STATUS.REJECTED,
          hr_approved_by: hrId,
          hr_approved_at: new Date(),
          hr_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus
        }
      });

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: hrId,
          action: ACTION_TYPES.HR_REJECTED,
          remarks
        }
      });

      return updated;
    });
  }

  // Admin Rejection
  static async adminReject(disputeId: number, adminId: string, remarks: string = '') {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new Error('Dispute not found');

      const finalStatus = DisputeWorkflow.computeFinalStatus(dispute.lead_status, DISPUTE_STATUS.REJECTED, dispute.hr_status);

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          admin_status: DISPUTE_STATUS.REJECTED,
          admin_approved_by: adminId,
          admin_approved_at: new Date(),
          admin_remarks: remarks,
          final_status: finalStatus,
          status: finalStatus
        }
      });

      await tx.disputeHistory.create({
        data: {
          dispute_id: disputeId,
          actor_id: adminId,
          action: ACTION_TYPES.ADMIN_REJECTED,
          remarks
        }
      });

      return updated;
    });
  }
}
