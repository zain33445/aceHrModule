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

// Export Payroll Report (rich: per-employee with attendance stats)
router.get('/salary', async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    // Determine month window
    let monthStart: Date;
    let monthEnd: Date;

    if (start_date) {
      monthStart = new Date(start_date as string);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
    } else {
      const now = new Date();
      monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    if (end_date) {
      monthEnd = new Date(end_date as string);
      monthEnd.setHours(23, 59, 59, 999);
    } else {
      monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const monthLabel = monthStart.toLocaleString('default', { month: 'long', year: 'numeric' });

    // Get all employees
    const employees = await prisma.user.findMany({
      where: { role: { not: 'admin' } },
      select: { id: true, name: true, monthly_salary: true }
    });

    // For each employee, aggregate attendance records for the month
    const rows = await Promise.all(employees.map(async (emp) => {
      const records = await prisma.attendanceRecord.findMany({
        where: {
          user_id: emp.id,
          date: { gte: monthStart, lte: monthEnd },
          status: { not: 'weekend' }
        }
      });

      const absents  = records.filter(r => r.status === 'absent').length;
      const leaves   = records.filter(r => r.status === 'leave').length;
      const late     = records.filter(r => r.status === 'late' || r.is_late).length;
      const halfday  = records.filter(r => r.status === 'halfday' || r.is_halfday).length;

      // Sum deductions for the month
      const deductionSum = await prisma.deduction.aggregate({
        where: {
          user_id: emp.id,
          date: { gte: monthStart, lte: monthEnd }
        },
        _sum: { amount: true }
      });

      const totalDeductions = deductionSum._sum.amount || 0;
      const netSalary = Math.max(0, emp.monthly_salary - totalDeductions);

      return {
        name: emp.name,
        month: monthLabel,
        absents,
        leaves,
        late,
        halfday,
        baseSalary: emp.monthly_salary,
        deductions: totalDeductions,
        netSalary
      };
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Payroll Report');

    worksheet.columns = [
      { header: 'Employee Name',   key: 'name',        width: 25 },
      { header: 'Month',           key: 'month',        width: 18 },
      { header: 'Absents',         key: 'absents',      width: 12 },
      { header: 'Leaves',          key: 'leaves',       width: 12 },
      { header: 'Late',            key: 'late',         width: 10 },
      { header: 'Half Day',        key: 'halfday',      width: 12 },
      { header: 'Base Salary',     key: 'baseSalary',   width: 18 },
      { header: 'Total Deductions',key: 'deductions',   width: 20 },
      { header: 'Net Salary',      key: 'netSalary',    width: 18 },
    ];

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    rows.forEach(row => {
      const r = worksheet.addRow(row);
      // Highlight net salary column
      r.getCell('netSalary').font = { bold: true };
      if (row.absents > 0) r.getCell('absents').font = { color: { argb: 'FFDC2626' } };
    });

    // Auto-filter
    worksheet.autoFilter = 'A1:I1';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=payroll_${monthStart.getFullYear()}_${String(monthStart.getMonth() + 1).padStart(2, '0')}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Failed to export payroll:', error);
    res.status(500).json({ error: 'Failed to export payroll data' });
  }
});

export default router;
