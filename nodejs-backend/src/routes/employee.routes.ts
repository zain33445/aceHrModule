import { Router } from 'express';
import prisma from '../prisma';
import axios from 'axios';

const router = Router();

// Get all employees
router.get('/', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        department: true
      }
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// Create an employee
router.post('/', async (req, res) => {
  const {
    role,
    name,
    password,
    username,
    department_id,
    monthly_salary,
    status,
    type,
    joining_date,
    closing_date,
    probation_duration,
  } = req.body;

  try {
    const lastUser = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
    });

    const lastID = lastUser
      ? parseInt(lastUser.id)
      : 0;

    const nextID = lastID + 1;

    const newId = String(nextID);

    const user = await prisma.user.create({
      data: {
        name,
        id: newId,
        username: username,
        role: role || 'employee',
        password_hash: password || '1234',
        monthly_salary: parseFloat(monthly_salary) || 0.0,
        department_id: department_id ? parseInt(department_id) : null,
        status: status || 'active',
        type: type || 'probation',
        joining_date: joining_date ? new Date(joining_date) : null,
        closing_date: closing_date ? new Date(closing_date) : null,
        probation_duration: probation_duration ? parseInt(probation_duration) : null,
      }
    });

    // Provision the UserLeaveLock for the new ledger architecture
    await prisma.userLeaveLock.create({
      data: { user_id: newId }
    });

    let deviceSyncStatus = 'completed';

    // Try to create the user on the fingerprint machine synchronously
    try {
      await axios.post('http://localhost:8000/create-user', {
        employee_id: newId,
        name: name,
      });
    } catch (deviceError: any) {
      console.warn(`[Device Sync] Failed to create user ${newId} on device (Offline). Queuing task...`);
      deviceSyncStatus = 'pending';
      
      // Queue it in the Outbox
      await prisma.outboxEvent.create({
        data: {
          type: 'DEVICE_CREATE_USER',
          payload: { employee_id: newId, name: name },
          status: 'PENDING'
        }
      });
    }

    res.status(201).json({ message: "Employee created", user, device_sync: deviceSyncStatus });
  } catch (error: any) {
    console.error("Failed to create employee:", error.message);
    res.status(500).json({ error: "Failed to create employee", details: error.message });
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

// Update employee leaves (Legacy)
router.post('/update-leaves', async (req, res) => {
  const { user_id, leave_bank } = req.body;
  try {
    const newTotal = parseInt(leave_bank);
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { leave_bank: newTotal }
    });

    res.json({ message: "Leave bank updated (Legacy)" });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update employee leaves", details: error.message });
  }
});

// Update employee username
router.post('/update-username', async (req, res) => {
  const { user_id, username } = req.body;
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { username: username }
    });
    res.json({ message: "Employee username updated" });
  } catch (error) {
    if ((error as any).code === 'P2002') {
      return res.status(400).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Failed to update employee username" });
  }
});

// Update employee status/type/dates
router.post('/update-status', async (req, res) => {
  const { user_id, status, type, joining_date, closing_date, probation_duration } = req.body;
  try {
    const data: any = {};
    if (status !== undefined) data.status = status;
    if (type !== undefined) data.type = type;
    if (joining_date !== undefined) data.joining_date = joining_date ? new Date(joining_date) : null;
    if (closing_date !== undefined) data.closing_date = closing_date ? new Date(closing_date) : null;
    if (probation_duration !== undefined) data.probation_duration = probation_duration ? parseInt(probation_duration) : null;

    await prisma.user.update({
      where: { id: String(user_id) },
      data
    });
    res.json({ message: "Employee status updated" });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update employee status", details: error.message });
  }
});

export default router;
