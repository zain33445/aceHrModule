const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const match = timeStr.toLowerCase().match(/(\d+):(\d+)(?:\s*(am|pm))?/);
  if (!match) return 0;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const isPM = match[3] === 'pm';
  const isAM = match[3] === 'am';

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

function getAdjustedMinutes(timeStr, shiftType) {
  const minutes = timeToMinutes(timeStr);
  if (shiftType === 'night' && minutes < 720) {
    return minutes + 1440;
  }
  return minutes;
}

function determineShiftType(checkInTime) {
  if (!checkInTime) return 'day';
  const checkInMinutes = timeToMinutes(checkInTime);
  if (checkInMinutes < 13 * 60) return 'day';
  return 'night';
}

async function run() {
  const records = await prisma.attendanceRecord.findMany({
    include: {
      user: {
        include: {
          department: {
             include: { shift: true }
          },
          leaveBank: true
        }
      }
    }
  });

  const shifts = await prisma.shift.findMany();
  const defaultShift = shifts[0];

  console.log(`Processing ${records.length} attendance records with the strict exclusive status logic...`);

  let updatedCount = 0;
  let leaveDeduppedCount = 0;

  for (const record of records) {
    const shift = record.user?.department?.shift || defaultShift;
    
    let newStatus = record.status;
    let newIsLate = record.is_late;
    let newIsHalfday = record.is_halfday;
    
    const hasPunches = record.check_in_time !== null || record.check_out_time !== null;

    if (!hasPunches) {
       // If check_in_time is null and check_out_time is null
       const leaveBank = record.user?.leaveBank;
       // We only deduct if it wasn't already marked as leave by a previous exact run
       if (record.status !== 'leave' && leaveBank && leaveBank.leaves_remaining > 0) {
           newStatus = 'leave';
           await prisma.leaveBank.update({
               where: { id: leaveBank.id },
               data: { leaves_remaining: leaveBank.leaves_remaining - 1 }
           });
           leaveDeduppedCount++;
       } else if (record.status !== 'leave' && (!leaveBank || leaveBank.leaves_remaining <= 0)) {
           newStatus = 'absent';
       }
    } else {
       // Halfday / Late / Present check
       if (!record.check_in_time) {
          newStatus = 'present'; // fallback if only checkout exists
       } else {
          const shiftType = determineShiftType(record.check_in_time);
          const checkInMins = getAdjustedMinutes(record.check_in_time, shiftType);
          const halfdayMins = getAdjustedMinutes(shift.halfday, shiftType);
          const lateMins = getAdjustedMinutes(shift.latetiming, shiftType);

          if (checkInMins > halfdayMins) {
             newStatus = 'halfday';
          } else if (checkInMins > lateMins) {
             newStatus = 'late';
          } else {
             newStatus = 'present';
          }
       }
    }
    
    // Mutually exclusive: A record cannot be both halfday and late.
    newIsLate = newStatus === 'late';
    newIsHalfday = newStatus === 'halfday';

    // Update if changed
    if (newStatus !== record.status || newIsLate !== record.is_late || newIsHalfday !== record.is_halfday) {
       await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
             status: newStatus,
             is_late: newIsLate,
             is_halfday: newIsHalfday
          }
       });
       updatedCount++;
    }
  }

  console.log(`Done! Updated ${updatedCount} records. Deducted ${leaveDeduppedCount} leaves.`);
  
  // Output example format if record for User 6 exists on March 19
  const user6Record = await prisma.attendanceRecord.findFirst({
      where: { user_id: '6', date: new Date('2026-03-19T00:00:00.000Z') }
  });
  
  if (user6Record) {
      console.log(`\nExample Output (User 6, 2026-03-19):`);
      console.log(`user_id\tdate\tcheck_in_time\tcheck_out_time\tstatus`);
      console.log(`${user6Record.user_id}\t${user6Record.date.toISOString().split('T')[0]}\t${user6Record.check_in_time}\t${user6Record.check_out_time}\t${user6Record.status}`);
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
