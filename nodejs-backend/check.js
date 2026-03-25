const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const rs = await prisma.attendanceRecord.findMany({ 
    where: { user_id: '6' },
    orderBy: { date: 'desc' }
  }); 

  console.log("Total records for user 6:", rs.length);
  rs.slice(0, 5).forEach(x => {
    console.log(x.id, x.date.toISOString(), x.status);
  });
}

check().catch(console.error).finally(() => prisma.$disconnect());
