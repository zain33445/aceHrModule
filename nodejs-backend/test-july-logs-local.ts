import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.attendanceLog.findMany({
    where: { 
        user_id: '34'
    },
    orderBy: {
        timestamp: 'asc'
    }
  });
  
  const julyLogs = logs.filter(l => l.timestamp.getMonth() === 6);

  console.log('July Attendance Logs for user 34 (LOCAL TIME UTC+5):');
  julyLogs.forEach(l => {
    const localTime = new Date(l.timestamp.getTime() + 5 * 60 * 60 * 1000);
    // YYYY-MM-DD HH:mm:ss
    const formatted = localTime.toISOString().replace('T', ' ').substring(0, 19);
    console.log(`- Time (Local): ${formatted}, Status: ${l.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
