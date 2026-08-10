import prisma from './src/prisma';
import { AbsenceService } from './src/services/absence.service';

async function main() {
  const userId = '41';

  // Pull the user's raw attendance logs so the exact UTC day windows match the
  // same code path the realtime sync uses (getUtcDateKey on the timestamp).
  const logs = await prisma.attendanceLog.findMany({
    where: { user_id: userId },
    select: { timestamp: true },
  });

  const keys = [...new Set(logs.map(l => l.timestamp.toISOString().split('T')[0]))].sort();
  console.log(`Reprocessing user ${userId} for ${keys.length} log-date(s):`, keys.join(', '));

  const dates = keys.map(k => new Date(`${k}T12:00:00.000Z`));
  await AbsenceService.processLiveSync([userId], dates);

  // Then compute what the deduction rows now hold for this user.
  const deds = await prisma.deduction.findMany({
    where: { user_id: userId, status: 'ACTIVE' },
    orderBy: { date: 'desc' },
    include: { user: { select: { monthly_salary: true } } },
  });
  console.log(`\n=== ACTIVE DEDUCTIONS for user ${userId} AFTER reprocess ===`);
  for (const d of deds) {
    console.log(`${d.date.toISOString().split('T')[0]}  ${d.type.padEnd(8)} ${d.amount.toFixed(2)}`);
  }
  const total = deds.reduce((s, d) => s + d.amount, 0);
  console.log(`TOTAL active deductions: ${total.toFixed(2)}`);

  const recs = await prisma.attendanceRecord.findMany({
    where: { user_id: userId, status: { in: ['late', 'halfday', 'present', 'absent'] } },
    orderBy: { date: 'desc' },
  });
  console.log(`\n=== ATTENDANCE RECORDS (non-weekend) AFTER reprocess ===`);
  for (const r of recs) {
    console.log(`${r.date.toISOString().split('T')[0]}  ${r.status.padEnd(8)} in=${r.check_in_time} out=${r.check_out_time} late=${r.is_late} hd=${r.is_halfday}`);
  }

  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('ERR', e);
  await prisma.$disconnect();
  process.exit(1);
});