const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const r = await prisma.attendanceRecord.findMany({ 
    where: { 
      user_id: '6',
      date: { gte: new Date('2026-03-01') }
    },
    orderBy: { date: 'desc' }
  }); 
  console.log("Total records in March 2026 for user 6:", r.length);
  
  r.forEach(x => {
    console.log(x.id, x.date.toISOString(), x.status);
  });
}

test().catch(console.error).finally(() => prisma.$disconnect());
