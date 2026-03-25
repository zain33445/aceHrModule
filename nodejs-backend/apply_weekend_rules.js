const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function getWorkingDaysInMonth(year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let workingDays = 0;
  for (let i = 1; i <= daysInMonth; i++) {
    const dayOfWeek = new Date(year, month, i).getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) workingDays++;
  }
  return workingDays > 0 ? workingDays : 30;
}

async function run() {
  console.log("Starting Retroactive Weekend and Salary Rule Application...");

  // 1. Process Weekend Attendance Records
  const records = await prisma.attendanceRecord.findMany({
    include: { user: { include: { leaveBank: true } } }
  });

  let weekendCount = 0;
  let leavesRefunded = 0;

  for (const record of records) {
    const day = record.date.getDay();
    const isWeekend = day === 0 || day === 6;
    
    if (isWeekend) {
       // Refund leave if applicable
       if (record.status === 'leave' && record.user?.leaveBank) {
         await prisma.leaveBank.update({
           where: { id: record.user.leaveBank.id },
           data: { leaves_remaining: record.user.leaveBank.leaves_remaining + 1 }
         });
         leavesRefunded++;
       }
       
       // Update to holiday
       if (record.status !== 'holiday' || record.is_late || record.is_halfday) {
         await prisma.attendanceRecord.update({
           where: { id: record.id },
           data: { status: 'holiday', is_late: false, is_halfday: false }
         });
         weekendCount++;
       }
    }
  }
  console.log(`Updated ${weekendCount} weekend records to 'holiday'. Refunded ${leavesRefunded} leave days.`);

  // 2. Process Deductions
  const deductions = await prisma.deduction.findMany({
    include: { user: true }
  });

  let deletedDeductions = 0;
  let recalculatedDeductions = 0;

  for (const ded of deductions) {
    const day = ded.date.getDay();
    const isWeekend = day === 0 || day === 6;
    
    if (isWeekend) {
       await prisma.deduction.delete({ where: { id: ded.id } });
       deletedDeductions++;
    } else {
       // 3. Recalculate remaining deductions based on working days
       const workingDays = getWorkingDaysInMonth(ded.date.getFullYear(), ded.date.getMonth());
       const salary = ded.user.monthly_salary;
       
       let newAmount = 0;
       if (ded.type === 'absent' || ded.type === 'leave') newAmount = salary / workingDays;
       else if (ded.type === 'late') newAmount = (salary / workingDays) * 0.25;
       else if (ded.type === 'half-day') newAmount = (salary / workingDays) * 0.5;

       if (Math.abs(ded.amount - newAmount) > 0.01) {
          await prisma.deduction.update({
             where: { id: ded.id },
             data: { amount: newAmount }
          });
          recalculatedDeductions++;
       }
    }
  }
  
  console.log(`Deleted ${deletedDeductions} invalid weekend deductions.`);
  console.log(`Recalculated ${recalculatedDeductions} weekday deductions with new active working-days math.`);
}

run().catch(console.error).finally(() => prisma.$disconnect());
