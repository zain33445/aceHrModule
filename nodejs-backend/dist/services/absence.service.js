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
exports.AbsenceService = void 0;
const prisma_1 = __importDefault(require("../prisma"));
const dispute_service_1 = require("./dispute.service");
class AbsenceService {
    static getUtcDateKey(date) {
        return date.toISOString().split('T')[0];
    }
    static getCanonicalUtcDate(dateRaw) {
        return new Date(`${this.getUtcDateKey(dateRaw)}T12:00:00.000Z`);
    }
    static getUtcDayWindow(dateRaw) {
        const dateKey = this.getUtcDateKey(dateRaw);
        return {
            startOfWindow: new Date(`${dateKey}T00:00:00.000Z`),
            endOfWindow: new Date(`${dateKey}T23:59:59.999Z`)
        };
    }
    static formatAttendanceClockTime(date) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    /**
     * Helper function to convert time HH:MM to comparable format
     */
    static timeToMinutes(timeStr) {
        if (!timeStr)
            return 0;
        // Normalize string: lowercase and remove extra spaces
        const normalized = timeStr.toLowerCase().replace(/\s+/g, '');
        // Check for am/pm
        const isPM = normalized.includes('pm');
        const isAM = normalized.includes('am');
        // Strip am/pm for parsing
        const timeOnly = normalized.replace(/[ap]m/g, '');
        const [hoursStr, minutesStr] = timeOnly.split(':');
        let hours = parseInt(hoursStr, 10);
        const minutes = parseInt(minutesStr, 10) || 0;
        if (isPM && hours < 12)
            hours += 12;
        if (isAM && hours === 12)
            hours = 0;
        return hours * 60 + minutes;
    }
    /**
     * Check absences for a specific date and process leave deductions
     * @param checkDate - The date to check for absences (defaults to yesterday)
     */
    static processDailyAbsences(checkDate) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const targetDate = checkDate || new Date();
            if (!checkDate) {
                targetDate.setUTCDate(targetDate.getUTCDate() - 1); // Check yesterday by default
            }
            const { startOfWindow, endOfWindow } = this.getUtcDayWindow(targetDate);
            try {
                // Get all users
                const allUsers = yield prisma_1.default.user.findMany({
                    where: { role: 'employee' },
                    include: {
                        department: {
                            include: {
                                shift: true
                            }
                        }
                    }
                });
                let processedCount = 0;
                for (const user of allUsers) {
                    // Check if user has any attendance logs for the target date
                    const attendanceLogs = yield prisma_1.default.attendanceLog.findMany({
                        where: {
                            user_id: user.id,
                            timestamp: {
                                gte: startOfWindow,
                                lte: endOfWindow
                            }
                        }
                    });
                    if (attendanceLogs.length === 0) {
                        yield this.processAttendance(user.id, targetDate, user.monthly_salary, (_a = user.department) === null || _a === void 0 ? void 0 : _a.shift);
                        processedCount++;
                    }
                    else {
                        // Process attendance with times and status calculation
                        yield this.calculateAndRecordAttendance(user.id, targetDate, attendanceLogs, user.monthly_salary, (_b = user.department) === null || _b === void 0 ? void 0 : _b.shift);
                        processedCount++;
                    }
                }
                return {
                    message: `Processed attendance for ${processedCount} users on ${targetDate.toDateString()}`,
                    processedCount,
                    checkDate: targetDate
                };
            }
            catch (error) {
                console.error('Error processing daily absences:', error);
                throw new Error('Failed to process daily absences');
            }
        });
    }
    /**
     * Run real-time sync for specific users who just registered a biometric punch.
     * Processes the UTC calendar date(s) present in the incoming logs.
     */
    static processLiveSync(userIds_1) {
        return __awaiter(this, arguments, void 0, function* (userIds, targetDate = new Date()) {
            var _a;
            try {
                const targetDates = Array.isArray(targetDate) ? targetDate : [targetDate];
                const uniqueDateKeys = [...new Set(targetDates.map((date) => this.getUtcDateKey(date)))];
                const usersToSync = yield prisma_1.default.user.findMany({
                    where: { id: { in: userIds } },
                    include: {
                        department: {
                            include: {
                                shift: true
                            }
                        }
                    }
                });
                let processedCount = 0;
                for (const user of usersToSync) {
                    for (const dateKey of uniqueDateKeys) {
                        const date = new Date(`${dateKey}T12:00:00.000Z`);
                        const { startOfWindow, endOfWindow } = this.getUtcDayWindow(date);
                        const attendanceLogs = yield prisma_1.default.attendanceLog.findMany({
                            where: {
                                user_id: user.id,
                                timestamp: { gte: startOfWindow, lte: endOfWindow }
                            }
                        });
                        if (attendanceLogs.length > 0) {
                            yield this.calculateAndRecordAttendance(user.id, date, attendanceLogs, user.monthly_salary, (_a = user.department) === null || _a === void 0 ? void 0 : _a.shift);
                            processedCount++;
                        }
                    }
                }
                console.log(`Live sync completed: updated ${processedCount} user/date attendance records.`);
            }
            catch (error) {
                console.error('Error during live sync processing:', error);
            }
        });
    }
    /**
     * Scan for any 'pending' records from past dates and finalize them (absent/leave)
     */
    static processMissedAbsences() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const staleRecords = yield prisma_1.default.attendanceRecord.findMany({
                where: {
                    status: 'pending',
                    date: { lt: today }
                },
                include: {
                    user: {
                        include: {
                            department: {
                                include: { shift: true }
                            }
                        }
                    }
                }
            });
            console.log(`[AbsenceService] Found ${staleRecords.length} stale pending records to finalize.`);
            for (const record of staleRecords) {
                try {
                    console.log(`[AbsenceService] Finalizing past record for user ${record.user_id} on ${record.date.toDateString()}`);
                    const { startOfWindow, endOfWindow } = this.getUtcDayWindow(record.date);
                    const logs = yield prisma_1.default.attendanceLog.findMany({
                        where: {
                            user_id: record.user_id,
                            timestamp: { gte: startOfWindow, lte: endOfWindow }
                        }
                    });
                    if (logs.length > 0) {
                        yield this.calculateAndRecordAttendance(record.user_id, record.date, logs, record.user.monthly_salary, (_a = record.user.department) === null || _a === void 0 ? void 0 : _a.shift);
                    }
                    else {
                        yield this.processAttendance(record.user_id, record.date, record.user.monthly_salary, (_b = record.user.department) === null || _b === void 0 ? void 0 : _b.shift);
                    }
                }
                catch (err) {
                    console.error(`Failed to finalize stale record ${record.id}:`, err);
                }
            }
            return staleRecords.length;
        });
    }
    /**
     * Calculate and record attendance status based on check-in/check-out times
     * For each user per day: First timestamp = check-in, Last timestamp = check-out
     */
    static calculateAndRecordAttendance(userId, targetDateRaw, attendanceLogs, monthlySalary, userShift) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const date = this.getCanonicalUtcDate(targetDateRaw);
                // Use provided shift or fallback to first shift
                const shift = userShift || (yield prisma_1.default.shift.findFirst());
                if (!shift) {
                    console.warn(`No shift configuration found`);
                    return;
                }
                // Filter logs by status: 0 represents Check-In, 1 represents Check-Out
                const inLogs = attendanceLogs.filter(l => l.status === 0).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                const outLogs = attendanceLogs.filter(l => l.status === 1).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                const checkInLog = inLogs.length > 0 ? inLogs[0] : null;
                const checkOutLog = outLogs.length > 0 ? outLogs[outLogs.length - 1] : null;
                // If no explicit status logs exist, fallback to earliest/latest chronological punches
                // as a safety measure for other devices or legacy logs.
                let checkInTime = null;
                let checkOutTime = null;
                if (checkInLog) {
                    checkInTime = this.formatAttendanceClockTime(checkInLog.timestamp);
                }
                else if (attendanceLogs.length > 0) {
                    // Fallback to earliest punch if no explicit "In" status found, BUT DO NOT use a checkout log as an IN log
                    const firstPunch = [...attendanceLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
                    if (firstPunch.status !== 1) {
                        checkInTime = this.formatAttendanceClockTime(firstPunch.timestamp);
                    }
                }
                if (checkOutLog) {
                    checkOutTime = this.formatAttendanceClockTime(checkOutLog.timestamp);
                }
                else if (attendanceLogs.length > 1) {
                    // Fallback to latest punch only if multiple punches exist, BUT DO NOT use a checkin log as an OUT log
                    const sorted = [...attendanceLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                    const lastPunch = sorted[sorted.length - 1];
                    const firstPunchOffset = checkInLog ? checkInLog.timestamp.getTime() : sorted[0].timestamp.getTime();
                    if (lastPunch.status !== 0 && lastPunch.timestamp.getTime() !== firstPunchOffset) {
                        checkOutTime = this.formatAttendanceClockTime(lastPunch.timestamp);
                    }
                }
                // Determine if it's today
                const now = new Date();
                const todayStr = this.getUtcDateKey(now);
                const isToday = date.toISOString().startsWith(todayStr);
                // Determine if weekend
                const dayOfWeek = date.getUTCDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                // Determine status based on Rules
                let status = 'present';
                let shiftType = 'day';
                if (isWeekend) {
                    status = 'weekend';
                }
                else if (!checkInTime && !checkOutTime) {
                    // Rule 1 & 2 Logic (No punches)
                    if (isToday) {
                        status = 'pending';
                    }
                    else {
                        // Rule 2: Past date with no punches, must check leave bank
                        return yield this.processAttendance(userId, date, monthlySalary, shift);
                    }
                }
                else if (checkInTime) {
                    // Rule 3: Has check-in
                    shiftType = this.determineShiftType(checkInTime, shift);
                    status = this.determineAttendanceStatus(checkInTime, shift, shiftType);
                }
                else if (checkOutTime) {
                    // Only check-out exists
                    status = 'present';
                }
                // Ensure mutually exclusive logic, isLate and isHalfday directly map from the status
                let isLate = status === 'late';
                let isHalfday = status === 'halfday';
                // Check if record already exists for this user and date
                const existingRecord = yield prisma_1.default.attendanceRecord.findUnique({
                    where: {
                        user_id_date: {
                            user_id: userId,
                            date: date
                        }
                    }
                });
                if (existingRecord) {
                    // ZK Teco Priority Strategy: If fingerprint punch exists, strictly override existing app punch.
                    let finalCheckIn = checkInTime ? checkInTime : existingRecord.check_in_time;
                    let finalCheckOut = checkOutTime ? checkOutTime : existingRecord.check_out_time;
                    // Recalculate status based on the merged earliest check-in
                    let finalStatus = status;
                    if (finalCheckIn) {
                        const currentShiftType = this.determineShiftType(finalCheckIn, shift);
                        finalStatus = this.determineAttendanceStatus(finalCheckIn, shift, currentShiftType);
                    }
                    isLate = finalStatus === 'late';
                    isHalfday = finalStatus === 'halfday';
                    yield prisma_1.default.attendanceRecord.update({
                        where: { id: existingRecord.id },
                        data: {
                            check_in_time: finalCheckIn,
                            check_out_time: finalCheckOut,
                            status: finalStatus,
                            is_late: isLate,
                            is_halfday: isHalfday
                        }
                    });
                }
                else {
                    // Create new record
                    yield prisma_1.default.attendanceRecord.create({
                        data: {
                            user_id: userId,
                            date: date,
                            check_in_time: checkInTime,
                            check_out_time: checkOutTime,
                            status: status,
                            is_late: isLate,
                            is_halfday: isHalfday
                        }
                    });
                }
                // Clean up previous deductions for this specific date and user to avoid duplicate penalties
                // on live real-time syncs
                yield prisma_1.default.deduction.deleteMany({
                    where: {
                        user_id: userId,
                        date: date,
                        type: { in: ['late', 'half-day'] }
                    }
                });
                // Create deduction records if applicable
                if (isLate) {
                    const amount = dispute_service_1.DisputeService.calculateDeductionAmount('late', monthlySalary, date);
                    if (amount > 0) {
                        yield prisma_1.default.deduction.create({
                            data: {
                                user_id: userId,
                                date: date,
                                type: 'late',
                                amount: amount
                            }
                        });
                    }
                }
                if (isHalfday) {
                    const amount = dispute_service_1.DisputeService.calculateDeductionAmount('half-day', monthlySalary, date);
                    if (amount > 0) {
                        yield prisma_1.default.deduction.create({
                            data: {
                                user_id: userId,
                                date: date,
                                type: 'half-day',
                                amount: amount
                            }
                        });
                    }
                }
            }
            catch (error) {
                console.error(`Error calculating attendance for user ${userId}:`, error);
            }
        });
    }
    /**
     * Determine shift type based on check-in time
     * Day shift: check-in in morning/early afternoon (08:00-12:00)
     * Night shift: check-in in evening/night (18:00-23:59)
     */
    static determineShiftType(checkInTime, shift) {
        if ((shift === null || shift === void 0 ? void 0 : shift.shiftid) && String(shift.shiftid).toLowerCase().includes('night')) {
            return 'night';
        }
        if ((shift === null || shift === void 0 ? void 0 : shift.checkin) && (shift === null || shift === void 0 ? void 0 : shift.checkout)) {
            const shiftCheckInMinutes = this.timeToMinutes(shift.checkin);
            const shiftCheckOutMinutes = this.timeToMinutes(shift.checkout);
            if (shiftCheckInMinutes >= 13 * 60 || shiftCheckOutMinutes <= shiftCheckInMinutes) {
                return 'night';
            }
            return 'day';
        }
        const checkInMinutes = this.timeToMinutes(checkInTime);
        // If check-in is before 13:00 (1 PM), it's day shift
        if (checkInMinutes < 13 * 60) {
            return 'day';
        }
        return 'night';
    }
    static getAdjustedMinutes(timeStr, shiftType) {
        const minutes = this.timeToMinutes(timeStr);
        // For night shift, early morning hours (00:00 to 11:59 AM) logically occur AFTER the evening check-in time.
        if (shiftType === 'night' && minutes < 720) {
            return minutes + 1440; // Add 24 hours to ensure mathematical continuity
        }
        return minutes;
    }
    static determineAttendanceStatus(checkInTime, shift, shiftType) {
        if (!checkInTime)
            return 'present'; // Fallback for punch anomalies
        const checkInMins = this.getAdjustedMinutes(checkInTime, shiftType);
        const halfdayMins = this.getAdjustedMinutes(shift.halfday, shiftType);
        const lateMins = this.getAdjustedMinutes(shift.latetiming, shiftType);
        if (checkInMins > halfdayMins) {
            return 'halfday';
        }
        else if (checkInMins > lateMins) {
            return 'late';
        }
        else {
            return 'present';
        }
    }
    /**
     * Process absence for a specific user on a specific date (no attendance logs)
     */
    static processAttendance(userId, targetDateRaw, monthlySalary, userShift) {
        return __awaiter(this, void 0, void 0, function* () {
            const date = this.getCanonicalUtcDate(targetDateRaw);
            // Use provided shift or fallback to first shift
            const shift = userShift || (yield prisma_1.default.shift.findFirst());
            // Clean up previous deductions for this specific date and user to avoid duplicates or orphaned deductions
            yield prisma_1.default.deduction.deleteMany({
                where: {
                    user_id: userId,
                    date: date
                }
            });
            // Check if it's a weekend BEFORE deducting leaves or marking absent
            const dayOfWeek = date.getUTCDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                const weekendRec = yield prisma_1.default.attendanceRecord.findUnique({
                    where: { user_id_date: { user_id: userId, date: date } }
                });
                if (!weekendRec) {
                    yield prisma_1.default.attendanceRecord.create({
                        data: {
                            user_id: userId,
                            status: 'weekend',
                            date: date,
                            is_late: false,
                            is_halfday: false
                        }
                    });
                }
                else if (weekendRec.check_in_time === null && weekendRec.check_out_time === null) {
                    yield prisma_1.default.attendanceRecord.update({
                        where: { id: weekendRec.id },
                        data: { status: 'weekend', is_late: false, is_halfday: false }
                    });
                }
                // If check_in/out already set (employee worked on weekend), preserve them.
                return; // Skip leave deduction and absence marking entirely
            }
            // Get or create user's leave bank record, and ensure monthly reset
            const leaveBankRecord = yield this.ensureMonthlyReset(userId, date);
            const now = new Date();
            const todayStr = this.getUtcDateKey(now);
            const isToday = date.toISOString().startsWith(todayStr);
            let status;
            let newLeavesRemaining = leaveBankRecord.leaves_remaining;
            if (isToday) {
                // Rule 1: Today with no punches
                status = 'pending';
            }
            else if (leaveBankRecord.leaves_remaining > 0) {
                // Rule 2: Past date with leaves remaining
                status = 'leave';
                newLeavesRemaining = leaveBankRecord.leaves_remaining - 1;
                // Update leave bank record
                yield prisma_1.default.leaveBank.update({
                    where: { user_id: userId },
                    data: { leaves_remaining: newLeavesRemaining }
                });
            }
            else {
                // Rule 2: Past date with no leaves
                status = 'absent';
            }
            // Create or update attendance record — but PRESERVE existing check-in/out times
            // (set by the Electron desktop monitor) if they already exist.
            const existingRec = yield prisma_1.default.attendanceRecord.findUnique({
                where: { user_id_date: { user_id: userId, date: date } }
            });
            if (!existingRec) {
                // No record at all — create a fresh one
                yield prisma_1.default.attendanceRecord.create({
                    data: {
                        user_id: userId,
                        status: status,
                        date: date,
                        is_late: false,
                        is_halfday: false
                    }
                });
            }
            else {
                // Record exists. Only update status if check_in_time is still null
                // (meaning the Electron monitor hasn't set it yet).
                // If the monitor already set check_in_time, do NOT overwrite anything.
                if (existingRec.check_in_time === null && existingRec.check_out_time === null) {
                    yield prisma_1.default.attendanceRecord.update({
                        where: { id: existingRec.id },
                        data: {
                            status: status,
                            is_late: false,
                            is_halfday: false
                        }
                    });
                }
                // If check_in_time or check_out_time already has a value, leave the record untouched.
            }
            if (status === 'absent') {
                const amount = dispute_service_1.DisputeService.calculateDeductionAmount('absent', monthlySalary, date);
                if (amount > 0) {
                    yield prisma_1.default.deduction.create({
                        data: {
                            user_id: userId,
                            date: date,
                            type: 'absent',
                            amount: amount
                        }
                    });
                }
            }
        });
    }
    /**
     * Ensure leave bank is reset for the current month.
     * If the month of the given date doesn't match last_reset_month, reset leaves_remaining
     * to the user's leave_bank value from the User table.
     */
    static ensureMonthlyReset(userId, date) {
        return __awaiter(this, void 0, void 0, function* () {
            const currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            let leaveBankRecord = yield prisma_1.default.leaveBank.findUnique({
                where: { user_id: userId }
            });
            const user = yield prisma_1.default.user.findUnique({
                where: { id: userId },
                select: { leave_bank: true }
            });
            if (!user) {
                throw new Error(`User ${userId} not found`);
            }
            if (!leaveBankRecord) {
                // Create new leave bank record with full leaves for this month
                leaveBankRecord = yield prisma_1.default.leaveBank.create({
                    data: {
                        user_id: userId,
                        leaves_remaining: user.leave_bank,
                        last_reset_month: currentMonth
                    }
                });
            }
            else if (leaveBankRecord.last_reset_month !== currentMonth) {
                // New month — reset leaves to the user's allowed leave_bank
                leaveBankRecord = yield prisma_1.default.leaveBank.update({
                    where: { user_id: userId },
                    data: {
                        leaves_remaining: user.leave_bank,
                        last_reset_month: currentMonth
                    }
                });
                console.log(`Leave bank reset for user ${userId}: ${user.leave_bank} leaves for ${currentMonth}`);
            }
            return leaveBankRecord;
        });
    }
    /**
     * Process attendance for a range of dates
     */
    static processDateRange(startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const dates = [];
            let current = this.getCanonicalUtcDate(startDate);
            const end = this.getCanonicalUtcDate(endDate);
            while (current <= end) {
                dates.push(new Date(current));
                current.setUTCDate(current.getUTCDate() + 1);
            }
            console.log(`Processing ${dates.length} days...`);
            const results = [];
            for (const date of dates) {
                console.log(`Processing ${date.toISOString().split('T')[0]}...`);
                const result = yield this.processDailyAbsences(date);
                results.push(result);
            }
            return results;
        });
    }
    /**
     * Get attendance records for a specific user
     */
    static getUserAttendances(userId_1, startDate_1, endDate_1, status_1) {
        return __awaiter(this, arguments, void 0, function* (userId, startDate, endDate, status, page = 1, limit = 20) {
            const whereClause = { user_id: userId };
            if (startDate || endDate) {
                whereClause.date = {};
                if (startDate)
                    whereClause.date.gte = startDate;
                if (endDate)
                    whereClause.date.lte = endDate;
            }
            if (status && status !== 'all') {
                whereClause.status = status;
            }
            else {
                whereClause.status = { not: 'pending' };
            }
            const skip = (page - 1) * limit;
            const [records, total] = yield Promise.all([
                prisma_1.default.attendanceRecord.findMany({
                    where: whereClause,
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true
                            }
                        }
                    },
                    orderBy: {
                        date: 'desc'
                    },
                    skip,
                    take: limit
                }),
                prisma_1.default.attendanceRecord.count({ where: whereClause })
            ]);
            return { records, total };
        });
    }
    /**
     * Get all attendance records with optional date range
     */
    static getAllAttendances(startDate_1, endDate_1, status_1, userId_1) {
        return __awaiter(this, arguments, void 0, function* (startDate, endDate, status, userId, page = 1, limit = 20) {
            const whereClause = {};
            if (userId && userId !== 'all') {
                whereClause.user_id = userId;
            }
            if (startDate || endDate) {
                whereClause.date = {};
                if (startDate)
                    whereClause.date.gte = startDate;
                if (endDate)
                    whereClause.date.lte = endDate;
            }
            if (status && status !== 'all') {
                whereClause.status = status;
            }
            else {
                whereClause.status = { not: 'pending' };
            }
            const skip = (page - 1) * limit;
            const [records, total] = yield Promise.all([
                prisma_1.default.attendanceRecord.findMany({
                    where: whereClause,
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true
                            }
                        }
                    },
                    orderBy: {
                        date: 'desc'
                    },
                    skip,
                    take: limit
                }),
                prisma_1.default.attendanceRecord.count({ where: whereClause })
            ]);
            return { records, total };
        });
    }
    /**
     * Get leave bank record for a user (with automatic monthly reset)
     */
    static getUserLeaveBank(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            let leaveBankRecord = yield prisma_1.default.leaveBank.findUnique({
                where: { user_id: userId },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            leave_bank: true // Total allowed leaves
                        }
                    }
                }
            });
            // If no leave bank record exists, create one
            if (!leaveBankRecord) {
                const user = yield prisma_1.default.user.findUnique({
                    where: { id: userId },
                    select: { leave_bank: true }
                });
                if (!user) {
                    throw new Error(`User ${userId} not found`);
                }
                leaveBankRecord = yield prisma_1.default.leaveBank.create({
                    data: {
                        user_id: userId,
                        leaves_remaining: user.leave_bank,
                        last_reset_month: currentMonth
                    },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                leave_bank: true
                            }
                        }
                    }
                });
            }
            else if (leaveBankRecord.last_reset_month !== currentMonth) {
                // New month — reset leaves
                leaveBankRecord = yield prisma_1.default.leaveBank.update({
                    where: { user_id: userId },
                    data: {
                        leaves_remaining: leaveBankRecord.user.leave_bank,
                        last_reset_month: currentMonth
                    },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                leave_bank: true
                            }
                        }
                    }
                });
            }
            return leaveBankRecord;
        });
    }
    /**
     * Get all leave bank records
     */
    static getAllLeaveBanks() {
        return __awaiter(this, void 0, void 0, function* () {
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            let leaveBanks = yield prisma_1.default.leaveBank.findMany({
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            leave_bank: true // Total allowed leaves
                        }
                    }
                }
            });
            // For users without leave bank records, create them
            const allUsers = yield prisma_1.default.user.findMany({
                select: { id: true, leave_bank: true }
            });
            const existingUserIds = leaveBanks.map(lb => lb.user_id);
            const missingUsers = allUsers.filter(user => !existingUserIds.includes(user.id));
            for (const user of missingUsers) {
                const newLeaveBank = yield prisma_1.default.leaveBank.create({
                    data: {
                        user_id: user.id,
                        leaves_remaining: user.leave_bank,
                        last_reset_month: currentMonth
                    },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                leave_bank: true
                            }
                        }
                    }
                });
                leaveBanks.push(newLeaveBank);
            }
            // Process resets
            const processedBanks = [];
            for (const lb of leaveBanks) {
                if (lb.last_reset_month !== currentMonth) {
                    const updated = yield prisma_1.default.leaveBank.update({
                        where: { user_id: lb.user_id },
                        data: {
                            leaves_remaining: lb.user.leave_bank,
                            last_reset_month: currentMonth
                        },
                        include: {
                            user: {
                                select: {
                                    id: true,
                                    name: true,
                                    leave_bank: true
                                }
                            }
                        }
                    });
                    processedBanks.push(updated);
                }
                else {
                    processedBanks.push(lb);
                }
            }
            return processedBanks;
        });
    }
    /**
     * Update leave bank for a user (admin function)
     */
    static updateLeaveBank(userId, leavesRemaining) {
        return __awaiter(this, void 0, void 0, function* () {
            const leaveBankRecord = yield prisma_1.default.leaveBank.upsert({
                where: { user_id: userId },
                update: { leaves_remaining: leavesRemaining },
                create: {
                    user_id: userId,
                    leaves_remaining: leavesRemaining
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            leave_bank: true
                        }
                    }
                }
            });
            return leaveBankRecord;
        });
    }
    /**
     * Reset leave bank to user's total allowed leaves
     */
    static resetLeaveBank(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const user = yield prisma_1.default.user.findUnique({
                where: { id: userId },
                select: { leave_bank: true }
            });
            if (!user) {
                throw new Error(`User ${userId} not found`);
            }
            return yield this.updateLeaveBank(userId, user.leave_bank);
        });
    }
    /**
     * Get attendance statistics for a user
     */
    static getUserAttendanceStats(userId, startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const { records } = yield this.getUserAttendances(userId, startDate, endDate);
            const stats = {
                totalDays: records.length,
                presentDays: records.filter(a => a.status === 'present').length,
                lateDays: records.filter(a => a.is_late).length,
                halfdayDays: records.filter(a => a.is_halfday).length,
                leaveDays: records.filter(a => a.status === 'leave').length,
                absentDays: records.filter(a => a.status === 'absent').length
            };
            return stats;
        });
    }
    /**
     * Backward compatibility: Keep old method names as aliases
     */
    static getUserAbsences(userId, startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const { records } = yield this.getUserAttendances(userId, startDate, endDate);
            return records;
        });
    }
    static getAllAbsences(startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const { records } = yield this.getAllAttendances(startDate, endDate);
            return records;
        });
    }
    static getUserAbsenceStats(userId, startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.getUserAttendanceStats(userId, startDate, endDate);
        });
    }
}
exports.AbsenceService = AbsenceService;
