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
  
  const julyLogs = logs.filter(l => l.timestamp.getMonth() === 6); // July

  console.log('All July Attendance Logs for user 34:');
  julyLogs.forEach(l => {
    // print time in a local-like format to be clear
    console.log(`- Time (UTC): ${l.timestamp.toISOString()}, Status: ${l.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
