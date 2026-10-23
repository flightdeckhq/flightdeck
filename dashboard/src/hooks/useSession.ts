import { useKeyedFetch } from "./useKeyedFetch";
import { fetchSession } from "@/lib/api";
import type { SessionDetail } from "@/lib/types";
import { attachmentsCache, eventsCache } from "./useSessionEvents";

// Cache session metadata so reopening the same drawer doesn't re-fetch.
// Each entry records the revalidation revision it was fetched under, so
// a caller that bumps ``revalidationKey`` past it gets a fresh fetch.
const sessionCache = new Map<string, { detail: SessionDetail; revision: number }>();

/**
 * Drop any cached state for a session so the next useSession() mount
 * performs a fresh fetch. Used by the drawer when the page-size pill
 * changes: a user asking for 50 newest events after
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
 * ``eventsLimit`` is the pagination cap the drawer passes through
 * as ``?events_limit=N``. Callers without pagination (Fleet-side
 * swimlane) omit the arg and get the full history.
 *
 * ``revalidationKey`` is an optional opaque value
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
  // revalidationKey 0 / undefined is the initial-mount sentinel; only a
  // positive value asks for data newer than the cached entry.
  const revision = revalidationKey && revalidationKey > 0 ? revalidationKey : 0;
  const cached = sessionId ? sessionCache.get(sessionId) : undefined;
  const cacheFresh = cached !== undefined && cached.revision >= revision;

  const { data, loading, error } = useKeyedFetch<SessionDetail>(
    sessionId && !cacheFresh ? `${sessionId}|${eventsLimit}|${revision}` : null,
    async () => {
      const detail = await fetchSession(sessionId ?? "", eventsLimit);
      if (sessionId) {
        sessionCache.set(sessionId, { detail, revision });
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
      }
      return detail;
    },
  );

  if (!sessionId) return { data: null, loading: false, error: null };
  return {
    data: cacheFresh ? cached.detail : (data ?? null),
    loading: cacheFresh ? false : loading,
    error:
      cacheFresh || error === null
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
  };
}
