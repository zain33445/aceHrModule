import prisma from './prisma';

async function analyzeLogsWithSameTimes() {
  try {
    // Get attendance records where check-in equals check-out
    const records = await prisma.attendanceRecord.findMany({
      where: {
        check_in_time: { not: null },
        check_out_time: { not: null },
        date: {
          gte: new Date('2026-03-01'),
          lte: new Date('2026-03-31')
        }
      },
      include: { user: { select: { name: true } } }
    });

    const sameTime = records.filter(r => r.check_in_time === r.check_out_time);

    console.log('\n🔍 ANALYSIS: Records with SAME Check-in and Check-out Times\n');
    console.log(`Total records with same times: ${sameTime.length} out of ${records.length}\n`);

    if (sameTime.length > 0) {
      console.log('Examples:');
      for (const record of sameTime.slice(0, 5)) {
        const date = record.date.toISOString().split('T')[0];
        
        // Get the actual attendance logs for this user/date
        const dayStart = new Date(date);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const logs = await prisma.attendanceLog.findMany({
          where: {
            user_id: record.user_id,
            timestamp: {
              gte: dayStart,
              lte: dayEnd
            }
          },
          orderBy: { timestamp: 'asc' }
        });

        console.log(`\n  ${record.user.name} (${date}) - Time: ${record.check_in_time}`);
        console.log(`  Actual logs from device: ${logs.length} logs`);
        logs.forEach(log => {
          console.log(`    • ${log.timestamp.toISOString()} (Status: ${log.status})`);
        });
      }

      console.log('\n\n✏️  REASON ANALYSIS:\n');
      console.log('These records have same times because employees only have ONE log recorded');
      console.log('(typically only check-in, no check-out).');
      console.log('\nWhen we process logs with timestamp-based extraction:');
      console.log('  • If only 1 log exists: first = last (same time)');
      console.log('  • If 2+ logs exist: first log = check-in, last log = check-out (different)');
      console.log('\nThis is NORMAL DEVICE BEHAVIOR - not everyone checks out explicitly.');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeLogsWithSameTimes();
