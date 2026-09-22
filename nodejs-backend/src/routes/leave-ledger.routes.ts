import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get balance for user
router.get('/balance/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    // Using leave bank table to get the balance for each leave type for the user
    const balances: any[] = await prisma.$queryRaw`
      SELECT
        lb.leave_type_id,
        lt.name,
        lb.leaves_remaining AS available_balance
      FROM leave_bank lb
      JOIN leave_type lt ON lb.leave_type_id = lt.id
      WHERE lb.user_id = ${user_id}
    `;

    res.json(balances);
  } catch (error) {
    console.error('Failed to fetch balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Get ledger history for user
router.get('/history/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const history = await prisma.leaveLedger.findMany({
      where: { user_id },
      include: {
        leave_type: true,
        leave_request: true,
        created_by_user: { select: { id: true, name: true } }
      },
      orderBy: { created_at: 'desc' }
    });
    
    res.json(history);
  } catch (error) {
    console.error('Failed to fetch ledger history:', error);
    res.status(500).json({ error: 'Failed to fetch ledger history' });
  }
});

// Manual HR Adjustment
router.post('/adjust', async (req, res) => {
  const { user_id, leave_type_id, amount, notes, created_by_user_id } = req.body;
  
  if (!user_id || !leave_type_id || !amount || !notes || !created_by_user_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const adjustment = await prisma.$transaction(async (tx) => {
      // Lock user row
      await tx.$executeRaw`SELECT 1 FROM user_leave_locks WHERE user_id = ${user_id} FOR UPDATE`;

      const ledgerEntry = await tx.leaveLedger.create({
        data: {
          user_id,
          leave_type_id: parseInt(leave_type_id),
          transaction_type: 'ADJUSTMENT',
          amount,
          notes,
          created_by_type: 'USER',
          created_by_user_id,
          idempotency_key: `ADJUST_${Date.now()}_${user_id}_${leave_type_id}`
        }
      });
      return ledgerEntry;
    });

    res.json(adjustment);
  } catch (error) {
    console.error('Failed to apply adjustment:', error);
    res.status(500).json({ error: 'Failed to apply adjustment' });
  }
});

export default router;
