import { Router } from 'express';
import prisma from '../prisma';
import { getUserPreferences, upsertUserPreferences } from '../services/notification.service';

const router = Router();

// Get notifications for a specific user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const notifications = await prisma.notification.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50
    });
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// Get unread count for a user
router.get('/user/:userId/unread-count', async (req, res) => {
  const { userId } = req.params;
  try {
    const count = await prisma.notification.count({
      where: { user_id: userId, is_read: false }
    });
    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// Get notification preferences for a user
router.get('/preferences/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const prefs = await getUserPreferences(userId);
    res.json(prefs);
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: "Failed to fetch notification preferences" });
  }
});

// Upsert notification preferences for a user
router.put('/preferences', async (req, res) => {
  const { user_id, preferences } = req.body;
  if (!user_id || !Array.isArray(preferences)) {
    return res.status(400).json({ error: 'user_id and preferences array required' });
  }
  try {
    const result = await upsertUserPreferences(user_id, preferences);
    res.json(result);
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: "Failed to save notification preferences" });
  }
});

// Mark a single notification as read
router.put('/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    const notification = await prisma.notification.update({
      where: { id: parseInt(id) },
      data: { is_read: true }
    });
    res.json(notification);
  } catch (error) {
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// Mark all notifications as read for a user
router.put('/user/:userId/read-all', async (req, res) => {
  const { userId } = req.params;
  try {
    await prisma.notification.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true }
    });
    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ error: "Failed to mark all notifications as read" });
  }
});

export default router;
