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
const router = (0, express_1.Router)();
// Get all attendance logs
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const logs = yield prisma_1.default.attendanceLog.findMany({
            orderBy: { timestamp: 'desc' },
            take: 1000 // Limit for safety
        });
        res.json(logs);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch attendance" });
    }
}));
// Get user specific attendance logs
router.get('/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const logs = yield prisma_1.default.attendanceLog.findMany({
            where: { user_id: String(req.params.userId) },
            orderBy: { timestamp: 'desc' }
        });
        res.json(logs);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user attendance" });
    }
}));
// Salary and attendance report (The heavy lifter)
// Needs proper date filtering similar to old Python implementation
router.get('/report/salary-report', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { start_date, end_date } = req.query;
    try {
        // Fetch users and join LeaveBank and AttendanceRecords
        const users = yield prisma_1.default.user.findMany({
            include: {
                attendance_records: {
                    where: start_date && end_date ? {
                        date: {
                            gte: new Date(start_date),
                            lte: new Date(end_date)
                        }
                    } : undefined
                },
                leaveBank: true
            }
        });
        // 0. Pre-fetch all deductions grouped by user
        const deductionWhere = {};
        if (start_date && end_date) {
            deductionWhere.date = {
                gte: new Date(start_date),
                lte: new Date(end_date)
            };
        }
        const groupedDeductions = yield prisma_1.default.deduction.groupBy({
            by: ['user_id'],
            where: deductionWhere,
            _sum: { amount: true }
        });
        const deductionMap = new Map(groupedDeductions.map(d => [d.user_id, d._sum.amount || 0]));
        const report = yield Promise.all(users.map((user) => __awaiter(void 0, void 0, void 0, function* () {
            const records = user.attendance_records;
            // Filter for worked days (present, late, halfday)
            const workedRecords = records.filter(r => ['present', 'late', 'halfday'].includes(r.status));
            const daysWorked = workedRecords.length;
            const totalAllowedLeaves = user.leave_bank;
            const remainingLeaves = user.leaveBank && typeof user.leaveBank.leaves_remaining === 'number'
                ? user.leaveBank.leaves_remaining
                : totalAllowedLeaves;
            const paidLeavesUsed = totalAllowedLeaves - remainingLeaves;
            // Identify absences and paid leaves from records
            const absentDays = records.filter(r => r.status === 'absent').length;
            const leaveDays = records.filter(r => r.status === 'leave').length;
            const paidLeaveDates = records.filter(r => r.status === 'leave').map(r => r.date.toISOString().split('T')[0]);
            const unpaidAbsenceDates = records.filter(r => r.status === 'absent').map(r => r.date.toISOString().split('T')[0]);
            // Financials
            const deductions = deductionMap.get(user.id) || 0;
            const totalSalary = Math.max(0, user.monthly_salary - deductions);
            return {
                id: user.id,
                name: user.name,
                monthly_salary: user.monthly_salary,
                leave_bank: totalAllowedLeaves,
                days_worked: daysWorked,
                absent_days: absentDays + leaveDays,
                paid_leave_dates: paidLeaveDates,
                unpaid_absence_dates: unpaidAbsenceDates,
                paid_leaves_used: paidLeavesUsed,
                deductions: parseFloat(deductions.toFixed(2)),
                total_salary: parseFloat(totalSalary.toFixed(2)),
                remaining_leaves: remainingLeaves,
                period: {
                    start: start_date || 'N/A',
                    end: end_date || 'N/A'
                }
            };
        })));
        res.json(report);
    }
    catch (error) {
        console.error('Error generating salary report:', error);
        res.status(500).json({ error: "Failed to generate salary report" });
    }
}));
exports.default = router;
