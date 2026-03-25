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
// /api/webhooks/attendance
// Python microservice posts data here
router.post('/attendance', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const logs = req.body;
    if (!Array.isArray(logs)) {
        return res.status(400).json({ error: "Logs must be an array" });
    }
    let insertedCount = 0;
    for (const log of logs) {
        try {
            // Attempt to find or create the user implicitly here if wanted,
            // or assume the user sync has already happened.
            yield prisma_1.default.attendanceLog.upsert({
                where: {
                    user_id_timestamp_status: {
                        user_id: String(log.user_id),
                        timestamp: new Date(log.timestamp),
                        status: Number(log.status)
                    }
                },
                update: {},
                create: {
                    user_id: String(log.user_id),
                    timestamp: new Date(log.timestamp),
                    status: Number(log.status)
                }
            });
            insertedCount++;
        }
        catch (error) {
            console.log(error);
            // Duplicate logs or similar constraints are ignored
        }
    }
    res.json({ message: "Webhook received", inserted: insertedCount });
}));
router.post('/users', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const users = req.body;
    if (!Array.isArray(users)) {
        return res.status(400).json({ error: "Users must be an array" });
    }
    let insertedCount = 0;
    for (const user of users) {
        try {
            const userExists = yield prisma_1.default.user.findUnique({
                where: { id: String(user.user_id) }
            });
            if (!userExists) {
                const newUser = yield prisma_1.default.user.create({
                    data: {
                        id: String(user.user_id),
                        name: user.name,
                        role: 'employee',
                        password_hash: '1234'
                    }
                });
                // Create leave bank record for new user
                yield prisma_1.default.leaveBank.create({
                    data: {
                        user_id: String(user.user_id),
                        leaves_remaining: newUser.leave_bank // Use default from user table
                    }
                });
            }
            else {
                yield prisma_1.default.user.update({
                    where: { id: String(user.user_id) },
                    data: {
                        name: user.name,
                    }
                });
            }
            insertedCount++;
        }
        catch (error) {
            // Duplicate logs or similar constraints are ignored
            console.log(error);
        }
    }
    res.json({ message: "Webhook received", inserted: insertedCount });
}));
exports.default = router;
