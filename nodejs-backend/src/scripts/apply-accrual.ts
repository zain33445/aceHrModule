import prisma from '../prisma';
import { ensureLeaveLedgerBalanceTrigger } from '../db/ensure-leave-ledger-trigger';

async function main() {
  await ensureLeaveLedgerBalanceTrigger();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  console.log(`Running manual accrual for month: ${currentMonth}`);

  const activePolicies = await prisma.employeeLeavePolicy.findMany({
    where: { effective_to: null, effective_from: { lte: now } }
  });

  console.log(`Found ${activePolicies.length} active policies`);
  if (activePolicies.length === 0) {
    console.log('No active policies — nothing to do.');
    return;
  }

  // Group accrual per (user_id, leave_type_id)
  const accrualByKey = activePolicies.reduce((acc, policy) => {
    const key = `${policy.user_id}-${policy.leave_type_id}`;
    acc[key] = (acc[key] || 0) + Number(policy.accrual_rate);
    return acc;
  }, {} as Record<string, number>);

  let applied = 0;
  let skipped = 0;

  for (const [key, totalAccrual] of Object.entries(accrualByKey)) {
    const sepIdx = key.lastIndexOf('-');
    const user_id = key.substring(0, sepIdx);
    const leave_type_id = parseInt(key.substring(sepIdx + 1));
    const idempotencyKey = `${user_id}-${leave_type_id}-${currentMonth}-ACCRUAL`;

    const existing = await prisma.leaveLedger.findUnique({ where: { idempotency_key: idempotencyKey } });
    if (existing) {
      console.log(`  [SKIP] user=${user_id} type=${leave_type_id} — already accrued for ${currentMonth}`);
      skipped++;
      continue;
    }

    // Record in ledger
    await prisma.leaveLedger.create({
      data: {
        user_id,
        leave_type_id,
        transaction_type: 'ACCRUAL',
        amount: totalAccrual,
        idempotency_key: idempotencyKey,
        notes: `Monthly accrual for ${currentMonth}`,
        created_by_type: 'SYSTEM'
      }
    });

    const updated = await prisma.leaveBank.findUnique({
      where: { user_id_leave_type_id: { user_id, leave_type_id } }
    });

    console.log(`  [OK] user=${user_id} type=${leave_type_id} += ${totalAccrual} → balance=${updated?.leaves_remaining}`);
    applied++;
  }

  console.log(`\nDone. Applied: ${applied} | Skipped (already done): ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
