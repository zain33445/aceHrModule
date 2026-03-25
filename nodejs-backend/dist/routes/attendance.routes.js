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
        // Fetch users and join LeaveBank for actual leaves_remaining
        const users = yield prisma_1.default.user.findMany({
            include: {
                attendance_logs: true,
                leaveBank: true // correct relation name for LeaveBank
            }
        });
        const report = users.map(user => {
            // 1. Smart Pivot: Group logs by day
            const logsByDay = {};
            user.attendance_logs.forEach(log => {
                const dateStr = log.timestamp.toISOString().split('T')[0];
                let startBound = start_date ? new Date(start_date) : new Date('2000-01-01');
                let endBound = end_date ? new Date(end_date) : new Date('2100-01-01');
                endBound.setHours(23, 59, 59, 999);
                if (log.timestamp >= startBound && log.timestamp <= endBound) {
                    if (!logsByDay[dateStr]) {
                        logsByDay[dateStr] = { checkIn: log.timestamp, checkOut: log.timestamp };
                    }
                    else {
                        if (log.timestamp < logsByDay[dateStr].checkIn) {
                            logsByDay[dateStr].checkIn = log.timestamp;
                        }
                        if (log.timestamp > logsByDay[dateStr].checkOut) {
                            logsByDay[dateStr].checkOut = log.timestamp;
                        }
                    }
                }
            });
            const daysWorked = Object.keys(logsByDay).length;
            // Use actual leaves_remaining from LeaveBank if available
            const totalAllowedLeaves = user.leave_bank;
            const remainingLeaves = user.leaveBank && typeof user.leaveBank.leaves_remaining === 'number'
                ? user.leaveBank.leaves_remaining
                : totalAllowedLeaves;
            const paidLeavesUsed = totalAllowedLeaves - remainingLeaves;
            // Calculate Absences (for stats only, not for leave logic)
            let absentDays = 0;
            let paidLeaveDates = [];
            let unpaidAbsenceDates = [];
            if (start_date && end_date) {
                let current = new Date(start_date);
                const end = new Date(end_date);
                while (current <= end) {
                    if (current.getDay() !== 0) {
                        const currentStr = current.toISOString().split('T')[0];
                        if (!logsByDay[currentStr] && current < new Date()) {
                            absentDays++;
                            // For display only, not for leave logic
                            if (paidLeavesUsed > paidLeaveDates.length) {
                                paidLeaveDates.push(currentStr);
                            }
                            else {
                                unpaidAbsenceDates.push(currentStr);
                            }
                        }
                    }
                    current.setDate(current.getDate() + 1);
                }
            }
            // Financials
            const perDaySalary = user.monthly_salary > 0 ? user.monthly_salary / 30.0 : 0;
            const deductions = unpaidAbsenceDates.length * perDaySalary;
            const totalSalary = Math.max(0, user.monthly_salary - deductions);
            return {
                id: user.id,
                name: user.name,
                monthly_salary: user.monthly_salary,
                leave_bank: totalAllowedLeaves,
                days_worked: daysWorked,
                absent_days: unpaidAbsenceDates.length + paidLeaveDates.length,
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
        });
        res.json(report);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to generate salary report" });
    }
}));
exports.default = router;
