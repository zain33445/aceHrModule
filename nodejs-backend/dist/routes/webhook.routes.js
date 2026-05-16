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
// /api/webhooks/attendance
// Python microservice posts data here
router.post('/attendance', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const logs = req.body;
    if (!Array.isArray(logs)) {
        return res.status(400).json({ error: "Logs must be an array" });
    }
    let insertedCount = 0;
    const syncedDates = [];
    for (const log of logs) {
        try {
            const userId = String(log.user_id);
            const timestamp = new Date(log.timestamp);
            // Check if user exists in our system
            const userExists = yield prisma_1.default.user.findUnique({
                where: { id: userId }
            });
            if (!userExists) {
                console.warn(`[Webhook] Skipping attendance log for unknown user ID: ${userId}`);
                continue;
            }
            yield prisma_1.default.attendanceLog.upsert({
                where: {
                    user_id_timestamp_status: {
                        user_id: userId,
                        timestamp,
                        status: Number(log.status)
                    }
                },
                update: {},
                create: {
                    user_id: userId,
                    timestamp,
                    status: Number(log.status)
                }
            });
            syncedDates.push(timestamp);
            insertedCount++;
        }
        catch (error) {
            console.log(error);
        }
    }
    const syncedUserIds = [...new Set(logs.map((log) => String(log.user_id)))];
    if (syncedUserIds.length > 0) {
        // Fire off the live sync asynchronously in the background so it doesn't block the webhook response
        absence_service_1.AbsenceService.processLiveSync(syncedUserIds, syncedDates.length > 0 ? syncedDates : new Date()).catch(console.error);
    }
    res.json({ message: "Webhook received", inserted: insertedCount, liveSyncedIds: syncedUserIds.length });
}));
router.post('/users', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const users = req.body;
    if (!Array.isArray(users)) {
        return res.status(400).json({ error: "Users must be an array" });
    }
    // Only proceed if the users table is currently empty
    const currentTotalUsers = yield prisma_1.default.user.count();
    if (currentTotalUsers > 0) {
        return res.json({
            message: "Users sync skipped: user table is not empty",
            inserted: 0
        });
    }
    let insertedCount = 0;
    for (const user of users) {
        try {
            const newUser = yield prisma_1.default.user.create({
                data: {
                    id: String(user.user_id),
                    name: user.name,
                    role: 'employee',
                    password_hash: '1234'
                }
            });
            // Create leave bank record for new user
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            yield prisma_1.default.leaveBank.create({
                data: {
                    user_id: String(user.user_id),
                    leaves_remaining: newUser.leave_bank,
                    last_reset_month: currentMonth
                }
            });
            insertedCount++;
        }
        catch (error) {
            console.log(error);
        }
    }
    res.json({ message: "Webhook received", inserted: insertedCount });
}));
exports.default = router;
