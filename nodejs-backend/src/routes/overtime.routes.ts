import { Router } from 'express';
import { OvertimeService } from '../services/overtime.service';

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
    res.json({ message: 'Overtime request rejected', request: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reject request';
    res.status(400).json({ error: message });
  }
});

// GET /api/overtime — Admin: all requests (filterable)
router.get('/', async (req, res) => {
  try {
    const { month, status, userId, page, limit } = req.query;
    const result = await OvertimeService.getAllRequests({
      month: month as string | undefined,
      status: status as string | undefined,
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

export default router;
