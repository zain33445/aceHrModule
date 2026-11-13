/**
 * screen-watcher.js — ONE shared cursor watcher for the recorder and live view.
 * Polls the cursor every FOLLOW_POLL_MS; the "active display" changes only after the cursor has
 * stayed on another display for FOLLOW_DELAY_MS (agent-policy.followStep).
 */
import electronPkg from 'electron';
const { screen } = electronPkg;
import { FOLLOW_POLL_MS, FOLLOW_DELAY_MS } from './config.js';
import { followStep, numberScreens } from './agent-policy.js';

const _listeners = new Set();
let _timer = null;
let _state;

const _cursorDisplayId = () => String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);

/** Numbered screens of this PC (Screen 1 = primary). */
export const getScreens = () => numberScreens(screen.getAllDisplays(), screen.getPrimaryDisplay().id);

function _poll() {
  try {
    const r = followStep(_state, _cursorDisplayId(), Date.now(), FOLLOW_DELAY_MS);
    _state = r.state;
    if (r.switchTo) for (const fn of _listeners) { try { fn(r.switchTo); } catch { /* listener bug must not stop the watcher */ } }
  } catch { /* screen API unavailable during shutdown */ }
}

/** Display the recorder/follow-mode live view should be on right now (starts from the cursor). */
export function getActiveDisplayId() {
  if (!_state) { try { _state = followStep(undefined, _cursorDisplayId(), Date.now(), FOLLOW_DELAY_MS).state; } catch { return String(screen.getPrimaryDisplay().id); } }
  return _state.current;
}

/** fn(displayId) on every debounced switch. Returns an unsubscribe function. */
export function onActiveDisplay(fn) {
  getActiveDisplayId();
  _listeners.add(fn);
  if (!_timer) { _timer = setInterval(_poll, FOLLOW_POLL_MS); if (typeof _timer.unref === 'function') _timer.unref(); }
  return () => _listeners.delete(fn);
}
