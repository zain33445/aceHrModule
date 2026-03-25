const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanDuplicates() {
  console.log('Fetching all attendance records...');
  // We want to delete duplicate AttendanceRecords generated from ms-precision issues.
  const records = await prisma.attendanceRecord.findMany({});
  
  // Map of "userId_YYYY-MM-DD" -> record_id
  const keepMap = new Map();
  const duplicateIds = [];
  
  for (const r of records) {
    const rDate = new Date(r.date);
    const dateKey = `${r.user_id}_${rDate.getFullYear()}-${rDate.getMonth()}-${rDate.getDate()}`;
    
    if (keepMap.has(dateKey)) {
      duplicateIds.push(r.id);
    } else {
      keepMap.set(dateKey, r.id);
    }
  }
  
  console.log(`Found ${duplicateIds.length} duplicate records. Deleting...`);
  
  if (duplicateIds.length > 0) {
    // Also delete any deductions linked to these? Deductions are linked to user and date.
    // Actually, let's just delete the duplicate attendance records.
    await prisma.attendanceRecord.deleteMany({
      where: {
        id: { in: duplicateIds }
      }
    });
    console.log(`Deleted ${duplicateIds.length} duplicate AttendanceRecord entries.`);
  }

  // Same for deductions... deductions don't have ms precision but might be duplicated if created multiple times
  const deductions = await prisma.deduction.findMany({});

  const keepDeductionMap = new Map();
  const duplicateDeductionIds = [];

  for (const d of deductions) {
    const dDate = new Date(d.date);
    const key = `${d.user_id}_${d.type}_${dDate.getFullYear()}-${dDate.getMonth()}-${dDate.getDate()}`;
    if (keepDeductionMap.has(key)) {
      duplicateDeductionIds.push(d.id);
    } else {
      keepDeductionMap.set(key, d.id);
    }
  }

  if (duplicateDeductionIds.length > 0) {
    await prisma.deduction.deleteMany({
      where: { id: { in: duplicateDeductionIds } }
    });
    console.log(`Deleted ${duplicateDeductionIds.length} duplicate Deductions.`);
  }

  console.log('Cleanup complete.');
}

cleanDuplicates().catch(console.error).finally(() => prisma.$disconnect());
