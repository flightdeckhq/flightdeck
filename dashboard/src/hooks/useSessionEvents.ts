import { useEffect, useState, useRef } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";
import { SESSION_POLL_INTERVAL_MS } from "@/lib/constants";

// Module-level cache: sessionId → events array.
const eventsCache = new Map<string, AgentEvent[]>();

/**
 * Fetches events for a session with module-level caching.
 * When isActive=true, polls every 15 seconds for new events.
 * Note: IntersectionObserver lazy loading is a Phase 5 optimization.
 */
export function useSessionEvents(sessionId: string, isActive = false) {
  const [events, setEvents] = useState<AgentEvent[]>(
    () => eventsCache.get(sessionId) ?? []
  );
  const [loading, setLoading] = useState(!eventsCache.has(sessionId));
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    function doFetch() {
      fetchSession(sessionId)
        .then((detail) => {
          if (cancelled) return;
          const evts = detail.events ?? [];
          eventsCache.set(sessionId, evts);
          setEvents(evts);
        })
        .catch(() => {
          if (cancelled) return;
          setEvents([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    // Initial fetch (skip if cached and not active)
    if (eventsCache.has(sessionId) && !isActive) {
      setEvents(eventsCache.get(sessionId)!);
      setLoading(false);
    } else {
      setLoading(!eventsCache.has(sessionId));
      doFetch();
    }

    // Poll for active sessions
    if (isActive) {
      pollRef.current = setInterval(() => {
        eventsCache.delete(sessionId); // Invalidate cache before poll
        doFetch();
      }, SESSION_POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sessionId, isActive]);

  return { events, loading };
}
