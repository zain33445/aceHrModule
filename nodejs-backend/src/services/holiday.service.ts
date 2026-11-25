import prisma from '../prisma';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class HolidayService {
  /**
   * Returns a UTC noon DateTime for a given date so it matches the canonical
   * format used by AbsenceService throughout the codebase.
   */
  private static getCanonicalUtcDate(date: Date): Date {
    const dateKey = date.toISOString().split('T')[0];
    return new Date(`${dateKey}T12:00:00.000Z`);
  }

  /**
   * Full UTC day window for a canonical date. Used instead of exact DateTime
   * matches so legacy rows stored at another time of day are still found.
   */
  private static getUtcDayWindow(date: Date): { start: Date; end: Date } {
    const dateKey = date.toISOString().split('T')[0];
    return {
      start: new Date(`${dateKey}T00:00:00.000Z`),
      end: new Date(`${dateKey}T23:59:59.999Z`)
    };
  }

  /**
   * Reverses the leave consumed for one holiday date.
   *
   * Handles both consumption sources:
   *  - an approved leave request covering the date: reverses that day's share
   *    of the request's CONSUMPTION row (1 for a full day, 0.5 for a half day,
   *    0.3 for a late-leave request, etc.)
   *  - a legacy automatic absence deduction: `<user>-<type>-<date>-LEAVE_CONSUMPTION`
   *
   * leave_bank is a cache of leave_ledger and is updated by the
   * leave_ledger_apply_balance trigger when the REVERSAL row is inserted.
   * Never writes leave_bank directly.
   *
   * Returns the number of refund entries created (0 when already refunded).
   */
  private static async refundLeaveForDate(
    userId: string,
    canonicalDate: Date,
    holidayName: string
  ): Promise<number> {
    const dateKey = canonicalDate.toISOString().split('T')[0];
    const { start: dayStart, end: dayEnd } = this.getUtcDayWindow(canonicalDate);
    let refunded = 0;

    // ── 1. Approved leave request covering this date ──────────────────────
    const leaveRequest = await prisma.leaveRequest.findFirst({
      where: {
        user_id: userId,
        status: 'APPROVED',
        start_date: { lte: dayEnd },
        end_date: { gte: dayStart }
      },
      orderBy: { id: 'desc' },
      include: {
        ledger_entries: {
          where: { transaction_type: 'CONSUMPTION' },
          orderBy: { id: 'asc' },
          take: 1
        }
      }
    });

    const requestConsumption = leaveRequest?.ledger_entries[0];

    if (leaveRequest && requestConsumption) {
      const startKey = leaveRequest.start_date.toISOString().split('T')[0];
      const endKey = leaveRequest.end_date.toISOString().split('T')[0];
      const requestStart = new Date(`${startKey}T00:00:00.000Z`);
      const requestEnd = new Date(`${endKey}T00:00:00.000Z`);
      const inclusiveDays = Math.max(
        1,
        Math.round((requestEnd.getTime() - requestStart.getTime()) / 86400000) + 1
      );

      // Reverse only this date's share: the other days of a multi-day request
      // remain consumed.
      const refundAmount = round2(Math.abs(Number(requestConsumption.amount)) / inclusiveDays);

      if (refundAmount > 0) {
        const refundKey = `${userId}-${requestConsumption.leave_type_id}-${dateKey}-HOLIDAY_REVERSAL_REQ_${leaveRequest.id}`;
        const punchKey = `${userId}-${requestConsumption.leave_type_id}-${dateKey}-LEAVE_REVERSAL`;

        const created = await prisma.$transaction(async (tx) => {
          const alreadyRefunded = await tx.leaveLedger.findFirst({
            where: { idempotency_key: { in: [refundKey, punchKey] } }
          });
          if (alreadyRefunded) return false;

          await tx.leaveLedger.create({
            data: {
              user_id: userId,
              leave_type_id: requestConsumption.leave_type_id,
              leave_request_id: leaveRequest.id,
              transaction_type: 'REVERSAL',
              amount: refundAmount,
              idempotency_key: refundKey,
              notes: `Refund: public holiday "${holidayName}" on ${dateKey} (approved leave request #${leaveRequest.id})`,
              created_by_type: 'SYSTEM'
            }
          });

          return true;
        });

        if (created) refunded++;
      }
    }

    // ── 2. Legacy automatic absence deduction ─────────────────────────────
    const legacyConsumption = await prisma.leaveLedger.findFirst({
      where: {
        user_id: userId,
        transaction_type: 'CONSUMPTION',
        idempotency_key: { endsWith: `-${dateKey}-LEAVE_CONSUMPTION` }
      },
      orderBy: { id: 'desc' }
    });

    if (legacyConsumption) {
      const leaveTypeId = legacyConsumption.leave_type_id;
      const holidayKey = `${userId}-${leaveTypeId}-${dateKey}-HOLIDAY_REVERSAL`;
      const punchKey = `${userId}-${leaveTypeId}-${dateKey}-LEAVE_REVERSAL`;

      // Refund exactly 1 leave — never clamp to the accrual rate, or a
      // balance above one month's accrual is silently wiped out.
      const created = await prisma.$transaction(async (tx) => {
        const alreadyReversed = await tx.leaveLedger.findFirst({
          where: { idempotency_key: { in: [holidayKey, punchKey] } }
        });
        if (alreadyReversed) return false;

        await tx.leaveLedger.create({
          data: {
            user_id: userId,
            leave_type_id: leaveTypeId,
            transaction_type: 'REVERSAL',
            amount: 1,
            idempotency_key: holidayKey,
            notes: `Refund: public holiday "${holidayName}" on ${dateKey}`,
            created_by_type: 'SYSTEM'
          }
        });

        return true;
      });

      if (created) refunded++;
    }

    return refunded;
  }

  /**
   * Core processor — finds all pending holidays and applies them to the DB.
   *
   * For each pending holiday, per employee:
   *  1. If there is an existing attendance record with status "leave",
   *     refund the leave consumed for that date through leave_ledger (the DB
   *     trigger updates leave_bank).
   *  2. Upsert the attendance record → status = "holiday", is_late/is_halfday = false.
   *  3. Delete any absence / late / half-day deductions for that date.
   *  4. Mark the holiday row as "marked".
   *
   * A holiday with any failed employee stays "pending" and is retried, so a
   * transient failure can never leave one employee half-processed.
   *
   * Returns a summary object for logging.
   */
  static async processHolidays(): Promise<{
    processed: number;
    recordsUpdated: number;
    leavesRefunded: number;
    deductionsRemoved: number;
    failed: number;
  }> {
    const pendingHolidays = await prisma.holiday.findMany({
      where: { status: 'pending' }
    });

    if (pendingHolidays.length === 0) {
      return { processed: 0, recordsUpdated: 0, leavesRefunded: 0, deductionsRemoved: 0, failed: 0 };
    }

    let recordsUpdated = 0;
    let leavesRefunded = 0;
    let deductionsRemoved = 0;
    let failedHolidays = 0;

    for (const holiday of pendingHolidays) {
      const canonicalDate = this.getCanonicalUtcDate(holiday.date);
      const { start: dayStart, end: dayEnd } = this.getUtcDayWindow(canonicalDate);

      const employeeWhereClause: any = { role: 'employee' };
      if (holiday.department_id) {
        employeeWhereClause.department_id = holiday.department_id;
      }

      const allEmployees = await prisma.user.findMany({
        where: employeeWhereClause,
        select: { id: true }
      });

      let failedEmployees = 0;

      for (const employee of allEmployees) {
        try {
          // ── 1. Check existing attendance record ─────────────────────────
          const existing = await prisma.attendanceRecord.findFirst({
            where: {
              user_id: employee.id,
              date: { gte: dayStart, lte: dayEnd }
            },
            orderBy: { id: 'asc' }
          });

          // ── 2. If it was "leave", refund the leave consumed for the day ──
          if (existing?.status === 'leave') {
            leavesRefunded += await this.refundLeaveForDate(employee.id, canonicalDate, holiday.name);
          }

          // ── 3. Upsert attendance record → holiday ───────────────────────
          if (existing) {
            await prisma.attendanceRecord.updateMany({
              where: {
                user_id: employee.id,
                date: { gte: dayStart, lte: dayEnd }
              },
              data: {
                status: 'holiday',
                is_late: false,
                is_halfday: false
              }
            });
          } else {
            await prisma.attendanceRecord.create({
              data: {
                user_id: employee.id,
                date: canonicalDate,
                status: 'holiday',
                is_late: false,
                is_halfday: false
              }
            });
          }
          recordsUpdated++;

          // ── 4. Remove all absence/penalty deductions for this date ───────
          const { count } = await prisma.deduction.deleteMany({
            where: {
              user_id: employee.id,
              date: { gte: dayStart, lte: dayEnd },
              type: { in: ['absent', 'late', 'half-day'] }
            }
          });
          deductionsRemoved += count;

        } catch (err) {
          failedEmployees++;
          console.error(
            `[HolidayService] Failed to process holiday "${holiday.name}" for employee ${employee.id}:`,
            err
          );
        }
      }

      // ── 5. Mark holiday as processed only when every employee succeeded ──
      if (failedEmployees > 0) {
        failedHolidays++;
        console.error(
          `[HolidayService] Holiday "${holiday.name}" on ${canonicalDate.toISOString().split('T')[0]} left pending: ${failedEmployees} employee(s) failed`
        );
        continue;
      }

      await prisma.holiday.update({
        where: { id: holiday.id },
        data: { status: 'marked' }
      });
    }

    return {
      processed: pendingHolidays.length - failedHolidays,
      recordsUpdated,
      leavesRefunded,
      deductionsRemoved,
      failed: failedHolidays
    };
  }
}
