import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Basic login logic compatible with the old Python API
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await prisma.user.findFirst({
      where: { 
        username: username,
        password_hash: password 
      }
    });
    
    if (!user) {
      return res.status(401).json({ detail: "Invalid username or password" });
    }

    res.json({
      user_id: user.id,
      name: user.name,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({ msg: "Internal server error", error });
  }
});

// Update password
router.post('/update-password', async (req, res) => {
  const { user_id, new_password } = req.body;
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { password_hash: new_password }
    });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// Change password (secure, requires current password verification)
router.post('/change-password', async (req, res) => {
  const { user_id, current_password, new_password } = req.body;
  try {
    const user = await prisma.user.findFirst({
      where: { id: String(user_id), password_hash: current_password }
    });
    
    if (!user) {
      return res.status(401).json({ detail: "Incorrect current password" });
    }

    await prisma.user.update({
      where: { id: String(user_id) },
      data: { password_hash: new_password }
    });
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ detail: "Failed to update password" });
  }
});

export default router;
