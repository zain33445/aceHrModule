import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
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

    // Ensure leave bank row exists
    await prisma.leaveBank.upsert({
      where: { user_id_leave_type_id: { user_id, leave_type_id } },
      create: { user_id, leave_type_id, leaves_remaining: 0, last_reset_month: currentMonth },
      update: {}
    });

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

    // Increment leave bank (additive — no reset)
    const updated = await prisma.leaveBank.update({
      where: { user_id_leave_type_id: { user_id, leave_type_id } },
      data: { leaves_remaining: { increment: totalAccrual }, last_reset_month: currentMonth }
    });

    console.log(`  [OK] user=${user_id} type=${leave_type_id} += ${totalAccrual} → balance=${updated.leaves_remaining}`);
    applied++;
  }

  console.log(`\nDone. Applied: ${applied} | Skipped (already done): ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
