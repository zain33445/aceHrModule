const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const rs = await prisma.attendanceRecord.findMany({ 
    where: { user_id: '6' },
  }); 

  console.log("March 18 records:");
  rs.forEach(x => {
    const d = new Date(x.date);
    if (d.getFullYear() === 2026 && d.getMonth() === 2 && d.getDate() === 18) {
      console.log(x.id, x.date.toISOString(), x.status);
    }
  });
}

check().catch(console.error).finally(() => prisma.$disconnect());
