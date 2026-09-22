import { Router } from 'express';
import { OvertimeService } from '../services/overtime.service';
import prisma from '../prisma';
import { createAndDeliver, NOTIFICATION_TYPES } from '../services/notification.service';

const router = Router();

// GET /api/overtime/eligible-dates?month=2026-06&userId=xxx
router.get('/eligible-dates', async (req, res) => {
  try {
    const { month, userId } = req.query;
    if (!month || !userId) {
      return res.status(400).json({ error: 'month and userId are required' });
    }
    const dates = await OvertimeService.getEligibleDates(month as string, userId as string);
    res.json(dates);
  } catch (error) {
    console.error('Failed to get eligible dates:', error);
    res.status(500).json({ error: 'Failed to get eligible dates' });
  }
});

// POST /api/overtime — Employee creates a request
router.post('/', async (req, res) => {
  try {
    const { user_id, date, hours_worked, reason } = req.body;
    if (!user_id || !date || !hours_worked) {
      return res.status(400).json({ error: 'user_id, date, and hours_worked are required' });
    }
    const request = await OvertimeService.createRequest(user_id, date, hours_worked, reason);

    // Notify lead + admins about new overtime request
    const employee = await prisma.user.findUnique({
      where: { id: user_id },
      select: { department_id: true, name: true }
    });
    if (employee?.department_id) {
      const dept = await prisma.department.findUnique({
        where: { id: employee.department_id },
        select: { lead_id: true }
      });
      const adminIds = (await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } })).map((a) => a.id);
      const notifyIds = new Set<string>(adminIds);
      if (dept?.lead_id) notifyIds.add(dept.lead_id);
      for (const id of notifyIds) {
        await createAndDeliver({
          userId: id,
          type: NOTIFICATION_TYPES.NEW_OVERTIME_REQUEST,
          title: 'New Overtime Request',
          message: `${employee.name} submitted an overtime request for ${new Date(date).toLocaleDateString()}.`,
          link: '/overtime',
        });
      }
    }

    res.status(201).json({ message: 'Overtime request created', request });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create overtime request';
    res.status(400).json({ error: message });
  }
});

// GET /api/overtime/my?userId=xxx&month=2026-06
router.get('/my', async (req, res) => {
  try {
    const { userId, month } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const requests = await OvertimeService.getUserRequests(userId as string, month as string | undefined);
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch overtime requests' });
  }
});

// PUT /api/overtime/:id/cancel — Employee cancels pending request
router.put('/:id/cancel', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const result = await OvertimeService.cancelRequest(parseInt(req.params.id), userId);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel request';
    res.status(400).json({ error: message });
  }
});

// PUT /api/overtime/:id/approve — Admin approves
router.put('/:id/approve', async (req, res) => {
  try {
    const { approved_by, multiplier } = req.body;
    if (!approved_by) return res.status(400).json({ error: 'approved_by is required' });
    const result = await OvertimeService.approveRequest(parseInt(req.params.id), approved_by, multiplier);

    await createAndDeliver({
      userId: result.user.id,
      type: NOTIFICATION_TYPES.OVERTIME_ADMIN_DECISION,
      title: 'Overtime Approved',
      message: `Your overtime request for ${new Date(result.date).toLocaleDateString()} has been approved by Admin.`,
      link: '/overtime',
    });

    res.json({ message: 'Overtime request approved', request: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to approve request';
    res.status(400).json({ error: message });
  }
});

// PUT /api/overtime/:id/reject — Admin rejects
router.put('/:id/reject', async (req, res) => {
  try {
    const { approved_by, rejection_reason } = req.body;
    if (!approved_by) return res.status(400).json({ error: 'approved_by is required' });
    const result = await OvertimeService.rejectRequest(parseInt(req.params.id), approved_by, rejection_reason);

    await createAndDeliver({
      userId: result.user.id,
      type: NOTIFICATION_TYPES.OVERTIME_ADMIN_DECISION,
      title: 'Overtime Rejected',
      message: `Your overtime request for ${new Date(result.date).toLocaleDateString()} has been rejected by Admin.`,
      link: '/overtime',
    });

    res.json({ message: 'Overtime request rejected', request: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reject request';
    res.status(400).json({ error: message });
  }
});

// GET /api/overtime — Admin: all requests (filterable)
router.get('/', async (req, res) => {
  try {
    const { month, status, leadStatus, userId, page, limit } = req.query;
    const result = await OvertimeService.getAllRequests({
      month: month as string | undefined,
      status: status as string | undefined,
      leadStatus: leadStatus as string | undefined,
      userId: userId as string | undefined,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 20
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch overtime requests' });
  }
});

// GET /api/overtime/summary?month=2026-06
router.get('/summary', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month is required' });
    const summary = await OvertimeService.getMonthlySummary(month as string);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch overtime summary' });
  }
});

// GET /api/overtime/team?leadId=xxx&month=2026-06&status=pending
router.get('/team', async (req, res) => {
  try {
    const { leadId, month, status, page, limit } = req.query;
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const result = await OvertimeService.getTeamRequests(
      leadId as string,
      month as string | undefined,
      status as string | undefined,
      page ? parseInt(page as string) : 1,
      limit ? parseInt(limit as string) : 20
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch team overtime requests' });
  }
});

// PUT /api/overtime/:id/lead-approve
router.put('/:id/lead-approve', async (req, res) => {
  try {
    const { lead_id, multiplier, remarks } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
    const result = await OvertimeService.leadApprove(parseInt(req.params.id), lead_id, multiplier, remarks);

    await createAndDeliver({
      userId: result.user.id,
      type: NOTIFICATION_TYPES.OVERTIME_LEAD_DECISION,
      title: 'Overtime Approved by Lead',
      message: `Your overtime request for ${new Date(result.date).toLocaleDateString()} has been approved by your team lead.`,
      link: '/overtime',
    });

    res.json({ message: 'Overtime request approved by lead', request: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to approve request';
    res.status(400).json({ error: message });
  }
});

// PUT /api/overtime/:id/lead-reject
router.put('/:id/lead-reject', async (req, res) => {
  try {
    const { lead_id, remarks } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
    const result = await OvertimeService.leadReject(parseInt(req.params.id), lead_id, remarks);

    await createAndDeliver({
      userId: result.user.id,
      type: NOTIFICATION_TYPES.OVERTIME_LEAD_DECISION,
      title: 'Overtime Rejected by Lead',
      message: `Your overtime request for ${new Date(result.date).toLocaleDateString()} has been rejected by your team lead.`,
      link: '/overtime',
    });

    res.json({ message: 'Overtime request rejected by lead', request: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reject request';
    res.status(400).json({ error: message });
  }
});

export default router;
