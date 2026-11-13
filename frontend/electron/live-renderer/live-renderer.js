/**
 * live-renderer.js — live view engine (hidden BrowserWindow, nodeIntegration).
 * docs/recording-v2.md §12. Independent of the recorder window: own capture,
 * one RTCPeerConnection per streamId, the agent is the offerer.
 *
 * Received:  'live:start' {streamId, quality, iceServers, sourceId}, 'live:quality' {streamId, quality},
 *            'live:source' {streamId, sourceId} (switch monitor in place: replaceTrack, no renegotiation),
 *            'live:stop' {streamId}, 'live:stop-all' (socket lost; closes silently), 'live:signal' {streamId, description?, candidate?}
 * Sent:      'live:signal-out' {streamId, description?|candidate?}, 'live:state' {streamId, state, error?},
 *            'live:count' <number of open peers>
 */
const { ipcRenderer } = require('electron');
const { qualityToEncoding, serializeCandidate, mapConnectionState } = require('../live-quality.cjs');
const { createRegistry } = require('../live-registry.cjs');

const RELEASE_DELAY_MS = 30_000;
const ICE_RESTART_WAIT_MS = 10_000;

const peers = new Map(); // streamId → { pc, sender, pending, hasRemote, restarted, timer, lastState }
const captures = new Map(); // sourceId → { stream, track } (shared by every stream on that screen)
const capturing = new Map(); // sourceId → in-flight getUserMedia
const wantSource = new Map(); // streamId → {sourceId} requested before its peer existed
let releaseTimer = null;

const state = (streamId, s, error) => ipcRenderer.send('live:state', { streamId, state: s, ...(error ? { error } : {}) });
const sendCount = () => ipcRenderer.send('live:count', peers.size);
const errMsg = (e) => (e && e.message) || String(e);

// Stream lifecycle (A10): a LIVE_STOP that arrives while start() is still pending closes the peer as soon as it exists.
const registry = createRegistry({ onClosed: (id) => state(id, 'closed') });

function getCapture(sourceId) {
  const have = captures.get(sourceId);
  if (have && have.track.readyState === 'live') return Promise.resolve(have);
  if (capturing.has(sourceId)) return capturing.get(sourceId);
  const pr = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 20 } },
  }).then((stream) => {
    const track = stream.getVideoTracks()[0];
    const c = { stream, track, sourceId };
    captures.set(sourceId, c);
    track.addEventListener('ended', () => {
      if (captures.get(sourceId) !== c) return;
      captures.delete(sourceId); // display gone: fail the streams on it; viewers resubscribe and capture restarts
      for (const [id, p] of [...peers]) if (p.sourceId === sourceId) { state(id, 'failed', 'capture ended'); closePeer(id, { silent: true }); }
    });
    return c;
  }).finally(() => { capturing.delete(sourceId); });
  capturing.set(sourceId, pr);
  return pr;
}

/** Stops every capture no stream uses any more (after a grace period, so a reconnect can reuse it). */
function scheduleRelease() {
  if (releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    const used = new Set([...peers.values()].map((p) => p.sourceId));
    for (const [id, c] of [...captures]) {
      if (used.has(id) || capturing.has(id)) continue;
      c.stream.getTracks().forEach((t) => t.stop());
      captures.delete(id);
    }
  }, RELEASE_DELAY_MS);
}

async function applyQuality(p, quality) {
  if (!p.sender) return;
  p.quality = quality;
  const params = p.sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  const { degradationPreference, ...enc } = qualityToEncoding(quality, p.sender.track?.getSettings().width);
  Object.assign(params.encodings[0], enc);
  params.degradationPreference = degradationPreference;
  try { await p.sender.setParameters(params); } catch {
    delete params.degradationPreference; // older Chromium
    await p.sender.setParameters(params);
  }
}

function closePeer(streamId, { silent = false } = {}) {
  const p = peers.get(streamId);
  if (!p) return;
  peers.delete(streamId);
  wantSource.delete(streamId);
  registry.release(streamId);
  clearTimeout(p.timer);
  try { p.pc.close(); } catch { /* already closed */ }
  if (!silent) state(streamId, 'closed');
  sendCount();
  scheduleRelease();
}

function fail(streamId, e) {
  state(streamId, 'failed', errMsg(e));
  closePeer(streamId, { silent: true });
}

async function sendOffer(streamId, p, opts) {
  const offer = await p.pc.createOffer(opts);
  await p.pc.setLocalDescription(offer);
  const d = p.pc.localDescription;
  ipcRenderer.send('live:signal-out', { streamId, description: { type: d.type, sdp: d.sdp } });
}

/** Opens the peer; resolves with a handle for the registry (throws on failure after reporting it). */
async function startPeer({ streamId, quality, iceServers, sourceId }) {
  if (peers.has(streamId)) closePeer(streamId, { silent: true });
  state(streamId, 'connecting');
  let c;
  try { c = await getCapture(sourceId); }
  catch (e) { state(streamId, 'failed', `capture failed: ${errMsg(e)}`); scheduleRelease(); throw e; }
  try {
    const pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [] });
    const p = { pc, sourceId, quality, sender: null, pending: [], hasRemote: false, restarted: false, timer: null, lastState: 'connecting' };
    peers.set(streamId, p);
    sendCount();
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      ipcRenderer.send('live:signal-out', { streamId, candidate: serializeCandidate(ev.candidate) });
    };
    pc.onconnectionstatechange = () => {
      if (peers.get(streamId) !== p) return;
      const s = mapConnectionState(pc.connectionState);
      if (s === 'closed') return; // our own close() reports it
      if (s === 'failed') { fail(streamId, 'connection failed'); return; }
      if (s && s !== p.lastState) { p.lastState = s; state(streamId, s); }
    };
    pc.oniceconnectionstatechange = async () => {
      if (peers.get(streamId) !== p || pc.iceConnectionState !== 'failed' || p.restarted) return;
      p.restarted = true;
      try {
        pc.restartIce();
        await sendOffer(streamId, p, { iceRestart: true });
      } catch (e) { fail(streamId, e); return; }
      p.timer = setTimeout(() => {
        if (peers.get(streamId) === p && pc.connectionState !== 'connected') fail(streamId, 'ICE restart did not recover');
      }, ICE_RESTART_WAIT_MS);
    };
    p.sender = pc.addTrack(c.track, c.stream);
    await applyQuality(p, quality);
    await sendOffer(streamId, p);
    if (wantSource.has(streamId)) { const w = wantSource.get(streamId); switchSource(streamId, w.sourceId); } // asked to move while starting
    return { close: () => closePeer(streamId, { silent: true }) };
  } catch (e) { fail(streamId, e); throw e; }
}

const start = (m) => registry.start(m.streamId, () => startPeer(m)).catch(() => { /* already reported as failed */ });

/** Move a stream to another screen without renegotiating: replaceTrack, then re-apply its quality. */
async function switchSource(streamId, sourceId) {
  wantSource.delete(streamId);
  const p = peers.get(streamId);
  if (!p || p.sourceId === sourceId) return;
  try {
    const c = await getCapture(sourceId);
    if (peers.get(streamId) !== p) return;
    await p.sender.replaceTrack(c.track);
    p.sourceId = sourceId;
    await applyQuality(p, p.quality);
  } catch (e) { console.warn('[Live] screen switch failed', errMsg(e)); }
  scheduleRelease(); // the old screen's capture may be unused now
}

async function signal({ streamId, description, candidate }) {
  const p = peers.get(streamId);
  if (!p) return;
  try {
    if (description) {
      await p.pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
      p.hasRemote = true;
      for (const cand of p.pending.splice(0)) await p.pc.addIceCandidate(cand);
    } else if (candidate) {
      if (p.hasRemote) await p.pc.addIceCandidate(candidate); else p.pending.push(candidate);
    }
  } catch (e) { fail(streamId, e); }
}

ipcRenderer.on('live:start', (_e, m) => { start(m || {}); });
ipcRenderer.on('live:source', (_e, { streamId, sourceId } = {}) => {
  if (!streamId || !sourceId) return;
  if (peers.has(streamId)) switchSource(streamId, sourceId); else wantSource.set(streamId, { sourceId });
});
ipcRenderer.on('live:quality', (_e, { streamId, quality } = {}) => {
  const p = peers.get(streamId);
  if (p) applyQuality(p, quality).catch((e) => fail(streamId, e));
});
ipcRenderer.on('live:stop', (_e, { streamId } = {}) => { if (registry.has(streamId)) registry.stop(streamId); else closePeer(streamId); });
ipcRenderer.on('live:stop-all', () => {
  for (const id of [...peers.keys()]) closePeer(id, { silent: true });
  for (const id of registry.ids()) registry.stop(id); // still-starting streams
});
ipcRenderer.on('live:signal', (_e, m) => { signal(m || {}); });
