const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function empty() {
  try {
    await prisma.deduction.deleteMany();
    await prisma.attendanceRecord.deleteMany();
    console.log('Successfully emptied AttendanceRecord and Deduction tables.');
  } catch(e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

empty();
