import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Lock, Search, WifiOff } from 'lucide-react';
import LiveCell from './LiveCell';

const PAGE_SIZE = 16;
const COLS_KEY = 'liveGridCols';
const COLS_CLS = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};
const readCols = () => {
  try {
    const n = Number(localStorage.getItem(COLS_KEY));
    return COLS_CLS[n] ? n : 2;
  } catch {
    return 2;
  }
};
const fieldCls =
  'rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

export default function LiveGrid({ hub }) {
  const { agents, connectionState } = hub;
  // The hub's CONNECTED message already carries the iceServers: a relay exists when one is turn:/turns:.
  const noRelay = connectionState === 'open' && !hub.getIceServers().some((s) =>
    [].concat(s.urls || s.url || []).some((u) => /^turns?:/.test(u)));
  const [dept, setDept] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState(readCols);
  const pickCols = (n) => {
    setCols(n);
    try { localStorage.setItem(COLS_KEY, String(n)); } catch { /* per-viewer convenience only */ }
  };

  const departments = useMemo(
    () => [...new Set(agents.map((a) => a.department).filter(Boolean))].sort(),
    [agents]
  );

  // The selected department vanished from the agent list: behave as "all".
  const activeDept = departments.includes(dept) ? dept : '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter((a) => (!activeDept || a.department === activeDept) && (!q || (a.name || '').toLowerCase().includes(q)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [agents, activeDept, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  if (connectionState === 'denied') {
    return (
      <div role="alert" className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 py-16 text-sm text-neutral-600">
        <Lock size={16} />
        You don't have access to live recording
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connectionState !== 'open' && (
        <div role="status" className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <WifiOff size={16} />
          {connectionState === 'connecting' ? 'Connecting to live view…' : 'Live connection lost — reconnecting…'}
        </div>
      )}

      {noRelay && (
        <p className="text-xs text-neutral-500">
          Remote viewing (outside the office) needs the TURN relay — see docs/live-view-turn.md.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={activeDept}
          onChange={(e) => { setDept(e.target.value); setPage(1); }}
          aria-label="Filter by department"
          className={fieldCls}
        >
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search name"
            aria-label="Search by name"
            className={`${fieldCls} pl-8`}
          />
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm text-neutral-600">
          <div role="group" aria-label="Grid columns" className="mr-2 flex items-center gap-1">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={cols === n}
                aria-label={`${n} columns`}
                onClick={() => pickCols(n)}
                className={`rounded-md border px-2.5 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  cols === n ? 'border-blue-600 bg-blue-600 text-white' : 'border-neutral-300 hover:bg-neutral-50'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
            className="rounded-md border border-neutral-300 p-1.5 hover:bg-neutral-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <ChevronLeft size={16} />
          </button>
          <span>Page {current} of {pages}</span>
          <button
            type="button"
            aria-label="Next page"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
            className="rounded-md border border-neutral-300 p-1.5 hover:bg-neutral-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 py-16 text-center text-sm text-neutral-500">
          No one is recording right now
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 py-16 text-center text-sm text-neutral-500">
          No one matches the filter
        </div>
      ) : (
        <div className={`grid grid-cols-1 gap-3 ${COLS_CLS[cols]}`}>
          {visible.map((a) => <LiveCell key={a.userId} hub={hub} agent={a} />)}
        </div>
      )}
    </div>
  );
}
