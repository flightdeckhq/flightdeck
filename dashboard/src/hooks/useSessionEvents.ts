import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// Module-level cache: sessionId → events array.
// Exported so Fleet.tsx can inject WebSocket events directly.
export const eventsCache = new Map<string, AgentEvent[]>();

// E2E debug surface — exposes the module-level cache via window so
// Playwright specs can introspect the runtime state without
// instrumenting components. Gated on the Vite build MODE: in any
// build other than ``production`` (``development`` for ``vite
// serve``, ``test`` for the Vitest unit harness, ``e2e`` if a
// future CI config introduces it) the cache is reachable; in
// production builds the static-literal check is tree-shaken to
// ``false`` and the assignment branch is dead-code-eliminated by
// the bundler, so ``window.__flightdeckEventsCache`` is absent
// from the shipped artifact.
if (
  typeof window !== "undefined" &&
  import.meta.env.MODE !== "production"
) {
  (window as unknown as { __flightdeckEventsCache?: Map<string, AgentEvent[]> }).__flightdeckEventsCache =
    eventsCache;
}

// Module-level cache: sessionId → attachment timestamp strings, newest
// last. Populated alongside eventsCache on the shared fetchSession
// path so swimlane renders (which don't open the drawer) still have
// access to the attachment list for ATTACH-circle recolouring.
// Empty map entry means "no attachments yet"; missing key means "not
// fetched yet" -- treat both as no attachments at render time.
export const attachmentsCache = new Map<string, string[]>();

// Track which sessions have been fetched to prevent duplicate requests.
// Once a session is in this set, it will NEVER be fetched again.
const fetchedSessions = new Set<string>();

/**
 * Reads events for a session from eventsCache.
 * Fetches via HTTP exactly ONCE on first access if cache is empty.
 * After that, all updates come from WebSocket injection (version prop).
 */
export function useSessionEvents(
  sessionId: string,
  _isActive = false,
  // ``_version`` is the WebSocket-injection reactive signal: when
  // a caller bumps it the prop change re-renders this hook and the
  // direct cache read below picks up the freshly-injected events.
  // The body never reads it directly (the underscore-prefix marks
  // it intentionally consumed only via React's prop-diff
  // re-render), matching the ``_isActive`` convention beside it.
  _version = 0,
) {
  const [, setTick] = useState(0);

  // Direct cache read. The setTick fires when the initial fetch
  // resolves; the WebSocket-injected events path rides on the
  // ``_version`` prop's re-render. Either signal triggers a fresh
  // read of the latest cached array. A `useMemo` here would lock
  // in the first render's empty array because Map.get's reference
  // is stable across calls AND the memo deps wouldn't include the
  // local tick state — it would never re-evaluate on cache mutation.
  const events = eventsCache.get(sessionId) ?? [];

  // Fetch exactly once per session if not in cache
  useEffect(() => {
    if (fetchedSessions.has(sessionId)) return;
    if (eventsCache.has(sessionId) && eventsCache.get(sessionId)!.length > 0) {
      fetchedSessions.add(sessionId);
      return;
    }

    fetchedSessions.add(sessionId); // mark BEFORE fetch to prevent duplicates

    fetchSession(sessionId)
      .then((detail) => {
        const evts = detail.events ?? [];
        if (evts.length > 0) {
          eventsCache.set(sessionId, evts);
          setTick((t) => t + 1); // force re-read from cache
        }
        // Cache attachments unconditionally (including the empty
        // array) so callers can distinguish "not yet fetched" from
        // "fetched, no attachments".
        attachmentsCache.set(sessionId, detail.attachments ?? []);
      })
      .catch(() => {
        // On error, allow retry next mount
        fetchedSessions.delete(sessionId);
      });
  }, [sessionId]);

  return { events, loading: events.length === 0 && !fetchedSessions.has(sessionId) };
}
