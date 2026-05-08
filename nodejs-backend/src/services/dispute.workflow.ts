import { DISPUTE_STATUS } from '../constants/dispute.constants';

export class DisputeWorkflow {
  static computeFinalStatus(leadStatus: string, adminStatus: string): string {
    if (adminStatus === DISPUTE_STATUS.APPROVED) return DISPUTE_STATUS.APPROVED;
    if (adminStatus === DISPUTE_STATUS.REJECTED) return DISPUTE_STATUS.REJECTED;
    
    if (leadStatus === DISPUTE_STATUS.REJECTED) return DISPUTE_STATUS.REJECTED;
    if (leadStatus === DISPUTE_STATUS.APPROVED) return DISPUTE_STATUS.PARTIALLY_APPROVED;
    
    return DISPUTE_STATUS.PENDING;
  }

  static canTransition(currentFinalStatus: string, action: string): boolean {
    // Basic transition rules
    // Admin can override almost anything
    // Lead can only act on PENDING
    
    if (currentFinalStatus === DISPUTE_STATUS.APPROVED || currentFinalStatus === DISPUTE_STATUS.REJECTED) {
      // Once final, only REOPENED or OVERRIDDEN can change it
      return ['REOPENED', 'OVERRIDDEN'].includes(action);
    }

    return true;
  }
}
