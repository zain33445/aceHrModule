import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, Search, User, Users, Loader2, X } from 'lucide-react';
import api from '../../services/api';
import { useCall } from '../../context/call-context';
import CallHistory from './CallHistory';

/**
 * CallsTab — the "Calls" page.
 *
 * Two parts:
 *   1. Start a call — pick one person (1:1) or several (group mesh, max 4
 *      people including yourself).
 *   2. Call history — the log of past calls.
 */
export default function CallsTab({ user }) {
  const { startCall, status } = useCall();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getEmployees();
      setEmployees(res?.data || []);
    } catch (err) {
      console.error('[CallsTab] could not load employees:', err);
      setError('Could not load the employee list.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  // Keep in step with the backend's CALL_MAX_PARTICIPANTS.
  const MAX_PARTICIPANTS = Math.max(
    2,
    parseInt(import.meta.env.VITE_MAX_CALL_PARTICIPANTS || '3', 10)
  );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees
      .filter((e) => e.id !== user?.user_id)
      .filter((e) => e.status !== 'inactive')
      .filter(
        (e) =>
          !q ||
          (e.name || '').toLowerCase().includes(q) ||
          (e.username || '').toLowerCase().includes(q)
      );
  }, [employees, query, user]);

  const toggle = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_PARTICIPANTS - 1) {
        setError(`A call can have at most ${MAX_PARTICIPANTS} people.`);
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleStart = async () => {
    if (selected.length === 0) return;
    setStarting(true);
    setError(null);
    const id = await startCall(selected);
    setStarting(false);
    if (id) setSelected([]);
  };

  const inCall = status !== 'idle';

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 space-y-8">
        {/* ── Start a call ─────────────────────────────── */}
        <section className="rounded-xl border border-neutral-200 bg-white">
          <div className="px-6 py-4 border-b border-neutral-100">
            <h2 className="text-lg font-semibold text-neutral-900">Start a call</h2>
            <p className="text-sm text-neutral-500">
              Pick one person for a direct call, or several for a group call (up to{' '}
              {MAX_PARTICIPANTS} people in total).
            </p>
          </div>

          <div className="p-6 space-y-4">
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500"
              />
            </div>

            {error && (
              <div className="flex items-center justify-between p-3 rounded-md bg-error/10 border border-error/20 text-sm text-error">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}

            {loading ? (
              <div className="flex items-center gap-2 text-neutral-500 text-sm py-6 justify-center">
                <Loader2 size={16} className="animate-spin" />
                Loading people…
              </div>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-neutral-400 py-6 text-center">Nobody found.</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-neutral-100 rounded-md border border-neutral-100">
                {candidates.map((e) => {
                  const isSelected = selected.includes(e.id);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => toggle(e.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                          isSelected ? 'bg-primary-50' : 'hover:bg-neutral-50'
                        }`}
                      >
                        <span className="w-8 h-8 rounded-full bg-neutral-200 text-neutral-700 flex items-center justify-center text-xs font-semibold shrink-0">
                          {(e.name || '?').charAt(0).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-neutral-900 truncate">
                            {e.name}
                          </span>
                          <span className="block text-xs text-neutral-500">
                            {/* The username disambiguates people who share a
                                name — the org has more than one "Haseeb". */}
                            @{e.username || e.id} · {e.role}
                          </span>
                        </span>
                        {isSelected && (
                          <span className="w-5 h-5 rounded-full bg-primary-500 text-white flex items-center justify-center text-xs">
                            ✓
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-neutral-600">
                <Users size={15} />
                {selected.length === 0
                  ? 'Nobody selected'
                  : `${selected.length + 1} ${selected.length === 0 ? 'person' : 'people'} in the call`}
              </div>
              <button
                type="button"
                onClick={handleStart}
                disabled={selected.length === 0 || starting || inCall}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {starting ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Phone size={15} />
                )}
                Start call
              </button>
            </div>
          </div>
        </section>

        {/* ── History ──────────────────────────────────── */}
        <CallHistory user={user} />
      </div>
    </div>
  );
}
