const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function empty() {
  console.log('Emptying attendance tables...');
  
  // Order matters for foreign keys
  await prisma.deduction.deleteMany({});
  await prisma.attendanceRecord.deleteMany({});
  await prisma.attendanceLog.deleteMany({});
  
  console.log('Tables emptied successfully.');
}

empty().catch(console.error).finally(() => prisma.$disconnect());
