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
const router = (0, express_1.Router)();
/**
 * POST /api/monitoring/screenshot
 *
 * Receives screenshot data from the Electron desktop monitor.
 * Body: { userId, appName, timestamp, screenshotBase64 }
 */
router.post('/screenshot', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { userId, appName, timestamp, screenshotBase64 } = req.body;
        if (!appName || !timestamp) {
            return res.status(400).json({ error: 'appName and timestamp are required' });
        }
        const log = yield prisma_1.default.monitoringLog.create({
            data: {
                user_id: userId || null,
                app_name: appName,
                timestamp: new Date(timestamp),
                screenshot_b64: screenshotBase64 || null,
            },
        });
        res.status(201).json({
            success: true,
            id: log.id,
            message: `Monitoring log saved for ${appName}`
        });
    }
    catch (error) {
        console.error('Monitoring screenshot save failed:', error);
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
        const { userId, appName, startDate, endDate, page = 1, limit = 50 } = req.query;
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
        const [logs, total] = yield Promise.all([
            prisma_1.default.monitoringLog.findMany({
                where,
                select: {
                    id: true,
                    user_id: true,
                    app_name: true,
                    timestamp: true,
                    created_at: true,
                    // Exclude screenshot_b64 from list to save bandwidth
                    user: { select: { id: true, name: true } },
                },
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
