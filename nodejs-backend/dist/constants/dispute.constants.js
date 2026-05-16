"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTION_TYPES = exports.DISPUTE_STATUS = void 0;
exports.DISPUTE_STATUS = {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
    PARTIALLY_APPROVED: "partially_approved",
};
exports.ACTION_TYPES = {
    CREATED: "CREATED",
    LEAD_APPROVED: "LEAD_APPROVED",
    LEAD_REJECTED: "LEAD_REJECTED",
    ADMIN_APPROVED: "ADMIN_APPROVED",
    ADMIN_REJECTED: "ADMIN_REJECTED",
    OVERRIDDEN: "OVERRIDDEN",
    REOPENED: "REOPENED",
    ESCALATED: "ESCALATED",
};
