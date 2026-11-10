import React, { useEffect, useRef } from 'react';
import Overlay from './Overlay';

/** Large view of an already-running stream; switches it to 'focus' quality while open. */
export default function LiveFocus({ agent, stream, setQuality, onClose }) {
  const videoRef = useRef(null);

  useEffect(() => {
    setQuality('focus');
    return () => setQuality('grid');
  }, [setQuality]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
    return () => { v.srcObject = null; };
  }, [stream]);

  return (
    <Overlay title={agent.name} subtitle={agent.department || undefined} onClose={onClose}>
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
