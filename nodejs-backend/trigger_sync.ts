import { AbsenceService } from './src/services/absence.service';

async function triggerSync() {
  console.log('--- Triggering Manual Sync ---');
  // Trigger sync for "today" (March 31st according to previous logs, or current actual date)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  try {
    const result = await AbsenceService.processDailyAbsences(tomorrow);
    console.log('Sync Result:', result);
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err);
    process.exit(1);
  }
}

triggerSync();
