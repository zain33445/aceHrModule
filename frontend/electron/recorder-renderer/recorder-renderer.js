/**
 * recorder-renderer.js — MediaRecorder Engine (Renderer Process)
 *
 * Runs inside a hidden BrowserWindow. Uses the Web MediaRecorder API
 * to record the screen and emit chunks to the main process via IPC.
 *
 * IPC Events:
 *   Received:  'recording:start'  → { sessionId, sourceId, quality }
 *   Received:  'recording:stop'   → (no payload)
 *   Sent:      'recording:chunk'  → ArrayBuffer
 *   Sent:      'recording:error'  → { code, message }
 *   Sent:      'recording:state'  → { state: 'recording'|'stopped'|'idle' }
 *
 * Architecture note: This file is the only place where MediaRecorder lives.
 * To swap to WebRTC or a different codec, only this file changes.
 */

const { ipcRenderer } = require('electron');

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────

let mediaRecorder = null;
let recordedChunks = [];
let currentStream = null;
let currentSessionId = null;
let chunkIndex = 0;
let peerConnection = null;

const statusEl = document.getElementById('status');

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
  console.log('[Recorder Renderer]', msg);
}

// ─────────────────────────────────────────
// Start Recording
// ─────────────────────────────────────────

ipcRenderer.on('recording:start', async (_event, { sessionId, sourceId, quality, chunkIntervalMs }) => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (currentSessionId === sessionId) {
      // Re-attach to the same session — just confirm state, no restart needed
      setStatus(`Re-attached to session ${sessionId} (already recording)`);
      ipcRenderer.send('recording:state', { state: 'recording', sessionId });
      return;
    }
    // Different session — stop current and start new one below
    setStatus(`Stopping previous session ${currentSessionId} for new session ${sessionId}`);
    mediaRecorder.requestData();
    mediaRecorder.stop();
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // FIX #9: Always reset chunk index on session change
  currentSessionId = sessionId;
  chunkIndex = 0;
  recordedChunks = [];
  setStatus(`Starting session ${sessionId}...`);

  try {
    // Get the screen stream using the sourceId provided by the main process
    const stream = await navigator.mediaDevices.getUserMedia({
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

    currentStream = stream;

    // Determine the best available codec
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      throw new Error('No supported video MIME type found in this Chromium build');
    }

    setStatus(`Using codec: ${mimeType}`);

    const videoBps = quality === '720p' ? 1_500_000 : 3_000_000;

    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBps,
    });

    // Each timeslice fires ondataavailable
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0) {
        const arrayBuffer = await event.data.arrayBuffer();
        ipcRenderer.send('recording:chunk', {
          sessionId: currentSessionId,
          chunkIndex: chunkIndex++,
          buffer: arrayBuffer,
        });
        setStatus(`Sent chunk ${chunkIndex - 1} (${Math.round(event.data.size / 1024)}KB)`);
      }
    };

    mediaRecorder.onstop = () => {
      setStatus('Recording stopped. Cleaning up stream.');
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
        currentStream = null;
      }
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      ipcRenderer.send('recording:state', { state: 'stopped', sessionId: currentSessionId });
      mediaRecorder = null;
    };

    mediaRecorder.onerror = (event) => {
      const errMsg = event.error?.message ?? 'Unknown MediaRecorder error';
      setStatus(`ERROR: ${errMsg}`);
      ipcRenderer.send('recording:error', {
        code: 'MEDIARECORDER_ERROR',
        message: errMsg,
      });
    };

    // Use configurable timeslices (passed from main process)
    mediaRecorder.start(chunkIntervalMs || 30_000);

    setStatus(`Recording active — session ${sessionId}`);
    ipcRenderer.send('recording:state', { state: 'recording', sessionId });

  } catch (err) {
    setStatus(`FAILED: ${err.message}`);
    ipcRenderer.send('recording:error', {
      code: 'START_FAILED',
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────
// Stop Recording
// ─────────────────────────────────────────

ipcRenderer.on('recording:stop', (_event) => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    setStatus('Stop requested but recorder is idle.');
    ipcRenderer.send('recording:state', { state: 'idle', sessionId: currentSessionId });
    return;
  }

  setStatus('Stopping MediaRecorder...');
  // requestData() forces a final ondataavailable before stop
  mediaRecorder.requestData();
  mediaRecorder.stop();
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
    if (!currentStream) {
      // FIX #2: Send error back to admin instead of silent reject
      ipcRenderer.send('recording:webrtc-out', {
        type: 'WEBRTC_ERROR',
        message: 'No active screen stream — agent is not recording',
        adminId: msg.adminId,
      });
      return;
    }

    if (peerConnection) {
      peerConnection.close();
    }

    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    currentStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, currentStream);
    });

    peerConnection.onicecandidate = event => {
      if (event.candidate) {
        ipcRenderer.send('recording:webrtc-out', {
          type: 'WEBRTC_ICE_CANDIDATE',
          candidate: event.candidate,
          adminId: msg.adminId,
        });
      }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ipcRenderer.send('recording:webrtc-out', {
      type: 'WEBRTC_ANSWER',
      answer,
      adminId: msg.adminId,
    });
    setStatus('WebRTC connection established with Admin');

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
