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
function processAndVerifyMarchData() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('🔍 Checking March 2026 attendance logs...\n');
            // Get all unique dates from March 2026
            const startOfMarch = new Date('2026-03-01');
            const endOfMarch = new Date('2026-03-31');
            endOfMarch.setHours(23, 59, 59, 999);
            const marchLogs = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                select: {
                    timestamp: true,
                    user_id: true
                },
                orderBy: {
                    timestamp: 'asc'
                }
            });
            console.log(`📊 Found ${marchLogs.length} total attendance logs in March 2026`);
            // Get unique dates
            const uniqueDates = new Set();
            marchLogs.forEach(log => {
                const dateStr = log.timestamp.toISOString().split('T')[0];
                uniqueDates.add(dateStr);
            });
            console.log(`📅 Unique dates: ${uniqueDates.size} days\n`);
            // Process each date
            console.log('⚙️  Processing attendance for each date...\n');
            for (const dateStr of Array.from(uniqueDates).sort()) {
                const processDate = new Date(dateStr);
                console.log(`Processing: ${dateStr}`);
                try {
                    // Get all users who have logs on this date
                    const daysLogs = marchLogs.filter(log => log.timestamp.toISOString().split('T')[0] === dateStr);
                    const uniqueUsers = new Set(daysLogs.map(l => l.user_id));
                    console.log(`  ├─ Users with logs: ${uniqueUsers.size}`);
                    // Process attendance for this date
                    const result = yield absence_service_1.AbsenceService.processDailyAbsences(processDate);
                    console.log(`  ├─ Processed: ${result.processedCount} users`);
                    // Check created records
                    const recordsForDate = yield prisma_1.default.attendanceRecord.findMany({
                        where: {
                            date: {
                                gte: new Date(dateStr),
                                lt: new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000)
                            }
                        },
                        include: {
                            user: {
                                select: { name: true }
                            }
                        }
                    });
                    console.log(`  ├─ Created/Updated records: ${recordsForDate.length}`);
                    // Show sample records
                    if (recordsForDate.length > 0) {
                        console.log(`  └─ Sample records:`);
                        recordsForDate.slice(0, 3).forEach(record => {
                            console.log(`     • ${record.user.name}`);
                            console.log(`       ├─ Status: ${record.status}`);
                            console.log(`       ├─ Check-in: ${record.check_in_time || 'N/A'}`);
                            console.log(`       ├─ Check-out: ${record.check_out_time || 'N/A'}`);
                            console.log(`       ├─ Late: ${record.is_late}`);
                            console.log(`       └─ Half-day: ${record.is_halfday}`);
                        });
                    }
                    console.log('');
                }
                catch (error) {
                    console.error(`  ❌ Error processing ${dateStr}:`, error);
                }
            }
            // Final verification
            console.log('\n✅ VERIFICATION REPORT\n');
            console.log('═══════════════════════════════════════');
            const totalRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                }
            });
            console.log(`Total Attendance Records Created: ${totalRecords.length}`);
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
            // Check late flag
            const lateCount = totalRecords.filter(r => r.is_late).length;
            console.log(`\nLate Arrivals (is_late=true): ${lateCount}`);
            // Check halfday flag
            const halfdayCount = totalRecords.filter(r => r.is_halfday).length;
            console.log(`Half-days (is_halfday=true): ${halfdayCount}`);
            // Records with check-in times
            const withCheckIn = totalRecords.filter(r => r.check_in_time).length;
            console.log(`Records with Check-in Times: ${withCheckIn}`);
            // Records with check-out times
            const withCheckOut = totalRecords.filter(r => r.check_out_time).length;
            console.log(`Records with Check-out Times: ${withCheckOut}`);
            console.log('\n═══════════════════════════════════════');
            console.log('✅ Processing Complete!\n');
            // Show detailed sample
            console.log('📋 DETAILED SAMPLE (First 5 records):\n');
            const sampleRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    date: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                include: {
                    user: {
                        select: { id: true, name: true }
                    }
                },
                take: 5,
                orderBy: { date: 'desc' }
            });
            sampleRecords.forEach((record, index) => {
                console.log(`${index + 1}. ${record.user.name} (ID: ${record.user.id})`);
                console.log(`   Date: ${record.date.toISOString().split('T')[0]}`);
                console.log(`   Status: ${record.status}`);
                console.log(`   Check-in: ${record.check_in_time || 'N/A'}`);
                console.log(`   Check-out: ${record.check_out_time || 'N/A'}`);
                console.log(`   Is Late: ${record.is_late}`);
                console.log(`   Is Half-day: ${record.is_halfday}`);
                console.log('');
            });
        }
        catch (error) {
            console.error('❌ Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
// Run the script
processAndVerifyMarchData();
