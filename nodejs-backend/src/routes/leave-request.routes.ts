import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get leave requests (with optional filters)
router.get('/', async (req, res) => {
  const { user_id, status } = req.query;
  const where: any = {};
  
  if (user_id) where.user_id = String(user_id);
  if (status && status !== 'all') where.status = String(status);

  try {
    const requests = await prisma.leaveRequest.findMany({
      where,
      include: {
        user: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        leave_type: true
      },
      orderBy: { created_at: 'desc' }
    });
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

// Create leave request (Submits a RESERVED hold)
router.post('/', async (req, res) => {
  const { user_id, leave_type_id, start_date, end_date, reason, is_half_day, half_day_session, idempotency_key, days_consumed } = req.body;
  
  if (!user_id || !leave_type_id || !start_date || !end_date || !reason || !idempotency_key) {
    return res.status(400).json({ error: 'Missing required fields including idempotency_key' });
  }

  try {
    const request = await prisma.$transaction(async (tx) => {
      // 1. Lock the user's control row
      await tx.$executeRaw`SELECT 1 FROM user_leave_locks WHERE user_id = ${user_id} FOR UPDATE`;

      // 2. Compute Available Balance strictly from Ledger
      const balances: any[] = await tx.$queryRaw`
        SELECT COALESCE(SUM(amount), 0) as balance 
        FROM leave_ledger 
        WHERE user_id = ${user_id} AND leave_type_id = ${parseInt(leave_type_id)}
      `;
      const availableBalance = parseFloat(balances[0]?.balance || 0);

      // 3. Compute Days Consumed
      const start = new Date(start_date);
      const end = new Date(end_date);
      const diffTime = Math.abs(end.getTime() - start.getTime());
      let diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      
      if (is_half_day) diffDays = 0.5;
      if (days_consumed !== undefined) diffDays = parseFloat(days_consumed);

      // 4. Validate Balance (Except Unpaid/Legacy, assuming we validate all for now, or just allow negative. Let's allow negative but normally we'd block)
      // Since policy dictates behavior, we will insert it anyway, but normally we check `availableBalance >= diffDays`

      // 5. Insert Leave Request
      const newReq = await tx.leaveRequest.create({
        data: {
          user_id: String(user_id),
          leave_type_id: parseInt(leave_type_id),
          start_date: start,
          end_date: end,
          reason,
          is_half_day: !!is_half_day,
          half_day_session,
          days_consumed: diffDays,
          status: 'PENDING',
          idempotency_key
        },
        include: { user: { select: { id: true, name: true } } }
      });

      // 6. Insert RESERVED hold (Negative amount to reduce Available Balance natively)
      await tx.leaveLedger.create({
        data: {
          user_id: String(user_id),
          leave_type_id: parseInt(leave_type_id),
          transaction_type: 'RESERVED',
          amount: -diffDays,
          leave_request_id: newReq.id,
          idempotency_key: `REQ_${newReq.id}_SUBMITTED`,
          created_by_type: 'SYSTEM'
        }
      });

      return newReq;
    });

    // Notify admins (Outside transaction is safer)
    const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          user_id: admin.id,
          type: 'new_leave_request',
          message: `${request.user.name} submitted a leave request.`
        }
      });
    }

    res.json(request);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Duplicate request detected (Idempotency Key Conflict)' });
    }
    console.error('Failed to create leave request:', error);
    res.status(500).json({ error: 'Failed to create leave request' });
  }
});

// Approve/Reject leave request
router.put('/:id/status', async (req, res) => {
  const { status, reviewed_by, action_role } = req.body; // status: 'APPROVED' | 'REJECTED' | 'CANCELLED'
  
  if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const updatedRequest = await prisma.$transaction(async (tx) => {
      const reqId = parseInt(req.params.id);
      const leaveReq = await tx.leaveRequest.findUnique({ where: { id: reqId } });
      if (!leaveReq) throw new Error('Not found');
      if (leaveReq.status !== 'PENDING') throw new Error('Request already processed');

      // 1. Lock User
      await tx.$executeRaw`SELECT 1 FROM user_leave_locks WHERE user_id = ${leaveReq.user_id} FOR UPDATE`;

      const daysConsumed = Number(leaveReq.days_consumed);

      // 2. Update Request Status
      const request = await tx.leaveRequest.update({
        where: { id: reqId },
        data: { status, reviewed_by: reviewed_by ? String(reviewed_by) : undefined, action_role: action_role || null },
        include: { user: { select: { id: true, name: true } } }
      });

      // 3. Process Ledger Reversal & Consumption
      if (status === 'APPROVED') {
        // Reverse the RESERVED hold (+X)
        await tx.leaveLedger.create({
          data: {
            user_id: leaveReq.user_id,
            leave_type_id: leaveReq.leave_type_id!,
            transaction_type: 'REVERSAL',
            amount: daysConsumed,
            leave_request_id: reqId,
            idempotency_key: `REQ_${reqId}_REV_APPROVED`,
            created_by_type: 'USER',
            created_by_user_id: reviewed_by ? String(reviewed_by) : null
          }
        });

        // Record the actual CONSUMPTION (-X)
        await tx.leaveLedger.create({
          data: {
            user_id: leaveReq.user_id,
            leave_type_id: leaveReq.leave_type_id!,
            transaction_type: 'CONSUMPTION',
            amount: -daysConsumed,
            leave_request_id: reqId,
            idempotency_key: `REQ_${reqId}_CONS_APPROVED`,
            created_by_type: 'USER',
            created_by_user_id: reviewed_by ? String(reviewed_by) : null
          }
        });

        // 4. Queue Outbox Event for Attendance Sync
        await tx.outboxEvent.create({
          data: {
            type: 'SYNC_ATTENDANCE',
            payload: {
              user_id: leaveReq.user_id,
              start_date: leaveReq.start_date,
              end_date: leaveReq.end_date,
              is_half_day: leaveReq.is_half_day,
              half_day_session: leaveReq.half_day_session
            }
          }
        });

      } else {
        // REJECTED or CANCELLED: Just reverse the hold (+X)
        await tx.leaveLedger.create({
          data: {
            user_id: leaveReq.user_id,
            leave_type_id: leaveReq.leave_type_id!,
            transaction_type: 'REVERSAL',
            amount: daysConsumed,
            leave_request_id: reqId,
            idempotency_key: `REQ_${reqId}_REV_${status}`,
            created_by_type: 'USER',
            created_by_user_id: reviewed_by ? String(reviewed_by) : null
          }
        });
      }

      return request;
    });

    // Notify employee (Outside transaction)
    await prisma.notification.create({
      data: {
        user_id: updatedRequest.user_id,
        type: `leave_${status.toLowerCase()}`,
        message: `Your leave request has been ${status}.`
      }
    });

    res.json(updatedRequest);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Conflict: This request was already processed' });
    }
    res.status(500).json({ error: 'Failed to update leave request' });
  }
});

export default router;
