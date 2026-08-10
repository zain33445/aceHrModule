import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const records = await prisma.attendanceRecord.findMany({
    where: { 
        user_id: '34'
    },
    orderBy: {
        date: 'asc'
    }
  });
  
  const julyRecords = records.filter(r => r.date.getMonth() === 6); // July

  console.log('July Attendance Records for user 34:');
  julyRecords.forEach(r => {
    console.log(`- Date: ${r.date.toISOString().split('T')[0]}, In: ${r.check_in_time}, Out: ${r.check_out_time}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
