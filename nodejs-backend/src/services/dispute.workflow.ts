import { DISPUTE_STATUS } from '../constants/dispute.constants';

export class DisputeWorkflow {
  static computeFinalStatus(leadStatus: string, adminStatus: string, hrStatus: string = 'pending'): string {
    // HR can final-approve or reject
    if (hrStatus === DISPUTE_STATUS.APPROVED) return DISPUTE_STATUS.APPROVED;
    if (hrStatus === DISPUTE_STATUS.REJECTED) return DISPUTE_STATUS.REJECTED;

    // Admin can approve or reject
    if (adminStatus === DISPUTE_STATUS.APPROVED) return DISPUTE_STATUS.APPROVED;
    if (adminStatus === DISPUTE_STATUS.REJECTED) return DISPUTE_STATUS.REJECTED;

    // Lead can reject outright, or partial-approve
    if (leadStatus === DISPUTE_STATUS.REJECTED) return DISPUTE_STATUS.REJECTED;
    if (leadStatus === DISPUTE_STATUS.APPROVED) return DISPUTE_STATUS.PARTIALLY_APPROVED;

    return DISPUTE_STATUS.PENDING;
  }

  static canTransition(currentFinalStatus: string, action: string): boolean {
    if (currentFinalStatus === DISPUTE_STATUS.APPROVED || currentFinalStatus === DISPUTE_STATUS.REJECTED) {
      return ['REOPENED', 'OVERRIDDEN'].includes(action);
    }
    return true;
  }
}
