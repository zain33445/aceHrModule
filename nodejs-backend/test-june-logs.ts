import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.attendanceLog.findMany({
    where: { 
        user_id: '34'
    }
  });
  
  const juneLogs = logs.filter(l => l.timestamp.getMonth() === 5); // 0-indexed, so 5 is June

  console.log('June Attendance Logs for user 34:');
  juneLogs.forEach(l => {
    console.log(`- Time: ${l.timestamp.toISOString()}, Status: ${l.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
