const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const rs = await prisma.attendanceRecord.findMany({ 
    where: { 
      user_id: '6' 
    }
  }); 

  // Filter in JS to be safe from db timezone issues
  let count = 0;
  rs.forEach(x => {
    const d = new Date(x.date);
    if (d.getFullYear() === 2026 && d.getMonth() === 2 && d.getDate() === 18) {
      console.log(x.id, x.date.toISOString(), x.status, x.check_in_time, x.check_out_time);
      count++;
    }
  });
  console.log("Total for March 18 in Local TZ:", count);
}

test().catch(console.error).finally(() => prisma.$disconnect());
