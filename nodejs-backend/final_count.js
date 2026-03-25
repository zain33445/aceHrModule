const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function count() {
  const c = await prisma.attendanceRecord.count();
  console.log('Total Attendance Records in DB:', c);
}

count().catch(console.error).finally(() => prisma.$disconnect());
