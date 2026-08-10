import prisma from './src/prisma';
import { DisputeService } from './src/services/dispute.service';

async function main() {
  const userId = '41';
  const deds = await prisma.deduction.findMany({
    where: { user_id: userId, type: 'late', status: 'ACTIVE' },
    orderBy: { date: 'desc' },
    include: { user: { select: { monthly_salary: true } } },
  });

  console.log('Recomputing "late" deduction amounts for user 41');
  console.log('Formula: (monthly_salary / working_days) * 0.3\n');

  let total = 0;
  for (const d of deds) {
    const amount = await DisputeService.calculateDeductionAmount('late', d.user.monthly_salary, d.date);
    if (d.amount !== amount) {
      await prisma.deduction.update({ where: { id: d.id }, data: { amount } });
    }
    console.log(`${d.date.toISOString().split('T')[0]}  ${d.amount.toFixed(2)} -> ${amount.toFixed(2)}`);
    total += amount;
  }
  console.log(`\nTotal late deductions: ${total.toFixed(2)} (${deds.length} late records)`);
  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('ERR', e);
  await prisma.$disconnect();
  process.exit(1);
});