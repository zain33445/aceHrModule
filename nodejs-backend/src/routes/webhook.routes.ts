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
  const usersToSync = new Set<string>();
  const datesToSync = new Set<string>();

  for (const log of logs) {
    try {
      const userId = String(log.user_id);
      const timestamp = new Date(log.timestamp);

      // Check if user exists
      const userExists = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!userExists) continue;

      const startOfDay = new Date(timestamp);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(timestamp);
      endOfDay.setHours(23, 59, 59, 999);

      // Check for duplicate log
      const duplicate = await prisma.attendanceLog.findFirst({
        where: {
          user_id: userId,
          status: Number(log.status),
          timestamp: { gte: startOfDay, lte: endOfDay }
        }
      });

      if (duplicate) {
        continue;
      }

      // Insert new log
      await prisma.attendanceLog.upsert({
        where: {
          user_id_timestamp_status: {
            user_id: userId,
            timestamp,
            status: Number(log.status)
          }
        },
        update: {},
        create: {
          user_id: userId,
          timestamp,
          status: Number(log.status)
        }
      });

      // Track that this user and date need a re-sync
      usersToSync.add(userId);
      datesToSync.add(timestamp.toISOString().split('T')[0]);
      insertedCount++;
    } catch (error) {
      console.log(`[Webhook Error] ${error}`);
    }
  }

  // Only trigger re-sync if NEW logs were actually inserted
  if (usersToSync.size > 0) {
    const uniqueUserIds = Array.from(usersToSync);
    const uniqueDates = Array.from(datesToSync).map(d => new Date(d));

    console.log(`[Webhook] Triggering live sync for ${uniqueUserIds.length} users across ${uniqueDates.length} dates.`);
    AbsenceService.processLiveSync(uniqueUserIds, uniqueDates).catch(console.error);
  }

  res.json({
    message: "Webhook processed",
    inserted: insertedCount,
    syncedUsers: usersToSync.size
  });
});

router.post('/users', async (req, res) => {
  const users = req.body;

  if (!Array.isArray(users)) {
    return res.status(400).json({ error: "Users must be an array" });
  }

  let insertedCount = 0;

  for (const user of users) {
    try {
      const userId = String(user.user_id);
      
      // Check if user already exists
      const userExists = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (userExists) {
        continue; // Skip existing user
      }

      const newUser = await prisma.user.create({
        data: {
          id: userId,
          name: user.name,
          role: 'employee',
          password_hash: '1234'
        }
      });

      // Provision the UserLeaveLock for the new ledger architecture
      await prisma.userLeaveLock.upsert({
        where: { user_id: userId },
        update: {},
        create: { user_id: userId }
      });

      insertedCount++;
    } catch (error) {
      console.log(`[Users Webhook Error] Failed to insert user ${user.user_id}:`, error);
    }
  }

  res.json({ message: "Webhook received", inserted: insertedCount });
});

export default router;
