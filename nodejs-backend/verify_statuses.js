const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function verify() {
  const statusCounts = await prisma.attendanceLog.groupBy({
    by: ['status'],
    _count: {
      id: true
    }
  });

  console.log('--- Attendance Log Status Counts ---');
  console.log(JSON.stringify(statusCounts, null, 2));

  const samples = await prisma.attendanceLog.findMany({
    take: 10,
    orderBy: { timestamp: 'desc' }
  });

  console.log('\n--- Recent Log Samples ---');
  samples.forEach(s => {
    console.log(`ID: ${s.id} | User: ${s.user_id} | Time: ${s.timestamp.toISOString()} | Status: ${s.status}`);
  });
}

verify().catch(console.error).finally(() => prisma.$disconnect());
