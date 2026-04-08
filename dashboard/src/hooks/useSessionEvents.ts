import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// Module-level cache: sessionId → events array.
// Persists across re-renders. Cleared on page refresh.
const eventsCache = new Map<string, AgentEvent[]>();

/**
 * Fetches events for a session with module-level caching.
 * Does not re-fetch if the session's events are already cached.
 * Note: IntersectionObserver lazy loading is a Phase 5 optimization.
 */
export function useSessionEvents(sessionId: string) {
  const [events, setEvents] = useState<AgentEvent[]>(
    () => eventsCache.get(sessionId) ?? []
  );
  const [loading, setLoading] = useState(!eventsCache.has(sessionId));

  useEffect(() => {
    if (eventsCache.has(sessionId)) {
      setEvents(eventsCache.get(sessionId)!);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

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

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return { events, loading };
}
