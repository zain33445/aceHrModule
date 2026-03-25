// Script to rebuild attendance history from Jan 1, 2026
const { AbsenceService } = require('./src/services/absence.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function rebuild() {
  // Start from Jan 1st
  const startDate = new Date('2026-01-01T12:00:00Z');
  const endDate = new Date(); // Now
  
  let current = new Date(startDate);
  
  console.log(`Starting historical rebuild from ${startDate.toDateString()} to ${endDate.toDateString()}...`);
  
  while (current <= endDate) {
    // AbsenceService.processDailyAbsences(d) checks for (d - 1)
    // So to process Jan 1st, we pass Jan 2nd
    const syncDate = new Date(current);
    syncDate.setDate(syncDate.getDate() + 1);
    
    console.log(`Syncing Day: ${current.toDateString()}...`);
    try {
      await AbsenceService.processDailyAbsences(syncDate);
    } catch (err) {
      console.error(`Error syncing ${current.toDateString()}:`, err.message);
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  console.log("Historical rebuild complete.");
}

rebuild().catch(console.error).finally(() => prisma.$disconnect());
