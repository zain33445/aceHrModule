const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSync() {
  console.log('--- Database Sync Check ---');
  const today = new Date().toISOString().split('T')[0];
  
  // 1. Get today's logs
  const logs = await prisma.attendanceLog.findMany({
    where: {
      log_time: {
        gte: new Date(today)
      }
    },
    orderBy: { log_time: 'asc' }
  });

  // 2. Get today's records
  const records = await prisma.attendanceRecord.findMany({
    where: {
      date: {
        equals: new Date(today)
      }
    }
  });

  console.log(`\nToday: ${today}`);
  console.log(`AttendanceLog count: ${logs.length}`);
  console.log(`AttendanceRecord count: ${records.length}`);

  // 3. Simple comparison for user 26 (common test user)
  const user26Logs = logs.filter(l => l.user_id === 26);
  const user26Record = records.find(r => r.user_id === 26);

  console.log('\n--- User 26 (Test User) ---');
  if (user26Logs.length > 0) {
    console.log(`First Log: ${user26Logs[0].log_time.toISOString()}`);
    console.log(`Last Log: ${user26Logs[user26Logs.length - 1].log_time.toISOString()}`);
  } else {
    console.log('No logs for User 26 today.');
  }

  if (user26Record) {
    console.log(`Record Check-in: ${user26Record.check_in_time}`);
    console.log(`Record Check-out: ${user26Record.check_out_time}`);
    console.log(`Record Status: ${user26Record.status}`);
  } else {
    console.log('No record found for User 26 today.');
  }

  // 4. Check for mismatches
  console.log('\n--- Consistency Scan ---');
  for (const record of records) {
    const userLogs = logs.filter(l => l.user_id === record.user_id);
    if (userLogs.length > 0 && !record.check_in_time) {
      console.warn(`Mismatch: User ${record.user_id} has logs but NULL check-in in record.`);
    }
  }

  console.log('\n--- End Check ---');
  await prisma.$disconnect();
}

checkSync().catch(console.error);
