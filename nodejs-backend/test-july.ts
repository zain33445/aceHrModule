import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const records = await prisma.attendanceRecord.findMany({
    where: { 
        user_id: '34',
        status: 'present' 
    }
  });
  
  const julyRecords = records.filter(r => r.date.getMonth() === 6); // 0-indexed, so 6 is July

  const missingCheckouts = julyRecords.filter(r => !r.check_out_time);
  console.log('Present records with missing checkouts in July:');
  missingCheckouts.forEach(r => {
    console.log(`- Date: ${r.date.toISOString().split('T')[0]}, Check In: ${r.check_in_time}, Status: ${r.status}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
