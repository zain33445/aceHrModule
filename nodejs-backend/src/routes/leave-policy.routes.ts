import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get active policies for a user
router.get('/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const policies = await prisma.employeeLeavePolicy.findMany({
      where: {
        user_id,
        effective_to: null, // Only active
      },
      include: {
        leave_type: true
      }
    });
    res.json(policies);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch policies' });
  }
});

// Create a new policy after closing any active policy (date-boxing)
router.post('/', async (req, res) => {
  const { user_id, leave_type_id, accrual_rate, updated_by, change_reason, effective_from } = req.body;

  if (!user_id || !leave_type_id || accrual_rate === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Find currently active policy
      const activePolicy = await tx.employeeLeavePolicy.findFirst({
        where: { user_id, leave_type_id: parseInt(leave_type_id), effective_to: null }
      });

      if (activePolicy) {
        // 2. Close the existing active policy
        await tx.employeeLeavePolicy.update({
          where: { id: activePolicy.id },
          data: { effective_to: new Date() }
        });
      }

      // 3. Create the new active policy
      const newPolicy = await tx.employeeLeavePolicy.create({
        data: {
          user_id,
          leave_type_id: parseInt(leave_type_id),
          accrual_rate,
          previous_rate: activePolicy?.accrual_rate || null,
          change_reason,
          updated_by,
          effective_from: effective_from ? new Date(effective_from) : new Date(),
          effective_to: null,
        },
        include: {
          leave_type: true,
          user: true
        }
      });

      return newPolicy;
    });

    res.json(result);
  } catch (error) {
    console.error('Failed to create policy:', error);
    res.status(500).json({ error: 'Failed to create policy' });
  }
});

// Bulk create policies after closing any active policies (date-boxing)
router.post('/bulk', async (req, res) => {
  const { employee_ids, leave_type_id, accrual_rate, updated_by, change_reason, effective_from } = req.body;

  if (!employee_ids || !Array.isArray(employee_ids) || !leave_type_id || accrual_rate === undefined) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const results = [];

      for (const user_id of employee_ids) {
        // 1. Find currently active policy
        const activePolicy = await tx.employeeLeavePolicy.findFirst({
          where: {
            user_id,
            leave_type_id: parseInt(leave_type_id),
            effective_to: null
          }
        });

        if (activePolicy) {
          // 2. Close the existing active policy
          await tx.employeeLeavePolicy.update({
            where: { id: activePolicy.id },
            data: { effective_to: new Date() }
          });
        }

        // 3. Create the new active policy
        const newPolicy = await tx.employeeLeavePolicy.create({
          data: {
            user_id,
            leave_type_id: parseInt(leave_type_id),
            accrual_rate,
            previous_rate: activePolicy?.accrual_rate || null,
            change_reason: change_reason || 'Bulk allocation',
            updated_by,
            effective_from: effective_from ? new Date(effective_from) : new Date(),
            effective_to: null,
          },
          include: {
            leave_type: true,
            user: true
          }
        });

        results.push(newPolicy);
      }

      return results;
    });

    res.json(result);
  } catch (error) {
    console.error('Failed to create bulk policies:', error);
    res.status(500).json({ error: 'Failed to create leave policies' });
  }
});

// Apply accrual for currently active leave policies immediately
router.post('/apply-active', async (req, res) => {
try {
  const currentDate = new Date();

  const currentMonth = `${currentDate.getFullYear()}-${String(
    currentDate.getMonth() + 1
  ).padStart(2, '0')}`;

  // 1. Get active policies
  const activePolicies = await prisma.employeeLeavePolicy.findMany({
    where: {
      effective_to: null,
      effective_from: { lte: currentDate }
    }
  });

  if (activePolicies.length === 0) {
    return res.json({ message: 'No active leave policies found to apply.' });
  }

  // 2. Group accrual per user
  const accrualByUser = activePolicies.reduce((acc, policy) => {
    const amount = Number(policy.accrual_rate);
    acc[policy.user_id] = (acc[policy.user_id] || 0) + amount;
    return acc;
  }, {} as Record<string, number>);

  // 3. Process inside transaction
  const updatedBanks = await prisma.$transaction(async (tx) => {
    const results = [];

    for (const [user_id, totalAccrual] of Object.entries(accrualByUser)) {
      const idempotencyKey = `${user_id}-${currentMonth}-ACCRUAL`;

      // -----------------------------
      // 0. Idempotency check (IMPORTANT)
      // -----------------------------
      const existingLedger = await tx.leaveLedger.findUnique({
        where: { idempotency_key: idempotencyKey }
      });

      if (existingLedger) {
        continue; // already processed
      }

      // -----------------------------
      // 1. Get user
      // -----------------------------
      const user = await tx.user.findUnique({
        where: { id: user_id },
        select: { leave_bank: true }
      });

      if (!user) continue;

      // -----------------------------
      // 2. Get or create leave bank
      // -----------------------------
      let leaveBank = await tx.leaveBank.findUnique({
        where: { user_id }
      });

      if (!leaveBank) {
        leaveBank = await tx.leaveBank.create({
          data: {
            user_id,
            leaves_remaining: 0,
            last_reset_month: currentMonth
          }
        });
      }

      // -----------------------------
      // 3. INSERT INTO LEAVE LEDGER (SOURCE OF TRUTH)
      // -----------------------------
      await tx.leaveLedger.create({
        data: {
          user_id,
          leave_type_id: 1, // ⚠️ replace with your default leave type id
          transaction_type: 'ACCRUAL',
          amount: totalAccrual,
          idempotency_key: idempotencyKey,
          notes: `Monthly accrual for ${currentMonth}`,
          created_by_type: 'SYSTEM'
        }
      });

      // -----------------------------
      // 4. UPDATE LEAVE BANK (CACHE)
      // -----------------------------
      if (leaveBank.last_reset_month !== currentMonth) {
        const updated = await tx.leaveBank.update({
          where: { user_id },
          data: {
            leaves_remaining: user.leave_bank + totalAccrual,
            last_reset_month: currentMonth
          }
        });

        results.push(updated);
      } else {
        const updated = await tx.leaveBank.update({
          where: { user_id },
          data: {
            leaves_remaining: {
              increment: totalAccrual
            }
          }
        });

        results.push(updated);
      }
    }

    return results;
  });

  // 4. Response
  return res.json({
    message: `Applied active leave policies for ${updatedBanks.length} user(s).`,
    updatedBanksCount: updatedBanks.length
  });
} catch (error) {
  console.error('Failed to apply active leave policies:', error);
  return res.status(500).json({
    error: 'Failed to apply active leave policies'
  });
}

});

export default router;
