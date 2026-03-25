import { Router } from 'express';
import { AbsenceService } from '../services/absence.service';

const router = Router();

// Get all attendance records
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, status, userId, page, limit } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const p = page ? parseInt(page as string) : 1;
    const l = limit ? parseInt(limit as string) : 20;

    const result = await AbsenceService.getAllAttendances(start, end, status as string, userId as string, p, l);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch attendance records" });
  }
});

// Get attendance records for a specific user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate, status, page, limit } = req.query;

  try {
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const p = page ? parseInt(page as string) : 1;
    const l = limit ? parseInt(limit as string) : 20;

    const result = await AbsenceService.getUserAttendances(userId, start, end, status as string, p, l);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user attendance records" });
  }
});

// Get attendance statistics for a user
router.get('/user/:userId/stats', async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate } = req.query;

  try {
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const stats = await AbsenceService.getUserAttendanceStats(userId, start, end);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch attendance statistics" });
  }
});

// Manually sync attendance for today (Live Manual Sync)
router.post('/sync-today', async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const result = await AbsenceService.processDailyAbsences(tomorrow);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to sync today's attendance" });
  }
});

// Process attendance for yesterday (daily cron job endpoint)
router.post('/process-daily', async (req, res) => {
  try {
    const result = await AbsenceService.processDailyAbsences();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to process daily attendance" });
  }
});

// Manually process attendance for a specific date (admin function)
router.post('/process/:date', async (req, res) => {
  const date = (req.params as any).date;

  try {
    const checkDate = date ? new Date(date) : undefined;
    const result = await AbsenceService.processDailyAbsences(checkDate);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to process attendance" });
  }
});

// LEAVE BANK MANAGEMENT ROUTES

// Get all leave bank records
router.get('/leave-bank', async (req, res) => {
  try {
    const leaveBanks = await AbsenceService.getAllLeaveBanks();
    res.json(leaveBanks);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch leave bank records" });
  }
});

// Get leave bank record for a specific user
router.get('/leave-bank/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const leaveBank = await AbsenceService.getUserLeaveBank(userId);
    res.json(leaveBank);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user leave bank" });
  }
});

// Update leave bank for a user (admin function)
router.put('/leave-bank/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { leaves_remaining } = req.body;

  try {
    const leaveBank = await AbsenceService.updateLeaveBank(userId, parseInt(leaves_remaining));
    res.json({ message: "Leave bank updated", leaveBank });
  } catch (error) {
    res.status(500).json({ error: "Failed to update leave bank" });
  }
});

// Reset leave bank to user's total allowed leaves
router.post('/leave-bank/user/:userId/reset', async (req, res) => {
  const { userId } = req.params;

  try {
    const leaveBank = await AbsenceService.resetLeaveBank(userId);
    res.json({ message: "Leave bank reset to total allowed leaves", leaveBank });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset leave bank" });
  }
});

export default router;