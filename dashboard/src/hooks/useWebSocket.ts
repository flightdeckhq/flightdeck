import { useEffect, useRef, useCallback } from "react";

const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket hook with native exponential backoff reconnect.
 * No external dependencies -- reconnect logic is built in.
 *
 * Passing ``url = null`` opts out of the WS subscription entirely
 * — the hook becomes a no-op. Used by ``useFleet`` under E2E when
 * the keep-alive WS disable flag is set so periodic fixture-
 * refresh events from the test harness don't perturb
 * IntersectionObserver virtualization or sidebar pagination
 * under parallel-worker load.
 *
 * ``onMessage`` is captured into a ref so a parent that passes a
 * fresh closure on every render does not retrigger connect /
 * reconnect. The handler ref always points at the latest closure
 * so the WS sees current state without forcing a reconnect.
 */
export function useWebSocket(
  url: string | null,
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
    if (url == null) return;

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
