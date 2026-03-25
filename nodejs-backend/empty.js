const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function empty() {
  try {
    await prisma.deduction.deleteMany();
    await prisma.attendanceRecord.deleteMany();
    await prisma.attendanceLog.deleteMany();
    console.log('Successfully emptied AttendanceLog, AttendanceRecord, and Deduction tables.');
  } catch(e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

empty();
