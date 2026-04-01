import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function debugUser26() {
  const userId = "26";
  const today = new Date();
  today.setHours(0,0,0,0);
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const logs = await prisma.attendanceLog.findMany({
    where: {
      user_id: userId,
      timestamp: {
        gte: yesterday
      }
    },
    orderBy: { timestamp: 'asc' }
  });

  console.log(`--- Debug User ${userId} ---`);
  console.log(`Logs found since yesterday: ${logs.length}`);
  logs.forEach(l => {
    console.log(`Log: ${l.timestamp.toISOString()} | Status: ${l.status}`);
  });

  const records = await prisma.attendanceRecord.findMany({
    where: { user_id: userId },
    orderBy: { date: 'desc' },
    take: 5
  });

  console.log(`\nRecords found: ${records.length}`);
  records.forEach(r => {
    console.log(`Record Date: ${r.date.toISOString().split('T')[0]} | Check-in: ${r.check_in_time} | Status: ${r.status}`);
  });

  await prisma.$disconnect();
}

debugUser26();
