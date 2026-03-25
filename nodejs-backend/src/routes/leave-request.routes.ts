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
        reviewer: { select: { id: true, name: true } }
      },
      orderBy: { created_at: 'desc' }
    });
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

// Create leave request
router.post('/', async (req, res) => {
  const { user_id, start_date, end_date, reason } = req.body;
  
  if (!user_id || !start_date || !end_date || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = await prisma.leaveRequest.create({
      data: {
        user_id: String(user_id),
        start_date: new Date(start_date),
        end_date: new Date(end_date),
        reason
      },
      include: { user: { select: { id: true, name: true } } }
    });

    // Notify admins
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
  } catch (error) {
    console.error('Failed to create leave request:', error);
    res.status(500).json({ error: 'Failed to create leave request' });
  }
});

// Approve/Reject leave request
router.put('/:id/status', async (req, res) => {
  const { status, reviewed_by } = req.body; // status: 'approved' | 'rejected'
  
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const request = await prisma.leaveRequest.update({
      where: { id: parseInt(req.params.id) },
      data: { status, reviewed_by: reviewed_by ? String(reviewed_by) : undefined },
      include: { user: { select: { id: true, name: true } } }
    });

    // Notify employee
    await prisma.notification.create({
      data: {
        user_id: request.user_id,
        type: `leave_${status}`,
        message: `Your leave request has been ${status}.`
      }
    });

    res.json(request);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update leave request' });
  }
});

export default router;
