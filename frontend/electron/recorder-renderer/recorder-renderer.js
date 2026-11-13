/**
 * recorder-renderer.js — capture + MediaRecorder engine (Renderer Process)
 *
 * Runs inside a hidden BrowserWindow. ONE capture stream (desktop
 * getUserMedia) is shared by the active MediaRecorder and by the live-view
 * RTCPeerConnection. Recorders are per segment; rotation starts the new
 * recorder on the same stream and only then stops the old one.
 *
 * IPC (docs/recording-v2.md §8):
 *   Received:  'recording:begin'  { segmentId, sourceId, newCapture, timesliceMs,
 *                                   videoBitsPerSecond, maxFps, maxWidth, maxHeight }
 *              'recording:stop'   { release }   stop current recorder (+ release capture)
 *              'recording:warmup' { sourceId }
 *              'recording:webrtc-in'
 *   Sent:      'recording:chunk'           { segmentId, seq, capturedAt, durationMs, buffer }
 *              'recording:segment-started' { segmentId, mime, width, height }
 *              'recording:segment-stopped' { segmentId, lastSeq }   (after its last chunk)
 *              'recording:capture-lost'    { reason }
 *              'recording:error'           { code, message, segmentId }
 *              'recording:webrtc-out'
 */

const { ipcRenderer } = require('electron');

/** { stream, track, sourceId } — owned here, separate from recorders. */
let capture = null;
/** The recorder receiving new data (segment currently being written). */
let current = null;
let peerConnection = null;
let peerCapture = null; // the capture the peer connection is sending

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
  peerCapture = null;
}

// Serialise begin/stop so rotation can never interleave with another command.
let queue = Promise.resolve();
const enqueue = (fn) => {
  queue = queue.then(fn).catch((err) => console.error('[Recorder Renderer] command failed', err));
  return queue;
};

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
// Capture (shared stream)
// ─────────────────────────────────────────

function releaseCapture() {
  const c = capture;
  capture = null;
  if (peerCapture === c) closePeer();
  if (c) c.stream.getTracks().forEach((t) => t.stop());
}

async function acquireCapture({ sourceId, maxWidth, maxHeight, maxFps }) {
  releaseCapture();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        // min = max: Chromium's desktop capturer then letterboxes to this fixed size on every monitor
        // (verified by letterbox.check.cjs), so a screen switch never changes the frame size.
        minWidth: maxWidth || 1280,
        maxWidth: maxWidth || 1280,
        minHeight: maxHeight || 720,
        maxHeight: maxHeight || 720,
        maxFrameRate: maxFps || 15,
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  const c = { stream, track, sourceId, maxWidth, maxHeight, maxFps };
  capture = c;
  track.addEventListener('ended', () => {
    // Display unplugged / source gone. Only the CURRENT capture counts.
    if (capture !== c) return;
    setStatus('Capture track ended');
    ipcRenderer.send('recording:capture-lost', { reason: 'video track ended' });
  });
  return c;
}

// ─────────────────────────────────────────
// Segments (one MediaRecorder each)
// ─────────────────────────────────────────

function stopRecorder(rec) {
  if (!rec || rec.recorder.state === 'inactive') return;
  try { rec.recorder.requestData(); } catch { /* not recording */ }
  try { rec.recorder.stop(); } catch { /* already stopping */ }
}

async function begin(p) {
  const { segmentId, timesliceMs, videoBitsPerSecond } = p;
  try {
    // A new recording day may bring a different quality preset, and a screen switch a different source:
    // constraints are fixed at capture time.
    const changed = capture && (capture.sourceId !== p.sourceId || capture.maxWidth !== p.maxWidth || capture.maxHeight !== p.maxHeight || capture.maxFps !== p.maxFps);
    if (changed && current && current.recorder.state !== 'inactive') {
      // Flush the old recorder's last chunk before its tracks are stopped.
      stopRecorder(current);
      await Promise.race([current.stopped, new Promise((r) => setTimeout(r, 4000))]);
    }
    if (p.newCapture || changed || !capture || capture.track.readyState !== 'live') await acquireCapture(p);
    const mimeType = getSupportedMimeType();
    if (!mimeType) throw new Error('No supported video MIME type found in this Chromium build');

    const myCapture = capture;
    const recorder = new MediaRecorder(myCapture.stream, { mimeType, videoBitsPerSecond, videoKeyFrameIntervalDuration: 5000 });
    const rec = { segmentId, recorder, seq: 0, lastEmitAt: Date.now(), pending: Promise.resolve() };
    rec.stopped = new Promise((r) => { rec.resolveStopped = r; });

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      // seq and timing are fixed synchronously; sends are chained so chunks
      // reach the main process in order.
      const seq = rec.seq++;
      const now = Date.now();
      const durationMs = now - rec.lastEmitAt;
      rec.lastEmitAt = now;
      const capturedAt = new Date(now).toISOString();
      const data = event.data;
      rec.pending = rec.pending.then(async () => {
        try {
          const buffer = await data.arrayBuffer();
          ipcRenderer.send('recording:chunk', { segmentId, seq, capturedAt, durationMs, buffer });
          setStatus(`Segment ${segmentId.slice(0, 8)} chunk ${seq} (${Math.round(data.size / 1024)}KB)`);
        } catch (err) {
          console.error('[Recorder Renderer] Failed to send chunk', seq, err);
        }
      });
    };

    // An old recorder stopping touches ONLY itself: never the shared stream,
    // never the new recorder, never the peer connection.
    recorder.onstop = async () => {
      await rec.pending; // its last chunk is handed to main first
      if (current === rec) current = null;
      ipcRenderer.send('recording:segment-stopped', { segmentId, lastSeq: rec.seq - 1 });
      rec.resolveStopped();
    };

    recorder.onerror = (event) => {
      const message = event.error?.message ?? 'Unknown MediaRecorder error';
      setStatus(`ERROR: ${message}`);
      ipcRenderer.send('recording:error', { code: 'MEDIARECORDER_ERROR', segmentId, message });
    };

    const old = current;
    recorder.start(timesliceMs || 10_000);
    current = rec; // new one is live BEFORE the old one stops: no gap
    const s = myCapture.track.getSettings?.() || {};
    ipcRenderer.send('recording:segment-started', { segmentId, mime: mimeType, width: s.width ?? null, height: s.height ?? null });
    setStatus(`Recording segment ${segmentId.slice(0, 8)} (${mimeType})`);
    if (old) stopRecorder(old);
  } catch (err) {
    setStatus(`FAILED: ${err.message}`);
    const isPermission =
      err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      /permission|denied|not allowed|blocked/i.test(err?.message || '');
    ipcRenderer.send('recording:error', {
      code: isPermission ? 'PERMISSION_DENIED' : 'START_FAILED',
      segmentId,
      message: err?.message || 'Failed to start capture',
    });
  }
}

ipcRenderer.on('recording:begin', (_event, p) => { enqueue(() => begin(p)); });

ipcRenderer.on('recording:stop', (_event, { release } = {}) => {
  enqueue(async () => {
    const rec = current;
    if (rec && rec.recorder.state !== 'inactive') {
      setStatus('Stopping MediaRecorder...');
      stopRecorder(rec);
      await Promise.race([rec.stopped, new Promise((r) => setTimeout(r, 4000))]);
    }
    if (release) releaseCapture();
  });
});

// ─────────────────────────────────────────
// Codec Detection
// ─────────────────────────────────────────

function getSupportedMimeType() {
  // Preference order: VP9 (sharper at low bitrate), then VP8
  const candidates = [
    'video/webm; codecs=vp9',
    'video/webm; codecs=vp8',
    'video/webm; codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// ─────────────────────────────────────────
// WebRTC Live Streaming (answers from the shared capture stream)
// ─────────────────────────────────────────

ipcRenderer.on('recording:webrtc-in', async (_event, msg) => {
  if (msg.type === 'WEBRTC_OFFER') {
    const owner = capture;
    if (!owner || owner.track.readyState !== 'live') {
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
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerConnection = pc;
      peerCapture = owner;

      owner.stream.getTracks().forEach((track) => {
        pc.addTrack(track, owner.stream);
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          // RTCIceCandidate does not survive Electron IPC structured clone —
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

setStatus('Recorder engine ready. Waiting for begin command...');
