const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function update() {
  console.log('Updating night_shift timing...');
  
  await prisma.shift.update({
    where: { shiftid: 'night_shift' },
    data: {
      checkin: '19:30',
      checkout: '03:00',
      latetiming: '19:45', // 15 min grace
      halfday: '23:30'
    }
  });
  
  console.log('Shift updated.');
}

update().catch(console.error).finally(() => prisma.$disconnect());
