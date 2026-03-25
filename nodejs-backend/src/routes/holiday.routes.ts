import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all holidays
router.get('/', async (req, res) => {
  try {
    const holidays = await prisma.holiday.findMany({
      orderBy: { date: 'asc' }
    });
    res.json(holidays);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch holidays' });
  }
});

// Create holiday
router.post('/', async (req, res) => {
  const { name, date } = req.body;
  try {
    const holiday = await prisma.holiday.create({
      data: { name, date: new Date(date) }
    });
    res.json(holiday);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create holiday' });
  }
});

// Delete holiday
router.delete('/:id', async (req, res) => {
  try {
    await prisma.holiday.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Holiday deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete holiday' });
  }
});

export default router;
