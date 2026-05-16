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
// Get all disputes (Admin View)
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { page = 1, limit = 20 } = req.query;
    try {
        const result = yield dispute_service_1.DisputeService.getAdminDisputes(Number(page), Number(limit));
        res.json({
            success: true,
            message: "Disputes fetched successfully",
            data: result
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch disputes" });
    }
}));
// Get team disputes (Lead View)
router.get('/team', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { leadId, page = 1, limit = 20 } = req.query;
    if (!leadId)
        return res.status(400).json({ success: false, error: "leadId is required" });
    try {
        const result = yield dispute_service_1.DisputeService.getTeamDisputes(leadId, Number(page), Number(limit));
        res.json({
            success: true,
            message: "Team disputes fetched successfully",
            data: result
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch team disputes" });
    }
}));
// Get disputes for a specific user
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const disputes = yield dispute_service_1.DisputeService.getUserDisputes(userId);
        res.json({
            success: true,
            message: "User disputes fetched successfully",
            data: disputes
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch user disputes" });
    }
}));
// Create a dispute
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, req_by, description, dispute_date, category } = req.body;
    try {
        const userId = user_id || req_by;
        const dispute = yield dispute_service_1.DisputeService.createDispute({
            user_id: userId,
            dispute_date: new Date(dispute_date),
            category,
            description
        });
        // Notify Leads of the department
        const employee = yield prisma_1.default.user.findUnique({
            where: { id: userId },
            select: { department_id: true, name: true }
        });
        if (employee === null || employee === void 0 ? void 0 : employee.department_id) {
            const dept = yield prisma_1.default.department.findUnique({
                where: { id: employee.department_id },
                select: { lead_id: true }
            });
            if (dept === null || dept === void 0 ? void 0 : dept.lead_id) {
                yield prisma_1.default.notification.create({
                    data: {
                        user_id: dept.lead_id,
                        type: 'new_dispute',
                        message: `${employee.name} filed a new dispute for ${new Date(dispute_date).toLocaleDateString()}.`
                    }
                });
            }
        }
        res.json({ success: true, message: "Dispute created successfully", data: dispute });
    }
    catch (error) {
        console.error('Error creating dispute:', error);
        res.status(500).json({ success: false, error: "Failed to create dispute" });
    }
}));
// Lead Approval Action
router.put('/:id/lead-approval', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { lead_id, action, remarks } = req.body;
    try {
        let dispute;
        if (action === 'approve') {
            dispute = yield dispute_service_1.DisputeService.leadApprove(Number(id), lead_id, remarks);
        }
        else {
            dispute = yield dispute_service_1.DisputeService.leadReject(Number(id), lead_id, remarks);
        }
        res.json({ success: true, message: `Dispute ${action}d by Lead`, data: dispute });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}));
// Admin Approval Action
router.put('/:id/admin-approval', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { admin_id, action, remarks } = req.body;
    try {
        let dispute;
        if (action === 'approve') {
            dispute = yield dispute_service_1.DisputeService.adminApprove(Number(id), admin_id, remarks);
        }
        else {
            dispute = yield dispute_service_1.DisputeService.adminReject(Number(id), admin_id, remarks);
        }
        res.json({ success: true, message: `Dispute ${action}d by Admin`, data: dispute });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}));
// Soft Delete
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    try {
        yield prisma_1.default.dispute.update({
            where: { id: Number(id) },
            data: { is_deleted: true, deleted_at: new Date() }
        });
        res.json({ success: true, message: "Dispute deleted successfully" });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Failed to delete dispute" });
    }
}));
exports.default = router;
