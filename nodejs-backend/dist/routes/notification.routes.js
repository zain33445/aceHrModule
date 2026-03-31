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
// Get notifications for a specific user
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const notifications = yield prisma_1.default.notification.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' },
            take: 50
        });
        res.json(notifications);
    }
    catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
}));
// Mark a single notification as read
router.put('/:id/read', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    try {
        const notification = yield prisma_1.default.notification.update({
            where: { id: parseInt(id) },
            data: { is_read: true }
        });
        res.json(notification);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
}));
// Mark all notifications as read for a user
router.put('/user/:userId/read-all', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        yield prisma_1.default.notification.updateMany({
            where: { user_id: userId, is_read: false },
            data: { is_read: true }
        });
        res.json({ message: "All notifications marked as read" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
}));
exports.default = router;
