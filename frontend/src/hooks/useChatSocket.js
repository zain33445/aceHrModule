import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useChatSocket — connects to the chat WS gateway (/chat-ws?userId=) with auto-reconnect.
 * Calls onEvent(payload) for every server message: { type: 'MESSAGE'|'TYPING'|'READ_RECEIPT'|'CONNECTED', ... }.
 * Returns { connected, sendTyping(conversationId), sendRead(conversationId) }.
 */
export function useChatSocket(userId, onEvent) {
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const [connected, setConnected] = useState(false);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!userId) return;
    let closed = false;
    let retry;

    const apiBase = (import.meta.env.VITE_API_BASE || 'http://localhost:5000/api').replace(/\/+$/, '');
    const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/api\/?$/, '');
    const url = `${wsBase}/chat-ws?userId=${encodeURIComponent(userId)}`;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000); // reconnect
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          onEventRef.current?.(JSON.parse(e.data));
        } catch {
          /* ignore malformed frames */
        }
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [userId]);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const sendTyping = useCallback((conversationId) => send({ type: 'TYPING', conversationId }), [send]);
  const sendRead = useCallback((conversationId) => send({ type: 'READ', conversationId }), [send]);

  return { connected, sendTyping, sendRead };
}
