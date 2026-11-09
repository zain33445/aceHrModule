/**
 * recorder-renderer.js — MediaRecorder Engine (Renderer Process)
 *
 * Runs inside a hidden BrowserWindow. Uses the Web MediaRecorder API
 * to record the screen and emit chunks to the main process via IPC.
 *
 * IPC Events:
 *   Received:  'recording:start'  → { sessionId, sourceId, quality, chunkIntervalMs, startIndex }
 *   Received:  'recording:stop'   → (no payload)
 *   Sent:      'recording:chunk'  → { sessionId, chunkIndex, buffer }
 *   Sent:      'recording:error'  → { code, message, sessionId }
 *   Sent:      'recording:state'  → { state: 'recording'|'stopped'|'idle', sessionId }
 *
 * Architecture note: This file is the only place where MediaRecorder lives.
 * To swap to WebRTC or a different codec, only this file changes.
 */

const { ipcRenderer } = require('electron');

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────

/**
 * One object per recording start. Every callback closes over ITS OWN `rec`, so
 * a late event from an old recorder can never use (or clear) a newer session's
 * id, stream, recorder or peer connection.
 * { sid, recorder, stream, nextIndex, pending, stopped }
 */
let active = null;
let peerConnection = null;
let peerOwner = null; // the `rec` whose stream the peer connection is sending
let startSeq = 0;

const statusEl = document.getElementById('status');

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
  console.log('[Recorder Renderer]', msg);
}

function closePeer() {
  if (peerConnection) {
    try { peerConnection.close(); } catch { /* already closed */ }
  }
  peerConnection = null;
  peerOwner = null;
}

// ─────────────────────────────────────────
// Silent capture warm-up (no MediaRecorder, no UI)
// ─────────────────────────────────────────

ipcRenderer.on('recording:warmup', async (_event, { sourceId }) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 320,
          maxHeight: 180,
          minFrameRate: 1,
          maxFrameRate: 1,
        },
      },
    });
    // Hold briefly so the system registers a successful grant, then release.
    await new Promise((r) => setTimeout(r, 400));
    stream.getTracks().forEach((t) => t.stop());
    ipcRenderer.send('recording:warmup-result', true);
    setStatus('Capture warm-up OK');
  } catch (err) {
    ipcRenderer.send('recording:warmup-result', false);
    console.warn('[Recorder Renderer] Warm-up failed:', err.message);
  }
});

// ─────────────────────────────────────────
// Start Recording
// ─────────────────────────────────────────

ipcRenderer.on('recording:start', async (_event, { sessionId, sourceId, quality, chunkIntervalMs, startIndex }) => {
  const seq = ++startSeq;

  if (active && active.recorder.state !== 'inactive') {
    if (active.sid === sessionId) {
      // Re-attach to the same session — just confirm state, no restart needed
      setStatus(`Re-attached to session ${sessionId} (already recording)`);
      ipcRenderer.send('recording:state', { state: 'recording', sessionId });
      return;
    }
    // Different session — stop the current one (its final chunk is flushed in
    // its own onstop) and wait for it before starting the new one.
    setStatus(`Stopping previous session ${active.sid} for new session ${sessionId}`);
    const old = active;
    try { old.recorder.requestData(); old.recorder.stop(); } catch { /* already stopping */ }
    await Promise.race([old.stopped, new Promise((r) => setTimeout(r, 5000))]);
  }

  setStatus(`Starting session ${sessionId}...`);

  let stream = null;
  try {
    // Get the screen stream using the sourceId provided by the main process
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: quality === '720p' ? 1280 : 1920,
          maxHeight: quality === '720p' ? 720 : 1080,
          minFrameRate: 15,
          maxFrameRate: 30,
        },
      },
    });

    if (seq !== startSeq) {
      // A newer start superseded this one while we waited for capture.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // Determine the best available codec
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      throw new Error('No supported video MIME type found in this Chromium build');
    }

    setStatus(`Using codec: ${mimeType}`);

    const videoBps = quality === '720p' ? 1_500_000 : 3_000_000;

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBps,
    });

    const sid = sessionId;
    let resolveStopped;
    const rec = {
      sid,
      recorder,
      stream,
      nextIndex: Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0,
      pending: Promise.resolve(),
      stopped: new Promise((r) => { resolveStopped = r; }),
    };
    active = rec;

    // Each timeslice fires ondataavailable
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      // Index is assigned synchronously so ordering is deterministic; sends
      // are chained so chunks reach the main process in order.
      const idx = rec.nextIndex++;
      const data = event.data;
      rec.pending = rec.pending.then(async () => {
        try {
          const arrayBuffer = await data.arrayBuffer();
          ipcRenderer.send('recording:chunk', { sessionId: sid, chunkIndex: idx, buffer: arrayBuffer });
          setStatus(`Sent chunk ${idx} (${Math.round(data.size / 1024)}KB)`);
        } catch (err) {
          console.error('[Recorder Renderer] Failed to send chunk', idx, err);
        }
      });
    };

    recorder.onstop = async () => {
      setStatus('Recording stopped. Cleaning up stream.');
      stream.getTracks().forEach((t) => t.stop());
      if (peerOwner === rec) closePeer();
      // Make sure the final chunk has been handed to the main process first.
      await rec.pending;
      if (active === rec) active = null;
      ipcRenderer.send('recording:state', { state: 'stopped', sessionId: sid });
      resolveStopped();
    };

    recorder.onerror = (event) => {
      const errMsg = event.error?.message ?? 'Unknown MediaRecorder error';
      setStatus(`ERROR: ${errMsg}`);
      ipcRenderer.send('recording:error', {
        code: 'MEDIARECORDER_ERROR',
        sessionId: sid,
        message: errMsg,
      });
    };

    // Use configurable timeslices (passed from main process)
    recorder.start(chunkIntervalMs || 30_000);

    setStatus(`Recording active — session ${sid}`);
    ipcRenderer.send('recording:state', { state: 'recording', sessionId: sid });

  } catch (err) {
    // Don't leak the capture stream if recorder creation/start failed.
    if (stream) stream.getTracks().forEach((t) => t.stop());
    setStatus(`FAILED: ${err.message}`);
    const isPermission =
      err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      /permission|denied|not allowed|blocked/i.test(err?.message || '');
    ipcRenderer.send('recording:error', {
      code: isPermission ? 'PERMISSION_DENIED' : 'START_FAILED',
      sessionId,
      message: err?.message || 'Failed to start capture',
    });
  }
});

// ─────────────────────────────────────────
// Stop Recording
// ─────────────────────────────────────────

ipcRenderer.on('recording:stop', () => {
  const rec = active;
  if (!rec || rec.recorder.state === 'inactive') {
    setStatus('Stop requested but recorder is idle.');
    ipcRenderer.send('recording:state', { state: 'idle', sessionId: rec?.sid ?? null });
    return;
  }

  setStatus('Stopping MediaRecorder...');
  // requestData() forces a final ondataavailable before stop
  rec.recorder.requestData();
  rec.recorder.stop();
});

// ─────────────────────────────────────────
// Codec Detection
// ─────────────────────────────────────────

function getSupportedMimeType() {
  // Preference order: VP8 (most compatible in Electron), then VP9
  const candidates = [
    'video/webm; codecs=vp8',
    'video/webm; codecs=vp9',
    'video/webm; codecs=vp8,opus',
    'video/webm',
  ];

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return null;
}

// ─────────────────────────────────────────
// WebRTC Live Streaming
// ─────────────────────────────────────────

ipcRenderer.on('recording:webrtc-in', async (_event, msg) => {
  if (msg.type === 'WEBRTC_OFFER') {
    const owner = active;
    if (!owner || owner.recorder.state === 'inactive') {
      // FIX #2: Send error back to admin instead of silent reject
      ipcRenderer.send('recording:webrtc-out', {
        type: 'WEBRTC_ERROR',
        message: 'No active screen stream — agent is not recording',
        adminId: msg.adminId,
      });
      return;
    }

    try {
      closePeer();
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      peerConnection = pc;
      peerOwner = owner;

      owner.stream.getTracks().forEach(track => {
        pc.addTrack(track, owner.stream);
      });

      pc.onicecandidate = event => {
        if (event.candidate) {
          // FIX #10: RTCIceCandidate does not survive Electron IPC structured clone —
          // send the fields explicitly or they arrive as {} at the gateway/admin
          const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
          ipcRenderer.send('recording:webrtc-out', {
            type: 'WEBRTC_ICE_CANDIDATE',
            candidate: { candidate, sdpMid, sdpMLineIndex },
            adminId: msg.adminId,
          });
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      ipcRenderer.send('recording:webrtc-out', {
        type: 'WEBRTC_ANSWER',
        answer,
        adminId: msg.adminId,
      });
      setStatus('WebRTC connection established with Admin');
    } catch (err) {
      console.error('[Recorder Renderer] WebRTC offer failed', err);
      closePeer();
      ipcRenderer.send('recording:webrtc-out', {
        type: 'WEBRTC_ERROR',
        message: err?.message || 'WebRTC negotiation failed',
        adminId: msg.adminId,
      });
    }

  } else if (msg.type === 'WEBRTC_ICE_CANDIDATE' && peerConnection) {
    try {
      if (msg.candidate && msg.candidate.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    } catch (err) {
      console.error('[Recorder Renderer] Error adding ICE candidate', err);
    }
  }
});

setStatus('Recorder engine ready. Waiting for start command...');
