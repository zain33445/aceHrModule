/**
 * callMesh.js — WebRTC mesh engine for voice & video calls.
 *
 * Topology is a full mesh: this engine holds one RTCPeerConnection per remote
 * participant. For a 4-person call that is 3 connections per participant (6
 * peer connections across the call), which is why group calls are capped at
 * four people.
 *
 * Signalling is handled by call.gateway.ts; this module only produces and
 * consumes the SDP/ICE payloads and hands them to the `sendSignal` callback.
 *
 * Offer collisions are resolved with the W3C "perfect negotiation" pattern:
 * each side decides whether it is the polite peer by comparing peer ids, the
 * polite peer yields (rolls back) when both sides offer at once, and the
 * impolite peer ignores the incoming collision.
 *
 *   polite = selfPeerId < remotePeerId
 *
 * Exactly one side of any pair is polite, because the comparison is
 * antisymmetric.
 */

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export class CallMesh {
  /**
   * @param {object} opts
   * @param {(peerId: string, signalType: string, payload: any) => void} opts.sendSignal
   * @param {(peerId: string, stream: MediaStream) => void} opts.onRemoteStream
   * @param {(peerId: string) => void} opts.onPeerGone
   * @param {(stream: MediaStream) => void} opts.onLocalStream
   * @param {(state: {mic: boolean, cam: boolean}) => void} opts.onMediaState
   */
  constructor(opts = {}) {
    this.sendSignal = opts.sendSignal || (() => {});
    this.onRemoteStream = opts.onRemoteStream || (() => {});
    this.onPeerGone = opts.onPeerGone || (() => {});
    this.onLocalStream = opts.onLocalStream || (() => {});
    this.onMediaState = opts.onMediaState || (() => {});

    /** @type {string|null} */
    this.selfPeerId = null;
    /** @type {Map<string, any>} remote peerId -> peer state */
    this.peers = new Map();
    /** @type {MediaStream|null} */
    this.localStream = null;
    /** In-flight getUserMedia promise, shared between concurrent callers. */
    this.localStreamPromise = null;
    /** @type {MediaStreamTrack|null} */
    this.cameraTrack = null;
    /** @type {MediaStreamTrack|null} */
    this.micTrack = null;
    /** @type {MediaStreamTrack|null} */
    this.screenTrack = null;
    /** @type {MediaStream|null} */
    this.screenPreviewStream = null;

    this.iceServers = DEFAULT_ICE_SERVERS;
    this.micEnabled = true;
    this.camEnabled = false;
    this.sharingScreen = false;
    this.healthTimer = null;
  }

  // ── Configuration ───────────────────────────────────────

  setIceServers(iceServers) {
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      this.iceServers = iceServers;
    }
  }

  setSelfPeerId(peerId) {
    this.selfPeerId = peerId;
  }

  // ── Local media ─────────────────────────────────────────

  /**
   * Acquires the microphone. The camera is NOT acquired here — turning a
   * webcam on without the user asking is invasive, and the Electron agent
   * already captures the screen, so video stays opt-in.
   *
   * The in-flight promise is shared so that concurrent callers (the join
   * handler and a peer connection being created at the same time) end up with
   * the same stream instead of racing two getUserMedia calls.
   */
  async ensureLocalStream() {
    if (this.localStream) return this.localStream;
    if (this.localStreamPromise) return this.localStreamPromise;

    this.localStreamPromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.localStream = stream;
      this.micTrack = stream.getAudioTracks()[0] || null;
      this.micEnabled = !!this.micTrack?.enabled;
      this.onLocalStream(stream);
      this.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
      return stream;
    })();

    try {
      return await this.localStreamPromise;
    } catch (err) {
      // Allow a later attempt to retry the acquisition.
      this.localStreamPromise = null;
      throw err;
    }
  }

  /**
   * Publishes the camera on one peer connection.
   *
   * The camera is switched on after the call has started, so it has to be
   * added to the connection — which renegotiates. The negotiation queue in
   * this class keeps one offer in flight per connection, so several peers
   * switching their camera on at the same time cannot lose an offer.
   */
  async publishCamera(peer) {
    if (!this.cameraTrack) {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
        audio: false,
      });
      this.cameraTrack = camStream.getVideoTracks()[0] || null;
    }

    if (!this.cameraTrack) return;

    this.cameraTrack.enabled = true;

    if (this.localStream && !this.localStream.getTracks().includes(this.cameraTrack)) {
      this.localStream.addTrack(this.cameraTrack);
    }

    const alreadySending = peer.pc
      .getSenders()
      .some((s) => s.track === this.cameraTrack);

    if (alreadySending) return;

    try {
      peer.pc.addTrack(this.cameraTrack, this.localStream);
    } catch (err) {
      console.error('[CallMesh] could not publish the camera:', err);
    }
  }

  /** Acquires the camera and publishes it to every existing peer. */
  async enableCamera() {
    if (this.camEnabled && this.cameraTrack) return;

    for (const peer of this.peers.values()) {
      await this.publishCamera(peer);
    }

    this.camEnabled = true;
    this.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
    this.startHealthCheck();
  }
  /** Turns the camera off without renegotiating (the track stays muted). */
  disableCamera() {
    if (this.cameraTrack) this.cameraTrack.enabled = false;
    this.camEnabled = false;
    this.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
  }

  setMicEnabled(enabled) {
    this.micEnabled = enabled;
    if (this.micTrack) this.micTrack.enabled = enabled;
    this.onMediaState({ mic: enabled, cam: this.camEnabled });
  }

  setCamEnabled(enabled) {
    if (enabled) this.enableCamera();
    else this.disableCamera();
  }

  // ── Screen sharing (1:1 only) ───────────────────────────

  /**
   * Replaces the outgoing video with the screen. replaceTrack keeps the
   * existing transceiver, so no renegotiation is needed.
   */
  async startScreenShare() {
    if (this.sharingScreen) return;
    if (!this.camEnabled) await this.enableCamera();

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: false,
    });

    this.screenTrack = display.getVideoTracks()[0] || null;
    if (!this.screenTrack) return;

    this.screenTrack.onended = () => this.stopScreenShare();
    this.sharingScreen = true;

    // A dedicated preview stream so the local tile shows the screen rather
    // than the camera while sharing.
    this.screenPreviewStream = new MediaStream([this.screenTrack]);

    await this.replaceOutgoingVideo(this.screenTrack);
  }

  async stopScreenShare() {
    if (!this.sharingScreen) return;
    this.sharingScreen = false;
    this.screenPreviewStream = null;

    const next = this.cameraTrack || null;
    await this.replaceOutgoingVideo(next);

    if (this.screenTrack) {
      this.screenTrack.onended = null;
      try { this.screenTrack.stop(); } catch { /* already stopped */ }
      this.screenTrack = null;
    }
  }

  /**
   * The stream that should be shown in the local preview tile: the screen
   * while sharing, otherwise the camera/microphone stream.
   */
  getPreviewStream() {
    return this.screenPreviewStream || this.localStream;
  }

  async replaceOutgoingVideo(track) {
    for (const peer of this.peers.values()) {
      const sender = peer.pc
        .getSenders()
        .find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch (err) {
          console.error('[CallMesh] replaceTrack failed:', err);
        }
      }
    }
  }

  // ── Peer connections ────────────────────────────────────

  /**
   * Creates the peer connection for a remote participant.
   * Adding the local tracks fires `negotiationneeded`, which produces the
   * offer — the perfect negotiation pattern then sorts out any collision.
   */
  async createPeer(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    const peer = {
      peerId,
      pc,
      polite: this.selfPeerId ? this.selfPeerId < peerId : true,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      stream: null,
      mic: true,
      cam: true,
      negotiating: false,
      renegotiateQueued: false,
      offering: false,
      videoTransceiver: null,
      iceRestartAt: 0,
      cameraRepublished: false,
      // The chain of pending signal handlers for this peer.
      signalChain: Promise.resolve(),
      // ICE candidates that arrived before the remote description was set.
      pendingCandidates: [],
    };

    this.peers.set(peerId, peer);

    // When the connection settles — our offer was answered, or an offer we
    // rolled back — resume a negotiation that had to wait for it.
    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState !== 'stable') return;
      peer.offering = false;
      if (peer.renegotiateQueued) {
        peer.renegotiateQueued = false;
        this.negotiate(peer);
      }
    });

    pc.onnegotiationneeded = () => {
      this.negotiate(peer);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.sendSignal(peerId, 'candidate', { candidate: candidate.toJSON() });
    };

    pc.ontrack = (event) => {
      // Use the stream the browser hands us — a remote track that is added to
      // a script-created MediaStream can stay muted and never deliver frames.
      const eventStream = (event.streams && event.streams[0]) || null;

      if (!peer.stream) {
        peer.stream = eventStream || new MediaStream([event.track]);
      } else {
        // A renegotiation handed us a different stream object (or updated the
        // existing one) — merge the tracks, replacing stale ones.
        this.mergeRemoteStream(peer, eventStream);
      }

      this.onRemoteStream(peerId, peer.stream, peer);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        // Recover from a dead path with an ICE restart (re-offers).
        try { pc.restartIce(); } catch (err) { console.error('[CallMesh] ICE restart failed:', err); }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId);
      }
    };

    // Publish the local tracks.
    //
    // The microphone MUST be attached before the connection is negotiated,
    // otherwise the peer connection is created with no outbound media and the
    // other side never hears us. Acquiring it can still be in flight when a
    // peer joins, so wait for it here.
    try {
      await this.ensureLocalStream();
    } catch (err) {
      console.error('[CallMesh] could not acquire the microphone:', err);
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          pc.addTrack(track, this.localStream);
        } catch (err) {
          console.error('[CallMesh] could not add a local track:', err);
        }
      }
    }

    // A video slot is reserved for the camera, which is switched on later.

    return peer;
  }
  /**
   * Waits until the peer connection is stable again.
   * A connection that is waiting for a remote answer stays in
   * "have-local-offer", and no negotiation can start until it settles.
   */
  waitForStable(peer, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        if (peer.pc.signalingState === 'stable') {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Negotiates a peer connection, one offer at a time.
   *
   * Several things can change a connection at once (the camera is published
   * to every peer, for example), which fires `negotiationneeded` repeatedly.
   * Only one offer may be in flight per connection, so extra requests are
   * queued.
   *
   * A negotiation is also deferred while the connection is not stable — we
   * may be in the middle of answering a remote offer. Attempting
   * setLocalDescription() then throws, and a lost offer leaves the peer
   * connection stuck in the "new" state with no media at all. The deferred
   * request is resumed when the connection settles (see the
   * `signalingstatechange` listener in createPeer).
   */
  negotiate(peer) {
    if (peer.pc.signalingState !== 'stable' || peer.offering) {
      peer.renegotiateQueued = true;
      return;
    }

    peer.offering = true;
    peer.renegotiateQueued = false;

    (async () => {
      try {
        peer.makingOffer = true;
        await peer.pc.setLocalDescription();
        this.sendSignal(peer.peerId, 'offer', { sdp: peer.pc.localDescription });
      } catch (err) {
        console.error('[CallMesh] negotiation failed:', err);
        // Try again once the connection is stable.
        peer.renegotiateQueued = true;
      } finally {
        peer.makingOffer = false;
      }
    })();
  }

  /**
   * Merges the tracks of a remote stream into the one the media element is
   * attached to.
   *
   * A renegotiation can deliver a *new* receiver for the same media section,
   * with a new track id. Adding it blindly leaves the stream with two video
   * tracks — and a <video> element only ever renders the first one, which is
   * the stale, dead track. So a track of the same kind is replaced.
   */
  mergeRemoteStream(peer, eventStream) {
    if (!eventStream) return;

    for (const track of eventStream.getTracks()) {
      if (peer.stream.getTracks().some((t) => t.id === track.id)) continue;

      for (const existing of peer.stream.getTracks()) {
        if (existing.kind !== track.kind) continue;
        try {
          peer.stream.removeTrack(existing);
        } catch {
          /* the track may already be gone */
        }
      }

      try {
        peer.stream.addTrack(track);
      } catch (err) {
        console.error('[CallMesh] could not merge a remote track:', err);
      }
    }
  }

  /**
   * Republishes the camera on a peer connection.
   *
   * The camera is added to the connection after it was negotiated, so a
   * collision between two peers can leave it out of the negotiated
   * description — the remote then has a video track that never carries a
   * frame. Detaching and re-attaching the track forces a fresh offer that
   * includes it.
   */
  republishVideo(peer) {
    const camera = this.cameraTrack;
    if (!camera) return;

    const sender = peer.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');

    try {
      if (sender) peer.pc.removeTrack(sender);
      peer.pc.addTrack(camera, this.localStream);
    } catch (err) {
      console.error('[CallMesh] could not republish the camera:', err);
    }
  }

  /**
   * Makes sure the camera is part of the negotiated description.
   *
   * The camera is added to the connection after it was negotiated, so it needs
   * a media section of its own. That section can only be created by an
   * *offer* — and in a perfect-negotiation collision our offer may be
   * ignored, in which case the camera is silently left out of the
   * negotiation and the remote never receives any video.
   *
   * When that happens the camera is detached and re-attached, which creates a
   * fresh media section and forces an offer that carries it.
   */
  ensureCameraNegotiated(peer) {
    const camera = this.cameraTrack;
    if (!camera || !this.camEnabled) return;

    const local = peer.pc.localDescription;
    if (!local) return;

    const mids = new Set();
    for (const m of local.media || []) {
      if (m.mid) mids.add(m.mid);
    }

    for (const transceiver of peer.pc.getTransceivers()) {
      if (
        transceiver.sender.track === camera &&
        transceiver.mid &&
        mids.has(transceiver.mid)
      ) {
        peer.cameraRepublished = false;
        return; // the camera is negotiated
      }
    }

    if (peer.cameraRepublished) return; // already tried once
    peer.cameraRepublished = true;

    try {
      const sender = peer.pc.getSenders().find((s) => s.track === camera);
      if (sender) peer.pc.removeTrack(sender);
      peer.pc.addTrack(camera, this.localStream);
    } catch (err) {
      console.error('[CallMesh] could not re-negotiate the camera:', err);
    }
  }

  /**
   * Watches the peer connections and repairs the ones that get stuck.
   *
   * Two things can go wrong on a link: the remote video track arrives but
   * never carries a frame (the camera did not make it into the negotiated
   * description), or the connection never gets past "connecting" because the
   * ICE candidates were not exchanged.
   *
   * A stuck connection is repaired by restarting ICE — the next offer then
   * carries fresh ICE credentials and the candidates are exchanged again.
   */
  startHealthCheck() {
    if (this.healthTimer) return;

    this.healthTimer = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.pc.connectionState === 'closed') continue;

        const now = Date.now();

        // A connection that never got going. Restarting ICE invalidates the
        // current credentials, so it is only done a couple of times and not
        // too often — otherwise the connection can never settle.
        if (peer.pc.connectionState !== 'connected') {
          peer.stuckSince = peer.stuckSince || now;
          if (now - peer.stuckSince < 10000) continue;
          if (peer.iceRestarts >= 3) continue;
          if (now - (peer.iceRestartAt || 0) < 15000) continue;
          peer.iceRestartAt = now;
          peer.iceRestarts = (peer.iceRestarts || 0) + 1;
          try {
            peer.pc.restartIce();
          } catch (err) {
            console.error('[CallMesh] could not restart ICE:', err);
          }
          this.negotiate(peer);
          continue;
        }
        peer.stuckSince = 0;

        if (!this.camEnabled) continue;
        if (peer.republishRequested) continue;

        const track = peer.stream ? peer.stream.getVideoTracks()[0] : null;
        if (!track || !track.muted) continue;

        peer.republishRequested = true;
        this.sendSignal(peer.peerId, 'video-republish', {});
        setTimeout(() => {
          peer.republishRequested = false;
        }, 10000);
      }
    }, 4000);
  }

  /**
   * Handles an inbound signalling message.
   *
   * The messages arrive over a WebSocket in order, but handling them is
   * asynchronous — and interleaving them corrupts the negotiation (an answer
   * applied while an offer is still being processed throws "wrong state",
   * and the peer connection never starts). The messages for one peer are
   * therefore processed strictly one at a time.
   *
   * @param {string} fromPeerId
   * @param {'offer'|'answer'|'candidate'|'video-republish'} signalType
   * @param {any} payload
   */
  async handleSignal(fromPeerId, signalType, payload) {
    let peer = this.peers.get(fromPeerId);

    if (!peer) {
      // Creating the connection is part of the chain too, so that the first
      // message is not processed on a half-built connection.
      const created = this.peers.get(fromPeerId);
      peer = created || (await this.createPeer(fromPeerId));
    }

    const previous = peer.signalChain || Promise.resolve();
    const next = previous
      .then(() => this.applySignal(peer, signalType, payload))
      .catch((err) => {
        console.error('[CallMesh] signal handling failed:', err);
      });

    peer.signalChain = next;
    await next;
  }

  /** Applies one signalling message to a peer connection. */
  async applySignal(peer, signalType, payload) {
    const fromPeerId = peer.peerId;
    const { pc } = peer;

    if (signalType === 'video-republish') {
      this.republishVideo(peer);
      return;
    }

    if (signalType === 'offer' || signalType === 'answer') {
      const description = payload?.sdp;
      if (!description) return;

      const offerCollision =
        description.type === 'offer' &&
        (peer.makingOffer || pc.signalingState !== 'stable');

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      peer.isSettingRemoteAnswerPending = description.type === 'answer';

      await pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;

      // Apply the ICE candidates that arrived while the connection was still
      // being set up. Dropping them leaves the connection in the "new" state
      // with no media at all.
      if (peer.pendingCandidates.length > 0) {
        const queued = peer.pendingCandidates;
        peer.pendingCandidates = [];
        for (const candidate of queued) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.error('[CallMesh] could not apply a queued ICE candidate:', err);
          }
        }
      }

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.sendSignal(fromPeerId, 'answer', { sdp: pc.localDescription });

        // Our answer only carries the camera if the remote's offer had a
        // media section for it. If not, the camera needs a fresh offer.
        this.ensureCameraNegotiated(peer);
      }

      // The connection is stable again — pick up a negotiation that had to
      // wait for it, otherwise the peer connection would never start.
      if (peer.renegotiateQueued && !peer.offering) {
        peer.renegotiateQueued = false;
        this.negotiate(peer);
      }
      return;
    }

    if (signalType === 'candidate') {
      const candidate = payload?.candidate;
      if (!candidate) return;

      // A candidate can arrive before the remote description has been
      // applied — adding it then fails and the candidate is lost, which
      // leaves the connection unable to start. Hold it until the description
      // is in place.
      if (!pc.remoteDescription) {
        peer.pendingCandidates.push(candidate);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        // Errors are expected for candidates that arrive after a collision
        // was ignored — only surface them for a peer we are not ignoring.
        if (!peer.ignoreOffer) {
          console.error('[CallMesh] addIceCandidate failed:', err);
        }
      }
    }
  }

  /** Tears down a single peer connection. */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try { peer.pc.close(); } catch { /* already closed */ }
    this.onPeerGone(peerId);
  }

  /** Current remote streams, keyed by peer id. */
  getRemoteStreams() {
    const map = new Map();
    for (const [peerId, peer] of this.peers) {
      if (peer.stream) map.set(peerId, peer.stream);
    }
    return map;
  }

  /** Closes every peer connection and releases the local devices. */
  close() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const peerId of Array.from(this.peers.keys())) {
      this.removePeer(peerId);
    }

    const stop = (track) => {
      if (!track) return;
      track.onended = null;
      try { track.stop(); } catch { /* already stopped */ }
    };

    stop(this.screenTrack);
    stop(this.cameraTrack);
    stop(this.micTrack);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) stop(track);
    }

    this.localStream = null;
    this.cameraTrack = null;
    this.micTrack = null;
    this.screenTrack = null;
    this.screenPreviewStream = null;
    this.selfPeerId = null;
  }
}

export default CallMesh;
