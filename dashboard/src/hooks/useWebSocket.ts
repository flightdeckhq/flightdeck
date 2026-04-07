import { useEffect, useRef, useCallback } from "react";

const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket hook with native exponential backoff reconnect.
 * No external dependencies -- reconnect logic is built in.
 */
export function useWebSocket(
  url: string,
  onMessage: (data: string) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      backoffRef.current = 1000; // reset on successful connect
    };

    ws.onmessage = (event: MessageEvent) => {
      onMessage(event.data as string);
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
  }, [url, onMessage]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
    };
  }, [connect]);
}
