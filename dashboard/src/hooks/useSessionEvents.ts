import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// Module-level cache: sessionId → events array.
// Exported so Fleet.tsx can inject WebSocket events directly.
export const eventsCache = new Map<string, AgentEvent[]>();

/**
 * Fetches events for a session with module-level caching.
 * Makes exactly ONE HTTP request on mount to populate the cache.
 * After that, active sessions update via WebSocket cache injection
 * (version prop triggers re-read from cache).
 */
export function useSessionEvents(sessionId: string, _isActive = false, version = 0) {
  const [events, setEvents] = useState<AgentEvent[]>(
    () => eventsCache.get(sessionId) ?? []
  );
  const [loading, setLoading] = useState(!eventsCache.has(sessionId));

  // Re-read from cache when version changes (WebSocket injection)
  useEffect(() => {
    if (version > 0) {
      const cached = eventsCache.get(sessionId);
      if (cached) setEvents(cached);
    }
  }, [version, sessionId]);

  // Single fetch on mount (skip if already cached)
  useEffect(() => {
    if (eventsCache.has(sessionId)) {
      setEvents(eventsCache.get(sessionId)!);
      setLoading(false);
      return;
    }

    let cancelled = false;

    fetchSession(sessionId)
      .then((detail) => {
        if (cancelled) return;
        const evts = detail.events ?? [];
        if (evts.length > 0) {
          eventsCache.set(sessionId, evts);
        }
        setEvents(evts);
      })
      .catch(() => {
        if (cancelled) return;
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  return { events, loading };
}
