import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// GET /api/tab-access/hr-employees — HR employees with their granted tabs
router.get('/hr-employees', async (req, res) => {
  try {
    const hrDept = await prisma.department.findFirst({
      where: { name: { equals: 'HR', mode: 'insensitive' } },
      select: { id: true }
    });

    if (!hrDept) {
      return res.json({ employees: [], tabs: [] });
    }

    const [employees, allTabs, tabAccessEntries] = await Promise.all([
      prisma.user.findMany({
        where: { department_id: hrDept.id, role: { not: 'admin' } },
        select: { id: true, name: true, username: true, email: true, role: true }
      }),
      prisma.userTabAccess.groupBy({
        by: ['tab_key'],
        _count: { tab_key: true }
      }),
      prisma.userTabAccess.findMany({
        where: { user: { department_id: hrDept.id } },
        select: { user_id: true, tab_key: true }
      })
    ]);

    // Build a map: user_id -> Set of tab_keys
    const accessMap: Record<string, Set<string>> = {};
    for (const entry of tabAccessEntries) {
      if (!accessMap[entry.user_id]) accessMap[entry.user_id] = new Set();
      accessMap[entry.user_id].add(entry.tab_key);
    }

    const allTabKeys = [
      'overview', 'attendance', 'payroll', 'leaves', 'leave-allocation',
      'disputes', 'departments', 'screenshots', 'employees', 'recording',
      'holidays', 'overtime', 'export', 'audit', 'settings'
    ];

    const employeesWithTabs = employees.map(emp => {
      const tabs = accessMap[emp.id] ? new Set(accessMap[emp.id]) : new Set();
      // Auto-include export when attendance or payroll is granted
      if (tabs.has('attendance') || tabs.has('payroll')) {
        tabs.add('export');
      }
      return { ...emp, granted_tabs: Array.from(tabs) };
    });

    res.json({ employees: employeesWithTabs, tabs: allTabKeys });
  } catch (error) {
    console.error('Error fetching HR employees:', error);
    res.status(500).json({ error: 'Failed to fetch HR employees' });
  }
});

// POST /api/tab-access/toggle — Grant or revoke a tab for a user
router.post('/toggle', async (req, res) => {
  const { user_id, tab_key, granted } = req.body;

  if (!user_id || !tab_key) {
    return res.status(400).json({ error: 'user_id and tab_key are required' });
  }

  const autoGrantTabs: string[] = [];
  if (granted && (tab_key === 'attendance' || tab_key === 'payroll')) {
    autoGrantTabs.push('export');
  }

  try {
    const operations = [];

    if (granted) {
      operations.push(
        prisma.userTabAccess.upsert({
          where: { user_id_tab_key: { user_id, tab_key } },
          create: { user_id, tab_key },
          update: {}
        })
      );
      for (const autoKey of autoGrantTabs) {
        operations.push(
          prisma.userTabAccess.upsert({
            where: { user_id_tab_key: { user_id, tab_key: autoKey } },
            create: { user_id, tab_key: autoKey },
            update: {}
          })
        );
      }
    } else {
      operations.push(
        prisma.userTabAccess.deleteMany({
          where: { user_id, tab_key }
        })
      );
    }

    await prisma.$transaction(operations);

    res.json({ success: true, auto_granted: autoGrantTabs });
  } catch (error) {
    console.error('Error toggling tab access:', error);
    res.status(500).json({ error: 'Failed to toggle tab access' });
  }
});

// GET /api/tab-access/my-tabs — Current user's granted tabs
router.get('/my-tabs', async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const entries = await prisma.userTabAccess.findMany({
      where: { user_id: String(user_id) },
      select: { tab_key: true }
    });

    const grantedSet = new Set(entries.map(e => e.tab_key));
    // Auto-include export when attendance or payroll is granted
    if (grantedSet.has('attendance') || grantedSet.has('payroll')) {
      grantedSet.add('export');
    }

    res.json({ tabs: Array.from(grantedSet) });
  } catch (error) {
    console.error('Error fetching user tabs:', error);
    res.status(500).json({ error: 'Failed to fetch user tabs' });
  }
});

export default router;
