import prisma from './prisma';

async function updateShiftTimes() {
  try {
    console.log('\n🔄 Updating shift times to HH:MM format (24-hour)...\n');

    // Day shift: 9:00 AM - 3:45 PM, late after 9:16 AM, half-day before 11:01 AM
    const dayShift = await prisma.shift.update({
      where: { shiftid: 'day' },
      data: {
        checkin: '09:00',
        checkout: '15:45',
        latetiming: '09:16',
        halfday: '11:01'
      }
    });
    
    console.log('✅ Day shift updated:');
    console.log(`   Check-in: ${dayShift.checkin}`);
    console.log(`   Check-out: ${dayShift.checkout}`);
    console.log(`   Late after: ${dayShift.latetiming}`);
    console.log(`   Half-day before: ${dayShift.halfday}\n`);

    // Night shift: 7:30 PM - 2:45 AM, late after 7:41 PM, half-day before 11:01 PM
    const nightShift = await prisma.shift.update({
      where: { shiftid: 'night' },
      data: {
        checkin: '19:30',
        checkout: '02:45',
        latetiming: '19:41',
        halfday: '23:01'
      }
    });
    
    console.log('✅ Night shift updated:');
    console.log(`   Check-in: ${nightShift.checkin}`);
    console.log(`   Check-out: ${nightShift.checkout}`);
    console.log(`   Late after: ${nightShift.latetiming}`);
    console.log(`   Half-day before: ${nightShift.halfday}\n`);

    console.log('✅ All shift times updated successfully!\n');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateShiftTimes();
