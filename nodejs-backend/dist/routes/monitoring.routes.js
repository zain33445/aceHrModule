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
const express_1 = require("express");
const prisma_1 = __importDefault(require("../prisma"));
const absence_service_1 = require("../services/absence.service");
const router = (0, express_1.Router)();
/**
 * POST /api/monitoring/screenshot
 *
 * Receives screenshot data from the Electron desktop monitor.
 * Body: { userId, appName, timestamp, screenshotBase64 }
 */
router.post('/screenshot', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const { userId, appName, timestamp, screenshotBase64, type = 'check-in' } = req.body;
        if (!appName || !timestamp) {
            return res.status(400).json({ error: 'appName and timestamp are required' });
        }
        const eventTime = new Date(timestamp);
        const timeStr = eventTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); // "HH:MM"
        const rawEventTime = new Date(eventTime.getTime() - (5 * 60 * 60 * 1000));
        const dateStr = rawEventTime.toISOString().split('T')[0];
        let finalUserId = null;
        if (userId && userId !== 'electron-monitor') {
            const userExists = yield prisma_1.default.user.findUnique({ where: { id: userId } });
            if (userExists)
                finalUserId = userId;
        }
        // 1. Save the monitoring log
        const log = yield prisma_1.default.monitoringLog.create({
            data: {
                user_id: finalUserId,
                app_name: appName,
                timestamp: eventTime,
                screenshot_b64: screenshotBase64 || null,
            },
        });
        // 2. Sync with AttendanceRecord if it's a valid user and check-in/out event
        if (finalUserId && (type === 'check-in' || type === 'check-out')) {
            try {
                // Use noon-UTC canonical date to match the cron's format and prevent duplicates
                const attendanceDate = new Date(dateStr + 'T12:00:00.000Z');
                if (type === 'check-in') {
                    // Fetch user shift for status calculation
                    const userWithShift = yield prisma_1.default.user.findUnique({
                        where: { id: finalUserId },
                        include: { department: { include: { shift: true } } }
                    });
                    const shift = ((_a = userWithShift === null || userWithShift === void 0 ? void 0 : userWithShift.department) === null || _a === void 0 ? void 0 : _a.shift) || (yield prisma_1.default.shift.findFirst());
                    let status = 'present';
                    let isLate = false;
                    let isHalfday = false;
                    if (shift) {
                        const shiftType = absence_service_1.AbsenceService.determineShiftType(timeStr, shift);
                        status = absence_service_1.AbsenceService.determineAttendanceStatus(timeStr, shift, shiftType);
                        isLate = status === 'late';
                        isHalfday = status === 'halfday';
                    }
                    // Find if record already exists (e.g., pre-created by cron)
                    const existingRecord = yield prisma_1.default.attendanceRecord.findUnique({
                        where: { user_id_date: { user_id: finalUserId, date: attendanceDate } }
                    });
                    if (!existingRecord) {
                        console.log(`[ATTENDANCE ROUTE] Creating entirely new record for user ${finalUserId} with check-in: ${timeStr}`);
                        // Create today's record
                        yield prisma_1.default.attendanceRecord.create({
                            data: {
                                user_id: finalUserId,
                                date: attendanceDate,
                                check_in_time: timeStr,
                                status: status,
                                is_late: isLate,
                                is_halfday: isHalfday
                            }
                        });
                    }
                    else if (existingRecord.check_in_time === null) {
                        console.log(`[ATTENDANCE ROUTE] Updating existing 'pending' record for user ${finalUserId} to set check-in: ${timeStr}`);
                        // Update today's record ONLY if check-in time is currently null
                        yield prisma_1.default.attendanceRecord.update({
                            where: { id: existingRecord.id },
                            data: {
                                check_in_time: timeStr,
                                status: status,
                                is_late: isLate,
                                is_halfday: isHalfday
                            }
                        });
                    }
                    else {
                        console.log(`[ATTENDANCE ROUTE] Check-in already exists (${existingRecord.check_in_time}) for user ${finalUserId}. Ignoring duplicate check-in to preserve start time!`);
                    }
                    // If existingRecord.check_in_time is NOT null, we do not overwrite it.
                    // This preserves the very first check-in of the day.
                }
                else if (type === 'check-out') {
                    console.log(`[ATTENDANCE ROUTE] Updating check-out time for user ${finalUserId} to ${timeStr}`);
                    // Update today's record with check-out time
                    yield prisma_1.default.attendanceRecord.updateMany({
                        where: { user_id: finalUserId, date: attendanceDate },
                        data: { check_out_time: timeStr }
                    });
                }
            }
            catch (attError) {
                console.error('Attendance sync failed:', attError);
            }
        }
        res.status(201).json({
            success: true,
            id: log.id,
            message: `Monitoring event (${type}) saved for ${appName}`
        });
    }
    catch (error) {
        console.error('Monitoring event save failed:', error);
        res.status(500).json({ error: 'Failed to save monitoring data' });
    }
}));
/**
 * GET /api/monitoring/logs
 *
 * Retrieve monitoring logs with optional filters.
 * Query params: userId, appName, startDate, endDate, page, limit
 */
router.get('/logs', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { userId, appName, startDate, endDate, page = 1, limit = 50, includeScreenshot } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const where = {};
        if (userId)
            where.user_id = userId;
        if (appName)
            where.app_name = appName;
        if (startDate || endDate) {
            where.timestamp = {};
            if (startDate)
                where.timestamp.gte = new Date(startDate);
            if (endDate)
                where.timestamp.lte = new Date(endDate);
        }
        const selectFields = {
            id: true,
            user_id: true,
            app_name: true,
            timestamp: true,
            created_at: true,
            user: { select: { id: true, name: true } },
        };
        if (includeScreenshot === 'true') {
            selectFields.screenshot_b64 = true;
        }
        const [logs, total] = yield Promise.all([
            prisma_1.default.monitoringLog.findMany({
                where,
                select: selectFields,
                orderBy: { timestamp: 'desc' },
                take: Number(limit),
                skip,
            }),
            prisma_1.default.monitoringLog.count({ where }),
        ]);
        res.json({
            logs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (error) {
        console.error('Failed to fetch monitoring logs:', error);
        res.status(500).json({ error: 'Failed to fetch monitoring logs' });
    }
}));
/**
 * GET /api/monitoring/logs/:id
 *
 * Get a single monitoring log with screenshot data.
 */
router.get('/logs/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const log = yield prisma_1.default.monitoringLog.findUnique({
            where: { id: Number(req.params.id) },
            include: {
                user: { select: { id: true, name: true } },
            },
        });
        if (!log) {
            return res.status(404).json({ error: 'Monitoring log not found' });
        }
        res.json(log);
    }
    catch (error) {
        console.error('Failed to fetch monitoring log:', error);
        res.status(500).json({ error: 'Failed to fetch monitoring log' });
    }
}));
exports.default = router;
