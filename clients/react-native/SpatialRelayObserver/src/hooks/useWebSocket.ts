import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboundPacket, OutboundPacket } from '../lib/protocol';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Robust WebSocket hook with automatic exponential-backoff reconnect.
 *
 * This replaces the web phone.js's simple `socket.onclose = () => setTimeout(connect, 2000)`
 * with proper backoff: 1s → 2s → 4s → 8s → 16s → 30s cap.
 *
 * The native WebSocket API is available in React Native without any imports.
 */
export function useWebSocket(url: string | null, onMessage?: (packet: InboundPacket) => void) {
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const wsRef      = useRef<WebSocket | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef     = useRef(url);
  const mountedRef = useRef(true);

  // Track latest URL without triggering reconnect effect constantly
  urlRef.current = url;

  const connect = useCallback(() => {
    if (!mountedRef.current || !urlRef.current) return;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    // Close any existing socket
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent double-reconnect
      wsRef.current.close();
    }

    setStatus('connecting');
    const ws = new WebSocket(urlRef.current);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      retryCount.current = 0;
      setStatus('connected');
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('disconnected');
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30_000);
      retryCount.current += 1;
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onmessage = (event) => {
      if (!onMessageRef.current || typeof event.data !== 'string') return;
      try { onMessageRef.current(JSON.parse(event.data) as InboundPacket); } catch {}
    };

    ws.onerror = () => {
      // onclose will fire after onerror; no need to handle separately
    };
  }, []); // stable — uses refs

  // Connect on mount, reconnect when URL changes
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatus('disconnected');
    };
  }, [url, connect]);

  const send = useCallback((packet: OutboundPacket) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(packet));
    }
  }, []);

  const reconnect = useCallback(() => {
    retryCount.current = 0;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    connect();
  }, [connect]);

  return { status, send, reconnect };
}
