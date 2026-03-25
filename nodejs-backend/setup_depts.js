const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Setup Shifts
  const dayShift = await prisma.shift.upsert({
    where: { shiftid: 'day_shift' },
    update: {},
    create: {
      shiftid: 'day_shift',
      checkin: '09:00',
      checkout: '17:00',
      latetiming: '09:15',
      halfday: '13:00'
    }
  });

  const nightShift = await prisma.shift.upsert({
    where: { shiftid: 'night_shift' },
    update: {},
    create: {
      shiftid: 'night_shift',
      checkin: '18:00',
      checkout: '02:00',
      latetiming: '18:15',
      halfday: '22:00'
    }
  });

  // 2. Setup Departments
  const marketing = await prisma.department.upsert({
    where: { name: 'Marketing' },
    update: { shift_id: nightShift.id },
    create: { name: 'Marketing', shift_id: nightShift.id }
  });

  const engineering = await prisma.department.upsert({
    where: { name: 'Engineering' },
    update: { shift_id: dayShift.id },
    create: { name: 'Engineering', shift_id: dayShift.id }
  });

  const it = await prisma.department.upsert({
    where: { name: 'IT' },
    update: {},
    create: { name: 'IT' }
  });

  // 3. Assign Users
  const targetNames = ['sohaib', 'aliakbar', 'zorain', 'musshaid', 'zaeem', 'asadullah', 'abdullah', 'mushahid']; // Added mushahid in case of spelling
  const allUsers = await prisma.user.findMany();

  for (const user of allUsers) {
    if (user.role === 'admin') {
      // Update admin password to admin123
      await prisma.user.update({
        where: { id: user.id },
        data: { password_hash: 'admin123' }
      });
      continue;
    }

    const nameLower = user.name.toLowerCase();
    const isMarketing = targetNames.some(t => nameLower.includes(t));
    const assignedDeptId = isMarketing ? marketing.id : engineering.id;
    
    // Create unique password based on name + 123
    const uniquePassword = nameLower.replace(/\s+/g, '') + '123';

    await prisma.user.update({
      where: { id: user.id },
      data: {
        department_id: assignedDeptId,
        password_hash: uniquePassword
      }
    });

    console.log(`Updated user ${user.name}: Dept -> ${isMarketing ? 'Marketing' : 'Engineering'}, Pass -> ${uniquePassword}`);
  }

  console.log('Successfully setup departments, shifts, user assignments, and passwords.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
