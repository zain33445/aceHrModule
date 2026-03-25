import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all departments
router.get('/', async (req, res) => {
  try {
    const departments = await prisma.department.findMany({
      include: {
        shift: true,
        users: { select: { id: true, name: true, role: true } }
      }
    });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

// Create department
router.post('/', async (req, res) => {
  const { name, shift_id } = req.body;
  try {
    const department = await prisma.department.create({
      data: { name, shift_id: shift_id ? parseInt(shift_id) : undefined }
    });
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create department' });
  }
});

// Update department
router.put('/:id', async (req, res) => {
  const { name, shift_id } = req.body;
  try {
    const department = await prisma.department.update({
      where: { id: parseInt(req.params.id) },
      data: { name, shift_id: shift_id ? parseInt(shift_id) : undefined }
    });
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update department' });
  }
});

// Delete department
router.delete('/:id', async (req, res) => {
  try {
    await prisma.department.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Department deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete department' });
  }
});

export default router;
