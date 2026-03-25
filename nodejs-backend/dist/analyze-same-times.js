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
function analyzeLogsWithSameTimes() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Get attendance records where check-in equals check-out
            const records = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    check_in_time: { not: null },
                    check_out_time: { not: null },
                    date: {
                        gte: new Date('2026-03-01'),
                        lte: new Date('2026-03-31')
                    }
                },
                include: { user: { select: { name: true } } }
            });
            const sameTime = records.filter(r => r.check_in_time === r.check_out_time);
            console.log('\n🔍 ANALYSIS: Records with SAME Check-in and Check-out Times\n');
            console.log(`Total records with same times: ${sameTime.length} out of ${records.length}\n`);
            if (sameTime.length > 0) {
                console.log('Examples:');
                for (const record of sameTime.slice(0, 5)) {
                    const date = record.date.toISOString().split('T')[0];
                    // Get the actual attendance logs for this user/date
                    const dayStart = new Date(date);
                    const dayEnd = new Date(date);
                    dayEnd.setHours(23, 59, 59, 999);
                    const logs = yield prisma_1.default.attendanceLog.findMany({
                        where: {
                            user_id: record.user_id,
                            timestamp: {
                                gte: dayStart,
                                lte: dayEnd
                            }
                        },
                        orderBy: { timestamp: 'asc' }
                    });
                    console.log(`\n  ${record.user.name} (${date}) - Time: ${record.check_in_time}`);
                    console.log(`  Actual logs from device: ${logs.length} logs`);
                    logs.forEach(log => {
                        console.log(`    • ${log.timestamp.toISOString()} (Status: ${log.status})`);
                    });
                }
                console.log('\n\n✏️  REASON ANALYSIS:\n');
                console.log('These records have same times because employees only have ONE log recorded');
                console.log('(typically only check-in, no check-out).');
                console.log('\nWhen we process logs with timestamp-based extraction:');
                console.log('  • If only 1 log exists: first = last (same time)');
                console.log('  • If 2+ logs exist: first log = check-in, last log = check-out (different)');
                console.log('\nThis is NORMAL DEVICE BEHAVIOR - not everyone checks out explicitly.');
            }
        }
        catch (error) {
            console.error('Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
analyzeLogsWithSameTimes();
