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
            targetDate.setDate(targetDate.getDate() - 1); // Check yesterday by default
            // Set time window: 06:00 AM on target date to 06:00 AM on the following day
            // This captures even late night shifts (e.g., 7:30 PM to 3:00 AM) in one record.
            const startOfWindow = new Date(targetDate);
            startOfWindow.setHours(6, 0, 0, 0);
            const endOfWindow = new Date(targetDate);
            endOfWindow.setDate(endOfWindow.getDate() + 1);
            endOfWindow.setHours(6, 0, 0, 0);
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
     * Run real-time sync for specific users who just registered a biometric punch
     */
    static processLiveSync(userIds_1) {
        return __awaiter(this, arguments, void 0, function* (userIds, targetDate = new Date()) {
            var _a;
            try {
                const startOfWindow = new Date(targetDate);
                startOfWindow.setHours(6, 0, 0, 0);
                const endOfWindow = new Date(targetDate);
                endOfWindow.setDate(endOfWindow.getDate() + 1);
                endOfWindow.setHours(6, 0, 0, 0);
                // Midnight version of target date for record-keeping
                const startOfDay = new Date(targetDate);
                startOfDay.setHours(0, 0, 0, 0);
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
                    // Fetch logs for today
                    const attendanceLogs = yield prisma_1.default.attendanceLog.findMany({
                        where: {
                            user_id: user.id,
                            timestamp: { gte: startOfWindow, lte: endOfWindow }
                        }
                    });
                    if (attendanceLogs.length > 0) {
                        // Pass startOfDay (midnight) instead of targetDate (which has ms precision)
                        yield this.calculateAndRecordAttendance(user.id, startOfDay, attendanceLogs, user.monthly_salary, (_a = user.department) === null || _a === void 0 ? void 0 : _a.shift);
                        processedCount++;
                    }
                }
                console.log(`Live sync completed: updated attendance for ${processedCount} users.`);
            }
            catch (error) {
                console.error('Error during live sync processing:', error);
            }
        });
    }
    /**
     * Calculate and record attendance status based on check-in/check-out times
     * For each user per day: First timestamp = check-in, Last timestamp = check-out
     */
    static calculateAndRecordAttendance(userId, targetDateRaw, attendanceLogs, monthlySalary, userShift) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // FORCE absolute pure YYYY-MM-DD midnight UTC representation to mathematically prevent ms-precision duplicates entirely.
                const localDateStr = new Date(targetDateRaw.getTime() - (targetDateRaw.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
                const date = new Date(localDateStr + "T00:00:00.000Z");
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
                    checkInTime = checkInLog.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                }
                else if (attendanceLogs.length > 0) {
                    // Fallback to earliest punch if no explicit "In" status found
                    const firstPunch = [...attendanceLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
                    checkInTime = firstPunch.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                }
                if (checkOutLog) {
                    checkOutTime = checkOutLog.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                }
                else if (attendanceLogs.length > 1) {
                    // Fallback to latest punch only if multiple punches exist
                    const lastPunch = [...attendanceLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[attendanceLogs.length - 1];
                    if (lastPunch.timestamp.getTime() !== ((checkInLog === null || checkInLog === void 0 ? void 0 : checkInLog.timestamp.getTime()) || 0)) {
                        checkOutTime = lastPunch.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                    }
                }
                // Determine if it's today
                const now = new Date();
                const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
                const isToday = date.toISOString().startsWith(todayStr);
                // Determine if weekend
                const dayOfWeek = date.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                // Determine status based on Rules
                let status = 'present';
                let shiftType = 'day';
                if (isWeekend) {
                    status = 'holiday';
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
                const isLate = status === 'late';
                const isHalfday = status === 'halfday';
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
                    // Update existing record
                    yield prisma_1.default.attendanceRecord.update({
                        where: { id: existingRecord.id },
                        data: {
                            check_in_time: checkInTime,
                            check_out_time: checkOutTime,
                            status: status,
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
            // FORCE absolute pure YYYY-MM-DD midnight UTC representation
            const localDateStr = new Date(targetDateRaw.getTime() - (targetDateRaw.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
            const date = new Date(localDateStr + "T00:00:00.000Z");
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
            const dayOfWeek = date.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                yield prisma_1.default.attendanceRecord.upsert({
                    where: {
                        user_id_date: {
                            user_id: userId,
                            date: date
                        }
                    },
                    update: {
                        status: 'holiday',
                        check_in_time: null,
                        check_out_time: null,
                        is_late: false,
                        is_halfday: false
                    },
                    create: {
                        user_id: userId,
                        status: 'holiday',
                        date: date,
                        is_late: false,
                        is_halfday: false
                    }
                });
                return; // Skip leave deduction and absence marking entirely
            }
            // Get or create user's leave bank record, and ensure monthly reset
            const leaveBankRecord = yield this.ensureMonthlyReset(userId, date);
            const now = new Date();
            const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
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
            // Create or update attendance record
            yield prisma_1.default.attendanceRecord.upsert({
                where: {
                    user_id_date: {
                        user_id: userId,
                        date: date
                    }
                },
                update: {
                    status: status,
                    check_in_time: null,
                    check_out_time: null,
                    is_late: false,
                    is_halfday: false
                },
                create: {
                    user_id: userId,
                    status: status,
                    date: date,
                    is_late: false,
                    is_halfday: false
                }
            });
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
            let current = new Date(startDate);
            current.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(0, 0, 0, 0);
            while (current <= end) {
                dates.push(new Date(current));
                current.setDate(current.getDate() + 1);
            }
            console.log(`Processing ${dates.length} days...`);
            const results = [];
            for (const date of dates) {
                // processDailyAbsences(d) processes d-1 by default. 
                // We want to process exactly the dates provided, so we pass date + 1 day
                const checkDate = new Date(date);
                checkDate.setDate(checkDate.getDate() + 1);
                console.log(`Processing ${date.toDateString()}...`);
                const result = yield this.processDailyAbsences(checkDate);
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
