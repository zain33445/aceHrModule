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
function sync13th() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        console.log('=== SYNCING 13TH FOR NIGHT SHIFT USERS ===\n');
        const names = ['sohaib', 'abdullah', 'zaeem', 'asadullah', 'mushahid'];
        for (const n of names) {
            const user = yield prisma_1.default.user.findFirst({
                where: { name: { contains: n, mode: 'insensitive' } },
                include: { department: { include: { shift: true } } }
            });
            if (!user)
                continue;
            // The Date object representing Noon UTC on April 13th (which maps safely to the correct day locally)
            const targetDate = new Date('2026-04-13T12:00:00.000Z');
            // Manually run calculateAndRecordAttendance logic for this specific date and user
            // First, define the correct 6AM-6AM 24-hour window
            const startOfWindow = new Date(targetDate);
            startOfWindow.setHours(6, 0, 0, 0);
            const endOfWindow = new Date(targetDate);
            endOfWindow.setDate(endOfWindow.getDate() + 1);
            endOfWindow.setHours(6, 0, 0, 0);
            // Fetch the logs that actually occurred between April 13th 6AM and April 14th 6AM
            const logs = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    user_id: user.id,
                    timestamp: { gte: startOfWindow, lte: endOfWindow }
                },
                orderBy: { timestamp: 'asc' }
            });
            if (logs.length > 0) {
                console.log(`\nFound ${logs.length} logs for ${user.name} on the 13th! Syncing...`);
                // @ts-ignore
                yield absence_service_1.AbsenceService.calculateAndRecordAttendance(user.id, targetDate, logs, user.monthly_salary, (_a = user.department) === null || _a === void 0 ? void 0 : _a.shift);
                console.log(`✅ successfully updated record.`);
            }
            else {
                console.log(`\n❌ No logs found for ${user.name} in the 13th window (Apr 13 6AM to Apr 14 6AM)`);
            }
        }
        // Print their final state
        console.log('\n--- FINAL VERIFICATION for 13th ---');
        for (const n of names) {
            const user = yield prisma_1.default.user.findFirst({
                where: { name: { contains: n, mode: 'insensitive' } }
            });
            if (!user)
                continue;
            const r = yield prisma_1.default.attendanceRecord.findFirst({
                where: { user_id: user.id, date: new Date('2026-04-13T12:00:00Z') }
            });
            if (r) {
                console.log(`${user.name.padEnd(12)} | Status: ${r.status.padEnd(8)} | In: ${(r.check_in_time || 'NULL').padEnd(5)} | Out: ${(r.check_out_time || 'NULL').padEnd(5)}`);
            }
        }
        yield prisma_1.default.$disconnect();
    });
}
sync13th().catch(console.error);
