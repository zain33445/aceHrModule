import prisma from './prisma';

async function checkData() {
  try {
    console.log('\n📋 SHIFT CONFIGURATIONS:\n');
    const shifts = await prisma.shift.findMany();
    
    if (shifts.length === 0) {
      console.log('❌ No shift configurations found!');
      console.log('   Shift data must be added for late/halfday detection to work.\n');
    } else {
      shifts.forEach(shift => {
        console.log(`Shift ID: ${shift.shiftid}`);
        console.log(`  ├─ Check-in: ${shift.checkin}`);
        console.log(`  ├─ Check-out: ${shift.checkout}`);
        console.log(`  ├─ Late Threshold: ${shift.latetiming}`);
        console.log(`  └─ Half-day Limit: ${shift.halfday}\n`);
      });
    }

    console.log('\n📊 ATTENDANCE RECORDS SUMMARY:\n');
    
    const records = await prisma.attendanceRecord.findMany({
      where: {
        check_in_time: { not: null }
      },
      select: {
        check_in_time: true,
        check_out_time: true,
        is_late: true,
        is_halfday: true
      },
      take: 15
    });

    console.log(`Sample Records with Check-in Times (showing first 15):\n`);
    records.forEach((r, i) => {
      console.log(`${i + 1}. Check-in: ${r.check_in_time} | Check-out: ${r.check_out_time} | Late: ${r.is_late} | Half-day: ${r.is_halfday}`);
    });

    // Statistics
    const totalWithTimes = await prisma.attendanceRecord.count({
      where: { check_in_time: { not: null } }
    });

    const lateCount = await prisma.attendanceRecord.count({
      where: { is_late: true }
    });

    const halfdayCount = await prisma.attendanceRecord.count({
      where: { is_halfday: true }
    });

    console.log(`\n\n📈 STATISTICS:\n`);
    console.log(`Records with check-in times: ${totalWithTimes}`);
    console.log(`Records marked as late: ${lateCount}`);
    console.log(`Records marked as half-day: ${halfdayCount}`);

    if (lateCount === 0 && halfdayCount === 0 && shifts.length > 0) {
      console.log(`\n⚠️  Note: No late or half-day records found.`);
      console.log(`   This could mean:`);
      console.log(`   1. Shift times don't match actual data times`);
      console.log(`   2. All employees are within normal working hours`);
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkData();
