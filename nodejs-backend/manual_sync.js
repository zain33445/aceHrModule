const { AbsenceService } = require('./src/services/absence.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function sync() {
  // Sync for March 17 (includes Mar 17 evening + Mar 18 morning)
  console.log("Syncing March 17...");
  await AbsenceService.processDailyAbsences(new Date('2026-03-18T00:00:00Z'));
  
  // Sync for March 18 (includes Mar 18 evening + Mar 19 morning)
  console.log("Syncing March 18...");
  await AbsenceService.processDailyAbsences(new Date('2026-03-19T00:00:00Z'));
  
  console.log("Done.");
}

sync().catch(console.error).finally(() => prisma.$disconnect());
