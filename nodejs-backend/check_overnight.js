const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const userId = '6';
  const start = new Date('2026-03-18T00:00:00Z');
  const end = new Date('2026-03-20T00:00:00Z');

  const logs = await prisma.attendanceLog.findMany({
    where: {
      user_id: userId,
      timestamp: { gte: start, lte: end }
    },
    orderBy: { timestamp: 'asc' }
  });

  console.log(`--- Logs for user ${userId} (March 18-19) ---`);
  logs.forEach(l => {
    console.log(`${l.timestamp.toISOString()} | Status: ${l.status}`);
  });

  const records = await prisma.attendanceRecord.findMany({
    where: { user_id: userId, date: { gte: start, lte: end } },
    orderBy: { date: 'asc' }
  });

  console.log(`\n--- Attendance Records ---`);
  records.forEach(r => {
    console.log(`${r.date.toISOString()} | In: ${r.check_in_time} | Out: ${r.check_out_time} | Status: ${r.status}`);
  });
}

check().catch(console.error).finally(() => prisma.$disconnect());
