import prisma from '../prisma';

const userId = process.argv[2];

async function main() {
  if (!userId) {
    throw new Error('Usage: ts-node src/scripts/fix-late-halfday-user.ts <userId>');
  }

  const [attendanceResult, deductionResult] = await prisma.$transaction([
    prisma.attendanceRecord.updateMany({
      where: {
        user_id: userId,
        OR: [
          { status: { in: ['late', 'halfday'] } },
          { is_late: true },
          { is_halfday: true },
        ],
      },
      data: {
        status: 'present',
        is_late: false,
        is_halfday: false,
      },
    }),
    prisma.deduction.updateMany({
      where: {
        user_id: userId,
        type: { in: ['late', 'half-day'] },
        status: { not: 'REVERSED' },
      },
      data: { status: 'REVERSED' },
    }),
  ]);

  console.log(
    `User ${userId}: updated ${attendanceResult.count} attendance record(s) to present; reversed ${deductionResult.count} late/half-day deduction(s).`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
