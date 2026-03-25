const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const userId = '6';
  const start = new Date('2026-03-16T00:00:00Z');
  
  const records = await prisma.attendanceRecord.findMany({
    where: { user_id: userId, date: { gte: start } },
    orderBy: { date: 'asc' }
  });

  console.log(`\n--- Attendance Records for ${userId} ---`);
  records.forEach(r => {
    console.log(`${r.date.toISOString()} | In: ${r.check_in_time} | Out: ${r.check_out_time} | Status: ${r.status}`);
  });
}

check().catch(console.error).finally(() => prisma.$disconnect());
