const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log("Starting Reprocessing...");

  // 1. Process Weekend Attendance Records
  const records = await prisma.attendanceRecord.findMany({
    include: { user: { include: { leaveBank: true } } }
  });

  let weekendCount = 0;
  let checkoutFixed = 0;

  for (const record of records) {
    const day = record.date.getDay();
    const isWeekend = day === 0 || day === 6;
    
    if (isWeekend) {
       if (record.status !== 'weekend' || record.is_late || record.is_halfday) {
         await prisma.attendanceRecord.update({
           where: { id: record.id },
           data: { status: 'weekend', is_late: false, is_halfday: false }
         });
         weekendCount++;
       }
    } else {
       // Check for missing check_out_time and recover from MonitoringLog
       // Only if they actually checked in!
       if (record.check_in_time && !record.check_out_time) {
          const startOfWindow = new Date(record.date);
          startOfWindow.setHours(6, 0, 0, 0);

          const endOfWindow = new Date(record.date);
          endOfWindow.setDate(endOfWindow.getDate() + 1);
          endOfWindow.setHours(6, 0, 0, 0);

          const lastLog = await prisma.monitoringLog.findFirst({
             where: {
               user_id: record.user_id,
               timestamp: { gte: startOfWindow, lte: endOfWindow }
             },
             orderBy: { timestamp: 'desc' }
          });

          if (lastLog) {
             const timeStr = lastLog.timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
             
             // If we found a log that's significantly after their check-in, set it as check-out
             // To be absolutely safe, we just set whatever the LAST log of the day is as their check_out
             await prisma.attendanceRecord.update({
               where: { id: record.id },
               data: { check_out_time: timeStr }
             });
             checkoutFixed++;
          }
       }
    }
  }
  
  console.log(`Updated ${weekendCount} weekend records to 'weekend' status.`);
  console.log(`Recovered and fixed ${checkoutFixed} missing check-out times using Desktop Monitor Logs.`);
}

run().catch(console.error).finally(() => prisma.$disconnect());
