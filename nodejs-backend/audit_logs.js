const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const userId = '6';
  const start = new Date('2026-03-01T00:00:00Z');
  const end = new Date('2026-03-25T00:00:00Z');

  const logs = await prisma.attendanceLog.findMany({
    where: {
      user_id: userId,
      timestamp: { gte: start, lte: end }
    },
    orderBy: { timestamp: 'asc' }
  });

  console.log(`--- ALL Logs for user ${userId} (March) ---`);
  logs.forEach(l => {
    // Show both UTC and local time (+5)
    const local = new Date(l.timestamp.getTime() + (5 * 60 * 60 * 1000));
    console.log(`UTC: ${l.timestamp.toISOString()} | Local: ${local.toISOString()} | Status: ${l.status}`);
  });
}

check().catch(console.error).finally(() => prisma.$disconnect());
