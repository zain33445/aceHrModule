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
// Get leave requests (with optional filters)
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, status } = req.query;
    const where = {};
    if (user_id)
        where.user_id = String(user_id);
    if (status && status !== 'all')
        where.status = String(status);
    try {
        const requests = yield prisma_1.default.leaveRequest.findMany({
            where,
            include: {
                user: { select: { id: true, name: true } },
                reviewer: { select: { id: true, name: true } }
            },
            orderBy: { created_at: 'desc' }
        });
        res.json(requests);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch leave requests' });
    }
}));
// Create leave request
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, start_date, end_date, reason } = req.body;
    if (!user_id || !start_date || !end_date || !reason) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const request = yield prisma_1.default.leaveRequest.create({
            data: {
                user_id: String(user_id),
                start_date: new Date(start_date),
                end_date: new Date(end_date),
                reason
            },
            include: { user: { select: { id: true, name: true } } }
        });
        // Notify admins
        const admins = yield prisma_1.default.user.findMany({ where: { role: 'admin' }, select: { id: true } });
        for (const admin of admins) {
            yield prisma_1.default.notification.create({
                data: {
                    user_id: admin.id,
                    type: 'new_leave_request',
                    message: `${request.user.name} submitted a leave request.`
                }
            });
        }
        res.json(request);
    }
    catch (error) {
        console.error('Failed to create leave request:', error);
        res.status(500).json({ error: 'Failed to create leave request' });
    }
}));
// Approve/Reject leave request
router.put('/:id/status', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { status, reviewed_by } = req.body; // status: 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    try {
        const request = yield prisma_1.default.leaveRequest.update({
            where: { id: parseInt(req.params.id) },
            data: { status, reviewed_by: reviewed_by ? String(reviewed_by) : undefined },
            include: { user: { select: { id: true, name: true } } }
        });
        // Notify employee
        yield prisma_1.default.notification.create({
            data: {
                user_id: request.user_id,
                type: `leave_${status}`,
                message: `Your leave request has been ${status}.`
            }
        });
        res.json(request);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update leave request' });
    }
}));
exports.default = router;
