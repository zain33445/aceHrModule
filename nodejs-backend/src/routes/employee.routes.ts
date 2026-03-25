import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Get all employees
router.get('/', async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// Create an employee
router.post('/', async (req, res) => {
  const { user_id, name, monthly_salary, leave_bank, password } = req.body;
  try {
    const user = await prisma.user.create({
      data: {
        id: String(user_id),
        name,
        monthly_salary: monthly_salary || 0.0,
        leave_bank: leave_bank || 5,
        password_hash: password || '1234',
        role: 'employee'
      }
    });

    // Create leave bank record with the same number of leaves as allowed
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await prisma.leaveBank.create({
      data: {
        user_id: String(user_id),
        leaves_remaining: leave_bank || 5,
        last_reset_month: currentMonth
      }
    });

    res.json({ message: "Employee created manually", user });
  } catch (error) {
    res.status(500).json({ error: "Failed to create employee" });
  }
});

// Delete an employee
router.delete('/:id', async (req, res) => {
  try {
    await prisma.user.delete({
      where: { id: String(req.params.id) }
    });
    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

// Update employee salary
router.post('/update-employee', async (req, res) => {
  const { user_id, monthly_salary } = req.body;
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { monthly_salary: parseFloat(monthly_salary) }
    });
    res.json({ message: "Employee salary updated" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update employee salary" });
  }
});

// Update employee leaves
router.post('/update-leaves', async (req, res) => {
  const { user_id, leave_bank } = req.body;
  try {
    const newTotal = parseInt(leave_bank);
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { leave_bank: newTotal }
    });

    // Upsert leave bank to match new total directly
    await prisma.leaveBank.upsert({
      where: { user_id: String(user_id) },
      create: {
        user_id: String(user_id),
        leaves_remaining: newTotal,
        last_reset_month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
      },
      update: {
        leaves_remaining: newTotal
      }
    });

    res.json({ message: "Leave bank updated" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update leave bank" });
  }
});

export default router;
