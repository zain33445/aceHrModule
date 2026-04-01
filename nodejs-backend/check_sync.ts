import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkSync() {
  console.log('--- Database Sync Check (TypeScript) ---');
  // Use today's date in local time or UTC as per the app's convention
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  
  const todayStr = todayDate.toISOString().split('T')[0];

  // 1. Get today's logs
  const logs = await prisma.attendanceLog.findMany({
    where: {
      timestamp: {
        gte: todayDate
      }
    },
    orderBy: { timestamp: 'asc' }
  });

  // 2. Get today's records
  const records = await prisma.attendanceRecord.findMany({
    where: {
      date: {
        gte: todayDate
      }
    }
  });

  console.log(`\nScan Date: ${todayStr}`);
  console.log(`AttendanceLog count: ${logs.length}`);
  console.log(`AttendanceRecord count: ${records.length}`);

  // 3. User 26 analysis
  const user26Id = "26";
  const user26Logs = logs.filter(l => l.user_id === user26Id);
  const user26Record = records.find(r => r.user_id === user26Id);

  console.log('\n--- User 26 (Test User) ---');
  if (user26Logs.length > 0) {
    console.log(`First Log: ${user26Logs[0].timestamp.toISOString()}`);
    console.log(`Last Log: ${user26Logs[user26Logs.length - 1].timestamp.toISOString()}`);
  } else {
    console.log('No logs for User 26 found today.');
  }

  if (user26Record) {
    console.log(`Record Check-in: ${user26Record.check_in_time}`);
    console.log(`Record Check-out: ${user26Record.check_out_time}`);
    console.log(`Record Status: ${user26Record.status}`);
  } else {
    console.log('No AttendanceRecord found for User 26 today.');
  }

  // 4. Inconsistency scan
  console.log('\n--- Consistency Scan ---');
  const allUserIds = [...new Set(logs.map(l => l.user_id))];
  
  for (const uid of allUserIds) {
    const userLogs = logs.filter(l => l.user_id === uid);
    const record = records.find(r => r.user_id === uid);
    
    if (userLogs.length > 0 && (!record || !record.check_in_time)) {
      console.warn(`User ${uid}: Has logs but no record or no check-in time.`);
    }
  }

  console.log('\n--- End Check ---');
  await prisma.$disconnect();
}

checkSync().catch(error => {
  console.error('Diagnostic failed:', error);
  process.exit(1);
});
