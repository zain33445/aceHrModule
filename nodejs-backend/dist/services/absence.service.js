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
class AbsenceService {
    /**
     * Helper function to convert time HH:MM to comparable format
     */
    static timeToMinutes(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + minutes;
    }
    /**
     * Check absences for a specific date and process leave deductions
     * @param checkDate - The date to check for absences (defaults to yesterday)
     */
    static processDailyAbsences(checkDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const targetDate = checkDate || new Date();
            targetDate.setDate(targetDate.getDate() - 1); // Check yesterday by default
            // Set time to start and end of the target date
            const startOfDay = new Date(targetDate);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(targetDate);
            endOfDay.setHours(23, 59, 59, 999);
            try {
                // Get all users
                const allUsers = yield prisma_1.default.user.findMany({
                    select: {
                        id: true,
                        name: true,
                        leave_bank: true
                    }
                });
                let processedCount = 0;
                for (const user of allUsers) {
                    // Check if user has any attendance logs for the target date
                    const attendanceLogs = yield prisma_1.default.attendanceLog.findMany({
                        where: {
                            user_id: user.id,
                            timestamp: {
                                gte: startOfDay,
                                lte: endOfDay
                            }
                        }
                    });
                    // If no attendance logs for the day, mark as absent or use leave
                    if (attendanceLogs.length === 0) {
                        yield this.processAttendance(user.id, targetDate);
                        processedCount++;
                    }
                    else {
                        // Process attendance with times and status calculation
                        yield this.calculateAndRecordAttendance(user.id, targetDate, attendanceLogs);
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
     * Calculate and record attendance status based on check-in/check-out times
     * For each user per day: First timestamp = check-in, Last timestamp = check-out
     */
    static calculateAndRecordAttendance(userId, date, attendanceLogs) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Get shift information
                const shift = yield prisma_1.default.shift.findFirst();
                if (!shift) {
                    console.warn(`No shift configuration found`);
                    return;
                }
                // Sort logs by timestamp - first = check-in, last = check-out
                const sortedLogs = attendanceLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                const checkInLog = sortedLogs[0];
                const checkOutLog = sortedLogs[sortedLogs.length - 1];
                const checkInTime = checkInLog.timestamp.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                const checkOutTime = checkOutLog.timestamp.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                // Determine shift type based on check-in time
                const shiftType = this.determineShiftType(checkInTime, shift);
                // Calculate status based on times and shift
                const status = this.determineAttendanceStatus(checkInTime, shift);
                const isLate = this.isLate(checkInTime, shift.latetiming, shiftType);
                const isHalfday = this.isHalfday(checkOutTime, shift.halfday, shiftType);
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
    /**
     * Determine attendance status based on check-in time and shift
     */
    static determineAttendanceStatus(checkInTime, shift) {
        // Status can be: "present", "late", "halfday", "absent", "leave"
        // This is determined by comparing check-in time with shift timing
        // For now, return "present" as default
        return 'present';
    }
    /**
     * Check if employee is late
     * For day shift: compare with day shift late timing
     * For night shift: compare with night shift late timing
     */
    static isLate(checkInTime, lateTimingLimit, shiftType) {
        const checkInMinutes = this.timeToMinutes(checkInTime);
        const lateMinutes = this.timeToMinutes(lateTimingLimit);
        return checkInMinutes > lateMinutes;
    }
    /**
     * Check if employee is half-day
     * For day shift: check if checkout is significantly early (before lunch/halfday limit)
     * For night shift: check if checkout is in early morning hours
     */
    static isHalfday(checkOutTime, halfdayLimit, shiftType) {
        const checkOutMinutes = this.timeToMinutes(checkOutTime);
        const halfdayMinutes = this.timeToMinutes(halfdayLimit);
        // For day shift: if checkout is before halfday limit, it's halfday
        if (shiftType === 'day') {
            return checkOutMinutes < halfdayMinutes;
        }
        // For night shift: 
        // Checkout should be in early AM (00:00-05:00 typically)
        // If it's much earlier than expected, it could be halfday
        // Expected checkout ~02:45, halfday limit might be ~23:01
        // So for night shift, check if checkout is before the limit in early morning
        return checkOutMinutes < halfdayMinutes;
    }
    /**
     * Process absence for a specific user on a specific date (no attendance logs)
     */
    static processAttendance(userId, date) {
        return __awaiter(this, void 0, void 0, function* () {
            // Check if attendance record already exists for this user and date
            const existingRecord = yield prisma_1.default.attendanceRecord.findUnique({
                where: {
                    user_id_date: {
                        user_id: userId,
                        date: date
                    }
                }
            });
            if (existingRecord) {
                return; // Already processed
            }
            // Get user's leave bank record
            let leaveBankRecord = yield prisma_1.default.leaveBank.findUnique({
                where: { user_id: userId }
            });
            // If no leave bank record exists, create one with default leaves
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
                        leaves_remaining: user.leave_bank // Initialize with total allowed leaves
                    }
                });
            }
            let status;
            let newLeavesRemaining = leaveBankRecord.leaves_remaining;
            if (leaveBankRecord.leaves_remaining > 0) {
                // Use a leave day
                status = 'leave';
                newLeavesRemaining = leaveBankRecord.leaves_remaining - 1;
                // Update leave bank record
                yield prisma_1.default.leaveBank.update({
                    where: { user_id: userId },
                    data: { leaves_remaining: newLeavesRemaining }
                });
            }
            else {
                // Mark as absent
                status = 'absent';
            }
            // Create attendance record
            yield prisma_1.default.attendanceRecord.create({
                data: {
                    user_id: userId,
                    status: status,
                    date: date
                }
            });
        });
    }
    /**
     * Get attendance records for a specific user
     */
    static getUserAttendances(userId, startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const whereClause = { user_id: userId };
            if (startDate || endDate) {
                whereClause.date = {};
                if (startDate)
                    whereClause.date.gte = startDate;
                if (endDate)
                    whereClause.date.lte = endDate;
            }
            return yield prisma_1.default.attendanceRecord.findMany({
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
                }
            });
        });
    }
    /**
     * Get all attendance records with optional date range
     */
    static getAllAttendances(startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            const whereClause = {};
            if (startDate || endDate) {
                whereClause.date = {};
                if (startDate)
                    whereClause.date.gte = startDate;
                if (endDate)
                    whereClause.date.lte = endDate;
            }
            return yield prisma_1.default.attendanceRecord.findMany({
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
                }
            });
        });
    }
    /**
     * Get leave bank record for a user
     */
    static getUserLeaveBank(userId) {
        return __awaiter(this, void 0, void 0, function* () {
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
                        leaves_remaining: user.leave_bank
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
            const leaveBanks = yield prisma_1.default.leaveBank.findMany({
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
                        leaves_remaining: user.leave_bank
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
            return leaveBanks;
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
            const records = yield this.getUserAttendances(userId, startDate, endDate);
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
            return this.getUserAttendances(userId, startDate, endDate);
        });
    }
    static getAllAbsences(startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.getAllAttendances(startDate, endDate);
        });
    }
    static getUserAbsenceStats(userId, startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.getUserAttendanceStats(userId, startDate, endDate);
        });
    }
}
exports.AbsenceService = AbsenceService;
