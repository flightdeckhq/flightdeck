import { useEffect, useState, useRef } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";
import { SESSION_POLL_INTERVAL_MS, SESSION_INITIAL_POLL_MS } from "@/lib/constants";

// Module-level cache: sessionId → events array.
// Exported so Fleet.tsx can inject WebSocket events directly.
export const eventsCache = new Map<string, AgentEvent[]>();

/**
 * Fetches events for a session with module-level caching.
 * When isActive=true, polls for new events.
 * First poll fires after SESSION_INITIAL_POLL_MS (2s),
 * subsequent polls at SESSION_POLL_INTERVAL_MS (15s).
 */
export function useSessionEvents(sessionId: string, isActive = false, version = 0) {
  const [events, setEvents] = useState<AgentEvent[]>(
    () => eventsCache.get(sessionId) ?? []
  );
  const [loading, setLoading] = useState(!eventsCache.has(sessionId));
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedRef = useRef(false);

  // Re-read from cache when version changes (WebSocket injection)
  useEffect(() => {
    if (version > 0) {
      const cached = eventsCache.get(sessionId);
      if (cached) setEvents(cached);
    }
  }, [version, sessionId]);

  useEffect(() => {
    let cancelled = false;
    hasLoadedRef.current = false;

    function doFetch() {
      fetchSession(sessionId)
        .then((detail) => {
          if (cancelled) return;
          const evts = detail.events ?? [];
          // Only cache non-empty results to avoid caching
          // before workers have processed the events
          if (evts.length > 0) {
            eventsCache.set(sessionId, evts);
            hasLoadedRef.current = true;
          }
          setEvents(evts);
        })
        .catch(() => {
          if (cancelled) return;
          setEvents([]);
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            if (isActive && !cancelled) {
              schedulePoll();
            }
          }
        });
    }

    function schedulePoll() {
      // Use fast interval until first successful load, then normal
      const delay = hasLoadedRef.current
        ? SESSION_POLL_INTERVAL_MS
        : SESSION_INITIAL_POLL_MS;
      pollRef.current = setTimeout(() => {
        if (!cancelled) doFetch();
      }, delay);
    }

    // Initial fetch (skip if cached and not active)
    if (eventsCache.has(sessionId) && !isActive) {
      setEvents(eventsCache.get(sessionId)!);
      setLoading(false);
    } else {
      setLoading(!eventsCache.has(sessionId));
      doFetch();
    }

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sessionId, isActive]);

  return { events, loading };
}
