import prisma from '../prisma';

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
   * Core processor — finds all pending holidays and applies them to the DB.
   *
   * For each pending holiday, per employee:
   *  1. If there is an existing attendance record with status "leave",
   *     refund 1 leave back to the leave bank (holiday has top priority).
   *  2. Upsert the attendance record → status = "holiday", is_late/is_halfday = false.
   *  3. Delete any absence / late / half-day deductions for that date.
   *  4. Mark the holiday row as "marked".
   *
   * Returns a summary object for logging.
   */
  static async processHolidays(): Promise<{
    processed: number;
    recordsUpdated: number;
    leavesRefunded: number;
    deductionsRemoved: number;
  }> {
    const pendingHolidays = await prisma.holiday.findMany({
      where: { status: 'pending' }
    });

    if (pendingHolidays.length === 0) {
      return { processed: 0, recordsUpdated: 0, leavesRefunded: 0, deductionsRemoved: 0 };
    }

    let recordsUpdated = 0;
    let leavesRefunded = 0;
    let deductionsRemoved = 0;

    for (const holiday of pendingHolidays) {
      const canonicalDate = this.getCanonicalUtcDate(holiday.date);

      const employeeWhereClause: any = { role: 'employee' };
      if (holiday.department_id) {
        employeeWhereClause.department_id = holiday.department_id;
      }

      const allEmployees = await prisma.user.findMany({
        where: employeeWhereClause,
        select: { id: true }
      });

      for (const employee of allEmployees) {
        try {
          // ── 1. Check existing attendance record ─────────────────────────
          const existing = await prisma.attendanceRecord.findUnique({
            where: {
              user_id_date: {
                user_id: employee.id,
                date: canonicalDate
              }
            }
          });

          // ── 2. If it was "leave", refund 1 leave to the leave bank ──────
          if (existing?.status === 'leave') {
            const leaveBank = await prisma.leaveBank.findUnique({
              where: { user_id: employee.id }
            });

            const user = await prisma.user.findUnique({
              where: { id: employee.id },
              select: { leave_bank: true }
            });

            if (leaveBank && user) {
              // Refund 1 leave but never exceed the user's monthly allowance
              const refunded = Math.min(
                leaveBank.leaves_remaining + 1,
                user.leave_bank
              );
              await prisma.leaveBank.update({
                where: { user_id: employee.id },
                data: { leaves_remaining: refunded }
              });
              leavesRefunded++;
            }
          }

          // ── 3. Upsert attendance record → holiday ───────────────────────
          if (existing) {
            await prisma.attendanceRecord.update({
              where: { id: existing.id },
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
              date: canonicalDate,
              type: { in: ['absent', 'late', 'half-day'] }
            }
          });
          deductionsRemoved += count;

        } catch (err) {
          console.error(
            `[HolidayService] Failed to process holiday "${holiday.name}" for employee ${employee.id}:`,
            err
          );
        }
      }

      // ── 5. Mark holiday as processed ─────────────────────────────────────
      await prisma.holiday.update({
        where: { id: holiday.id },
        data: { status: 'marked' }
      });
    }

    return {
      processed: pendingHolidays.length,
      recordsUpdated,
      leavesRefunded,
      deductionsRemoved
    };
  }
}
