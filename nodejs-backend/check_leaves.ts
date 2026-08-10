import prisma from './src/prisma';

async function main() {
  const leaveBanks = await prisma.leaveBank.findMany();
  console.log("LeaveBanks count:", leaveBanks.length);
  if (leaveBanks.length > 0) {
    console.log("Sample:", leaveBanks.slice(0, 3));
  }
}
main().finally(() => prisma.$disconnect());
