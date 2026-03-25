import { Router } from 'express';
import prisma from '../prisma';

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
