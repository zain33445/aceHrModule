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
const dispute_service_1 = require("../services/dispute.service");
const prisma_1 = __importDefault(require("../prisma"));
const router = (0, express_1.Router)();
// Get all disputes (including pending and resolved)
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const disputes = yield prisma_1.default.dispute.findMany({
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date_of_req: 'desc'
            }
        });
        res.json(disputes);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch disputes" });
    }
}));
// Get disputes requested by a specific user
router.get('/requested/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const disputes = yield prisma_1.default.dispute.findMany({
            where: { req_by: userId },
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date_of_req: 'desc'
            }
        });
        res.json(disputes);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user disputes" });
    }
}));
// Get disputes for a specific user (alias for /requested/:userId)
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const disputes = yield prisma_1.default.dispute.findMany({
            where: { req_by: userId },
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date_of_req: 'desc'
            }
        });
        res.json(disputes);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user disputes" });
    }
}));
// Get disputes approved by a specific user
router.get('/approved/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const disputes = yield prisma_1.default.dispute.findMany({
            where: { approved_by: userId },
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date_of_req: 'desc'
            }
        });
        res.json(disputes);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch approved disputes" });
    }
}));
// Get all pending disputes (for admin) - returns all disputes for filtering
router.get('/pending', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const disputes = yield dispute_service_1.DisputeService.getPendingDisputes();
        res.json(disputes);
    }
    catch (error) {
        console.error('Error fetching pending disputes:', error);
        res.status(500).json({ error: "Failed to fetch pending disputes" });
    }
}));
// Create a dispute
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, req_by, description, dispute_date, category, date_of_req, status } = req.body;
    try {
        const userId = user_id || req_by;
        const disputeCategory = category || 'other';
        const dispute = yield dispute_service_1.DisputeService.createDispute({
            user_id: userId,
            dispute_date: new Date(dispute_date),
            dispute_category: disputeCategory,
            description,
            status: status || 'pending'
        });
        res.json(dispute);
    }
    catch (error) {
        console.error('Error creating dispute:', error);
        res.status(500).json({ error: "Failed to create dispute" });
    }
}));
// Update dispute status (approve/reject)
router.put('/:id/status', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { approved_by, remarks, date_of_approve, status } = req.body;
    try {
        const dispute = yield prisma_1.default.dispute.update({
            where: { id: parseInt(id) },
            data: {
                approved_by,
                remarks,
                date_of_approve: date_of_approve ? new Date(date_of_approve) : new Date(),
                status
            },
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
        res.json({ message: "Dispute status updated", dispute });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update dispute status" });
    }
}));
// Update a dispute
router.put('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { description, remarks, status } = req.body;
    try {
        const dispute = yield prisma_1.default.dispute.update({
            where: { id: parseInt(id) },
            data: {
                description,
                remarks,
                status
            },
            include: {
                requester: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                approver: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
        res.json({ message: "Dispute updated", dispute });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update dispute" });
    }
}));
// Approve a dispute
router.put('/:id/approve', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { remarks, approved_by } = req.body;
    try {
        const dispute = yield dispute_service_1.DisputeService.approveDispute(parseInt(id), remarks || '');
        res.json(dispute);
    }
    catch (error) {
        console.error('Error approving dispute:', error);
        res.status(500).json({ error: "Failed to approve dispute" });
    }
}));
// Reject a dispute
router.put('/:id/reject', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { remarks, approved_by } = req.body;
    try {
        const dispute = yield dispute_service_1.DisputeService.rejectDispute(parseInt(id), remarks || '');
        res.json(dispute);
    }
    catch (error) {
        console.error('Error rejecting dispute:', error);
        res.status(500).json({ error: "Failed to reject dispute" });
    }
}));
// Delete a dispute
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    try {
        yield prisma_1.default.dispute.delete({
            where: { id: parseInt(id) }
        });
        res.json({ message: "Dispute deleted" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to delete dispute" });
    }
}));
exports.default = router;
