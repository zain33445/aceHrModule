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
// Export Attendance
router.get('/attendance', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { start_date, end_date } = req.query;
    try {
        const where = {};
        if (start_date && end_date) {
            where.timestamp = {
                gte: new Date(start_date),
                lte: new Date(end_date)
            };
        }
        const logs = yield prisma_1.default.attendanceLog.findMany({
            where,
            include: { user: { select: { name: true, role: true } } },
            orderBy: { timestamp: 'desc' }
        });
        const workbook = new exceljs_1.default.Workbook();
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
        yield workbook.xlsx.write(res);
        res.end();
    }
    catch (error) {
        console.error('Failed to export attendance:', error);
        res.status(500).json({ error: 'Failed to export attendance data' });
    }
}));
// Export Salary
router.get('/salary', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { start_date, end_date } = req.query;
    try {
        const where = {};
        if (start_date && end_date) {
            where.date = {
                gte: new Date(start_date),
                lte: new Date(end_date)
            };
        }
        const salaries = yield prisma_1.default.salary.findMany({
            where,
            include: { user: { select: { name: true } } },
            orderBy: { date: 'desc' }
        });
        const workbook = new exceljs_1.default.Workbook();
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
        yield workbook.xlsx.write(res);
        res.end();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to export salary data' });
    }
}));
exports.default = router;
