import prisma from './prisma';

async function checkLogStatuses() {
  try {
    console.log('\n📊 Checking AttendanceLog Status Values:\n');

    const startOfMarch = new Date('2026-03-01');
    const endOfMarch = new Date('2026-03-31');
    endOfMarch.setHours(23, 59, 59, 999);

    // Get all unique statuses
    const logs = await prisma.attendanceLog.findMany({
      where: {
        timestamp: {
          gte: startOfMarch,
          lte: endOfMarch
        }
      },
      select: { 
        status: true,
        user_id: true,
        timestamp: true
      },
      orderBy: { timestamp: 'asc' },
      take: 50
    });

    console.log(`Sample logs (first 50):\n`);
    logs.forEach((log, i) => {
      const date = log.timestamp.toISOString().split('T')[0];
      const time = log.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      console.log(`${i + 1}. User: ${log.user_id}, Status: ${log.status}, Date: ${date}, Time: ${time}`);
    });

    // Get unique statuses
    const statuses = await prisma.attendanceLog.findMany({
      where: {
        timestamp: {
          gte: startOfMarch,
          lte: endOfMarch
        }
      },
      select: { status: true },
      distinct: ['status']
    });

    console.log(`\n\nUnique Status Values Found:`);
    statuses.forEach(s => {
      console.log(`  • ${s.status}`);
    });

    // Count by status
    const groupedByStatus = await prisma.attendanceLog.groupBy({
      by: ['status'],
      where: {
        timestamp: {
          gte: startOfMarch,
          lte: endOfMarch
        }
      },
      _count: true
    });

    console.log(`\n\nCount by Status:`);
    groupedByStatus.forEach(g => {
      console.log(`  • Status ${g.status}: ${g._count} logs`);
    });

    // Count per user per day
    console.log(`\n\nLogs per User per Day Sample:\n`);
    const userId1Logs = await prisma.attendanceLog.findMany({
      where: {
        user_id: '1',
        timestamp: {
          gte: startOfMarch,
          lte: endOfMarch
        }
      },
      orderBy: { timestamp: 'asc' }
    });

    console.log(`User 1 logs (${userId1Logs.length} total):`);
    userId1Logs.forEach(log => {
      const date = log.timestamp.toISOString().split('T')[0];
      const time = log.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      console.log(`  • ${date} ${time} - Status: ${log.status}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkLogStatuses();
