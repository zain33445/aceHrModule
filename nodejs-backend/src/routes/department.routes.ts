import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all departments
router.get('/', async (req, res) => {
  try {
    const departments = await prisma.department.findMany({
      include: {
        shift: true,
        lead: { select: { id: true, name: true } },
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
  const { name, shift_id, lead_id } = req.body;
  try {
    const department = await prisma.department.create({
      data: { 
        name, 
        shift_id: shift_id ? parseInt(shift_id) : undefined,
        lead_id: lead_id || undefined
      }
    });
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create department' });
  }
});

// Update department
router.put('/:id', async (req, res) => {
  const { name, shift_id, lead_id } = req.body;
  try {
    const department = await prisma.department.update({
      where: { id: parseInt(req.params.id) },
      data: { 
        name, 
        shift_id: shift_id ? parseInt(shift_id) : undefined,
        lead_id: lead_id !== undefined ? lead_id : undefined
      }
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

// Assign an employee to this department
router.put('/:id/assign-employee', async (req, res) => {
  const deptId = parseInt(req.params.id);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { department_id: deptId }
    });
    // Return fresh department data
    const department = await prisma.department.findUnique({
      where: { id: deptId },
      include: {
        shift: true,
        lead: { select: { id: true, name: true } },
        users: { select: { id: true, name: true, role: true } }
      }
    });
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: 'Failed to assign employee' });
  }
});

// Remove an employee from this department (set department_id to null)
router.put('/:id/remove-employee', async (req, res) => {
  const deptId = parseInt(req.params.id);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { department_id: null }
    });
    const department = await prisma.department.findUnique({
      where: { id: deptId },
      include: {
        shift: true,
        lead: { select: { id: true, name: true } },
        users: { select: { id: true, name: true, role: true } }
      }
    });
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove employee' });
  }
});

export default router;
