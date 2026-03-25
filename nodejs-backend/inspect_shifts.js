const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const shifts = await prisma.shift.findMany();
    const departments = await prisma.department.findMany({
      include: { shift: true }
    });
    console.log('--- SHIFTS ---');
    console.log(JSON.stringify(shifts, null, 2));
    console.log('--- DEPARTMENTS ---');
    console.log(JSON.stringify(departments, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

check();
