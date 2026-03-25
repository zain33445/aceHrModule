import prisma from './prisma';

async function analyze() {
  try {
    const users = await prisma.user.findMany({ 
      select: { id: true, name: true, monthly_salary: true } 
    });
    console.log('--- User Salaries ---');
    console.table(users);
    
    const deductionStats = await prisma.deduction.groupBy({
      by: ['user_id'],
      _count: { id: true }
    });
    console.log('\n--- Deduction Counts per User ---');
    console.table(deductionStats);

    const statusStats = await prisma.attendanceRecord.groupBy({
      by: ['status'],
      _count: { id: true }
    });
    console.log('\n--- AttendanceRecord Status Stats ---');
    console.table(statusStats);

    const logCount = await prisma.attendanceLog.count();
    const recordCount = await prisma.attendanceRecord.count();
    console.log(`\n--- Summary Counts ---`);
    console.log(`AttendanceLogs: ${logCount}`);
    console.log(`AttendanceRecords: ${recordCount}`);
    
    // Check user6's specific stats
    const user6AbsenceCount = await prisma.attendanceRecord.count({
      where: { user_id: '6', status: 'absent' }
    });
    console.log(`\nUser 6 Absent Days: ${user6AbsenceCount}`);

  } catch (error) {
    console.error('Analysis failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyze();
