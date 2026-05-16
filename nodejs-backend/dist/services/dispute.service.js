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
exports.DisputeService = void 0;
const prisma_1 = __importDefault(require("../prisma"));
const dispute_constants_1 = require("../constants/dispute.constants");
const dispute_workflow_1 = require("./dispute.workflow");
class DisputeService {
    // Helper to get active working days in a month (excluding weekends)
    static getWorkingDaysInMonth(year, month) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let workingDays = 0;
        for (let i = 1; i <= daysInMonth; i++) {
            const dayOfWeek = new Date(year, month, i).getDay();
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                workingDays++;
            }
        }
        return workingDays > 0 ? workingDays : 30;
    }
    // Calculate deduction amount based on category
    static calculateDeductionAmount(category, employeeSalary, date) {
        const workingDays = this.getWorkingDaysInMonth(date.getFullYear(), date.getMonth());
        switch (category) {
            case 'absent':
                return employeeSalary / workingDays;
            case 'late':
            case 'half-day':
                return (employeeSalary / workingDays) * 0.5;
            case 'leave':
                return employeeSalary / workingDays;
            default:
                return 0;
        }
    }
    // Get all disputes for a user
    static getUserDisputes(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            return prisma_1.default.dispute.findMany({
                where: { req_by: userId, is_deleted: false },
                include: {
                    requester: { select: { id: true, name: true } },
                    leadApprover: { select: { id: true, name: true } },
                    adminApprover: { select: { id: true, name: true } },
                    history: { orderBy: { created_at: 'desc' } }
                },
                orderBy: { date_of_req: 'desc' }
            });
        });
    }
    // Get all disputes for admin
    static getAdminDisputes() {
        return __awaiter(this, arguments, void 0, function* (page = 1, limit = 20) {
            const skip = (page - 1) * limit;
            const [records, total] = yield Promise.all([
                prisma_1.default.dispute.findMany({
                    where: { is_deleted: false },
                    include: {
                        requester: { select: { id: true, name: true, department: true } },
                        leadApprover: { select: { id: true, name: true } },
                        adminApprover: { select: { id: true, name: true } }
                    },
                    orderBy: { date_of_req: 'desc' },
                    skip,
                    take: limit
                }),
                prisma_1.default.dispute.count({ where: { is_deleted: false } })
            ]);
            return { records, total };
        });
    }
    // Get team disputes for a lead
    static getTeamDisputes(leadId_1) {
        return __awaiter(this, arguments, void 0, function* (leadId, page = 1, limit = 20) {
            const skip = (page - 1) * limit;
            const departments = yield prisma_1.default.department.findMany({
                where: { lead_id: leadId },
                select: { id: true }
            });
            const deptIds = departments.map(d => d.id);
            const where = {
                requester: { department_id: { in: deptIds } },
                is_deleted: false
            };
            const [records, total] = yield Promise.all([
                prisma_1.default.dispute.findMany({
                    where,
                    include: {
                        requester: { select: { id: true, name: true, department: true } },
                        leadApprover: { select: { id: true, name: true } }
                    },
                    orderBy: { date_of_req: 'desc' },
                    skip,
                    take: limit
                }),
                prisma_1.default.dispute.count({ where })
            ]);
            return { records, total };
        });
    }
    // Create a new dispute
    static createDispute(data) {
        return __awaiter(this, void 0, void 0, function* () {
            return prisma_1.default.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const dispute = yield tx.dispute.create({
                    data: {
                        req_by: data.user_id,
                        dispute_date: data.dispute_date,
                        category: data.category || 'other',
                        description: data.description,
                        date_of_req: new Date(),
                        status: dispute_constants_1.DISPUTE_STATUS.PENDING,
                        lead_status: dispute_constants_1.DISPUTE_STATUS.PENDING,
                        admin_status: dispute_constants_1.DISPUTE_STATUS.PENDING,
                        final_status: dispute_constants_1.DISPUTE_STATUS.PENDING
                    }
                });
                yield tx.disputeHistory.create({
                    data: {
                        dispute_id: dispute.id,
                        actor_id: data.user_id,
                        action: dispute_constants_1.ACTION_TYPES.CREATED,
                        remarks: 'Dispute submitted'
                    }
                });
                return dispute;
            }));
        });
    }
    // Lead Approval
    static leadApprove(disputeId_1, leadId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, leadId, remarks = '') {
            return prisma_1.default.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const dispute = yield tx.dispute.findUnique({ where: { id: disputeId } });
                if (!dispute)
                    throw new Error('Dispute not found');
                if (!dispute_workflow_1.DisputeWorkflow.canTransition(dispute.final_status, dispute_constants_1.ACTION_TYPES.LEAD_APPROVED)) {
                    throw new Error('Invalid workflow transition');
                }
                const finalStatus = dispute_workflow_1.DisputeWorkflow.computeFinalStatus(dispute_constants_1.DISPUTE_STATUS.APPROVED, dispute.admin_status);
                const updated = yield tx.dispute.update({
                    where: { id: disputeId },
                    data: {
                        lead_status: dispute_constants_1.DISPUTE_STATUS.APPROVED,
                        lead_approved_by: leadId,
                        lead_approved_at: new Date(),
                        lead_remarks: remarks,
                        final_status: finalStatus,
                        status: finalStatus // for backward compatibility
                    }
                });
                yield tx.disputeHistory.create({
                    data: {
                        dispute_id: disputeId,
                        actor_id: leadId,
                        action: dispute_constants_1.ACTION_TYPES.LEAD_APPROVED,
                        remarks
                    }
                });
                yield tx.notification.create({
                    data: {
                        user_id: dispute.req_by,
                        type: 'dispute_partially_approved',
                        message: `Your dispute for ${new Date(dispute.dispute_date).toLocaleDateString()} was approved by your Team Lead.`
                    }
                });
                return updated;
            }));
        });
    }
    // Lead Rejection
    static leadReject(disputeId_1, leadId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, leadId, remarks = '') {
            return prisma_1.default.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const dispute = yield tx.dispute.findUnique({ where: { id: disputeId } });
                if (!dispute)
                    throw new Error('Dispute not found');
                const finalStatus = dispute_workflow_1.DisputeWorkflow.computeFinalStatus(dispute_constants_1.DISPUTE_STATUS.REJECTED, dispute.admin_status);
                const updated = yield tx.dispute.update({
                    where: { id: disputeId },
                    data: {
                        lead_status: dispute_constants_1.DISPUTE_STATUS.REJECTED,
                        lead_approved_by: leadId,
                        lead_approved_at: new Date(),
                        lead_remarks: remarks,
                        final_status: finalStatus,
                        status: finalStatus
                    }
                });
                yield tx.disputeHistory.create({
                    data: {
                        dispute_id: disputeId,
                        actor_id: leadId,
                        action: dispute_constants_1.ACTION_TYPES.LEAD_REJECTED,
                        remarks
                    }
                });
                return updated;
            }));
        });
    }
    // Admin Approval (Final)
    static adminApprove(disputeId_1, adminId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, adminId, remarks = '') {
            return prisma_1.default.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const dispute = yield tx.dispute.findUnique({
                    where: { id: disputeId },
                    include: { requester: true }
                });
                if (!dispute)
                    throw new Error('Dispute not found');
                const finalStatus = dispute_workflow_1.DisputeWorkflow.computeFinalStatus(dispute.lead_status, dispute_constants_1.DISPUTE_STATUS.APPROVED);
                const updated = yield tx.dispute.update({
                    where: { id: disputeId },
                    data: {
                        admin_status: dispute_constants_1.DISPUTE_STATUS.APPROVED,
                        admin_approved_by: adminId,
                        admin_approved_at: new Date(),
                        admin_remarks: remarks,
                        final_status: finalStatus,
                        status: finalStatus,
                        approved_by: adminId,
                        date_of_approve: new Date()
                    }
                });
                // Idempotent Salary Restoration
                if (finalStatus === dispute_constants_1.DISPUTE_STATUS.APPROVED && !dispute.salary_restored) {
                    const startOfDay = new Date(dispute.dispute_date);
                    startOfDay.setHours(0, 0, 0, 0);
                    const endOfDay = new Date(dispute.dispute_date);
                    endOfDay.setHours(23, 59, 59, 999);
                    const deduction = yield tx.deduction.findFirst({
                        where: {
                            user_id: dispute.req_by,
                            date: { gte: startOfDay, lte: endOfDay },
                            type: dispute.category
                        }
                    });
                    if (deduction) {
                        yield tx.deduction.delete({ where: { id: deduction.id } });
                        yield tx.dispute.update({
                            where: { id: disputeId },
                            data: { salary_restored: true }
                        });
                    }
                }
                yield tx.disputeHistory.create({
                    data: {
                        dispute_id: disputeId,
                        actor_id: adminId,
                        action: dispute_constants_1.ACTION_TYPES.ADMIN_APPROVED,
                        remarks
                    }
                });
                yield tx.notification.create({
                    data: {
                        user_id: dispute.req_by,
                        type: 'dispute_approved',
                        message: `Your dispute for ${new Date(dispute.dispute_date).toLocaleDateString()} has been fully approved by Admin.`
                    }
                });
                return updated;
            }));
        });
    }
    // Admin Rejection
    static adminReject(disputeId_1, adminId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, adminId, remarks = '') {
            return prisma_1.default.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const dispute = yield tx.dispute.findUnique({ where: { id: disputeId } });
                if (!dispute)
                    throw new Error('Dispute not found');
                const finalStatus = dispute_workflow_1.DisputeWorkflow.computeFinalStatus(dispute.lead_status, dispute_constants_1.DISPUTE_STATUS.REJECTED);
                const updated = yield tx.dispute.update({
                    where: { id: disputeId },
                    data: {
                        admin_status: dispute_constants_1.DISPUTE_STATUS.REJECTED,
                        admin_approved_by: adminId,
                        admin_approved_at: new Date(),
                        admin_remarks: remarks,
                        final_status: finalStatus,
                        status: finalStatus
                    }
                });
                yield tx.disputeHistory.create({
                    data: {
                        dispute_id: disputeId,
                        actor_id: adminId,
                        action: dispute_constants_1.ACTION_TYPES.ADMIN_REJECTED,
                        remarks
                    }
                });
                return updated;
            }));
        });
    }
}
exports.DisputeService = DisputeService;
