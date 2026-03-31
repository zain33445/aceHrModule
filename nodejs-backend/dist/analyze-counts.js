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
function analyze() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const users = yield prisma_1.default.user.findMany({
                select: { id: true, name: true, monthly_salary: true }
            });
            console.log('--- User Salaries ---');
            console.table(users);
            const deductionStats = yield prisma_1.default.deduction.groupBy({
                by: ['user_id'],
                _count: { id: true }
            });
            console.log('\n--- Deduction Counts per User ---');
            console.table(deductionStats);
            const statusStats = yield prisma_1.default.attendanceRecord.groupBy({
                by: ['status'],
                _count: { id: true }
            });
            console.log('\n--- AttendanceRecord Status Stats ---');
            console.table(statusStats);
            const logCount = yield prisma_1.default.attendanceLog.count();
            const recordCount = yield prisma_1.default.attendanceRecord.count();
            console.log(`\n--- Summary Counts ---`);
            console.log(`AttendanceLogs: ${logCount}`);
            console.log(`AttendanceRecords: ${recordCount}`);
            // Check user6's specific stats
            const user6AbsenceCount = yield prisma_1.default.attendanceRecord.count({
                where: { user_id: '6', status: 'absent' }
            });
            console.log(`\nUser 6 Absent Days: ${user6AbsenceCount}`);
        }
        catch (error) {
            console.error('Analysis failed:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
analyze();
