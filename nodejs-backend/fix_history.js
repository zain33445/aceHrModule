const { AbsenceService } = require('./src/services/absence.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function sync() {
  const dates = [
    new Date('2026-03-17T00:00:00Z'), // Sync for Mar 16 shift
    new Date('2026-03-18T00:00:00Z'), // Sync for Mar 17 shift
    new Date('2026-03-19T00:00:00Z'), // Sync for Mar 18 shift
    new Date('2026-03-20T00:00:00Z')  // Sync for Mar 19 shift (if any)
  ];
  
  for (const d of dates) {
    console.log(`Syncing for ${d.toISOString()}...`);
    // Pass d to processDailyAbsences. It subtracts 1 day.
    // So passing Mar 18 syncs Mar 17.
    await AbsenceService.processDailyAbsences(d);
  }
}

sync().catch(console.error).finally(() => prisma.$disconnect());
