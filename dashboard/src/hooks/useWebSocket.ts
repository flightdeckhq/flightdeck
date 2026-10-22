import { useEffect, useRef } from "react";

/** First reconnect delay; doubles on each failed attempt. */
const INITIAL_BACKOFF_MS = 1000;
/** Ceiling for the reconnect delay. */
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
  const handlerRef = useRef(onMessage);

  // Keep the handler ref in sync without triggering connect.
  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  // One connection loop per url. ``active`` is cleared on unmount or
  // url change so a socket closing during teardown does not schedule
  // a reconnect, and a pending reconnect timer is cancelled.
  useEffect(() => {
    if (url == null) return;
    let active = true;
    let ws: WebSocket | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (!active) return;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        backoff = INITIAL_BACKOFF_MS; // reset on successful connect
      };

      socket.onmessage = (event: MessageEvent) => {
        handlerRef.current(event.data as string);
      };

      socket.onclose = () => {
        if (!active) return;
        const delay = backoff;
        backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      active = false;
      window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [url]);
}
