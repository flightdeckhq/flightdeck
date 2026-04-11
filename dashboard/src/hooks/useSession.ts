import { useState, useEffect } from "react";
import { fetchSession } from "@/lib/api";
import type { SessionDetail } from "@/lib/types";
import { eventsCache } from "./useSessionEvents";

// Cache session metadata so reopening the same drawer doesn't re-fetch
const sessionCache = new Map<string, SessionDetail>();

/**
 * Fetch session detail (metadata + events).
 * Caches results — reopening the same session does not re-fetch.
 * Populates eventsCache from the fetch response.
 */
export function useSession(sessionId: string | null) {
  const [data, setData] = useState<SessionDetail | null>(
    () => (sessionId ? sessionCache.get(sessionId) ?? null : null)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setData(null);
      return;
    }

    // Use cached session metadata if available
    const cached = sessionCache.get(sessionId);
    if (cached) {
      setData(cached);
      return;
    }

    setLoading(true);
    setError(null);
    fetchSession(sessionId)
      .then((detail) => {
        sessionCache.set(sessionId, detail);
        setData(detail);
        // Populate eventsCache so swimlane and drawer share the same data
        if (detail.events && detail.events.length > 0) {
          const existing = eventsCache.get(sessionId);
          if (!existing || existing.length < detail.events.length) {
            eventsCache.set(sessionId, detail.events);
          }
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return { data, loading, error };
}
