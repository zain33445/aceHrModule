import { Router } from 'express';
import prisma from '../prisma';
import { HolidayService } from '../services/holiday.service';

const router = Router();

// Get all holidays
router.get('/', async (req, res) => {
  try {
    const holidays = await prisma.holiday.findMany({
      orderBy: { date: 'asc' },
      include: {
        department: { select: { name: true } }
      }
    });
    res.json(holidays);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch holidays' });
  }
});

// Create holiday (status defaults to "pending" via schema)
router.post('/', async (req, res) => {
  const { name, date, department_id } = req.body;
  try {
    const holiday = await prisma.holiday.create({
      data: { 
        name, 
        date: new Date(date),
        department_id: department_id ? parseInt(department_id) : null
      }
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

// Bulk create holidays for a date range
router.post('/bulk', async (req, res) => {
  const { name, startDate, endDate, department_id } = req.body;

  if (!name || !startDate || !endDate) {
    return res.status(400).json({ error: 'name, startDate and endDate are required' });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  // Build list of all dates in the range (UTC noon to match canonical format)
  const dates: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const dateKey = cursor.toISOString().split('T')[0];
    dates.push(new Date(`${dateKey}T12:00:00.000Z`));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  try {
    // Use createMany with skipDuplicates so existing dates are not overwritten
    const result = await prisma.holiday.createMany({
      data: dates.map(date => ({ 
        name, 
        date,
        department_id: department_id ? parseInt(department_id) : null
      })),
      skipDuplicates: true
    });

    res.json({
      message: `Created ${result.count} holiday(s) out of ${dates.length} days`,
      created: result.count,
      total: dates.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create bulk holidays' });
  }
});

// Manually trigger holiday processing (admin use)
router.post('/process', async (req, res) => {
  try {
    const result = await HolidayService.processHolidays();
    res.json({
      message: 'Holiday processing complete',
      ...result
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process holidays' });
  }
});

export default router;
