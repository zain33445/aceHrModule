import React, { useEffect, useState } from 'react';
import api from '../../../services/api';

const OPTIONS = [
  { value: 0, label: 'Forever' },
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
];

const QUALITY_OPTIONS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p (default)' },
  { value: '1080p', label: '1080p' },
];

export default function RecordingSettings() {
  const [days, setDays] = useState(0);
  const [savedDays, setSavedDays] = useState(0);
  const [quality, setQuality] = useState('720p');
  const [savedQuality, setSavedQuality] = useState('720p');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  useEffect(() => {
    api.recordingGetSettings().then(
      (res) => {
        const d = Number(res.data?.retentionDays ?? 0);
        const q = res.data?.quality ?? '720p';
        setDays(d); setSavedDays(d); setQuality(q); setSavedQuality(q); setLoaded(true);
      },
      (err) => { setMsg({ ok: false, text: err.response?.data?.error ?? err.message }); }
    );
  }, []);

  const save = async () => {
    // A shorter (non-forever) retention deletes existing recordings: confirm with the cut-off date.
    if (days > 0 && (savedDays === 0 || days < savedDays)) {
      const cutoff = new Date(Date.now() - days * 86400_000)
        .toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric' });
      if (!window.confirm(`Recordings older than ${days} days (before ${cutoff}) will be permanently deleted. This cannot be undone.`)) return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await api.recordingPutSettings({ retentionDays: days, quality });
      setSavedDays(days);
      setSavedQuality(quality);
      setMsg({ ok: true, text: 'Settings saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error ?? err.message });
    }
    setSaving(false);
  };

  return (
    <div className="max-w-[28rem] space-y-4 rounded-lg border border-neutral-200 bg-white p-5">
      <div>
        <label htmlFor="rec-retention" className="block text-sm font-semibold text-neutral-900">Recording retention</label>
        <p className="mt-0.5 text-xs text-neutral-500">Recordings older than this are deleted automatically.</p>
      </div>
      <select
        id="rec-retention"
        value={days}
        disabled={!loaded}
        onChange={(e) => setDays(Number(e.target.value))}
        className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div>
        <label htmlFor="rec-quality" className="block text-sm font-semibold text-neutral-900">Recording quality</label>
        <p className="mt-0.5 text-xs text-neutral-500">
          Worst case per employee per 9-hour day: 480p ≈ 2.7 GB, 720p ≈ 4.9 GB (default), 1080p ≈ 8 GB. Static screens use less.
          Applies from each employee&apos;s next recording day.
        </p>
      </div>
      <select
        id="rec-quality"
        value={quality}
        disabled={!loaded}
        onChange={(e) => setQuality(e.target.value)}
        className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button
        type="button"
        onClick={save}
        disabled={!loaded || saving || (days === savedDays && quality === savedQuality)}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>
      )}
    </div>
  );
}
