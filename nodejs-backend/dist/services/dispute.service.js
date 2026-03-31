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
        // Fallback in case of 0 to avoid Infinity
        return workingDays > 0 ? workingDays : 30;
    }
    // Calculate deduction amount based on category
    static calculateDeductionAmount(category, employeeSalary, date) {
        const workingDays = this.getWorkingDaysInMonth(date.getFullYear(), date.getMonth());
        switch (category) {
            case 'absent':
                return employeeSalary / workingDays; // 1 day deduction
            case 'late':
                return (employeeSalary / workingDays) * 0.5; // 50% of daily salary for late
            case 'half-day':
                return (employeeSalary / workingDays) * 0.5; // 50% of daily salary for half-day
            case 'leave':
                return employeeSalary / workingDays; // 1 day deduction if unauthorized
            default:
                return 0;
        }
    }
    // Get all disputes for a user
    static getUserDisputes(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            return prisma_1.default.dispute.findMany({
                where: { req_by: userId.toString() },
                include: {
                    requester: {
                        select: { id: true, name: true }
                    },
                    approver: {
                        select: { id: true, name: true }
                    }
                },
                orderBy: { date_of_req: 'desc' }
            });
        });
    }
    // Get all pending disputes
    static getPendingDisputes() {
        return __awaiter(this, void 0, void 0, function* () {
            return prisma_1.default.dispute.findMany({
                include: {
                    requester: {
                        select: { id: true, name: true }
                    }
                },
                orderBy: { date_of_req: 'desc' }
            });
        });
    }
    // Create a new dispute
    static createDispute(data) {
        return __awaiter(this, void 0, void 0, function* () {
            return prisma_1.default.dispute.create({
                data: {
                    req_by: data.user_id.toString(),
                    dispute_date: data.dispute_date,
                    category: data.dispute_category || 'other',
                    description: data.description,
                    date_of_req: new Date(),
                    status: data.status || 'pending'
                },
                include: {
                    requester: {
                        select: { id: true, name: true }
                    }
                }
            });
        });
    }
    // Approve a dispute and restore salary deductions
    static approveDispute(disputeId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, remarks = '') {
            const dispute = yield prisma_1.default.dispute.findUnique({
                where: { id: disputeId },
                include: {
                    requester: {
                        select: { id: true, monthly_salary: true }
                    }
                }
            });
            if (!dispute) {
                throw new Error('Dispute not found');
            }
            // Calculate deduction that should be restored
            const deductionAmount = this.calculateDeductionAmount(dispute.category, dispute.requester.monthly_salary, new Date(dispute.dispute_date));
            // Update dispute status
            const updatedDispute = yield prisma_1.default.dispute.update({
                where: { id: disputeId },
                data: {
                    status: 'approved',
                    approved_by: 'admin',
                    remarks,
                    date_of_approve: new Date()
                },
                include: {
                    requester: {
                        select: { id: true, name: true }
                    }
                }
            });
            // Find deduction record for the disputed date and remove it
            // Create date range for the disputed date (start of day to end of day)
            const startOfDay = new Date(dispute.dispute_date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(dispute.dispute_date);
            endOfDay.setHours(23, 59, 59, 999);
            const deductionRecord = yield prisma_1.default.deduction.findFirst({
                where: {
                    user_id: dispute.req_by,
                    date: {
                        gte: startOfDay,
                        lte: endOfDay
                    },
                    type: dispute.category
                }
            });
            if (deductionRecord) {
                // If we found a deduction record, we remove it because the dispute is approved
                yield prisma_1.default.deduction.delete({
                    where: { id: deductionRecord.id }
                });
                console.log(`Deduction record ${deductionRecord.id} removed for user ${dispute.req_by} on ${dispute.dispute_date} due to approved dispute.`);
            }
            else {
                console.log(`No matching deduction record found for user ${dispute.req_by} on ${dispute.dispute_date}. Nothing to remove.`);
            }
            // Create notification for the employee
            const disputeDateStr = new Date(dispute.dispute_date).toLocaleDateString();
            yield prisma_1.default.notification.create({
                data: {
                    user_id: dispute.req_by,
                    type: 'dispute_approved',
                    message: `Your ${dispute.category} dispute for ${disputeDateStr} has been approved.${remarks ? ' Remarks: ' + remarks : ''}`
                }
            });
            return updatedDispute;
        });
    }
    // Reject a dispute
    static rejectDispute(disputeId_1) {
        return __awaiter(this, arguments, void 0, function* (disputeId, remarks = '') {
            const dispute = yield prisma_1.default.dispute.findUnique({
                where: { id: disputeId }
            });
            const updatedDispute = yield prisma_1.default.dispute.update({
                where: { id: disputeId },
                data: {
                    status: 'rejected',
                    approved_by: 'admin',
                    remarks,
                    date_of_approve: new Date()
                },
                include: {
                    requester: {
                        select: { id: true, name: true }
                    }
                }
            });
            // Create notification for the employee
            if (dispute) {
                const disputeDateStr = new Date(dispute.dispute_date).toLocaleDateString();
                yield prisma_1.default.notification.create({
                    data: {
                        user_id: dispute.req_by,
                        type: 'dispute_rejected',
                        message: `Your ${dispute.category} dispute for ${disputeDateStr} has been rejected.${remarks ? ' Remarks: ' + remarks : ''}`
                    }
                });
            }
            return updatedDispute;
        });
    }
}
exports.DisputeService = DisputeService;
