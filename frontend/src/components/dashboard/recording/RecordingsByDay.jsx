import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Play } from 'lucide-react';
import api from '../../../services/api';
import { API_BASE } from '../../../services/endpoints';
import Overlay from './Overlay';

const PAGE_SIZE = 50;
const ymd = (d) => d.toLocaleDateString('en-CA');
// Default range is in the company zone, not the browser's (en-CA → YYYY-MM-DD).
const karachiDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(ms);
const TOKEN_REFRESH_MS = 9 * 60_000; // playback tokens live 10 min
const MAX_PLAYBACK_FAILS = 3;
const fieldCls =
  'rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

function fmtHms(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

function fmtHm(ms) {
  const m = Math.floor((ms || 0) / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Derived from Day fields (docs §13).
function dayStatus(d) {
  if ((d.openSegments ?? 0) > 0 || d.status === 'recording') return 'Recording';
  if (d.assembling) return 'Assembling';
  if (d.incompleteSegments > 0) return 'Incomplete';
  if (d.hasFile) return 'Ready';
  // Nothing assembling and no file: a v2 day still waiting for its first
  // assembly, or a legacy session that never produced a video.
  return d.legacy ? 'No video' : 'Waiting';
}

const STATUS_CLS = {
  Recording: 'bg-red-50 text-red-700',
  Assembling: 'bg-amber-50 text-amber-700',
  Ready: 'bg-emerald-50 text-emerald-700',
  Incomplete: 'bg-orange-50 text-orange-700',
  Waiting: 'bg-slate-100 text-slate-600',
  'No video': 'bg-slate-100 text-slate-500',
};

const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) : '—');
function fmtDur(a, b) {
  if (!a || !b) return '—';
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// Segment list of one day (shows which monitor each segment recorded). Loaded on first expand.
function SegmentList({ sessionId }) {
  const [state, setState] = useState({ loading: true, segments: [], error: '' });
  useEffect(() => {
    let stale = false;
    api.recordingGetSession(sessionId).then(
      (res) => { if (!stale) setState({ loading: false, segments: res.data?.segments ?? [], error: '' }); },
      (err) => { if (!stale) setState({ loading: false, segments: [], error: err.response?.data?.error ?? err.message }); }
    );
    return () => { stale = true; };
  }, [sessionId]);
  if (state.loading) return <p className="text-xs text-neutral-500"><Loader2 size={12} className="mr-1 inline animate-spin" />Loading segments…</p>;
  if (state.error) return <p role="alert" className="text-xs text-red-700">{state.error}</p>;
  if (state.segments.length === 0) return <p className="text-xs text-neutral-500">No segments</p>;
  return (
    <table className="text-xs">
      <thead className="text-neutral-500">
        <tr><th className="pr-6 text-left font-medium">Time</th><th className="pr-6 text-left font-medium">Duration</th><th className="text-left font-medium">Screen</th></tr>
      </thead>
      <tbody>
        {state.segments.map((s) => (
          <tr key={s.id} className="text-neutral-700">
            <td className="pr-6 whitespace-nowrap">{fmtClock(s.started_at)}–{fmtClock(s.ended_at)}</td>
            <td className="pr-6 whitespace-nowrap">{fmtDur(s.started_at, s.ended_at)}</td>
            <td>{s.screen ? `Screen ${s.screen}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function dayLabel(d) {
  return d.recordingDate || (d.createdAt ? ymd(new Date(d.createdAt)) : '—');
}

// The token url is `/api/recording/...` (relative to the server origin) — see report.
function absoluteUrl(url) {
  if (/^https?:/i.test(url)) return url;
  if (/^https?:/i.test(API_BASE)) return new URL(url.startsWith('/api/') ? url : `${API_BASE}${url}`, API_BASE).toString();
  return url.startsWith('/api/') ? url : `${API_BASE}${url}`;
}

// <video> with a self-renewing playback token: expired/failed src → new token, same position.
function PlaybackVideo({ sessionId, initialUrl }) {
  const ref = useRef(null);
  const resume = useRef(null); // { t, play } to restore once the new src has loaded
  const fails = useRef(0);
  const busy = useRef(false);
  const broken = useRef(false); // element already failed: its currentTime/paused are reset, don't trust them
  const last = useRef({ t: 0, play: true }); // last position/play state seen while healthy
  const [src, setSrc] = useState(initialUrl);
  const [phase, setPhase] = useState('ok'); // ok | reconnecting | failed

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const snapshot = { ...last.current };
    setPhase('reconnecting');
    for (let i = 0; i < MAX_PLAYBACK_FAILS; i += 1) {
      try {
        const res = await api.recordingPlaybackToken(sessionId);
        resume.current = snapshot;
        setSrc(absoluteUrl(res.data.url));
        setPhase('ok');
        busy.current = false;
        return;
      } catch { await new Promise((r) => setTimeout(r, 1500)); }
    }
    busy.current = false;
    setPhase('failed');
  }, [sessionId]);

  useEffect(() => {
    const id = setInterval(refresh, TOKEN_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // A seek target counts even before data is ready (that is how an expired token shows up).
  const track = (e) => {
    const v = e.currentTarget;
    if (busy.current || broken.current) return;
    if (e.type !== 'seeking' && v.readyState < 2) return;
    last.current = { t: v.currentTime, play: !v.paused && !v.ended };
  };

  const onError = () => {
    broken.current = true;
    if (busy.current) return;
    fails.current += 1;
    if (fails.current >= MAX_PLAYBACK_FAILS) setPhase('failed');
    else refresh();
  };

  const onLoadedMetadata = (e) => {
    fails.current = 0;
    broken.current = false;
    const r = resume.current;
    if (!r) return;
    resume.current = null;
    const v = e.currentTarget;
    v.currentTime = r.t;
    if (r.play) v.play().catch(() => {}); else v.pause();
  };

  if (phase === 'failed') {
    return (
      <p role="alert" className="p-8 text-center text-sm text-neutral-300">
        Playback could not be restored. Close this window and press Play again.
      </p>
    );
  }
  return (
    <div className="relative">
      <video ref={ref} src={src} controls autoPlay onError={onError} onTimeUpdate={track} onSeeking={track} onPlay={track} onPause={track} onLoadedMetadata={onLoadedMetadata}
        className="aspect-video w-full bg-black" />
      {phase === 'reconnecting' && (
        <p role="status" className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">
          <Loader2 size={12} className="mr-1 inline animate-spin" />Reconnecting playback…
        </p>
      )}
    </div>
  );
}

export default function RecordingsByDay({ employees = [] }) {
  const [from, setFrom] = useState(() => karachiDay(Date.now() - 6 * 86400_000));
  const [to, setTo] = useState(() => karachiDay(Date.now()));
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, key: null });
  const [errorState, setErrorState] = useState(null); // { key, msg } — hidden once a newer request starts
  const [player, setPlayer] = useState(null); // { day, url? , error? }
  const [open, setOpen] = useState({}); // sessionId -> segment list expanded
  const playReq = useRef(0); // ignores token responses of a closed modal / superseded Play

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const curPage = Math.min(page, pages); // total shrank (e.g. retention purge): clamp
  const key = `${from}|${to}|${userId}|${curPage}`;
  const error = errorState?.key === key ? errorState.msg : '';
  const loading = data.key !== key && !error;

  useEffect(() => {
    let stale = false;
    api.recordingGetDays({ from, to, userId, page: curPage, pageSize: PAGE_SIZE }).then(
      (res) => {
        if (stale) return;
        setErrorState(null);
        setData({ items: res.data?.items ?? [], total: res.data?.total ?? 0, key });
      },
      (err) => { if (!stale) setErrorState({ key, msg: err.response?.data?.error ?? err.message }); }
    );
    return () => { stale = true; };
  }, [from, to, userId, curPage, key]);

  const play = async (day) => {
    const id = ++playReq.current;
    setPlayer({ day });
    try {
      const res = await api.recordingPlaybackToken(day.sessionId);
      if (id !== playReq.current) return;
      setPlayer({ day, url: absoluteUrl(res.data.url) });
    } catch (err) {
      if (id !== playReq.current) return;
      setPlayer({
        day,
        error: err.response?.status === 409
          ? 'This recording has not been assembled yet. Try again shortly.'
          : `Could not start playback: ${err.response?.data?.error ?? err.message}`,
      });
    }
  };

  // Streams to disk via the download=1 playback URL (no blob in memory).
  const download = async (day) => {
    try {
      const res = await api.recordingPlaybackToken(day.sessionId);
      const a = document.createElement('a');
      a.href = `${absoluteUrl(res.data.url)}&download=1`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      const st = err.response?.status;
      alert(st === 409
        ? 'Recording is not assembled yet. Try again shortly.'
        : st === 403
          ? "You don't have permission to download this recording."
          : `Failed to download recording: ${err.response?.data?.error ?? err.message}`);
    }
  };

  const people = employees.filter((e) => e.role !== 'admin' && e.role !== 'superadmin');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-neutral-600">
          From
          <input type="date" value={from} max={to} onChange={(e) => { const v = e.target.value; setFrom(v); if (v && v > to) setTo(v); setPage(1); }}
            className={`${fieldCls} mt-1 block`} />
        </label>
        <label className="text-xs text-neutral-600">
          To
          <input type="date" value={to} min={from} onChange={(e) => { const v = e.target.value; setTo(v); if (v && v < from) setFrom(v); setPage(1); }}
            className={`${fieldCls} mt-1 block`} />
        </label>
        {people.length > 0 && (
          <label className="text-xs text-neutral-600">
            Employee
            <select value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }}
              className={`${fieldCls} mt-1 block`}>
              <option value="">All employees</option>
              {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-4 py-2.5">Employee</th>
              <th className="px-4 py-2.5">Day</th>
              <th className="px-4 py-2.5">Duration</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {loading && data.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                <Loader2 size={18} className="mr-2 inline animate-spin" />Loading…
              </td></tr>
            )}
            {!loading && !error && data.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-neutral-500">No recordings in this range</td></tr>
            )}
            {data.items.map((d) => {
              const st = dayStatus(d);
              return (
                <Fragment key={d.sessionId}>
                <tr>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-neutral-900">{d.name}</p>
                    <p className="text-xs text-neutral-500">{d.department || ''}</p>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {dayLabel(d)}
                    {d.legacy && <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">legacy</span>}
                    {d.screens > 1 && (
                      <button type="button" aria-expanded={!!open[d.sessionId]} aria-label={`Segments of ${d.name} on ${dayLabel(d)}`}
                        onClick={() => setOpen((o) => ({ ...o, [d.sessionId]: !o[d.sessionId] }))}
                        className="ml-2 inline-flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                        {open[d.sessionId] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{d.screens} screens
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {fmtHms(d.durationMs)}
                    {d.loggedOutMs > 0 && (
                      <p className="text-xs text-neutral-500">includes {fmtHm(d.loggedOutMs)} logged out</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[st]}`}>{st}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button type="button" disabled={!d.hasFile} onClick={() => play(d)}
                        aria-label={`Play recording of ${d.name} on ${dayLabel(d)}`}
                        className="flex items-center gap-1 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                        <Play size={13} /> Play
                      </button>
                      <button type="button" disabled={!d.hasFile} onClick={() => download(d)}
                        aria-label={`Download recording of ${d.name} on ${dayLabel(d)}`}
                        className="flex items-center gap-1 rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                        <Download size={13} /> Download
                      </button>
                    </div>
                  </td>
                </tr>
                {open[d.sessionId] && (
                  <tr className="bg-neutral-50"><td colSpan={5} className="px-4 py-3"><SegmentList sessionId={d.sessionId} /></td></tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm text-neutral-600">
          <button type="button" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}
            className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Previous</button>
          <span>Page {curPage} of {pages}</span>
          <button type="button" disabled={curPage >= pages} onClick={() => setPage(curPage + 1)}
            className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Next</button>
        </div>
      )}

      {player && (
        <Overlay title={player.day.name} subtitle={dayLabel(player.day)} onClose={() => { playReq.current += 1; setPlayer(null); }}>
          {player.error ? (
            <p className="p-8 text-center text-sm text-neutral-300">{player.error}</p>
          ) : player.url ? (
            <PlaybackVideo key={player.url} sessionId={player.day.sessionId} initialUrl={player.url} />
          ) : (
            <p className="p-8 text-center text-sm text-neutral-300">
              <Loader2 size={18} className="mr-2 inline animate-spin" />Preparing playback…
            </p>
          )}
        </Overlay>
      )}
    </div>
  );
}
