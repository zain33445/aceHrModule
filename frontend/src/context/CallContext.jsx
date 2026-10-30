import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import useCallSocket from '../hooks/useCallSocket';
import CallMesh from '../lib/callMesh';
import { CallAudioRecorder } from '../lib/audioRecorder';
import {
  startIncomingRing,
  startRingback,
  stopAllSounds,
  stopIncomingRing,
  stopRingback,
  unlockSounds,
} from '../lib/sounds';
import { CallContext, CALL_STATUS } from './call-context';

/**
 * CallContext — the single shared source of truth for the calling feature.
 *
 * This is the first shared-state mechanism in the app (there is no Redux or
 * store), so it also owns the lifecycle of the WebRTC mesh, the signalling
 * socket and the local media.
 *
 * It is mounted once, at the root of the app, so that the call overlay is
 * available over every tab and in both the admin and employee dashboards.
 */

/**
 * @param {object} props
 * @param {object} props.user          the signed-in user
 * @param {boolean} [props.enabled]    set to false on surfaces that must not
 *   open a call socket (the floating Electron chat window), so a user cannot
 *   end up with two peers for the same call.
 */
export function CallProvider({ user, children, enabled = true }) {  const userId = user?.user_id || null;

  const [status, setStatus] = useState(CALL_STATUS.IDLE);
  const [callId, setCallId] = useState(null);
  const [selfPeerId, setSelfPeerId] = useState(null);
  const [peers, setPeers] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [previewStream, setPreviewStream] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [incomingCall, setIncomingCall] = useState(null);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isHost, setIsHost] = useState(false);
  /** People this user is calling, so the overlay can show their names. */
  const [outgoingTargets, setOutgoingTargets] = useState([]);
  /** 'idle' | 'recording' */
  const [recording, setRecording] = useState('idle');

  const meshRef = useRef(null);
  const pendingJoinRef = useRef(null);
  const joinSentRef = useRef(null);
  const sendRef = useRef(() => false);
  const sendNowRef = useRef(() => false);
  const callIdRef = useRef(null);
  const startedAtRef = useRef(null);
  const incomingRef = useRef(null);
  const localStreamRef = useRef(null);
  const recorderRef = useRef(null);
  const statusRef = useRef(CALL_STATUS.IDLE);
  const connectedRef = useRef(false);
  const outgoingTargetIdsRef = useRef([]);
  const targetNamesRef = useRef({});
  /** Prevents a delegated start request from being handled twice. */
  const delegatedStartRef = useRef(false);

  // ── Mesh setup ──────────────────────────────────────────

  /**
   * Adds or updates a peer in the state.
   *
   * The remote stream can arrive before the peer has been announced (the
   * other side may offer first), so the stream is merged in rather than
   * dropped — losing it would leave the participant silent.
   */
  const upsertPeer = useCallback((peer, stream) => {
    setPeers((prev) => {
      const idx = prev.findIndex((p) => p.peerId === peer.peerId);
      const base = idx >= 0 ? prev[idx] : { mic: true, cam: true, stream: null };
      const merged = { ...base };
      // Only overwrite fields that were actually provided. The remote stream
      // arrives before (or after) the peer announcement and must never blank
      // out the real name with a generic label.
      for (const [key, value] of Object.entries(peer)) {
        if (value !== undefined && value !== null && value !== '') merged[key] = value;
      }
      if (stream) merged.stream = stream;
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = merged;
        return next;
      }
      return [...prev, merged];
    });
  }, []);

  const ensureMesh = useCallback(() => {
    if (meshRef.current) return meshRef.current;

    const mesh = new CallMesh({
      sendSignal: (peerId, signalType, payload) => {
        const id = callIdRef.current;
        if (!id) return;
        sendRef.current({
          type: 'CALL_SIGNAL',
          callId: id,
          toPeerId: peerId,
          signalType,
          payload,
        });
      },
      onRemoteStream: (peerId, stream) => {
        upsertPeer({ peerId }, stream);
        // Audio tracks can arrive after the recording was started (or after
        // the call connected). Mix them in so no participant is left out.
        recorderRef.current?.addRemoteStream(stream);
      },
      onPeerGone: (peerId) => {
        setPeers((prev) => prev.filter((p) => p.peerId !== peerId));
      },
      onLocalStream: (stream) => {
        localStreamRef.current = stream;
        setLocalStream(stream);
        setPreviewStream(stream);
      },
      onMediaState: ({ mic, cam }) => {
        setMicOn(mic);
        setCamOn(cam);
        const id = callIdRef.current;
        if (id) {
          sendRef.current({ type: 'CALL_MEDIA_STATE', callId: id, mic, cam });
        }
      },
    });

    meshRef.current = mesh;
    // Exposed for the automated browser tests to inspect the mesh state.
    if (typeof window !== 'undefined') window.__callMesh = mesh;
    return mesh;
  }, [upsertPeer]);

  // ── Signalling ───────────────────────────────────────────

  const sendJoin = useCallback(() => {
    const id = pendingJoinRef.current;
    if (!id) return;
    // Not queued: a join is retried explicitly when the socket reconnects.
    // A join that is already in flight is not repeated — the extra join
    // would make the others rebuild their connections.
    if (joinSentRef.current === id) return;
    if (sendNowRef.current({ type: 'CALL_JOIN', callId: id })) {
      pendingJoinRef.current = null;
      joinSentRef.current = id;
    }
  }, []);

  // ── Recording ────────────────────────────────────────────

  /** Starts recording the local mix of the call and uploads the chunks. */
  /**
   * Explains why the microphone is unavailable.
   *
   * Browsers only expose `navigator.mediaDevices` on a secure origin.
   * `http://localhost` counts as secure, but a LAN address such as
   * `http://192.168.18.65:5173` does not — and without this check the call
   * would simply connect with no audio and no explanation.
   */
  const mediaUnavailableReason = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (window.isSecureContext === false) {
      return (
        'This page is not on a secure connection, so the browser has blocked the ' +
        'camera and microphone. Use http://localhost, or serve the dev server over HTTPS.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return 'This browser does not support camera and microphone capture.';
    }
    return null;
  }, []);

  const startLocalRecording = useCallback(async () => {
    const id = callIdRef.current;
    if (!id || recorderRef.current?.active) return;

    // The recording is started as soon as the call connects, which may race
    // with microphone acquisition. Wait for the shared stream instead of
    // starting with no local audio.
    if (meshRef.current && !localStreamRef.current) {
      try {
        await meshRef.current.ensureLocalStream();
      } catch (err) {
        console.error('[Call] no local microphone for the recording:', err);
      }
    }

    const recorder = new CallAudioRecorder({
      uploadChunk: async (chunkIndex, buffer) => {
        await api.uploadCallChunk(id, chunkIndex, buffer);
      },
    });

    const remoteStreams = meshRef.current
      ? Array.from(meshRef.current.getRemoteStreams().values())
      : [];

    try {
      await recorder.start(localStreamRef.current, remoteStreams);
      recorderRef.current = recorder;
      // Pick up anything that connected while the recorder was starting.
      if (meshRef.current) {
        for (const stream of meshRef.current.getRemoteStreams().values()) {
          recorder.addRemoteStream(stream);
        }
      }
      setRecording('recording');
    } catch (err) {
      console.error('[Call] could not start recording:', err);
      setError('The recording could not be started.');
    }
  }, []);

  /**
   * Stops the local recording. Resolves once the final audio chunk has been
   * uploaded — the server assembles the file when the call ends, so this has
   * to finish before the end-of-call signal is sent.
   */
  const stopLocalRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    try {
      await recorder.stop();
    } catch (err) {
      console.error('[Call] could not stop the recording cleanly:', err);
    }
  }, []);

  const handleEvent = useCallback(
    (msg) => {
      switch (msg.type) {
        case 'CONNECTED': {
          // Only join if a join is actually pending. A duplicate CONNECTED
          // (for example the extra socket React StrictMode opens on mount)
          // must never trigger a second join.
          if (pendingJoinRef.current) {
            sendJoin();
          }
          break;
        }

        case 'CALL_INCOMING': {
          // Already in a call (or already showing another incoming call):
          // decline the new invite instead of tearing down the live one. A
          // reconnect replays the *same* invite, so that one must not be
          // declined.
          if (
            statusRef.current !== CALL_STATUS.IDLE &&
            incomingRef.current?.callId !== msg.callId
          ) {
            api.declineCall(msg.callId).catch(() => {});
            break;
          }
          // A reconnect replays the invite that is already ringing. Raising
          // the native notification again would make it flicker.
          if (incomingRef.current?.callId === msg.callId) break;

          statusRef.current = CALL_STATUS.INCOMING;
          incomingRef.current = { callId: msg.callId, from: msg.from };
          setIncomingCall({ callId: msg.callId, from: msg.from });
          setStatus(CALL_STATUS.INCOMING);
          // Raise a native OS notification (Electron agent) so the call can be
          // answered even when the app window is hidden in the tray.
          try {
            window.electronAPI?.call?.notifyIncoming({
              callId: msg.callId,
              fromName: msg.from?.name,
            });
          } catch (err) {
            console.error('[Call] could not raise the incoming-call notification:', err);
          }
          break;
        }

        case 'CALL_RINGING': {
          // The server tells us whether at least one callee is actually
          // reachable. Online -> "Ringing…"; all offline -> stay on
          // "Connecting…" until somebody comes online.
          // The first notice can arrive before the REST call returns the id.
          if (callIdRef.current && msg.callId !== callIdRef.current) break;
          const online = Array.isArray(msg.onlineUserIds) ? msg.onlineUserIds : [];
          if (online.length > 0) {
            setStatus((prev) =>
              prev === CALL_STATUS.ACTIVE ? prev : CALL_STATUS.RINGING
            );
          } else {
            setStatus((prev) =>
              prev === CALL_STATUS.RINGING ? CALL_STATUS.OUTGOING : prev
            );
          }
          break;
        }

        case 'CALL_JOINED': {
          setCallId(msg.callId);
          callIdRef.current = msg.callId;
          setSelfPeerId(msg.selfPeerId);
          joinSentRef.current = null;
          setStatus((prev) =>
            prev === CALL_STATUS.ACTIVE || prev === CALL_STATUS.RINGING
              ? prev
              : CALL_STATUS.CONNECTING
          );

          const mesh = ensureMesh();
          mesh.setSelfPeerId(msg.selfPeerId);

          const list = (msg.peers || []).map((p) => ({
            peerId: p.peerId,
            userId: p.userId,
            name: p.name,
            mic: true,
            cam: true,
            stream: null,
          }));

          // Only drop the connections that are really gone. A repeated
          // CALL_JOINED (the same participant joining twice) must not tear
          // down connections that are working — rebuilding them mid
          // negotiation leaves a peer without any media.
          const wanted = new Set(list.map((p) => p.peerId));
          for (const peerId of Array.from(mesh.peers.keys())) {
            if (!wanted.has(peerId)) mesh.removePeer(peerId);
          }

          setPeers(list);

          // The joiner is the offerer towards every peer already present.
          (async () => {
            try {
              const blocked = mediaUnavailableReason();
              if (blocked) {
                setError(blocked);
                return;
              }
              await mesh.ensureLocalStream();
              for (const peer of list) {
                if (!mesh.peers.has(peer.peerId)) {
                  await mesh.createPeer(peer.peerId);
                }
              }
            } catch (err) {
              console.error('[Call] could not start local media:', err);
              setError('Could not access your camera or microphone.');
            }
          })();
          break;
        }

        case 'CALL_PEER_JOINED': {
          const peer = msg.peer;
          upsertPeer({
            peerId: peer.peerId,
            userId: peer.userId,
            name: peer.name,
          });
          // Somebody answered: the ringing is over, now we establish media.
          setStatus((prev) =>
            prev === CALL_STATUS.ACTIVE ? prev : CALL_STATUS.CONNECTING
          );
          ensureMesh().createPeer(peer.peerId).catch((err) =>
            console.error('[Call] could not open peer connection:', err)
          );
          break;
        }

        case 'CALL_PEER_LEFT':
          setPeers((prev) => prev.filter((p) => p.peerId !== msg.peerId));
          meshRef.current?.removePeer(msg.peerId);
          break;

        case 'CALL_SIGNAL':
          meshRef.current?.handleSignal(msg.fromPeerId, msg.signalType, msg.payload);
          break;

        case 'CALL_MEDIA_STATE':
          setPeers((prev) =>
            prev.map((p) =>
              p.peerId === msg.peerId ? { ...p, mic: msg.mic, cam: msg.cam } : p
            )
          );
          break;

        case 'CALL_DECLINED': {
          const calleeId = msg.calleeUserId;
          const name = targetNamesRef.current[calleeId] || 'The person';
          if (calleeId) {
            outgoingTargetIdsRef.current = outgoingTargetIdsRef.current.filter(
              (id) => id !== calleeId
            );
          }
          setError(`${name} declined the call.`);
          // In a 1:1 call there is nobody left to ring.
          if (outgoingTargetIdsRef.current.length === 0) {
            resetCall();
          }
          break;
        }

        case 'CALL_CANCELLED':
        case 'CALL_ENDED': {
          // Only end the call this notice is about. A late notice for a call
          // already left must not tear down the next one.
          const current = callIdRef.current || incomingRef.current?.callId;
          if (msg.callId && msg.callId !== current) break;
          if (msg.reason === 'no_answer') setError('No answer.');
          resetCall();
          break;
        }

        case 'CALL_ERROR':
          setError(msg.message || 'The call could not be started.');
          resetCall();
          break;

        // ── Recording ────────────────────────────────────
        case 'CALL_RECORD_START':
          startLocalRecording();
          break;

        case 'CALL_RECORD_STOP':
          stopLocalRecording();
          setRecording('idle');
          break;

        default:
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ensureMesh, mediaUnavailableReason]
  );

  const { connected, connecting, send, sendNow, reconnect } = useCallSocket({
    enabled: !!userId && enabled,
    onEvent: handleEvent,
    onReconnect: () => {
      // The signalling socket dropped and came back. The server has forgotten
      // our peer, so re-join the call to get a fresh peer id and renegotiate.
      if (callIdRef.current) {
        pendingJoinRef.current = callIdRef.current;
        sendJoin();
      }
    },
  });

  useEffect(() => {
    sendRef.current = send;
    sendNowRef.current = sendNow;
  }, [send, sendNow]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Keep the status ref in sync and drive the ringtones from it. A ringtone
  // must play only while the state is really ringing, and stop immediately on
  // answer, decline, cancel or drop.
  useEffect(() => {
    statusRef.current = status;

    if (status === CALL_STATUS.RINGING && connected) {
      startRingback();
    } else {
      stopRingback();
    }

    if (status === CALL_STATUS.INCOMING && connected) {
      startIncomingRing();
    } else {
      stopIncomingRing();
    }
  }, [status, connected]);

  useEffect(() => () => stopAllSounds(), []);

  // ── Lifecycle ────────────────────────────────────────────

  const resetCall = useCallback(() => {
    const id = callIdRef.current;
    if (id) sendRef.current({ type: 'CALL_LEAVE', callId: id });

    stopLocalRecording().catch(() => {});
    stopAllSounds();

    meshRef.current?.close();
    meshRef.current = null;

    pendingJoinRef.current = null;
    callIdRef.current = null;
    startedAtRef.current = null;
    incomingRef.current = null;
    localStreamRef.current = null;
    statusRef.current = CALL_STATUS.IDLE;
    outgoingTargetIdsRef.current = [];
    targetNamesRef.current = {};

    // Clear any native incoming-call notification.
    try {
      window.electronAPI?.call?.notifyEnded({});
    } catch {
      /* not running under Electron */
    }

    setStatus(CALL_STATUS.IDLE);
    setCallId(null);
    setSelfPeerId(null);
    setPeers([]);
    setLocalStream(null);
    setPreviewStream(null);
    setIncomingCall(null);
    setOutgoingTargets([]);
    setIsHost(false);
    setSharingScreen(false);
    setMicOn(true);
    setCamOn(false);
    setElapsed(0);
    setRecording('idle');
  }, [stopLocalRecording]);

  // Elapsed call timer.
  useEffect(() => {
    if (status !== CALL_STATUS.ACTIVE && status !== CALL_STATUS.CONNECTING) {
      return undefined;
    }
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [status]);

  // A call becomes active once at least one remote peer is connected.
  useEffect(() => {
    if (status === CALL_STATUS.CONNECTING && peers.length > 0) {
      setStatus(CALL_STATUS.ACTIVE);
    }
  }, [peers, status]);

  // The first accepted participant activates the call server-side.
  const markActive = useCallback(() => {
    if (status === CALL_STATUS.ACTIVE) return;
    setStatus(CALL_STATUS.ACTIVE);
    if (!startedAtRef.current) startedAtRef.current = Date.now();
  }, [status]);

  useEffect(() => {
    if (peers.length > 0) markActive();
  }, [peers.length, markActive]);

  // ── Public actions ───────────────────────────────────────

  const startCall = useCallback(
    async (targetUserIds, conversationId) => {
      if (!userId) return null;
      if (!enabled) {
        setError('Calling is not available on this screen.');
        return null;
      }
      if (!targetUserIds || targetUserIds.length === 0) return null;

      // A call cannot be placed without a signalling socket, and the caller
      // must be told that plainly instead of watching "Connecting…" forever.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setError("Can't make the call — you are offline.");
        return null;
      }
      if (!connectedRef.current) {
        setError(
          "Can't make the call — the call service is not connected. Check your connection and try again."
        );
        return null;
      }

      // A call without a microphone is pointless, and the browser will not
      // even expose the capture APIs on an insecure origin. Say so up front
      // instead of connecting silently.
      const blocked = mediaUnavailableReason();
      if (blocked) {
        setError(blocked);
        return null;
      }

      unlockSounds();
      setError(null);
      setOutgoingTargets([]);
      statusRef.current = CALL_STATUS.OUTGOING;
      setStatus(CALL_STATUS.OUTGOING);

      try {
        const res = await api.startCall(userId, targetUserIds, conversationId);
        const data = res?.data || {};
        const id = data.id;
        if (!id) throw new Error('The call could not be created.');

        const names = {};
        for (const target of data.target_users || []) {
          if (target?.id) names[target.id] = target.name;
        }
        targetNamesRef.current = names;
        outgoingTargetIdsRef.current = [...targetUserIds];
        setOutgoingTargets(
          targetUserIds.map((targetId) => ({
            id: targetId,
            name: names[targetId] || '',
          }))
        );

        callIdRef.current = id;
        setCallId(id);
        setIsHost(true);
        pendingJoinRef.current = id;
        sendJoin();

        // The server reports which callees are actually connected. Only then
        // does the caller see "Ringing…"; otherwise they stay on "Connecting…".
        if (Array.isArray(data.online_user_ids) && data.online_user_ids.length > 0) {
          setStatus(CALL_STATUS.RINGING);
        }

        return id;
      } catch (err) {
        console.error('[Call] startCall failed:', err);
        statusRef.current = CALL_STATUS.IDLE;
        setStatus(CALL_STATUS.IDLE);
        setOutgoingTargets([]);
        outgoingTargetIdsRef.current = [];
        const offline =
          typeof navigator !== 'undefined' && navigator.onLine === false;
        setError(
          offline
            ? "Can't make the call — you are offline."
            : err?.response?.data?.error || 'The call could not be started.'
        );
        return null;
      }
    },
    [userId, enabled, sendJoin, mediaUnavailableReason]
  );

  // A call can also be started from the floating chat window, which owns no
  // call socket of its own. The Electron main process focuses this window and
  // hands the request here, so the main window remains the single peer.
  useEffect(() => {
    if (!enabled) return undefined;
    const bridge = window.electronAPI?.call;
    if (!bridge?.onStart) return undefined;

    const handleStartRequest = (payload) => {
      if (!payload?.userIds?.length) return;
      bridge.consumed?.();
      // The same request can reach both the live listener and the pending
      // queue, so guard against creating the call twice.
      if (callIdRef.current || delegatedStartRef.current) return;
      delegatedStartRef.current = true;
      Promise.resolve(startCall(payload.userIds, payload.conversationId || undefined))
        .finally(() => { delegatedStartRef.current = false; });
    };

    const unsubscribe = bridge.onStart(handleStartRequest);

    // Claim a request that arrived before this window had mounted.
    Promise.resolve(bridge.consumePending?.())
      .then((pending) => {
        if (pending) handleStartRequest(pending);
      })
      .catch(() => {});

    return unsubscribe;
  }, [enabled, startCall]);

  const acceptCall = useCallback(async () => {
    const incoming = incomingRef.current;
    if (!incoming) return;

    unlockSounds();
    statusRef.current = CALL_STATUS.CONNECTING;
    setStatus(CALL_STATUS.CONNECTING);
    setCallId(incoming.callId);
    callIdRef.current = incoming.callId;
    setIsHost(false);
    // Show the caller's name while the media connects.
    setOutgoingTargets(
      incoming.from ? [{ id: incoming.from.userId, name: incoming.from.name }] : []
    );
    setIncomingCall(null);
    incomingRef.current = null;

    // Close the native "incoming call" notification — the call is now live.
    try {
      window.electronAPI?.call?.notifyEnded({});
    } catch {
      /* not running under Electron */
    }

    try {
      await api.acceptCall(incoming.callId);
    } catch (err) {
      console.error('[Call] accept failed:', err);
    }

    pendingJoinRef.current = incoming.callId;
    sendJoin();
  }, [sendJoin]);

  const declineCall = useCallback(async () => {
    const incoming = incomingRef.current;
    if (!incoming) return;

    // Close the native notification immediately, even if the API call fails.
    try {
      window.electronAPI?.call?.notifyEnded({});
    } catch {
      /* not running under Electron */
    }

    try {
      await api.declineCall(incoming.callId);
    } catch (err) {
      console.error('[Call] decline failed:', err);
    }

    incomingRef.current = null;
    setIncomingCall(null);
    statusRef.current = CALL_STATUS.IDLE;
    setStatus(CALL_STATUS.IDLE);
  }, []);

  const hangUp = useCallback(async () => {
    const id = callIdRef.current;
    // Flush the recording before the call ends, otherwise the last audio chunk
    // can arrive after the server has already assembled the file.
    await stopLocalRecording();

    if (id) {
      if (isHost) {
        try { await api.endCall(id); } catch { /* best effort */ }
        sendRef.current({ type: 'CALL_END', callId: id });
      } else {
        try { await api.leaveCall(id); } catch { /* best effort */ }
        sendRef.current({ type: 'CALL_LEAVE', callId: id });
      }
    }
    resetCall();
  }, [isHost, resetCall, stopLocalRecording]);

  const toggleMic = useCallback(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const next = !micOn;
    mesh.setMicEnabled(next);
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (camOn) {
      mesh.disableCamera();
      setCamOn(false);
    } else {
      const blocked = mediaUnavailableReason();
      if (blocked) {
        setError(blocked);
        return;
      }
      mesh.enableCamera().catch((err) => {
        console.error('[Call] could not enable the camera:', err);
        setError('Could not access your camera.');
      });
    }
  }, [camOn, mediaUnavailableReason]);

  const toggleScreenShare = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    try {
      if (sharingScreen) {
        await mesh.stopScreenShare();
        setSharingScreen(false);
      } else {
        await mesh.startScreenShare();
        setSharingScreen(true);
      }
      setPreviewStream(mesh.getPreviewStream());
    } catch (err) {
      console.error('[Call] screen share failed:', err);
      setError('Screen sharing was cancelled.');
    }
  }, [sharingScreen]);

  const clearError = useCallback(() => setError(null), []);

  /** Starts recording again after the host stopped it. */
  const startRecording = useCallback(() => {
    const id = callIdRef.current;
    if (!id) return;
    sendRef.current({ type: 'CALL_RECORD_REQUEST' });
  }, []);

  /** Stops the recording for everyone. */
  const stopRecording = useCallback(async () => {
    // Flush the last chunk before telling the others to stop, so that every
    // participant's file is complete.
    await stopLocalRecording();
    sendRef.current({ type: 'CALL_RECORD_STOP' });
    setRecording('idle');
  }, [stopLocalRecording]);

  // Accept / Decline chosen from the native OS notification (Electron agent).
  useEffect(() => {
    const api = window.electronAPI?.call;
    if (!api?.onAction) return undefined;

    return api.onAction((payload) => {
      if (!payload) return;

      // A stale notification must never answer a different call.
      if (payload.callId && incomingRef.current?.callId !== payload.callId) {
        return;
      }

      if (payload.action === 'accept') {
        acceptCall();
      } else if (payload.action === 'decline') {
        declineCall();
      }
      // 'prompt' means the window was focused and the in-app dialog is
      // already visible — no action needed.
    });
  }, [acceptCall, declineCall]);

  const value = useMemo(
    () => ({
      status,
      callId,
      selfPeerId,
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
      connecting,
      recording,
      enabled,
      startCall,
      acceptCall,
      declineCall,
      hangUp,
      toggleMic,
      toggleCam,
      toggleScreenShare,
      clearError,
      reconnect,
      startRecording,
      stopRecording,
    }),
    [
      status, callId, selfPeerId, peers, localStream, previewStream, micOn, camOn, sharingScreen,
      incomingCall, outgoingTargets, error, elapsed, isHost, connected, connecting,
      recording, enabled,
      startCall, acceptCall, declineCall, hangUp, toggleMic, toggleCam,
      toggleScreenShare, clearError, reconnect,
      startRecording, stopRecording,
    ]
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export default CallProvider;
