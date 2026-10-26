/**
 * audioRecorder.js — Records the audio of a call.
 *
 * The media plane is a peer-to-peer mesh, so the server never sees the audio.
 * Each participant records its own mix of the local microphone plus every
 * remote audio track, and uploads 30-second Opus chunks. Because every
 * participant holds the full conversation, the recording survives a participant
 * dropping mid-call.
 *
 * Chrome quirk: audio from a remote WebRTC stream is not available to the
 * Web Audio API until the stream has been attached to a media element, so
 * every remote stream is "primed" with a muted, zero-volume <audio> element
 * before it is routed into the mix.
 */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export class CallAudioRecorder {
  /**
   * @param {object} opts
   * @param {(callId: string, chunkIndex: number, buffer: ArrayBuffer) => Promise<void>} opts.uploadChunk
   * @param {number} [opts.chunkIntervalMs]
   */
  constructor({ uploadChunk, chunkIntervalMs = 30000 } = {}) {
    this.uploadChunk = uploadChunk;
    this.chunkIntervalMs = chunkIntervalMs;
    this.recorder = null;
    this.audioCtx = null;
    this.mixDest = null;
    this.primed = [];
    /** Audio tracks already routed into the mix. */
    this.routedTracks = new Set();
    this.chunkIndex = 0;
    this.active = false;
    /** Resolves when every chunk handed to the recorder has been uploaded. */
    this.pendingUpload = Promise.resolve();
  }

  /**
   * Starts recording the mix of the given streams.
   * @param {MediaStream} localStream
   * @param {MediaStream[]} remoteStreams
   */
  async start(localStream, remoteStreams = []) {
    if (this.active) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Web Audio is not available in this browser.');
    }

    this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch { /* will retry on the next gesture */ }
    }

    this.mixDest = this.audioCtx.createMediaStreamDestination();

    if (localStream && localStream.getAudioTracks().length > 0) {
      try {
        this.audioCtx.createMediaStreamSource(localStream).connect(this.mixDest);
      } catch (err) {
        console.error('[Call Recording] could not route the local microphone:', err);
      }
    }

    for (const remote of remoteStreams) {
      this.routeRemoteStream(remote);
    }

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(
      this.mixDest.stream,
      mimeType ? { mimeType } : undefined
    );

    this.recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      // Chunks are uploaded strictly in order, and the promise chain keeps
      // track of the last one so that stop() can wait for it.
      this.pendingUpload = this.pendingUpload
        .then(async () => {
          const buffer = await event.data.arrayBuffer();
          await this.uploadChunk?.(this.chunkIndex, buffer);
          this.chunkIndex += 1;
        })
        .catch((err) => {
          console.error('[Call Recording] chunk upload failed:', err);
        });
    };

    this.recorder.onerror = (event) => {
      console.error('[Call Recording] recorder error:', event?.error);
    };

    this.recorder.start(this.chunkIntervalMs);
    this.active = true;
  }

  /**
   * Mixes in a remote stream that became available after recording started.
   *
   * Recording begins the moment the call connects, but the peer connections
   * are still being negotiated then. Without this, the beginning of the call
   * (or a participant who joined later) would be missing from the mix.
   */
  addRemoteStream(stream) {
    if (!this.active || !this.audioCtx || !this.mixDest) return;
    this.routeRemoteStream(stream);
  }

  /** Routes one remote audio track into the mix (once). */
  routeRemoteStream(stream) {
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track || this.routedTracks.has(track)) return;
    this.routedTracks.add(track);

    this.primeStream(stream);

    try {
      this.audioCtx.createMediaStreamSource(stream).connect(this.mixDest);
    } catch (err) {
      console.error('[Call Recording] could not route a remote stream:', err);
    }
  }

  /**
   * Attaches a remote stream to a hidden <audio> element so Chrome exposes
   * its audio to the Web Audio API. The element is silent (volume 0) so it
   * never doubles the audio coming from the video tiles.
   */
  primeStream(stream) {
    try {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.volume = 0;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      const play = audio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
      this.primed.push(audio);
    } catch (err) {
      console.error('[Call Recording] could not prime a remote stream:', err);
    }
  }

  /**
   * Stops recording and releases the audio resources.
   *
   * Resolves once the final chunk has been uploaded. The server assembles the
   * recording when the call ends, so the caller MUST await this before
   * signalling the end of the call — otherwise the last chunk can arrive after
   * the file has already been assembled.
   */
  stop() {
    return new Promise((resolve) => {
      const recorder = this.recorder;

      if (!recorder || recorder.state === 'inactive') {
        this.release();
        resolve();
        return;
      }

      recorder.onstop = async () => {
        try {
          await this.pendingUpload;
        } catch {
          /* the individual chunk error was already logged */
        }
        this.release();
        resolve();
      };

      try {
        recorder.stop();
      } catch {
        this.release();
        resolve();
      }
    });
  }

  /** Releases the audio resources. */
  release() {
    this.recorder = null;

    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* already closed */ }
    }
    this.audioCtx = null;
    this.mixDest = null;

    for (const audio of this.primed) {
      try {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      } catch {
        /* the element is already detached */
      }
    }
    this.primed = [];
    this.routedTracks.clear();

    this.active = false;
  }
}

export default CallAudioRecorder;
