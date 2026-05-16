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
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
const MAY_REWRITE_START = '2026-05-01';
function parseDateArg(value, fallback) {
    const raw = value || fallback;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = match
        ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        : new Date(raw);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${value}`);
    }
    date.setHours(0, 0, 0, 0);
    return date;
}
function resetMayLeaveBanks() {
    return __awaiter(this, void 0, void 0, function* () {
        const users = yield prisma_1.default.user.findMany({
            where: { role: 'employee' },
            select: { id: true, leave_bank: true },
        });
        for (const user of users) {
            yield prisma_1.default.leaveBank.upsert({
                where: { user_id: user.id },
                update: {
                    leaves_remaining: user.leave_bank,
                    last_reset_month: '2026-05',
                },
                create: {
                    user_id: user.id,
                    leaves_remaining: user.leave_bank,
                    last_reset_month: '2026-05',
                },
            });
        }
        return users.length;
    });
}
function reprocessAttendance() {
    return __awaiter(this, void 0, void 0, function* () {
        const startDate = parseDateArg(process.argv[2], MAY_REWRITE_START);
        const endDate = parseDateArg(process.argv[3], new Date().toISOString().split('T')[0]);
        if (startDate < parseDateArg(MAY_REWRITE_START, MAY_REWRITE_START)) {
            throw new Error(`This script is limited to ${MAY_REWRITE_START} onward.`);
        }
        if (endDate < startDate) {
            throw new Error('End date must be on or after start date.');
        }
        const deleteStart = new Date(startDate);
        deleteStart.setHours(0, 0, 0, 0);
        const deleteEnd = new Date(endDate);
        deleteEnd.setHours(23, 59, 59, 999);
        try {
            console.log(`\nReprocessing attendance records from ${startDate.toDateString()} to ${endDate.toDateString()}.\n`);
            const resetCount = yield resetMayLeaveBanks();
            console.log(`Reset May leave banks for ${resetCount} employees.`);
            const deletedDeductions = yield prisma_1.default.deduction.deleteMany({
                where: {
                    date: {
                        gte: deleteStart,
                        lte: deleteEnd,
                    },
                    type: { in: ['late', 'half-day', 'absent'] },
                },
            });
            console.log(`Deleted ${deletedDeductions.count} attendance-related deductions.`);
            const deletedRecords = yield prisma_1.default.attendanceRecord.deleteMany({
                where: {
                    date: {
                        gte: deleteStart,
                        lte: deleteEnd,
                    },
                },
            });
            console.log(`Deleted ${deletedRecords.count} attendance records.`);
            const results = yield absence_service_1.AbsenceService.processDateRange(startDate, endDate);
            console.log(`Processed ${results.length} attendance dates.`);
            const records = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    date: {
                        gte: deleteStart,
                        lte: deleteEnd,
                    },
                },
            });
            const summary = records.reduce((acc, record) => {
                acc[record.status] = (acc[record.status] || 0) + 1;
                return acc;
            }, {});
            console.log('\nMay-forward rewrite summary:');
            console.log(`Total records: ${records.length}`);
            Object.entries(summary)
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([status, count]) => console.log(`${status}: ${count}`));
            console.log('\nDone.\n');
        }
        catch (error) {
            console.error('Reprocessing failed:', error);
            process.exitCode = 1;
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
reprocessAttendance();
