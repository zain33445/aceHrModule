/**
 * RecordingTab.jsx — Recording container (docs/recording-v2.md §14).
 * Tabs: Live | Recordings | Settings (admins only). Recording is always-on, so there
 * are no start/stop controls. One viewer socket (useLiveHub) lives only while the
 * Live tab is mounted.
 */
import React, { useState } from 'react';
import useLiveHub from '../../hooks/useLiveHub';
import LiveGrid from './recording/LiveGrid';
import RecordingsByDay from './recording/RecordingsByDay';
import RecordingSettings from './recording/RecordingSettings';

function LiveTab() {
  const hub = useLiveHub();
  return <LiveGrid hub={hub} />;
}

function readIsAdmin() {
  try {
    const role = JSON.parse(localStorage.getItem('bio_auth') || 'null')?.role;
    return role === 'admin' || role === 'superadmin';
  } catch {
    return false;
  }
}

// `adminId` is accepted for compatibility with AdminDashboardNew and unused.
// eslint-disable-next-line no-unused-vars
export default function RecordingTab({ adminId, employees = [], isAdmin }) {
  const admin = isAdmin ?? readIsAdmin();
  const tabs = [
    { id: 'live', label: 'Live' },
    { id: 'recordings', label: 'Recordings' },
    ...(admin ? [{ id: 'settings', label: 'Settings' }] : []),
  ];
  const [active, setActive] = useState('live');

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Recording sections" className="flex gap-1 border-b border-neutral-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              active === t.id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {active === 'live' && <LiveTab />}
      {active === 'recordings' && <RecordingsByDay employees={employees} />}
      {active === 'settings' && admin && <RecordingSettings />}
    </div>
  );
}
