import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutboundPacket } from '../lib/protocol';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * If `onopen` has not fired within this window, the attempt is treated as
 * failed. Some networks silently drop the TCP handshake, and React Native then
 * delivers neither `onerror` nor `onclose`, which would otherwise leave the UI
 * stuck on "connecting" forever with no retry ever scheduled.
 */
const CONNECT_TIMEOUT_MS = 6000;

/**
 * Robust WebSocket hook with automatic exponential-backoff reconnect.
 *
 * This replaces the web phone.js's simple `socket.onclose = () => setTimeout(connect, 2000)`
 * with proper backoff: 1s → 2s → 4s → 8s → 16s → 30s cap.
 *
 * The native WebSocket API is available in React Native without any imports.
 */
export function useWebSocket(url: string | null) {
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const wsRef      = useRef<WebSocket | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef     = useRef(url);
  const mountedRef = useRef(true);
  /** Fires on every successful open, so callers can re-sync state on reconnect. */
  const onOpenRef  = useRef<(() => void) | null>(null);
  /** Short, human-readable reason for the current failure, if any. */
  const [lastError, setLastError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Track latest URL without triggering reconnect effect constantly
  useEffect(() => { urlRef.current = url; }, [url]);

  /** Queue the next attempt with exponential backoff (1s → 30s cap). */
  const scheduleRetry = useCallback(() => {
    if (!mountedRef.current) return;
    const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30_000);
    retryCount.current += 1;
    setAttempt(retryCount.current);
    retryTimer.current = setTimeout(() => {
      // `connect` is referenced through a ref-free closure via the ref below.
      connectRef.current?.();
    }, delay);
  }, []);

  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    // Close any existing socket and detach every handler so the old socket
    // cannot schedule a second reconnect.
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      try { wsRef.current.close(); } catch { /* already gone */ }
      wsRef.current = null;
    }
    if (connectTimer.current) {
      clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }

    // No URL yet (settings still loading): stay idle rather than dialling a
    // placeholder host and burning the retry schedule.
    if (!urlRef.current) {
      setStatus('disconnected');
      return;
    }

    setStatus('connecting');
    const dialed = urlRef.current;
    let ws: WebSocket;
    try {
      ws = new WebSocket(dialed);
    } catch (e) {
      // A malformed URL throws synchronously; treat it as a failed attempt so
      // the retry loop still runs.
      setLastError(`invalid hub address "${dialed}" — check the IP in Settings`);
      setStatus('disconnected');
      scheduleRetry();
      return;
    }
    wsRef.current = ws;

    // Guarantee progress even if the socket goes silent.
    connectTimer.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (ws.readyState !== WebSocket.OPEN) {
        setLastError(`no response from ${dialed} after ${CONNECT_TIMEOUT_MS / 1000}s — ` +
          `check the hub is running, the IP is right, and the phone is on the same Wi-Fi`);
        try { ws.close(); } catch { /* already gone */ }
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
      retryCount.current = 0;
      setAttempt(0);
      setLastError(null);
      setStatus('connected');
      onOpenRef.current?.();
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
      setStatus('disconnected');
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      scheduleRetry();
    };

    ws.onerror = () => {
      // onclose normally follows, so this only records the reason.
      if (mountedRef.current) {
        setLastError(`cannot reach ${dialed} — check hub is running, ` +
          `phone is on the same Wi-Fi, and the IP in Settings is correct`);
      }
    };
  }, []); // stable — uses refs

  // `scheduleRetry` cannot close over `connect` (which is declared later), so
  // keep a ref to the latest implementation.
  connectRef.current = connect;

  // Connect on mount, reconnect when URL changes
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (connectTimer.current) clearTimeout(connectTimer.current);
      wsRef.current?.close();
    };
  }, [url, connect]);

  /** Register a callback fired on every successful (re)connect. */
  const setOnOpen = useCallback((fn: (() => void) | null) => {
    onOpenRef.current = fn;
  }, []);

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

  return { status, send, reconnect, setOnOpen, lastError, attempt, url };
}
