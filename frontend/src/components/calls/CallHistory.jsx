import React, { useCallback, useEffect, useState } from 'react';
import { Phone, PhoneIncoming, PhoneMissed, RefreshCw, Loader2 } from 'lucide-react';
import api from '../../services/api';

/**
 * CallHistory — the call log.
 *
 * Employees see the calls they took part in; admins see every call in the
 * organisation. The rows come from GET /api/call/history.
 */
export default function CallHistory({ user }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCallHistory(200);
      setLogs(res?.data || []);
    } catch (err) {
      console.error('[CallHistory] load failed:', err);
      setError(err?.response?.data?.error || 'Could not load the call history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const outcomeMeta = {
    answered: { label: 'Answered', icon: PhoneIncoming, className: 'text-success' },
    declined: { label: 'Declined', icon: PhoneMissed, className: 'text-neutral-500' },
    missed: { label: 'Missed', icon: PhoneMissed, className: 'text-error' },
    cancelled: { label: 'Cancelled', icon: PhoneMissed, className: 'text-neutral-500' },
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Call history</h2>
          <p className="text-sm text-neutral-500">
            {isAdmin ? 'Every call in the organisation.' : 'Calls you took part in.'}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-error/10 border border-error/20 text-sm text-error">
          {error}
        </div>
      )}

      {loading && logs.length === 0 ? (
        <div className="flex items-center gap-2 text-neutral-500 text-sm py-8 justify-center">
          <Loader2 size={16} className="animate-spin" />
          Loading calls…
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-neutral-400">
          <Phone size={28} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No calls yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-600">
              <tr>
                <th className="text-left font-medium px-4 py-3">When</th>
                <th className="text-left font-medium px-4 py-3">From</th>
                <th className="text-left font-medium px-4 py-3">To</th>
                <th className="text-left font-medium px-4 py-3">Outcome</th>
                <th className="text-right font-medium px-4 py-3">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {logs.map((log) => {
                const meta = outcomeMeta[log.outcome] || outcomeMeta.missed;
                const Icon = meta.icon;
                return (
                  <tr key={log.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 text-neutral-600 whitespace-nowrap">
                      {new Date(log.started_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-neutral-900">
                      {log.from_user?.name || log.from_user_id}
                    </td>
                    <td className="px-4 py-3 text-neutral-900">
                      {log.to_user?.name || log.to_user_id}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 ${meta.className}`}>
                        <Icon size={14} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-600 tabular-nums">
                      {log.duration_sec != null
                        ? `${Math.floor(log.duration_sec / 60)}:${String(
                            log.duration_sec % 60
                          ).padStart(2, '0')}`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
