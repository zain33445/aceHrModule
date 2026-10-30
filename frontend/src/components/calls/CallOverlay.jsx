import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  Users,
  Volume2,
  VolumeX,
  WifiOff,
  X,
  Circle,
  Disc,
} from 'lucide-react';
import { useCall, CALL_STATUS } from '../../context/call-context';

/**
 * CallOverlay — the in-app calling UI.
 *
 * Rendered once at the root of the app so the call is visible over every tab
 * and in both the admin and employee dashboards. It owns three states:
 *
 *   1. Incoming call  — a centred dialog with Accept / Decline
 *   2. In call        — a video grid plus a control bar
 *   3. Error          — a dismissible toast
 */

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * A single video tile.
 *
 * The <video> element is ALWAYS rendered, even when there is no camera feed.
 * That is deliberate: the remote stream carries the participant's audio, and a
 * media element that is never attached to the DOM would silently drop it. So
 * the element is rendered transparently behind the avatar placeholder
 * instead of being removed.
 */
function VideoTile({ stream, name, isLocal, muted, camOn, micOn, className = '' }) {
  const videoRef = useRef(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    const node = videoRef.current;
    if (!node || !stream) return;
    if (node.srcObject !== stream) {
      node.srcObject = stream;
    }
    const play = node.play();
    if (play && typeof play.catch === 'function') {
      play.catch(() => {
        // The browser refused to start playback with sound (autoplay policy).
        // Wait for the next user gesture and try again, otherwise the
        // participant cannot be heard.
        if (!isLocal) setNeedsGesture(true);
      });
    }
  }, [stream, isLocal]);

  // Retry playback as soon as the user interacts with the page.
  useEffect(() => {
    if (!needsGesture) return undefined;

    const retry = () => {
      const node = videoRef.current;
      if (!node) return;
      const p = node.play();
      if (p && typeof p.catch === 'function') {
        p.then(() => setNeedsGesture(false)).catch(() => {});
      }
    };

    document.addEventListener('click', retry, { once: true });
    document.addEventListener('keydown', retry, { once: true });
    return () => {
      document.removeEventListener('click', retry);
      document.removeEventListener('keydown', retry);
    };
  }, [needsGesture]);

  const hasVideo = !!stream && stream.getVideoTracks().length > 0 && camOn;

  // The camera is switched on but no frames arrive — the link is not
  // delivering video, which the user needs to be told about.
  const videoStalled =
    !hasVideo &&
    camOn &&
    !!stream &&
    stream.getVideoTracks().length > 0 &&
    stream.getVideoTracks()[0].muted;

  return (
    <div className={`relative bg-neutral-900 rounded-xl overflow-hidden ${className}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`w-full h-full object-cover ${isLocal ? 'scale-x-[-1]' : ''} ${
          hasVideo ? '' : 'opacity-0 absolute inset-0'
        }`}
      />

      {!hasVideo && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center bg-neutral-800">
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-primary-500 text-white flex items-center justify-center text-xl font-semibold">
              {(name || '?').charAt(0).toUpperCase()}
            </div>
            <span className="text-neutral-300 text-sm">{name || 'Unknown'}</span>
          </div>
        </div>
      )}

      <div className="absolute bottom-2 left-3 flex items-center gap-2 z-10">
        <span className="text-white text-xs font-medium bg-black/50 rounded px-2 py-1">
          {isLocal ? 'You' : name || 'Participant'}
        </span>
        {!micOn && (
          <span className="p-1 rounded-full bg-error/90 text-white" title="Muted">
            <MicOff size={12} />
          </span>
        )}
        {!camOn && (
          <span className="p-1 rounded-full bg-neutral-700/90 text-white" title="Camera off">
            <VideoOff size={12} />
          </span>
        )}
      </div>

      {needsGesture && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-warning/90 text-white text-[11px] font-medium px-2 py-1 rounded">
          <VolumeX size={12} />
          Click to hear {name || 'the participant'}
        </div>
      )}

      {videoStalled && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-neutral-800/90 text-neutral-300 text-[11px] font-medium px-2 py-1 rounded">
          <VideoOff size={12} />
          No video from {name || 'the participant'}
        </div>
      )}
    </div>
  );
}

/** Round control button used in the call control bar. */
function ControlButton({ onClick, active, danger, title, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? 'bg-error text-white hover:bg-red-600'
          : active
            ? 'bg-white text-neutral-900'
            : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {children}
    </button>
  );
}

export default function CallOverlay() {
  const {
    status,
    peers,
    localStream,
    previewStream,
    micOn,
    camOn,
    sharingScreen,
    incomingCall,
    outgoingTargets,
    error,
    elapsed,
    isHost,
    connected,
    recording,
    acceptCall,
    declineCall,
    hangUp,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    clearError,
    startRecording,
    stopRecording,
  } = useCall();

  // Remote audio is on by default: the overlay only appears after the user
  // has clicked "Start call" or "Accept", so the autoplay policy allows it.
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);

  const inCall =
    status === CALL_STATUS.ACTIVE ||
    status === CALL_STATUS.CONNECTING ||
    status === CALL_STATUS.RINGING ||
    status === CALL_STATUS.OUTGOING;

  const ringing = status === CALL_STATUS.INCOMING && incomingCall;

  const targetNames = outgoingTargets
    .map((target) => target.name)
    .filter(Boolean);
  const targetLabel =
    targetNames.length > 0 ? targetNames.join(', ') : 'the other person';

  // Caller ID: the people actually in the call, or the ones being called.
  const peerNames = peers.map((p) => p.name).filter(Boolean);
  const callName = (peerNames.length > 0 ? peerNames : targetNames).join(', ');

  const statusText =
    status === CALL_STATUS.RINGING
      ? `Ringing ${targetLabel}…`
      : `Connecting to ${targetLabel}…`;

  // Reset the remote-mute flag when the call ends (adjust state during render
  // rather than in an effect, so it does not trigger a cascading render).
  const [wasInCall, setWasInCall] = useState(inCall);
  if (wasInCall !== inCall) {
    setWasInCall(inCall);
    if (!inCall) setRemoteMuted(false);
  }

  const handleHangUp = useCallback(() => {
    hangUp();
  }, [hangUp]);

  if (!inCall && !ringing && !error) return null;

  return (
    <>
      {/* ── Incoming call ─────────────────────────────────── */}
      <AnimatePresence>
        {ringing && (
          <Motion.div
            key="incoming-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <Motion.div
              key="incoming-dialog"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              // NOTE: max-w-[24rem] instead of max-w-sm — this project overrides
              // Tailwind's spacing scale (--spacing-sm: 0.5rem), which makes the
              // named max-w-* utilities collapse to a few pixels.
              className="bg-white rounded-2xl shadow-2xl w-full max-w-[24rem] overflow-hidden"
            >
              <div className="pt-10 pb-6 flex flex-col items-center gap-4 bg-gradient-to-b from-primary-50 to-white">
                <Motion.div
                  animate={{ scale: [1, 1.08, 1] }}
                  transition={{ repeat: Infinity, duration: 1.6 }}
                  className="w-20 h-20 rounded-full bg-primary-500 text-white flex items-center justify-center text-2xl font-semibold shadow-lg"
                >
                  {(incomingCall.from?.name || '?').charAt(0).toUpperCase()}
                </Motion.div>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-wide text-primary-600 font-semibold">
                    Incoming call
                  </p>
                  <h3 className="text-xl font-semibold text-neutral-900 mt-1">
                    {incomingCall.from?.name || 'Unknown caller'}
                  </h3>
                </div>
              </div>

              <div className="flex items-center justify-center gap-6 px-6 py-6">
                <button
                  type="button"
                  onClick={declineCall}
                  className="w-14 h-14 rounded-full bg-error text-white flex items-center justify-center hover:bg-red-600 transition-colors"
                  title="Decline"
                  aria-label="Decline call"
                >
                  <PhoneOff size={24} />
                </button>
                <button
                  type="button"
                  onClick={acceptCall}
                  className="w-16 h-16 rounded-full bg-success text-white flex items-center justify-center hover:brightness-110 transition-all shadow-lg"
                  title="Accept"
                  aria-label="Accept call"
                >
                  <Phone size={28} />
                </button>
              </div>
            </Motion.div>
          </Motion.div>
        )}
      </AnimatePresence>

      {/* ── In-call panel ─────────────────────────────────── */}
      <AnimatePresence>
        {inCall && (
          <Motion.div
            key="call-panel"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            // NOTE: max-w-[28rem] instead of max-w-md — this project overrides
            // Tailwind's spacing scale (--spacing-md: 1rem), which makes the
            // named max-w-* utilities collapse to a few pixels.
            className="fixed bottom-4 right-4 z-[80] w-[calc(100vw-2rem)] max-w-[28rem] bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden border border-neutral-700"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-neutral-800/80">
              <div className="flex items-center gap-2 text-white text-sm min-w-0">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
                {callName && (
                  <span className="font-medium truncate" title={callName}>
                    {callName}
                  </span>
                )}
                <span className="text-neutral-400 shrink-0">
                  {status === CALL_STATUS.ACTIVE
                    ? formatDuration(elapsed)
                    : status === CALL_STATUS.RINGING
                      ? 'Ringing…'
                      : 'Connecting…'}
                </span>
                {isHost && (
                  <span className="text-[10px] uppercase tracking-wide bg-primary-500/20 text-primary-300 px-1.5 py-0.5 rounded">
                    host
                  </span>
                )}
                {recording === 'recording' && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide bg-error/20 text-error-300 px-1.5 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />
                    rec
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!connected && (
                  <span
                    className="flex items-center gap-1 text-[11px] text-error bg-error/15 px-2 py-1 rounded"
                    title="The signalling connection dropped. Reconnecting…"
                  >
                    <WifiOff size={12} /> offline
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowParticipants((v) => !v)}
                  className="p-1.5 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-700"
                  title="Participants"
                  aria-label="Toggle participants"
                >
                  <Users size={16} />
                </button>
              </div>
            </div>

            {/* Participants list */}
            <AnimatePresence>
              {showParticipants && (
                <Motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden bg-neutral-800/60"
                >
                  <ul className="px-4 py-2 space-y-1.5 text-sm">
                    <li className="flex items-center justify-between text-neutral-200">
                      <span>You</span>
                      <span className="text-neutral-400 text-xs">
                        {isHost ? 'host' : 'you'}
                      </span>
                    </li>
                    {peers.map((p) => (
                      <li
                        key={p.peerId}
                        className="flex items-center justify-between text-neutral-200"
                      >
                        <span className="truncate">{p.name || 'Unknown'}</span>
                        <span className="flex items-center gap-2 text-neutral-400">
                          {p.mic ? <Mic size={12} /> : <MicOff size={12} />}
                          {p.cam ? <Video size={12} /> : <VideoOff size={12} />}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Motion.div>
              )}
            </AnimatePresence>

            {/* Video grid */}
            <div
              className={`p-2 grid gap-2 ${
                peers.length === 0 ? 'grid-cols-1' : peers.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
              }`}
            >
              {peers.length === 0 ? (
                <div className="aspect-video rounded-xl bg-neutral-800 flex flex-col items-center justify-center gap-2">
                  <span className="text-neutral-300 text-sm">{statusText}</span>
                  <span className="text-neutral-500 text-xs">
                    {status === CALL_STATUS.RINGING
                      ? 'Waiting for an answer'
                      : 'Waiting for someone to come online'}
                  </span>
                </div>
              ) : (
                peers.map((peer) => (
                  <VideoTile
                    key={peer.peerId}
                    stream={peer.stream}
                    name={peer.name}
                    muted={remoteMuted}
                    camOn={peer.cam}
                    micOn={peer.mic}
                    className="aspect-video"
                  />
                ))
              )}

              {/* Your own tile only appears when there is something to see:
                  your camera or your screen share. */}
              {(previewStream || localStream) && (camOn || sharingScreen) && (
                <VideoTile
                  stream={previewStream || localStream}
                  name="You"
                  isLocal
                  muted
                  camOn={camOn || sharingScreen}
                  micOn={micOn}
                  className={`${
                    peers.length === 0 ? 'aspect-video' : 'aspect-video'
                  } ${peers.length > 0 ? 'col-span-2 sm:col-span-1' : ''}`}
                />
              )}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-3 px-4 py-3 bg-neutral-800/80">
              <ControlButton
                onClick={toggleMic}
                active={!micOn}
                title={micOn ? 'Mute microphone' : 'Unmute microphone'}
              >
                {micOn ? <Mic size={18} /> : <MicOff size={18} />}
              </ControlButton>

              <ControlButton
                onClick={toggleCam}
                active={!camOn}
                title={camOn ? 'Turn camera off' : 'Turn camera on'}
              >
                {camOn ? <Video size={18} /> : <VideoOff size={18} />}
              </ControlButton>

              {peers.length <= 1 && (
                <ControlButton
                  onClick={toggleScreenShare}
                  active={sharingScreen}
                  title={sharingScreen ? 'Stop sharing' : 'Share screen'}
                >
                  <MonitorUp size={18} />
                </ControlButton>
              )}

              <ControlButton
                onClick={() => setRemoteMuted((v) => !v)}
                title={remoteMuted ? 'Unmute participants' : 'Mute participants'}
              >
                {remoteMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </ControlButton>

              {/* Only the host sees the record button while it is idle (a
                  restart is host-only). Everyone can stop a running recording
                  by clicking it while it is active. */}
              {(recording === 'recording' || isHost) && (
                <ControlButton
                  onClick={recording === 'recording' ? stopRecording : startRecording}
                  danger={recording === 'recording'}
                  active={recording === 'recording'}
                  title={
                    recording === 'recording'
                      ? 'Stop recording'
                      : 'Start recording'
                  }
                >
                  {recording === 'recording' ? (
                    <Disc size={18} className="animate-pulse" />
                  ) : (
                    <Circle size={18} />
                  )}
                </ControlButton>
              )}

              <ControlButton onClick={handleHangUp} danger title="End call">
                <PhoneOff size={20} />
              </ControlButton>
            </div>
          </Motion.div>
        )}
      </AnimatePresence>

      {/* ── Error toast ───────────────────────────────────── */}
      <AnimatePresence>
        {error && (
          <Motion.div
            key="call-error"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 right-4 z-[95] max-w-[24rem] bg-white border border-neutral-200 rounded-lg shadow-xl px-4 py-3 flex items-start gap-3"
          >
            <p className="text-sm text-neutral-800 flex-1">{error}</p>
            <button
              type="button"
              onClick={clearError}
              className="text-neutral-400 hover:text-neutral-700"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </Motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
