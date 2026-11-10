/**
 * useLiveStream — one recv-only WebRTC stream for one agent (docs/recording-v2.md §11).
 * Returns { stream, status, setQuality }.
 * status: connecting | live | busy | offline | unsupported | denied | idle.
 * Subscribes while `active` && agent connected && liveCapable && hub socket open;
 * everything is torn down (peer closed, subscription closed) otherwise or on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CONNECT_TIMEOUT_MS = 15_000;
const BUSY_RETRY_MS = 30_000;
const OFFLINE_RETRY_MS = 10_000;

export default function useLiveStream(hub, agent, active = true) {
  const [stream, setStream] = useState(null);
  const [status, setStatus] = useState('connecting');
  const subRef = useRef(null);
  const qualityRef = useRef('grid');
  const { userId, connected, liveCapable } = agent;
  const open = hub.connectionState === 'open';
  const { subscribe, getIceServers } = hub;

  const setQuality = useCallback((q) => {
    qualityRef.current = q;
    subRef.current?.setQuality(q);
  }, []);

  useEffect(() => {
    if (!active || !open || !connected || !liveCapable) return undefined;
    let dead = false;
    let sub = null;
    let pc = null;
    let attempt = 0;
    let connTimer = null;
    let retryTimer = null;
    let remoteSet = false;
    let queued = [];

    const teardown = () => {
      clearTimeout(connTimer);
      if (pc) {
        pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null;
        pc.close();
        pc = null;
      }
      if (sub) { sub.close(); sub = null; subRef.current = null; }
      setStream(null);
    };

    const retry = (delayMs, nextStatus = 'connecting') => {
      teardown();
      if (dead) return;
      setStatus(nextStatus);
      const delay = delayMs ?? Math.min(2000 * 2 ** attempt, 30_000);
      attempt += 1;
      retryTimer = setTimeout(start, delay);
    };

    const markLive = () => {
      clearTimeout(connTimer);
      attempt = 0;
      setStatus('live');
    };

    function start() {
      if (dead) return;
      setStatus('connecting');
      remoteSet = false;
      queued = [];
      // The peer is created when LIVE_SUBSCRIBED delivers fresh iceServers (the offer follows it).
      let myPc = null;
      const makePc = (iceServers) => {
        const mine = new RTCPeerConnection({ iceServers: iceServers?.length ? iceServers : getIceServers() });
        myPc = mine;
        pc = mine;
        mine.ontrack = (e) => {
          if (pc === mine) setStream(e.streams[0] || new MediaStream([e.track]));
        };
        mine.onicecandidate = (e) => {
          if (!e.candidate || pc !== mine) return;
          const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
          sub?.signal({ candidate: { candidate, sdpMid, sdpMLineIndex } });
        };
        mine.onconnectionstatechange = () => {
          if (pc !== mine) return;
          if (mine.connectionState === 'connected') markLive();
          else if (mine.connectionState === 'failed') retry();
        };
      };
      connTimer = setTimeout(() => { if (!dead) retry(); }, CONNECT_TIMEOUT_MS);

      const s = subscribe(userId, qualityRef.current, {
        onSubscribed: ({ iceServers }) => { if (!myPc && pc === null) makePc(iceServers); },
        onSignal: async (m) => {
          if (!myPc || pc !== myPc) return;
          try {
            if (m.description) {
              await myPc.setRemoteDescription(m.description);
              remoteSet = true;
              for (const c of queued) await myPc.addIceCandidate(c).catch(() => {});
              queued = [];
              if (m.description.type === 'offer') {
                const answer = await myPc.createAnswer();
                await myPc.setLocalDescription(answer);
                if (pc === myPc) s.signal({ description: { type: answer.type, sdp: answer.sdp } });
              }
            }
            if (m.candidate) {
              if (remoteSet) await myPc.addIceCandidate(m.candidate).catch(() => {});
              else queued.push(m.candidate);
            }
          } catch (err) {
            console.warn('[live] signalling failed', err);
            if (pc === myPc) retry();
          }
        },
        onState: (state) => {
          if (pc !== myPc) return;
          if (state === 'connected') markLive();
          else if (state === 'failed') retry();
        },
        onRejected: (reason) => {
          if (pc !== myPc) return;
          if (reason === 'viewer_limit') {
            retry(BUSY_RETRY_MS, 'busy');
          } else if (reason === 'offline') {
            // Agent still listed as connected: try again (the effect is torn down if it stops being listed).
            retry(OFFLINE_RETRY_MS, 'offline');
          } else {
            teardown();
            setStatus(reason === 'not_live_capable' ? 'unsupported' : 'denied');
          }
        },
        onEnded: () => { if (pc === myPc) { sub = null; subRef.current = null; retry(); } },
      });
      sub = s;
      subRef.current = s;
    }

    start();
    return () => {
      dead = true;
      clearTimeout(retryTimer);
      teardown();
    };
  }, [active, open, connected, liveCapable, userId, subscribe, getIceServers]);

  const live = active && open && connected && liveCapable;
  return { stream: live ? stream : null, status: live ? status : 'idle', setQuality };
}
