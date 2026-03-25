import prisma from './prisma';
import { AbsenceService } from './services/absence.service';

/**
 * This script manually tests the AbsenceService logic against the new Rules.
 * Rules:
 * 1. Today + No Punches = pending
 * 2. Past + No Punches = leave (if bank > 0) or absent
 * 3. Punches = present/late/halfday based on thresholds
 */
async function testRules() {
    console.log('🧪 Testing Attendance Rules...\n');

    try {
        // 1. Setup Mock User
        const userId = 'TEST_USER_RULE';
        
        // Use exact same normalization as AbsenceService
        const targetDateRaw = new Date();
        const localDateStr = new Date(targetDateRaw.getTime() - (targetDateRaw.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        const todayNormalized = new Date(localDateStr + 'T00:00:00.000Z');
        
        const yesterdayRaw = new Date(targetDateRaw);
        yesterdayRaw.setDate(yesterdayRaw.getDate() - 1);
        const yesterdayDateStr = new Date(yesterdayRaw.getTime() - (yesterdayRaw.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        const yesterdayNormalized = new Date(yesterdayDateStr + 'T00:00:00.000Z');

        console.log(`Today Normalized: ${todayNormalized.toISOString()}`);
        console.log(`Yesterday Normalized: ${yesterdayNormalized.toISOString()}\n`);

        // Clean up
        await prisma.attendanceRecord.deleteMany({ where: { user_id: userId } });
        await prisma.leaveBank.deleteMany({ where: { user_id: userId } });
        await prisma.user.deleteMany({ where: { id: userId } });

        // Create User
        await prisma.user.create({
            data: {
                id: userId,
                name: 'Rule Tester',
                role: 'employee',
                leave_bank: 1, // Start with 1 leave
                monthly_salary: 30000
            }
        });

        // Ensure Leave Bank exists
        await AbsenceService.getUserLeaveBank(userId);

        const shift = await prisma.shift.findFirst();
        if (!shift) {
            console.error('❌ No shift found in DB to test with.');
            return;
        }
        console.log(`Using Shift: ${shift.shiftid} (Late: ${shift.latetiming}, Halfday: ${shift.halfday})`);

        // --- TEST SCENARIOS ---

        // SCENARIO 1: Rule 1 - Today with no punches
        console.log('\n--- Scenario 1: Today, No Punches ---');
        await (AbsenceService as any).processAttendance(userId, todayNormalized, 30000, shift);
        let rec = await prisma.attendanceRecord.findFirst({ 
            where: { user_id: userId, date: todayNormalized } 
        });
        console.log(`Expected: pending | Actual: ${rec?.status}`);

        // SCENARIO 2: Rule 2 - Yesterday, No Punches, Bank > 0
        console.log('\n--- Scenario 2: Past (Yesterday), No Punches, Bank=1 ---');
        await (AbsenceService as any).processAttendance(userId, yesterdayNormalized, 30000, shift);
        rec = await prisma.attendanceRecord.findFirst({ 
            where: { user_id: userId, date: yesterdayNormalized } 
        });
        let bank = await prisma.leaveBank.findUnique({ where: { user_id: userId } });
        console.log(`Expected Status: leave | Actual: ${rec?.status}`);
        console.log(`Expected Bank: 0 | Actual: ${bank?.leaves_remaining}`);

        // SCENARIO 3: Rule 2 - Day Before Yesterday, No Punches, Bank = 0
        const dbRaw = new Date(yesterdayRaw);
        dbRaw.setDate(dbRaw.getDate() - 1);
        const dbDateStr = new Date(dbRaw.getTime() - (dbRaw.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        const dbNormalized = new Date(dbDateStr + 'T00:00:00.000Z');

        console.log('\n--- Scenario 3: Past, No Punches, Bank=0 ---');
        await (AbsenceService as any).processAttendance(userId, dbNormalized, 30000, shift);
        rec = await prisma.attendanceRecord.findFirst({ 
            where: { user_id: userId, date: dbNormalized } 
        });
        console.log(`Expected Status: absent | Actual: ${rec?.status}`);

        // SCENARIO 4: Rule 3 - Late Check-in
        console.log('\n--- Scenario 4: Late Check-in ---');
        const lateDate = new Date(dbNormalized);
        lateDate.setDate(lateDate.getDate() - 1);
        // Assuming day shift 09:16 is late. Mock checking in at 09:30
        const logs = [
            { user_id: userId, timestamp: new Date(lateDate.getTime()), status: 0 } // Check-in
        ];
        // Manually set timestamp to be late
        const [h, m] = shift.latetiming.replace(/[ap]m/g, '').split(':');
        logs[0].timestamp.setHours(parseInt(h), parseInt(m) + 10, 0, 0); 
        
        await (AbsenceService as any).calculateAndRecordAttendance(userId, lateDate, logs, 30000, shift);
        rec = await prisma.attendanceRecord.findFirst({ 
            where: { user_id: userId, date: lateDate } 
        });
        console.log(`Check-in Time: ${rec?.check_in_time} (Threshold: ${shift.latetiming})`);
        console.log(`Expected Status: late | Actual: ${rec?.status}`);

        // SCENARIO 5: Rule 3 - Halfday Check-in
        console.log('\n--- Scenario 5: Halfday Check-in ---');
        const halfdayDate = new Date(lateDate);
        halfdayDate.setDate(halfdayDate.getDate() - 3); // Move further back to a weekday
        const [hh, mm] = shift.halfday.replace(/[ap]m/g, '').split(':');
        logs[0].timestamp = new Date(halfdayDate);
        logs[0].timestamp.setHours(parseInt(hh), parseInt(mm) + 1, 0, 0);

        await (AbsenceService as any).calculateAndRecordAttendance(userId, halfdayDate, logs, 30000, shift);
        rec = await prisma.attendanceRecord.findFirst({ 
            where: { user_id: userId, date: halfdayDate } 
        });
        console.log(`Check-in Time: ${rec?.check_in_time} (Threshold: ${shift.halfday})`);
        console.log(`Expected Status: halfday | Actual: ${rec?.status}`);

    } catch (err) {
        console.error('❌ Test Failed:', err);
    } finally {
        await prisma.$disconnect();
    }
}

testRules();
