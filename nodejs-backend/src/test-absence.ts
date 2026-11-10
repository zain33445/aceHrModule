/**
 * Absence policy test (runs in-process against the dev DB, no HTTP).
 *
 * Policy: no punches on a past working day => 'absent' + 'absent' deduction,
 * NEVER an automatic leave deduction. Approved leave requests still win.
 *
 * Safe on a dev DB: only employee '10' on 2020-01-06..09 (+ today's Karachi
 * date for T2); leave_bank is snapshotted and restored; everything created is
 * deleted in `finally`.
 *
 * Notes:
 *  - processAttendance / calculateAndRecordAttendance are private; called via
 *    (AbsenceService as any) (processDailyAbsences would touch ALL employees).
 *  - the outbox handler (processEvent) is not exported, so we use
 *    processOutboxEvents with prisma.outboxEvent.findMany narrowed to our event.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import prisma from './prisma';
import { AbsenceService } from './services/absence.service';
import { processOutboxEvents } from './workers/outbox-worker';

const UID = '10';
const DK = { t1: '2020-01-06', t3: '2020-01-07', t4: '2020-01-08', t5: '2020-01-09' };
const KEYS = Object.values(DK);
const noon = (k: string) => new Date(`${k}T12:00:00.000Z`);
const svc = AbsenceService as any;

const results: { name: string; ok: boolean; msg?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, msg: e.message });
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}

const rec = (k: string) => prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: UID, date: noon(k) } } });
const activeAbsent = (k: string) => prisma.deduction.count({ where: { user_id: UID, date: noon(k), type: 'absent', status: 'ACTIVE' } });
const ledger = (k: string, type?: string) =>
  prisma.leaveLedger.count({ where: { user_id: UID, idempotency_key: { contains: k, ...(type ? { endsWith: `-${type}` } : {}) } } });
const logWindow = { gte: new Date('2020-01-05T00:00:00Z'), lte: new Date('2020-01-11T00:00:00Z') };

async function main() {
  const user: any = await prisma.user.findUnique({ where: { id: UID }, include: { department: { include: { shift: true } } } });
  assert(user, `seed user ${UID} not found`);
  const shift = user.department?.shift || (await prisma.shift.findFirst());
  assert(shift, 'no shift configured');
  const salary = 30000; // dev users have monthly_salary 0, and the service skips zero-amount deductions
  const leaveTypeId: number = await svc.getDefaultLeaveTypeId(UID);
  const bankKey = { user_id_leave_type_id: { user_id: UID, leave_type_id: leaveTypeId } };
  const bank = async () => (await prisma.leaveBank.findUnique({ where: bankKey }))!.leaves_remaining;

  // ---- safety pre-flight -------------------------------------------------
  for (const k of KEYS) assert.notEqual([0, 6].includes(noon(k).getUTCDay()), true, `${k} is a weekend`);
  const dayDates = KEYS.map(noon);
  const dirty = {
    attendance: await prisma.attendanceRecord.count({ where: { user_id: UID, date: { in: dayDates } } }),
    deductions: await prisma.deduction.count({ where: { user_id: UID, date: { in: dayDates } } }),
    logs: await prisma.attendanceLog.count({ where: { user_id: UID, timestamp: logWindow } }),
    ledger: await prisma.leaveLedger.count({ where: { user_id: UID, OR: KEYS.map((k) => ({ idempotency_key: { contains: k } })) } }),
    holidays: await prisma.holiday.count({ where: { date: { gte: new Date('2020-01-05T00:00:00Z'), lte: new Date('2020-01-11T00:00:00Z') } } }),
  };
  if (Object.values(dirty).some((n) => n > 0)) throw new Error(`refusing to run, test dates not clean: ${JSON.stringify(dirty)}`);

  // T2 subject: an employee (not '10') with no data at all for today's Karachi date
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
  const todayDate = noon(todayKey);
  assert(![0, 6].includes(todayDate.getUTCDay()), `today (${todayKey}) is a weekend; T2 cannot run`);
  const todayLogWin = { gte: new Date(`${todayKey}T00:00:00Z`), lte: new Date(`${todayKey}T23:59:59.999Z`) };
  let t2User: any = null;
  for (const u of await prisma.user.findMany({ where: { role: 'employee', id: { not: UID } }, include: { department: { include: { shift: true } } }, orderBy: { id: 'asc' } })) {
    const busy =
      (await prisma.attendanceRecord.count({ where: { user_id: u.id, date: todayDate, NOT: { status: 'pending', check_in_time: null, check_out_time: null } } })) + // the cron already creates an empty 'pending' row for everyone
      (await prisma.deduction.count({ where: { user_id: u.id, date: todayDate } })) +
      (await prisma.attendanceLog.count({ where: { user_id: u.id, timestamp: todayLogWin } }));
    if (busy === 0) { t2User = u; break; }
  }
  assert(t2User, 'T2: no employee without punches/deductions for today found');
  const t2HadRecord = (await prisma.attendanceRecord.count({ where: { user_id: t2User.id, date: todayDate } })) > 0;

  // ---- snapshot / setup --------------------------------------------------
  const bankSnapshot = await prisma.leaveBank.findMany({ where: { user_id: UID } });
  const t2BankSnapshot = await prisma.leaveBank.findMany({ where: { user_id: t2User.id } });
  const outboxIds: number[] = [];
  const pendingBefore = await prisma.outboxEvent.count({ where: { status: 'PENDING' } });

  const setBank = (n: number) =>
    prisma.leaveBank.upsert({
      where: bankKey,
      update: { leaves_remaining: n },
      create: { user_id: UID, leave_type_id: leaveTypeId, leaves_remaining: n, last_reset_month: null },
    });

  try {
    await setBank(5);

    // T1 ---------------------------------------------------------------
    await check('T1 past day, no punches => absent, no leave consumed, ACTIVE absent deduction', async () => {
      const before = await bank();
      await svc.processAttendance(UID, noon(DK.t1), salary, shift);
      const r = await rec(DK.t1);
      assert.equal(r?.status, 'absent', `status expected 'absent' but was '${r?.status}'`);
      assert.equal(await bank(), before, 'leave_bank.leaves_remaining must be unchanged');
      assert.equal(await ledger(DK.t1, 'LEAVE_CONSUMPTION'), 0, 'no CONSUMPTION ledger row expected');
      assert.equal(await activeAbsent(DK.t1), 1, "expected one ACTIVE 'absent' deduction");
    });

    // T2 ---------------------------------------------------------------
    await check("T2 today with no punches stays 'pending' (no deduction, no leave consumed)", async () => {
      const t2Shift = t2User.department?.shift || shift;
      const sum = (rows: { leaves_remaining: number }[]) => rows.reduce((n, r) => n + r.leaves_remaining, 0);
      const before = sum(await prisma.leaveBank.findMany({ where: { user_id: t2User.id } }));
      await svc.processAttendance(t2User.id, todayDate, salary, t2Shift);
      const r = await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: t2User.id, date: todayDate } } });
      assert.equal(r?.status, 'pending', `status expected 'pending' but was '${r?.status}'`);
      assert.equal(await prisma.deduction.count({ where: { user_id: t2User.id, date: todayDate } }), 0, 'no deduction expected for today');
      assert.equal(sum(await prisma.leaveBank.findMany({ where: { user_id: t2User.id } })), before, 'leave balance must be unchanged');
      assert.equal(await prisma.leaveLedger.count({ where: { user_id: t2User.id, idempotency_key: { contains: todayKey } } }), 0, 'no ledger row expected');
    });

    // T3 ---------------------------------------------------------------
    await check('T3 approved leave over an absent day => leave, no ACTIVE absent deduction', async () => {
      await setBank(5);
      await svc.processAttendance(UID, noon(DK.t3), salary, shift); // absent day (as T1 after fix)
      const pre = await rec(DK.t3);
      assert.equal(pre?.status, 'absent', `precondition: day must start 'absent' but was '${pre?.status}'`);
      assert.equal(await activeAbsent(DK.t3), 1, "precondition: expected an ACTIVE 'absent' deduction before approval");
      const ev = await prisma.outboxEvent.create({
        data: {
          type: 'SYNC_ATTENDANCE',
          payload: { user_id: UID, start_date: `${DK.t3}T00:00:00.000Z`, end_date: `${DK.t3}T00:00:00.000Z`, is_half_day: false, half_day_session: null },
        },
      });
      outboxIds.push(ev.id);
      // Narrow the worker's batch to our event only (the server cron may take it first; that is equivalent).
      const od: any = prisma.outboxEvent;
      const origFind = od.findMany;
      od.findMany = (args: any) => origFind.call(od, { ...args, where: { ...(args?.where || {}), id: ev.id } });
      try {
        await processOutboxEvents();
      } finally {
        od.findMany = origFind;
      }
      for (let i = 0; i < 30; i++) {
        const cur = await prisma.outboxEvent.findUnique({ where: { id: ev.id } });
        if (cur && cur.status !== 'PENDING' && cur.status !== 'PROCESSING') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const done = await prisma.outboxEvent.findUnique({ where: { id: ev.id } });
      assert.equal(done?.status, 'COMPLETED', `outbox event not completed: ${done?.status} ${done?.error ?? ''}`);
      const r = await rec(DK.t3);
      assert.equal(r?.status, 'leave', `status expected 'leave' but was '${r?.status}'`);
      assert.equal(await activeAbsent(DK.t3), 0, "no ACTIVE 'absent' deduction may remain");
    });

    // T4 ---------------------------------------------------------------
    await check('T4 punch on an approved-leave day (no auto consumption) => no free leave refund', async () => {
      await setBank(5);
      await prisma.attendanceRecord.create({ data: { user_id: UID, date: noon(DK.t4), status: 'leave' } });
      await prisma.attendanceLog.create({ data: { user_id: UID, timestamp: new Date(`${DK.t4}T05:00:00.000Z`), status: 0 } });
      const logs = await prisma.attendanceLog.findMany({ where: { user_id: UID, timestamp: { gte: new Date(`${DK.t4}T00:00:00Z`), lte: new Date(`${DK.t4}T23:59:59.999Z`) } } });
      const before = await bank();
      await svc.calculateAndRecordAttendance(UID, noon(DK.t4), logs, salary, shift);
      assert.equal(await bank(), before, `leaves_remaining must be unchanged (was ${before}, now ${await bank()})`);
      assert.equal(await ledger(DK.t4, 'LEAVE_REVERSAL'), 0, 'no LEAVE_REVERSAL ledger row expected');
    });

    // T5 ---------------------------------------------------------------
    await check('T5 legacy auto-leave day refunded exactly once on punch', async () => {
      await setBank(4); // 5 - 1 consumed by the legacy auto-deduction
      await prisma.attendanceRecord.create({ data: { user_id: UID, date: noon(DK.t5), status: 'leave' } });
      await prisma.leaveLedger.create({
        data: {
          user_id: UID, leave_type_id: leaveTypeId, transaction_type: 'CONSUMPTION', amount: -1,
          idempotency_key: `${UID}-${leaveTypeId}-${DK.t5}-LEAVE_CONSUMPTION`, notes: 'test legacy auto leave', created_by_type: 'SYSTEM',
        },
      });
      await prisma.attendanceLog.create({ data: { user_id: UID, timestamp: new Date(`${DK.t5}T05:00:00.000Z`), status: 0 } });
      const logs = await prisma.attendanceLog.findMany({ where: { user_id: UID, timestamp: { gte: new Date(`${DK.t5}T00:00:00Z`), lte: new Date(`${DK.t5}T23:59:59.999Z`) } } });
      await svc.calculateAndRecordAttendance(UID, noon(DK.t5), logs, salary, shift);
      assert.equal(await bank(), 5, `bank expected 5 after refund, was ${await bank()}`);
      assert.equal(await ledger(DK.t5, 'LEAVE_REVERSAL'), 1, 'expected exactly one LEAVE_REVERSAL after first run');
      await svc.calculateAndRecordAttendance(UID, noon(DK.t5), logs, salary, shift);
      assert.equal(await bank(), 5, `bank must not be incremented twice, was ${await bank()}`);
      assert.equal(await ledger(DK.t5, 'LEAVE_REVERSAL'), 1, 'expected still exactly one LEAVE_REVERSAL after second run');
    });
  } finally {
    // ---- cleanup -------------------------------------------------------
    await prisma.deduction.deleteMany({ where: { user_id: UID, date: { in: dayDates } } });
    await prisma.leaveLedger.deleteMany({ where: { user_id: UID, OR: KEYS.map((k) => ({ idempotency_key: { contains: k } })) } });
    await prisma.attendanceLog.deleteMany({ where: { user_id: UID, timestamp: logWindow } });
    await prisma.attendanceRecord.deleteMany({ where: { user_id: UID, date: { in: dayDates } } });
    await prisma.deduction.deleteMany({ where: { user_id: t2User.id, date: todayDate } });
    await prisma.leaveLedger.deleteMany({ where: { user_id: t2User.id, idempotency_key: { contains: todayKey } } });
    if (!t2HadRecord) await prisma.attendanceRecord.deleteMany({ where: { user_id: t2User.id, date: todayDate, status: 'pending', check_in_time: null, check_out_time: null } });
    if (outboxIds.length) await prisma.outboxEvent.deleteMany({ where: { id: { in: outboxIds } } });
    // restore leave_bank exactly
    const keep = bankSnapshot.map((b) => b.id);
    await prisma.leaveBank.deleteMany({ where: { user_id: UID, id: { notIn: keep } } });
    for (const b of bankSnapshot) {
      await prisma.leaveBank.update({ where: { id: b.id }, data: { leaves_remaining: b.leaves_remaining, last_reset_month: b.last_reset_month } });
    }

    await prisma.leaveBank.deleteMany({ where: { user_id: t2User.id, id: { notIn: t2BankSnapshot.map((b) => b.id) } } });
    for (const b of t2BankSnapshot) {
      await prisma.leaveBank.update({ where: { id: b.id }, data: { leaves_remaining: b.leaves_remaining, last_reset_month: b.last_reset_month } });
    }

    const left = {
      t2_new_today_records: t2HadRecord ? 0 : await prisma.attendanceRecord.count({ where: { user_id: t2User.id, date: todayDate } }),
      attendance_records: await prisma.attendanceRecord.count({ where: { user_id: UID, date: { in: dayDates } } }),
      deductions: await prisma.deduction.count({ where: { user_id: UID, date: { in: dayDates } } }),
      attendance_logs: await prisma.attendanceLog.count({ where: { user_id: UID, timestamp: logWindow } }),
      leave_ledger: await prisma.leaveLedger.count({ where: { user_id: UID, OR: KEYS.map((k) => ({ idempotency_key: { contains: k } })) } }),
      outbox_events: outboxIds.length ? await prisma.outboxEvent.count({ where: { id: { in: outboxIds } } }) : 0,
    };
    const bankAfter = await prisma.leaveBank.findMany({ where: { user_id: UID }, orderBy: { id: 'asc' } });
    const t2Restored = JSON.stringify(await prisma.leaveBank.findMany({ where: { user_id: t2User.id }, orderBy: { id: 'asc' } })) === JSON.stringify([...t2BankSnapshot].sort((a, b) => a.id - b.id));
    const restored = t2Restored && JSON.stringify(bankAfter) === JSON.stringify([...bankSnapshot].sort((a, b) => a.id - b.id));
    console.log(`\nCLEANUP leftovers (2020 dates): ${JSON.stringify(left)}; leave_bank restored: ${restored}`);
    const pendingAfter = await prisma.outboxEvent.count({ where: { status: 'PENDING' } });
    console.log(`CLEANUP pending outbox events before/after: ${pendingBefore}/${pendingAfter}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
