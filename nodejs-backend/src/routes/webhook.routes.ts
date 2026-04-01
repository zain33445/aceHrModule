import { Router } from 'express';
import prisma from '../prisma';
import { AbsenceService } from '../services/absence.service';

const router = Router();

// /api/webhooks/attendance
// Python microservice posts data here
router.post('/attendance', async (req, res) => {
  const logs = req.body;
  
  if (!Array.isArray(logs)) {
    return res.status(400).json({ error: "Logs must be an array" });
  }

  let insertedCount = 0;

  for (const log of logs) {
    try {
      const userId = String(log.user_id);
      
      // Check if user exists in our system
      const userExists = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!userExists) {
        console.warn(`[Webhook] Skipping attendance log for unknown user ID: ${userId}`);
        continue;
      }

      await prisma.attendanceLog.upsert({
        where: {
          user_id_timestamp_status: {
            user_id: userId,
            timestamp: new Date(log.timestamp),
            status: Number(log.status)
          }
        },
        update: {},
        create: {
          user_id: userId,
          timestamp: new Date(log.timestamp),
          status: Number(log.status)
        }
      });
      insertedCount++;
    } catch (error) {
      console.log(error)
    }
  }

  const syncedUserIds = [...new Set(logs.map((log: any) => String(log.user_id)))];
  
  if (syncedUserIds.length > 0) {
    // Fire off the live sync asynchronously in the background so it doesn't block the webhook response
    AbsenceService.processLiveSync(syncedUserIds, new Date()).catch(console.error);
  }

  res.json({ message: "Webhook received", inserted: insertedCount, liveSyncedIds: syncedUserIds.length });
});

router.post('/users', async (req, res) => {
  const users = req.body;
  
  if (!Array.isArray(users)) {
    return res.status(400).json({ error: "Users must be an array" });
  }

  // Only proceed if the users table is currently empty
  const currentTotalUsers = await prisma.user.count();
  if (currentTotalUsers > 0) {
    return res.json({ 
      message: "Users sync skipped: user table is not empty", 
      inserted: 0 
    });
  }

  let insertedCount = 0;

  for (const user of users) {
    try {
      const newUser = await prisma.user.create({
        data: {
          id: String(user.user_id),
          name: user.name,
          role: 'employee',
          password_hash: '1234'
        }
      });

      // Create leave bank record for new user
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await prisma.leaveBank.create({
        data: {
          user_id: String(user.user_id),
          leaves_remaining: newUser.leave_bank,
          last_reset_month: currentMonth
        }
      });

      insertedCount++;
    } catch (error) {
      console.log(error)
    }
  }

  res.json({ message: "Webhook received", inserted: insertedCount });
});

export default router;
