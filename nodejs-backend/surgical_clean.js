const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  const records = await prisma.attendanceRecord.findMany();
  let deletedCount = 0;
  
  for (const r of records) {
    const iso = r.date.toISOString();
    // If it doesn't end in 00:00:00.000Z, it's a legacy corrupted record
    if (!iso.endsWith('T00:00:00.000Z')) {
      await prisma.attendanceRecord.delete({ where: { id: r.id } });
      deletedCount++;
    }
  }
  
  console.log(`Surgically deleted ${deletedCount} legacy records.`);
}

clean().catch(console.error).finally(() => prisma.$disconnect());
