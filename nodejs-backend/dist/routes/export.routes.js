"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../prisma"));
const exceljs_1 = __importDefault(require("exceljs"));
const router = (0, express_1.Router)();
// Export Attendance Records
router.get('/attendance', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { start_date, end_date, user_id } = req.query;
    try {
        const where = {};
        // Date range filtering with 12-hour buffer logic for stability
        if (start_date && end_date) {
            const s = new Date(start_date);
            s.setHours(s.getHours() + 12);
            const e = new Date(end_date);
            e.setHours(e.getHours() + 12);
            const start = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0);
            const end = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59, 999);
            where.date = {
                gte: start,
                lte: end
            };
        }
        // User filtering
        if (user_id && user_id !== 'all') {
            where.user_id = user_id;
        }
        // Exclude weekends from report
        where.status = { not: 'weekend' };
        const records = yield prisma_1.default.attendanceRecord.findMany({
            where,
            include: { user: { select: { name: true, role: true } } },
            orderBy: { date: 'desc' }
        });
        const workbook = new exceljs_1.default.Workbook();
        const worksheet = workbook.addWorksheet('Attendance');
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Employee', key: 'name', width: 25 },
            { header: 'Check In', key: 'check_in', width: 12 },
            { header: 'Check Out', key: 'check_out', width: 12 },
            { header: 'Status', key: 'status', width: 15 },
        ];
        // Style headers
        worksheet.getRow(1).font = { bold: true };
        records.forEach(record => {
            worksheet.addRow({
                date: record.date.toISOString().split('T')[0],
                name: record.user.name,
                check_in: record.check_in_time || '-',
                check_out: record.check_out_time || '-',
                status: record.status,
            });
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=attendance_records.xlsx');
        yield workbook.xlsx.write(res);
        res.end();
    }
    catch (error) {
        console.error('Failed to export attendance records:', error);
        res.status(500).json({ error: 'Failed to export attendance records' });
    }
}));
// Export Payroll Report (rich: per-employee with attendance stats)
router.get('/salary', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { start_date, end_date } = req.query;
    try {
        // Determine month window
        let monthStart;
        let monthEnd;
        if (start_date) {
            const d = new Date(start_date);
            // Adding 12 hours buffer prevents the date from slipping into the previous month 
            // due to UTC/local timezone differences.
            d.setHours(d.getHours() + 12);
            monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
            monthStart.setHours(0, 0, 0, 0);
        }
        else {
            const now = new Date();
            monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        }
        if (end_date) {
            monthEnd = new Date(end_date);
            monthEnd.setHours(23, 59, 59, 999);
        }
        else {
            monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
        }
        const monthLabel = monthStart.toLocaleString('default', { month: 'long', year: 'numeric' });
        // Get all employees
        const employees = yield prisma_1.default.user.findMany({
            where: { role: { not: 'admin' } },
            select: { id: true, name: true, monthly_salary: true }
        });
        // For each employee, aggregate attendance records for the month
        const rows = yield Promise.all(employees.map((emp) => __awaiter(void 0, void 0, void 0, function* () {
            const records = yield prisma_1.default.attendanceRecord.findMany({
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
            const deductionSum = yield prisma_1.default.deduction.aggregate({
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
                baseSalary: `Rs. ${Math.round(emp.monthly_salary).toLocaleString()}`,
                deductions: `Rs. ${Math.round(totalDeductions).toLocaleString()}`,
                netSalary: `Rs. ${Math.round(netSalary).toLocaleString()}`
            };
        })));
        const workbook = new exceljs_1.default.Workbook();
        const worksheet = workbook.addWorksheet('Payroll Report');
        worksheet.columns = [
            { header: 'Employee Name', key: 'name', width: 25 },
            { header: 'Month', key: 'month', width: 18 },
            { header: 'Absents', key: 'absents', width: 12 },
            { header: 'Leaves', key: 'leaves', width: 12 },
            { header: 'Late', key: 'late', width: 10 },
            { header: 'Half Day', key: 'halfday', width: 12 },
            { header: 'Base Salary', key: 'baseSalary', width: 18, style: { alignment: { horizontal: 'right' } } },
            { header: 'Total Deductions', key: 'deductions', width: 20, style: { alignment: { horizontal: 'right' } } },
            { header: 'Net Salary', key: 'netSalary', width: 18, style: { alignment: { horizontal: 'right' } } },
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
            if (row.absents > 0)
                r.getCell('absents').font = { color: { argb: 'FFDC2626' } };
        });
        // Auto-filter
        worksheet.autoFilter = 'A1:I1';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=payroll_${monthStart.getFullYear()}_${String(monthStart.getMonth() + 1).padStart(2, '0')}.xlsx`);
        yield workbook.xlsx.write(res);
        res.end();
    }
    catch (error) {
        console.error('Failed to export payroll:', error);
        res.status(500).json({ error: 'Failed to export payroll data' });
    }
}));
exports.default = router;
