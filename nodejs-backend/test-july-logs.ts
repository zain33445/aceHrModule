import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.attendanceLog.findMany({
    where: { 
        user_id: '34'
    }
  });
  
  const julyLogs = logs.filter(l => l.timestamp.getMonth() === 6); // 0-indexed, so 6 is July

  console.log('July Attendance Logs for user 34:');
  julyLogs.forEach(l => {
    console.log(`- Time: ${l.timestamp.toISOString()}, Status: ${l.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
