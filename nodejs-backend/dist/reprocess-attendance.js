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
function reprocessAttendance() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('\n🔄 Clearing existing attendance records for March...\n');
            // Delete existing March records
            const startOfMarch = new Date('2026-03-01');
            const endOfMarch = new Date('2026-03-31');
            endOfMarch.setHours(23, 59, 59, 999);
            const deleted = yield prisma_1.default.attendanceRecord.deleteMany({
                where: {
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                }
            });
            console.log(`🗑️  Deleted ${deleted.count} old records\n`);
            // Get all unique dates from March attendance logs
            const marchLogs = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                select: { timestamp: true },
                orderBy: { timestamp: 'asc' }
            });
            const uniqueDates = new Set();
            marchLogs.forEach(log => {
                const dateStr = log.timestamp.toISOString().split('T')[0];
                uniqueDates.add(dateStr);
            });
            const sortedDates = Array.from(uniqueDates).sort();
            console.log(`📅 Re-processing ${sortedDates.length} dates with corrected shift times...\n`);
            // Process each date
            for (const dateStr of sortedDates) {
                const processDate = new Date(dateStr);
                yield absence_service_1.AbsenceService.processDailyAbsences(processDate);
                console.log(`✅ Processed: ${dateStr}`);
            }
            // Fetch and display results
            console.log('\n\n📊 VERIFICATION RESULTS\n');
            console.log('═══════════════════════════════════════');
            const totalRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                }
            });
            console.log(`Total Attendance Records: ${totalRecords.length}`);
            // Breakdown by status
            const statusCounts = {
                present: totalRecords.filter(r => r.status === 'present').length,
                absent: totalRecords.filter(r => r.status === 'absent').length,
                leave: totalRecords.filter(r => r.status === 'leave').length,
                late: totalRecords.filter(r => r.status === 'late').length,
                halfday: totalRecords.filter(r => r.status === 'halfday').length
            };
            console.log('\nStatus Breakdown:');
            console.log(`  ├─ Present: ${statusCounts.present}`);
            console.log(`  ├─ Absent: ${statusCounts.absent}`);
            console.log(`  ├─ Leave: ${statusCounts.leave}`);
            console.log(`  ├─ Late: ${statusCounts.late}`);
            console.log(`  └─ Half-day: ${statusCounts.halfday}`);
            // Flags
            const lateCount = totalRecords.filter(r => r.is_late).length;
            const halfdayCount = totalRecords.filter(r => r.is_halfday).length;
            const withCheckIn = totalRecords.filter(r => r.check_in_time).length;
            const withCheckOut = totalRecords.filter(r => r.check_out_time).length;
            console.log('\nDetailed Metrics:');
            console.log(`  ├─ Late Arrivals (is_late): ${lateCount}`);
            console.log(`  ├─ Half-days (is_halfday): ${halfdayCount}`);
            console.log(`  ├─ Records with Check-in Times: ${withCheckIn}`);
            console.log(`  └─ Records with Check-out Times: ${withCheckOut}`);
            console.log('\n═══════════════════════════════════════');
            // Show detailed examples
            console.log('\n📋 SAMPLE RECORDS WITH LATE ARRIVALS:\n');
            const lateRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    is_late: true,
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                include: {
                    user: { select: { name: true } }
                },
                take: 5
            });
            if (lateRecords.length > 0) {
                lateRecords.forEach((r, i) => {
                    console.log(`${i + 1}. ${r.user.name}`);
                    console.log(`   Date: ${r.date.toISOString().split('T')[0]}`);
                    console.log(`   Check-in: ${r.check_in_time} (Late after 09:16 for day shift, 19:41 for night shift)`);
                    console.log(`   Status: ${r.status}`);
                    console.log('');
                });
            }
            else {
                console.log('No late arrivals found in current data.');
            }
            console.log('\n📋 SAMPLE RECORDS WITH HALF-DAYS:\n');
            const halfdayRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    is_halfday: true,
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                include: {
                    user: { select: { name: true } }
                },
                take: 5
            });
            if (halfdayRecords.length > 0) {
                halfdayRecords.forEach((r, i) => {
                    console.log(`${i + 1}. ${r.user.name}`);
                    console.log(`   Date: ${r.date.toISOString().split('T')[0]}`);
                    console.log(`   Check-out: ${r.check_out_time} (Before 11:01 for day shift, 23:01 for night shift)`);
                    console.log(`   Status: ${r.status}`);
                    console.log('');
                });
            }
            else {
                console.log('No half-day records found in current data.');
            }
            console.log('\n📋 OVERALL SAMPLE (First 10 records):\n');
            const sampleRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                include: {
                    user: { select: { name: true } }
                },
                take: 10,
                orderBy: { date: 'desc' }
            });
            sampleRecords.forEach((r, i) => {
                console.log(`${i + 1}. ${r.user.name} - ${r.date.toISOString().split('T')[0]}`);
                console.log(`   Status: ${r.status} | Check-in: ${r.check_in_time || 'N/A'} | Check-out: ${r.check_out_time || 'N/A'} | Late: ${r.is_late} | Half-day: ${r.is_halfday}`);
            });
            console.log('\n✅ Re-processing Complete!\n');
        }
        catch (error) {
            console.error('❌ Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
reprocessAttendance();
