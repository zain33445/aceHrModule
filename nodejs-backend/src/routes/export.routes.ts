import { Router } from 'express';
import prisma from '../prisma';
import ExcelJS from 'exceljs';

const router = Router();

// Export Attendance
router.get('/attendance', async (req, res) => {
  const { start_date, end_date } = req.query;
  
  try {
    const where: any = {};
    if (start_date && end_date) {
      where.timestamp = {
        gte: new Date(start_date as string),
        lte: new Date(end_date as string)
      };
    }

    const logs = await prisma.attendanceLog.findMany({
      where,
      include: { user: { select: { name: true, role: true } } },
      orderBy: { timestamp: 'desc' }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance');
    
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Time', key: 'time', width: 15 },
      { header: 'Employee', key: 'name', width: 25 },
      { header: 'Role', key: 'role', width: 15 },
      { header: 'Status Code', key: 'status', width: 15 }
    ];

    logs.forEach(log => {
      worksheet.addRow({
        date: log.timestamp.toLocaleDateString(),
        time: log.timestamp.toLocaleTimeString(),
        name: log.user.name,
        role: log.user.role,
        status: log.status
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.xlsx');
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Failed to export attendance:', error);
    res.status(500).json({ error: 'Failed to export attendance data' });
  }
});

// Export Salary
router.get('/salary', async (req, res) => {
  const { start_date, end_date } = req.query;
  
  try {
    const where: any = {};
    if (start_date && end_date) {
      where.date = {
        gte: new Date(start_date as string),
        lte: new Date(end_date as string)
      };
    }

    const salaries = await prisma.salary.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { date: 'desc' }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Salaries');
    
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Employee', key: 'name', width: 25 },
      { header: 'Payable Salary', key: 'payable', width: 20 },
      { header: 'Deduction', key: 'deduction', width: 20 },
      { header: 'Paid Salary', key: 'paid', width: 20 }
    ];

    salaries.forEach(s => {
      worksheet.addRow({
        date: s.date.toLocaleDateString(),
        name: s.user.name,
        payable: s.payable_salary,
        deduction: s.deduction,
        paid: s.paid_salary
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=salary_export.xlsx');
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ error: 'Failed to export salary data' });
  }
});

export default router;
