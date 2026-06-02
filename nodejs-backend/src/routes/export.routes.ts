import { Router } from 'express';
import prisma from '../prisma';
import ExcelJS from 'exceljs';

const router = Router();

// Export Attendance
router.get('/attendance', async (req, res) => {
  const { start_date, end_date, user_id } = req.query;

  try {
    const where: any = {};

    if (start_date || end_date) {
      where.date = {};
      if (start_date) where.date.gte = new Date(start_date as string);
      if (end_date) where.date.lte = new Date(end_date as string);
    }

    if (user_id && user_id !== 'all') {
      where.user_id = user_id as string;
    }

    // Exclude weekend records from the export
    where.status = { not: 'weekend' };

    const records = await prisma.attendanceRecord.findMany({
      where,
      include: { user: { select: { name: true, role: true } } },
      orderBy: { date: 'desc' }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance');

    worksheet.columns = [
      { header: 'Employee', key: 'name', width: 25 },
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Check In', key: 'check_in', width: 15 },
      { header: 'Check Out', key: 'check_out', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Late', key: 'is_late', width: 10 },
      { header: 'Half Day', key: 'is_halfday', width: 12 },
    ];

    // Style header
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    worksheet.autoFilter = 'A1:G1';

    records.forEach(r => {
      const row = worksheet.addRow({
        name: r.user.name,
        date: new Date(r.date).toLocaleDateString(),
        check_in: r.check_in_time || '-',
        check_out: r.check_out_time || '-',
        status: r.status,
        is_late: r.is_late ? 'Yes' : 'No',
        is_halfday: r.is_halfday ? 'Yes' : 'No',
      });
      if (r.status === 'absent') row.getCell('status').font = { color: { argb: 'FFDC2626' } };
      if (r.is_late) row.getCell('is_late').font = { color: { argb: 'FFCA8A04' } };
    });

    // Dynamic filename
    const suffix = user_id && user_id !== 'all' ? `_user${user_id}` : '';
    const dateRange = start_date ? `_${(start_date as string).slice(0, 10)}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance${dateRange}${suffix}.xlsx`);

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

  console.log('start_date', start_date);
  console.log('end_date', end_date);
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

      const absents = records.filter(r => r.status === 'absent').length;
      const leaves = records.filter(r => r.status === 'leave').length;
      const late = records.filter(r => r.status === 'late' || r.is_late).length;
      const halfday = records.filter(r => r.status === 'halfday' || r.is_halfday).length;

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
      { header: 'Employee Name', key: 'name', width: 20 },
      { header: 'Month', key: 'month', width: 15 },
      { header: 'Absents', key: 'absents', width: 10 },
      { header: 'Leaves', key: 'leaves', width: 10 },
      { header: 'Late', key: 'late', width: 10 },
      { header: 'Half Day', key: 'halfday', width: 12 },
      { header: 'Base Salary', key: 'baseSalary', width: 15 },
      { header: 'Total Deductions', key: 'deductions', width: 18 },
      { header: 'Net Salary', key: 'netSalary', width: 15 },
    ];


    const headerRow = worksheet.getRow(1);

    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // rows.forEach(row => {
    //   const r = worksheet.addRow(row);
    //   // Highlight net salary column
    //   r.getCell('netSalary').font = { bold: true };
    //   if (row.absents > 0) r.getCell('absents').font = { color: { argb: 'FFDC2626' } };
    // });
    rows.forEach((row) => {
      const r = worksheet.addRow(row);

      // center everything like table
      r.alignment = { vertical: 'middle', horizontal: 'center' };

      // Net salary bold (like your sheet)
      r.getCell('netSalary').font = { bold: true };
      r.getCell('netSalary').alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell('baseSalary').alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell('deductions').alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell('name').alignment = { vertical: 'middle', horizontal: 'left' };

      // Red absents (your logic is fine)
      if (row.absents > 0) {
        r.getCell('absents').font = { color: { argb: 'FFDC2626' } };
      }

      // Optional: currency formatting (VERY important for PKR look)
      ['baseSalary', 'deductions', 'netSalary'].forEach((key) => {
        const cell = r.getCell(key);
        if (cell.value !== '-' && cell.value != null) {
          cell.numFmt = '"PKR" #,##0';
        }
      });
    });
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
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
