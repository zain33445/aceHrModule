import prisma from './src/prisma';
(async () => {
  const r = await prisma.deduction.groupBy({
    by: ['type'],
    where: { user_id: '41', status: 'ACTIVE' },
    _count: { type: true },
    _sum: { amount: true },
  });
  console.log(JSON.stringify(r, null, 2));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });