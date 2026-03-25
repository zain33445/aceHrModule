import prisma from './src/prisma';
import { AbsenceService } from './src/services/absence.service';

async function syncAll() {
  try {
    const logs = await prisma.attendanceLog.findMany({
      select: { timestamp: true }
    });

    const dates = new Set<string>();
    for (const log of logs) {
      const d = new Date(log.timestamp);
      d.setHours(0,0,0,0);
      dates.add(d.toISOString());
    }

    console.log(`Found ${dates.size} distinct dates with logs.`);

    let count = 0;
    for (const dateStr of dates) {
      const targetDate = new Date(dateStr);
      // processDailyAbsences subtracts 1, so pass targetDate + 1
      const passDate = new Date(targetDate);
      passDate.setDate(passDate.getDate() + 1);
      
      await AbsenceService.processDailyAbsences(passDate);
      count++;
    }
    console.log(`Historical sync complete for ${count} days.`);
  } catch(e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}
syncAll();
