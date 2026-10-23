import { useEffect, useRef, useState, useCallback } from 'react';
import api from '../services/api';
import { WS_BASE } from '../services/endpoints';

/**
 * useCallSocket — connects to the call WebSocket gateway (/call-ws) with
 * auto-reconnect.
 *
 * Unlike useChatSocket (which trusts an unsigned ?userId= query parameter),
 * the call gateway requires a *signed* ticket. The ticket is short-lived
 * (5 minutes), so it is fetched fresh on every connection attempt.
 *
 * Calls onEvent(payload) for every server message, except the keep-alive
 * PING which is answered automatically.
 *
 * Returns { connected, connecting, send, reconnect }.
 */
export function useCallSocket({ enabled = true, onEvent, onReconnect } = {}) {
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  const pendingRef = useRef([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Keep the latest handlers without re-opening the socket on every render.
  useEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = onReconnect;
  }, [onEvent, onReconnect]);

  useEffect(() => {
    if (!enabled) return undefined;

    let closed = false;
    let retryTimer = null;
    let attempt = 0;
    // Tracks whether a socket of *this* connection attempt has already opened,
    // so that onReconnect only fires for a genuine reconnection (and not for
    // the duplicate socket React StrictMode creates on mount).
    let hadOpen = false;

    // WS_BASE is empty when the dev server proxies the gateway, which makes
    // the socket URL relative (and therefore same-origin and secure).
    const wsBase = WS_BASE;

    const scheduleRetry = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
      retryTimer = setTimeout(connect, delay);
    };

    const connect = async () => {
      if (closed) return;
      setConnecting(true);

      let token = null;
      try {
        const res = await api.getCallWsToken();
        token = res?.data?.token || null;
      } catch {
        token = null;
      }

      if (closed) return;

      if (!token) {
        setConnecting(false);
        scheduleRetry();
        return;
      }

      const url = `${wsBase}/call-ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setConnecting(false);
        attempt = 0;

        // Flush anything that was queued while the socket was down. Dropping
        // an offer or an answer silently would leave the peer connection
        // stuck in the "new" state with no media at all.
        const queued = pendingRef.current;
        pendingRef.current = [];
        for (const payload of queued) {
          ws.send(JSON.stringify(payload));
        }

        if (hadOpen) {
          // The socket dropped and came back — the server has forgotten our
          // peer, so the caller has to re-join.
          onReconnectRef.current?.();
        }
        hadOpen = true;
      };

      ws.onclose = () => {
        setConnected(false);
        setConnecting(false);
        if (!closed) scheduleRetry();
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'PING') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
          }
          return;
        }

        onEventRef.current?.(msg);
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      setConnected(false);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled]);

  /**
   * Sends a message. While the socket is down the message is queued and
   * flushed as soon as it is open again — a dropped offer or answer would
   * leave a peer connection permanently without media.
   */
  const send = useCallback((payload, { queue = true } = {}) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    if (queue) pendingRef.current.push(payload);
    return false;
  }, []);

  /** Sends a message only if the socket is open right now. */
  const sendNow = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const reconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  return { connected, connecting, send, sendNow, reconnect };
}

export default useCallSocket;
