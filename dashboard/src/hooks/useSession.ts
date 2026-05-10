import { useState, useEffect } from "react";
import { fetchSession } from "@/lib/api";
import type { SessionDetail } from "@/lib/types";
import { attachmentsCache, eventsCache } from "./useSessionEvents";

// Cache session metadata so reopening the same drawer doesn't re-fetch
const sessionCache = new Map<string, SessionDetail>();

/**
 * Drop any cached state for a session so the next useSession() mount
 * performs a fresh fetch. Used by the drawer when the page-size pill
 * changes (D113 pagination): a user asking for 50 newest events after
 * having loaded 100 must not reuse the old cache entry.
 */
export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
  eventsCache.delete(sessionId);
  attachmentsCache.delete(sessionId);
}

/**
 * Fetch session detail (metadata + events).
 * Caches results — reopening the same session does not re-fetch.
 * Populates eventsCache from the fetch response.
 *
 * ``eventsLimit`` is the D113 pagination cap the drawer passes through
 * as ``?events_limit=N``. Callers without pagination (Fleet-side
 * swimlane) omit the arg and get the full history.
 *
 * ``revalidationKey`` (D140 step 6.6) is an optional opaque value
 * the caller bumps to force a fresh fetch — useful when an external
 * signal (e.g., the fleet WebSocket's ``mcp_server_attached``
 * event) tells the drawer that ``sessions.context`` has changed
 * server-side. Bumping the key invalidates the cache for this
 * session id and triggers a fetch on the next render.
 */
export function useSession(
  sessionId: string | null,
  eventsLimit?: number,
  revalidationKey?: number,
) {
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

    // D140 step 6.6 — when revalidationKey changes, drop cache so
    // the fetch below runs with fresh data. revalidationKey === 0
    // is the initial-mount sentinel; only > 0 forces invalidation.
    if (revalidationKey && revalidationKey > 0) {
      sessionCache.delete(sessionId);
    }

    // Use cached session metadata if available
    const cached = sessionCache.get(sessionId);
    if (cached) {
      setData(cached);
      return;
    }

    setLoading(true);
    setError(null);
    fetchSession(sessionId, eventsLimit)
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
        // Mirror attachments into the shared cache so SessionEventRow
        // and AggregatedSessionEvents can colour their session_start
        // circles amber without each having to round-trip the API
        // themselves. Always set (including empty array) so callers
        // can tell "not fetched" from "fetched with no attachments".
        attachmentsCache.set(sessionId, detail.attachments ?? []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId, eventsLimit, revalidationKey]);

  return { data, loading, error };
}
