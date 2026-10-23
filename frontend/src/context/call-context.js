import { createContext, useContext } from 'react';

/**
 * callContext.js — the shared context object and its accessor.
 *
 * Kept in its own module (no JSX) so that CallContext.jsx can export only
 * the <CallProvider> component, which keeps React Fast Refresh working.
 */

export const CallContext = createContext(null);

export const CALL_STATUS = {
  IDLE: 'idle',
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  ENDED: 'ended',
};

/** Access the calling feature. Must be used inside a <CallProvider>. */
export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used inside a <CallProvider>');
  return ctx;
}

export default CallContext;
