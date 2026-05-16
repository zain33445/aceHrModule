"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeWorkflow = void 0;
const dispute_constants_1 = require("../constants/dispute.constants");
class DisputeWorkflow {
    static computeFinalStatus(leadStatus, adminStatus) {
        if (adminStatus === dispute_constants_1.DISPUTE_STATUS.APPROVED)
            return dispute_constants_1.DISPUTE_STATUS.APPROVED;
        if (adminStatus === dispute_constants_1.DISPUTE_STATUS.REJECTED)
            return dispute_constants_1.DISPUTE_STATUS.REJECTED;
        if (leadStatus === dispute_constants_1.DISPUTE_STATUS.REJECTED)
            return dispute_constants_1.DISPUTE_STATUS.REJECTED;
        if (leadStatus === dispute_constants_1.DISPUTE_STATUS.APPROVED)
            return dispute_constants_1.DISPUTE_STATUS.PARTIALLY_APPROVED;
        return dispute_constants_1.DISPUTE_STATUS.PENDING;
    }
    static canTransition(currentFinalStatus, action) {
        // Basic transition rules
        // Admin can override almost anything
        // Lead can only act on PENDING
        if (currentFinalStatus === dispute_constants_1.DISPUTE_STATUS.APPROVED || currentFinalStatus === dispute_constants_1.DISPUTE_STATUS.REJECTED) {
            // Once final, only REOPENED or OVERRIDDEN can change it
            return ['REOPENED', 'OVERRIDDEN'].includes(action);
        }
        return true;
    }
}
exports.DisputeWorkflow = DisputeWorkflow;
