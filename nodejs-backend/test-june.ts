import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const records = await prisma.attendanceRecord.findMany({
    where: { 
        user_id: '34',
        status: 'present' 
    }
  });
  
  const juneRecords = records.filter(r => r.date.getMonth() === 5); // 0-indexed, so 5 is June

  const missingCheckouts = juneRecords.filter(r => !r.check_out_time);
  console.log('Present records with missing checkouts in June:');
  missingCheckouts.forEach(r => {
    console.log(`- Date: ${r.date.toISOString().split('T')[0]}, Check In: ${r.check_in_time}, Status: ${r.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
