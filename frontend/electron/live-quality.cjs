// Pure helpers shared by live-renderer (require) and live-quality.check.mjs. No dependencies.

/**
 * Quality profile (docs/recording-v2.md §10) → RTCRtpEncodingParameters fields.
 * 'grid' = the 4-column level (old agents treat any non-'focus' value as it); grid2/grid3 are sharper tiles for 2/3 columns.
 */
const LEVELS = {
  focus: { width: 0, maxFramerate: 15, maxBitrate: 4_000_000 }, // native resolution
  grid2: { width: 1280, maxFramerate: 10, maxBitrate: 1_500_000 },
  grid3: { width: 960, maxFramerate: 10, maxBitrate: 1_000_000 },
  grid: { width: 640, maxFramerate: 10, maxBitrate: 600_000 },
};

function qualityToEncoding(quality, trackWidth) {
  const l = LEVELS[quality] || LEVELS.grid;
  const down = l.width === 0 ? 1 : trackWidth > 0 ? Math.max(1, trackWidth / l.width) : 2;
  // maintain-resolution: under load drop frames, not text sharpness.
  return { scaleResolutionDownBy: down, maxFramerate: l.maxFramerate, maxBitrate: l.maxBitrate, degradationPreference: 'maintain-resolution' };
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
