import React, { useEffect, useRef } from 'react';
import Overlay from './Overlay';
import ScreenSwitch from './ScreenSwitch';

/**
 * Large view of an already-running stream; switches it to 'focus' quality while open.
 * The tile (LiveCell) owns the stream and the screen choice; this view just shows/changes them.
 */
export default function LiveFocus({ agent, stream, setQuality, gridQuality, screen, setScreen, onClose }) {
  const videoRef = useRef(null);

  useEffect(() => {
    setQuality('focus');
    return () => setQuality(gridQuality);
  }, [setQuality]); // eslint-disable-line react-hooks/exhaustive-deps -- gridQuality is read at close; the column choice cannot change while focused

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
    return () => { v.srcObject = null; };
  }, [stream]);

  return (
    <Overlay title={agent.name} subtitle={agent.department || undefined} onClose={onClose}>
      {(agent.screens ?? 1) > 1 && (
        <div className="flex items-center gap-2 px-4 pb-2 text-xs text-neutral-300">
          <span>Screen</span>
          <ScreenSwitch screens={agent.screens} value={screen} onChange={setScreen} />
        </div>
      )}
      <div className="flex aspect-video w-full items-center justify-center bg-black">
        {stream ? (
          <video ref={videoRef} muted autoPlay playsInline className="h-full w-full object-contain" />
        ) : (
          <>
            <video ref={videoRef} muted playsInline className="hidden" />
            <p className="text-sm text-neutral-400">Waiting for stream…</p>
          </>
        )}
      </div>
    </Overlay>
  );
}
