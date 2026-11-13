import React from 'react';

/** Segmented "Follow · 1 · 2 …" switch. value 0 = follow the cursor, 1..N = fixed screen. */
export default function ScreenSwitch({ screens, value, onChange, className = '' }) {
  const opts = [0, ...Array.from({ length: Math.min(screens, 16) }, (_, i) => i + 1)];
  return (
    <div role="group" aria-label="Screen" className={`inline-flex overflow-hidden rounded-md bg-black/70 text-[11px] font-semibold text-white ${className}`}>
      {opts.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          onClick={() => onChange(n)}
          className={`px-2 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ${value === n ? 'bg-white text-neutral-900' : 'hover:bg-white/20'}`}
        >
          {n === 0 ? 'Follow' : n}
        </button>
      ))}
    </div>
  );
}
