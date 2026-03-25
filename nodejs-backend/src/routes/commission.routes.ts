import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all commissions
router.get('/', async (req, res) => {
  try {
    const commissions = await prisma.commission.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });
    res.json(commissions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch commissions" });
  }
});

// Get commissions for a specific user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const commissions = await prisma.commission.findMany({
      where: { user_id: userId },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });
    res.json(commissions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user commissions" });
  }
});

// Create a commission record
router.post('/', async (req, res) => {
  const { user_id, commission, date } = req.body;
  try {
    const commissionRecord = await prisma.commission.create({
      data: {
        user_id,
        commission: parseFloat(commission),
        date: new Date(date)
      },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Commission record created", commission: commissionRecord });
  } catch (error) {
    res.status(500).json({ error: "Failed to create commission record" });
  }
});

// Update a commission record
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { commission, date } = req.body;
  try {
    const commissionRecord = await prisma.commission.update({
      where: { id: parseInt(id) },
      data: {
        commission: commission ? parseFloat(commission) : undefined,
        date: date ? new Date(date) : undefined
      },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Commission record updated", commission: commissionRecord });
  } catch (error) {
    res.status(500).json({ error: "Failed to update commission record" });
  }
});

// Delete a commission record
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.commission.delete({
      where: { id: parseInt(id) }
    });
    res.json({ message: "Commission record deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete commission record" });
  }
});

export default router;