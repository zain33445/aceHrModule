'use strict';
/** live-registry.cjs — stream lifecycle with stop-while-starting semantics (A10). Dependency-free. */
function createRegistry({ onClosed = () => { } } = {}) {
  const open = new Map();      // id -> handle
  const pending = new Map();   // id -> { stopped: bool }

  const report = (id) => { try { onClosed(id); } catch { /* listener bug */ } };

  function start(id, startFn) {
    const slot = { stopped: false };
    pending.set(id, slot);
    return Promise.resolve().then(startFn).then(
      (handle) => {
        if (pending.get(id) === slot) pending.delete(id);
        if (slot.stopped) { try { handle?.close?.(); } catch { /* already closed */ } report(id); return null; }
        open.set(id, handle);
        return handle;
      },
      (err) => {
        if (pending.get(id) === slot) pending.delete(id);
        if (slot.stopped) { report(id); return null; }
        throw err;
      },
    );
  }

  function stop(id) {
    const slot = pending.get(id);
    if (slot) { slot.stopped = true; return; }
    const handle = open.get(id);
    if (!handle) return;
    open.delete(id);
    try { handle.close?.(); } catch { /* already closed */ }
    report(id);
  }

  /** Forget an open stream that ended by itself (no close(), no report). */
  const release = (id) => { open.delete(id); };

  return { start, stop, release, count: () => open.size, has: (id) => open.has(id) || pending.has(id), ids: () => [...open.keys(), ...pending.keys()] };
}
module.exports = { createRegistry };
