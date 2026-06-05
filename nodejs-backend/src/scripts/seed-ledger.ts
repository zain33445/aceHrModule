import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting ledger migration seed...');

  // 1. Seed Leave Types
  console.log('Seeding leave types...');
  const types = ['Legacy', 'Casual', 'Medical'];
  const leaveTypes: Record<string, any> = {};
  
  for (const name of types) {
    const lt = await prisma.leaveType.upsert({
      where: { name },
      update: {},
      create: { name, is_paid: true },
    });
    leaveTypes[name] = lt;
  }
  
  const legacyTypeId = leaveTypes['Legacy'].id;
  const casualTypeId = leaveTypes['Casual'].id;

  // 2. Fetch all users
  const users = await prisma.user.findMany();
  console.log(`Found ${users.length} users. Creating UserLeaveLocks and mapping legacy balances...`);

  // 3. Process each user
  for (const user of users) {
    // a. Create UserLeaveLock if not exists
    await prisma.userLeaveLock.upsert({
      where: { user_id: user.id },
      update: {},
      create: { user_id: user.id },
    });

    // b. Create a default EmployeeLeavePolicy for Casual (1.25/month for example)
    const existingPolicy = await prisma.employeeLeavePolicy.findFirst({
      where: { user_id: user.id, leave_type_id: casualTypeId, effective_to: null }
    });
    if (!existingPolicy) {
      await prisma.employeeLeavePolicy.create({
        data: {
          user_id: user.id,
          leave_type_id: casualTypeId,
          accrual_rate: 1.25, // Default assumption
        }
      });
    }

    // c. Migrate User.leave_bank to LeaveLedger as a starting ADJUSTMENT if they don't have ledger entries
    const existingLedgerEntries = await prisma.leaveLedger.count({
      where: { user_id: user.id }
    });
    
    if (existingLedgerEntries === 0 && user.leave_bank > 0) {
      await prisma.leaveLedger.create({
        data: {
          user_id: user.id,
          leave_type_id: casualTypeId, // Assuming legacy bank applies to casual
          transaction_type: 'ADJUSTMENT',
          amount: user.leave_bank,
          idempotency_key: `MIGRATION_INITIAL_BAL_${user.id}`,
          notes: 'Migrated from legacy User.leave_bank',
          created_by_type: 'SYSTEM'
        }
      });
    }
  }

  // 4. Backfill existing LeaveRequests
  console.log('Backfilling legacy LeaveRequests...');
  const legacyRequests = await prisma.leaveRequest.findMany({
    where: { leave_type_id: null }
  });

  console.log(`Found ${legacyRequests.length} legacy requests to update.`);
  for (const req of legacyRequests) {
    // Calculate estimated days_consumed (simplistic calculation excluding weekends/holidays for migration purposes, or just 1 day minimum)
    const start = new Date(req.start_date);
    const end = new Date(req.end_date);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    let diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays <= 0) diffDays = 1;

    await prisma.leaveRequest.update({
      where: { id: req.id },
      data: {
        leave_type_id: legacyTypeId,
        days_consumed: diffDays,
        original_source_metadata: {
          migrated_at: new Date().toISOString(),
          original_status: req.status
        }
      }
    });
  }

  console.log('Migration seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
