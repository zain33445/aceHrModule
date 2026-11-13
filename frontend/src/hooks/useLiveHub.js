/**
 * useLiveHub — ONE viewer WebSocket for a mounted Recording tab (docs/recording-v2.md §11).
 *
 * Returns { agents, connectionState, subscribe, getIceServers }.
 *  - agents carry `screens` (monitors on the agent, 1 for old agents).
 *  - agents: array, one per userId. A disconnected agent is kept 60 s
 *    (connected:false → "Reconnecting") and then dropped.
 *  - connectionState: 'connecting' | 'open' | 'reconnecting' | 'denied' (terminal: no access).
 *  - subscribe(userId, quality, handlers, screen = 0) → { streamId, setQuality(q), setScreen(n), signal(payload), close() }.
 *    screen: 0 = follow the cursor, 1..16 = fixed screen (LIVE_SCREEN switches it live).
 *    handlers: onSubscribed({streamId, iceServers}), onRejected(reason), onSignal(msg),
 *    onState(state, error), onEnded(reason).
 *    When the socket drops every stream is gone: handlers get onEnded('socket_closed')
 *    and consumers resubscribe once connectionState is 'open' again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { WS_BASE } from '../services/endpoints';

const GONE_MS = 60_000;
const STALE_MS = 65_000; // open but silent (the server PINGs ~every 30 s) → half-open socket
const STABLE_MS = 30_000; // backoff resets only after the socket stayed open this long
const isDenied = (err) => [401, 403].includes(err?.response?.status);

function wsUrl(token) {
  const base = WS_BASE || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  return `${base}/admin-recording-ws?token=${encodeURIComponent(token)}`;
}

export default function useLiveHub() {
  const [agentMap, setAgentMap] = useState({});
  const [connectionState, setConnectionState] = useState('connecting');
  const wsRef = useRef(null);
  const iceRef = useRef([]);
  const byStream = useRef(new Map()); // streamId -> sub
  const pending = useRef([]); // subs awaiting LIVE_SUBSCRIBED / LIVE_REJECTED, in send order
  const goneTimers = useRef(new Map());

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const subscribe = useCallback((userId, quality, handlers, screen = 0) => {
    const sub = { userId, handlers, streamId: null, closed: false };
    pending.current.push(sub);
    send({ type: 'LIVE_SUBSCRIBE', userId, quality, screen });
    return {
      get streamId() { return sub.streamId; },
      setQuality(q) {
        if (sub.streamId && !sub.closed) send({ type: 'LIVE_QUALITY', streamId: sub.streamId, quality: q });
      },
      setScreen(n) {
        if (sub.streamId && !sub.closed) send({ type: 'LIVE_SCREEN', streamId: sub.streamId, screen: n });
      },
      signal(payload) {
        if (sub.streamId && !sub.closed) send({ type: 'LIVE_SIGNAL', streamId: sub.streamId, ...payload });
      },
      close() {
        if (sub.closed) return;
        sub.closed = true;
        if (sub.streamId) {
          byStream.current.delete(sub.streamId);
          send({ type: 'LIVE_UNSUBSCRIBE', streamId: sub.streamId });
        } // else: unsubscribed as soon as LIVE_SUBSCRIBED arrives
      },
    };
  }, [send]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    let attempt = 0;
    let denied = false;
    let openedAt = 0;
    let lastMsgAt = 0;
    let poll = null;
    let watchdog = null;
    const gone = goneTimers.current;
    const streams = byStream.current;

    const upsert = (a) => {
      const old = gone.get(a.userId);
      if (old) { clearTimeout(old); gone.delete(a.userId); }
      setAgentMap((m) => ({ ...m, [a.userId]: a }));
      if (a.connected === false) {
        gone.set(a.userId, setTimeout(() => {
          gone.delete(a.userId);
          setAgentMap((m) => {
            if (m[a.userId]?.connected !== false) return m;
            const { [a.userId]: _drop, ...rest } = m;
            return rest;
          });
        }, GONE_MS));
      }
    };

    const failAll = () => {
      const subs = [...byStream.current.values(), ...pending.current.filter((s) => !s.closed)];
      byStream.current.clear();
      pending.current = [];
      for (const s of subs) if (!s.closed) s.handlers.onEnded?.('socket_closed');
    };

    // Terminal: no access to live recording. No reconnect, no presence poll.
    const deny = () => {
      denied = true;
      clearTimeout(retryTimer);
      clearInterval(poll);
      clearInterval(watchdog);
      setConnectionState('denied');
    };

    function scheduleRetry() {
      if (cancelled || denied) return;
      setConnectionState('reconnecting');
      const delay = Math.min(1000 * 2 ** attempt, 30_000) * (0.8 + Math.random() * 0.4);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    }

    async function connect() {
      let token;
      try {
        const res = await api.recordingGetAdminWsToken();
        token = res.data?.token;
      } catch (err) {
        if (!cancelled && isDenied(err)) { deny(); failAll(); return; }
      }
      if (cancelled) return;
      if (!token) { scheduleRetry(); return; }

      const mine = new WebSocket(wsUrl(token));
      wsRef.current = mine;
      lastMsgAt = Date.now();
      const closed = (code) => {
        if (wsRef.current === mine) wsRef.current = null;
        if (cancelled) return;
        if (openedAt && Date.now() - openedAt >= STABLE_MS) attempt = 0;
        openedAt = 0;
        failAll();
        if (code === 4003) deny(); // access revoked: never reconnect
        else scheduleRetry();
      };
      mine.stale = () => { mine.onclose = null; mine.onmessage = null; mine.close(); closed(0); };
      mine.onmessage = (ev) => {
        if (cancelled || wsRef.current !== mine) return;
        lastMsgAt = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        switch (m.type) {
          case 'CONNECTED':
            iceRef.current = m.iceServers || [];
            openedAt = Date.now();
            setConnectionState('open');
            break;
          case 'LIVE_PRESENCE':
            for (const t of gone.values()) clearTimeout(t);
            gone.clear();
            setAgentMap({});
            for (const a of m.agents || []) upsert(a);
            break;
          case 'LIVE_PRESENCE_UPDATE':
            if (m.agent) upsert(m.agent);
            break;
          case 'PING':
            mine.send(JSON.stringify({ type: 'PONG' }));
            break;
          case 'LIVE_SUBSCRIBED': {
            const i = pending.current.findIndex((s) => s.userId === m.userId);
            if (i < 0) break;
            const [sub] = pending.current.splice(i, 1);
            sub.streamId = m.streamId;
            if (sub.closed) { send({ type: 'LIVE_UNSUBSCRIBE', streamId: m.streamId }); break; }
            byStream.current.set(m.streamId, sub);
            sub.handlers.onSubscribed?.({ streamId: m.streamId, quality: m.quality, iceServers: m.iceServers });
            break;
          }
          case 'LIVE_REJECTED': {
            const i = pending.current.findIndex((s) => s.userId === m.userId);
            if (i < 0) break;
            const [sub] = pending.current.splice(i, 1);
            if (!sub.closed) sub.handlers.onRejected?.(m.reason);
            break;
          }
          case 'LIVE_SIGNAL':
            byStream.current.get(m.streamId)?.handlers.onSignal?.(m);
            break;
          case 'LIVE_STATE':
            byStream.current.get(m.streamId)?.handlers.onState?.(m.state, m.error);
            break;
          case 'LIVE_ENDED': {
            const sub = byStream.current.get(m.streamId);
            byStream.current.delete(m.streamId);
            if (sub && !sub.closed) { sub.closed = true; sub.handlers.onEnded?.(m.reason); }
            break;
          }
          default: break;
        }
      };
      mine.onclose = (ev) => closed(ev?.code);
      mine.onerror = () => { /* onclose follows */ };
    }

    // Half-open detection: an OPEN socket with no frame at all for 65 s is dead.
    watchdog = setInterval(() => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > STALE_MS) w.stale?.();
    }, 5_000);

    connect();

    // First paint / fallback while the socket is not open.
    poll = setInterval(async () => {
      if (denied || wsRef.current?.readyState === WebSocket.OPEN) return;
      try {
        const res = await api.recordingGetLivePresence();
        if (!cancelled && !denied && wsRef.current?.readyState !== WebSocket.OPEN) {
          const next = {};
          for (const a of res.data || []) next[a.userId] = a;
          setAgentMap(next);
        }
      } catch (err) { if (!cancelled && isDenied(err)) deny(); }
    }, 15_000);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearInterval(poll);
      clearInterval(watchdog);
      for (const t of gone.values()) clearTimeout(t);
      gone.clear();
      const w = wsRef.current;
      wsRef.current = null;
      if (w) { w.onclose = null; w.onmessage = null; w.close(); }
      streams.clear();
      pending.current = [];
    };
  }, [send]);

  const getIceServers = useCallback(() => iceRef.current, []);
  return { agents: Object.values(agentMap), connectionState, subscribe, getIceServers };
}
