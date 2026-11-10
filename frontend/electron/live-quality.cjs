// Pure helpers shared by live-renderer (require) and live-quality.check.mjs. No dependencies.

/** Quality profile (docs/recording-v2.md §10) → RTCRtpEncodingParameters fields. */
function qualityToEncoding(quality) {
  return quality === 'focus'
    ? { scaleResolutionDownBy: 1, maxFramerate: 10, maxBitrate: 1_200_000 }
    : { scaleResolutionDownBy: 2, maxFramerate: 5, maxBitrate: 250_000 }; // grid (default)
}

/** RTCIceCandidate has getters that IPC/JSON drop: copy the fields explicitly. */
function serializeCandidate(c) {
  return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
}

/** RTCPeerConnection.connectionState → LIVE_STATE state, or null for "no report". */
function mapConnectionState(s) {
  switch (s) {
    case 'new':
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'failed': return 'failed';
    case 'closed': return 'closed';
    default: return null; // 'disconnected' is transient; ICE may recover, 'failed' reports it
  }
}

module.exports = { qualityToEncoding, serializeCandidate, mapConnectionState };
