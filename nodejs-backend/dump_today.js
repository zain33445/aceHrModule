const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const rs = await prisma.attendanceRecord.findMany({ 
    where: { 
      user_id: '6' 
    },
    orderBy: { date: 'desc' }
  }); 

  console.log("Records for user 6 (last 15):");
  rs.slice(0, 15).forEach(x => {
    console.log(x.id, x.date.toISOString(), x.status, x.check_in_time, x.check_out_time);
  });
}

test().catch(console.error).finally(() => prisma.$disconnect());
