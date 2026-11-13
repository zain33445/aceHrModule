import React, { useEffect, useRef, useState } from 'react';
import useLiveStream from '../../../hooks/useLiveStream';
import LiveFocus from './LiveFocus';

const BADGES = {
  live: { label: 'Live', cls: 'bg-red-600 text-white' },
  connecting: { label: 'Connecting', cls: 'bg-amber-100 text-amber-800' },
  reconnecting: { label: 'Reconnecting', cls: 'bg-amber-100 text-amber-800' },
  notRecording: { label: 'Not recording', cls: 'bg-neutral-200 text-neutral-700' },
  diskLow: { label: 'Low disk — recording paused', cls: 'bg-red-100 text-red-800' },
  writeError: { label: 'Disk write error — recording paused', cls: 'bg-red-100 text-red-800' },
  offline: { label: 'Offline', cls: 'bg-neutral-200 text-neutral-700' },
  busy: { label: 'Busy', cls: 'bg-orange-100 text-orange-800' },
  failed: { label: "Can't reach relay — retrying", cls: 'bg-amber-100 text-amber-800' },
  update: { label: 'Update app', cls: 'bg-blue-100 text-blue-800' },
};

function badgeFor(agent, status) {
  if (!agent.connected) return 'reconnecting';
  if (!agent.liveCapable) return 'update';
  if (status === 'unsupported') return 'update';
  if (status === 'offline' || status === 'denied') return 'offline';
  // The agent pauses recording below 2 GB free disk (docs §8); say why.
  if (agent.state === 'write_error') return 'writeError';
  if (!agent.recording) return agent.state === 'disk_low' ? 'diskLow' : 'notRecording';
  if (status === 'busy') return 'busy';
  if (status === 'live') return 'live';
  if (status === 'failed') return 'failed';
  return 'connecting';
}

export default function LiveCell({ hub, agent }) {
  const { stream, status, setQuality } = useLiveStream(hub, agent, true);
  const [focused, setFocused] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
    return () => { v.srcObject = null; };
  }, [stream]);

  const badge = BADGES[badgeFor(agent, status)];

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setFocused(true)}
          disabled={!stream}
          aria-label={`Open live view of ${agent.name}`}
          className="relative block aspect-video w-full bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default"
        >
          <video ref={videoRef} muted autoPlay playsInline className="h-full w-full object-contain" />
          <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
            {badge.label}
          </span>
        </button>
        <div className="px-2.5 py-1.5">
          <p className="truncate text-xs font-semibold text-neutral-900" title={agent.name}>{agent.name}</p>
          <p className="truncate text-[11px] text-neutral-500">{agent.department || 'No department'}</p>
          {agent.loggedIn === false && (
            <p className="truncate text-[11px] italic text-neutral-500">currently logged out</p>
          )}
        </div>
      </div>
      {focused && (
        <LiveFocus agent={agent} stream={stream} setQuality={setQuality} onClose={() => setFocused(false)} />
      )}
    </>
  );
}
