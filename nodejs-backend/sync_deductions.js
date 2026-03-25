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

function calculateDeductionAmount(category, monthlySalary, workingDays) {
  switch (category) {
    case 'absent': return monthlySalary / workingDays;
    case 'late': return (monthlySalary / workingDays) * 0.25;
    case 'half-day': return (monthlySalary / workingDays) * 0.5;
    // Leave is typically paid if authorized (leaves_remaining > 0), so 0 deduction.
    // If we wanted unauthorized leave deduction, it would be absent.
    default: return 0;
  }
}

async function run() {
  console.log("Starting Deductions Sync...");

  const records = await prisma.attendanceRecord.findMany({
    include: { user: true }
  });

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  for (const record of records) {
    const userId = record.user_id;
    const date = record.date;
    const salary = record.user?.monthly_salary || 0;
    const workingDays = getWorkingDaysInMonth(date.getFullYear(), date.getMonth());

    // Determine Required Deduction
    let reqType = null;
    if (record.status === 'absent') reqType = 'absent';
    else if (record.status === 'late') reqType = 'late';
    else if (record.status === 'halfday') reqType = 'half-day';

    let reqAmount = 0;
    if (reqType) {
        reqAmount = calculateDeductionAmount(reqType, salary, workingDays);
    }

    // Fetch existing deductions for this user and date
    const existingDeds = await prisma.deduction.findMany({
      where: { user_id: userId, date: date }
    });

    if (!reqType) {
       // Should have NO deductions
       for (const ded of existingDeds) {
          await prisma.deduction.delete({ where: { id: ded.id } });
          deletedCount++;
       }
    } else {
       // Should have exactly ONE deduction of reqType
       let foundMatch = false;

       for (const ded of existingDeds) {
          if (ded.type === reqType) {
             foundMatch = true;
             if (Math.abs(ded.amount - reqAmount) > 0.01) {
                await prisma.deduction.update({
                  where: { id: ded.id },
                  data: { amount: reqAmount }
                });
                updatedCount++;
             }
          } else {
             // Wrong type, delete it
             await prisma.deduction.delete({ where: { id: ded.id } });
             deletedCount++;
          }
       }

       if (!foundMatch && reqAmount > 0) {
          await prisma.deduction.create({
             data: {
               user_id: userId,
               date: date,
               type: reqType,
               amount: reqAmount
             }
          });
          createdCount++;
       }
    }
  }

  console.log(`Sync Complete!`);
  console.log(`Created:  ${createdCount}`);
  console.log(`Updated:  ${updatedCount}`);
  console.log(`Deleted:  ${deletedCount}`);
}

run().catch(console.error).finally(() => prisma.$disconnect());
