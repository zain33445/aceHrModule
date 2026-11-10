import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Fixed full-screen dialog rendered in a portal. Esc and backdrop click close it. */
export default function Overlay({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-[72rem] flex-col overflow-hidden rounded-xl bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{title}</p>
            {subtitle && <p className="truncate text-xs text-neutral-400">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-neutral-300 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}
