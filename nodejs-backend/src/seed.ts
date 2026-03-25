import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial data...');
  
  // Create Departments
  const hr = await prisma.department.upsert({
    where: { name: 'Human Resources' },
    update: {},
    create: { name: 'Human Resources' },
  });

  const engineering = await prisma.department.upsert({
    where: { name: 'Engineering' },
    update: {},
    create: { name: 'Engineering' },
  });

  // Create an initial admin user
  const admin = await prisma.user.upsert({
    where: { id: 'admin' },
    update: {
      name: 'Super Admin',
      department_id: hr.id,
    },
    create: {
      id: 'admin',
      name: 'Super Admin',
      role: 'admin',
      password_hash: 'admin123',
      monthly_salary: 0,
      department_id: hr.id,
    },
  });

  // Create Staff #6
  const staff6 = await prisma.user.upsert({
    where: { id: '6' },
    update: {
      name: 'Staff Six',
      monthly_salary: 50000,
      department_id: engineering.id,
    },
    create: {
      id: '6',
      name: 'Staff Six',
      role: 'employee',
      password_hash: '1234',
      monthly_salary: 50000,
      leave_bank: 5,
      department_id: engineering.id,
    },
  });

  // Seed Shift table with day and night shifts
  const dayShift = await prisma.shift.upsert({
    where: { shiftid: 'day' },
    update: {
      latetiming: '9:16am',
      halfday: '11:01 am',
      checkin: '9:00am',
      checkout: '3:45pm',
    },
    create: {
      shiftid: 'day',
      latetiming: '9:16am',
      halfday: '11:01 am',
      checkin: '9:00am',
      checkout: '3:45pm',
    },
  });

  const nightShift = await prisma.shift.upsert({
    where: { shiftid: 'night' },
    update: {
      latetiming: '7:41',
      halfday: '11:01pm',
      checkin: '7:30pm',
      checkout: '2:45am',
    },
    create: {
      shiftid: 'night',
      latetiming: '7:41',
      halfday: '11:01pm',
      checkin: '7:30pm',
      checkout: '2:45am',
    },
  });

  console.log({ dayShift, nightShift });
  console.log({ admin, staff6, departments: [hr, engineering] });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
