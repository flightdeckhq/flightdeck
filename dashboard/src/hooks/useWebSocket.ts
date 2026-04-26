import { useEffect, useRef, useCallback } from "react";

const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket hook with native exponential backoff reconnect.
 * No external dependencies -- reconnect logic is built in.
 *
 * Phase 4.5 M-16: ``onMessage`` is captured into a ref so a parent
 * that passes a fresh closure on every render does not retrigger
 * connect / reconnect. Pre-fix, an inline ``onMessage={(d) => ...}``
 * caller forced ``connect`` to recreate every render and tore down
 * the WS each time, masking real reconnect telemetry. The handler
 * ref always points at the latest closure so the WS sees current
 * state without forcing a reconnect.
 */
export function useWebSocket(
  url: string,
  onMessage: (data: string) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);
  const handlerRef = useRef(onMessage);

  // Keep the handler ref in sync without triggering connect.
  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      backoffRef.current = 1000; // reset on successful connect
    };

    ws.onmessage = (event: MessageEvent) => {
      handlerRef.current(event.data as string);
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
    };
  }, [connect]);
}
