import { useEffect, useState } from "react";
import { fetchSession } from "@/lib/api";
import { compareEventOrder, sortByEventOrder } from "@/lib/event-order";
import { EventsCacheMap } from "@/lib/events-cache-epoch";
import type { AgentEvent, FeedEvent } from "@/lib/types";

// Module-level cache: sessionId → events array, in the server's order
// (occurred_at, then id; lib/event-order.ts). Every write is counted
// (see lib/events-cache-epoch.ts), so a swimlane row re-derives its
// runs' segments when any of their events change. Every writer goes
// through mergeSessionEvents / mergeIntoEventsCache below, which add
// events by id and never replace or drop a run's list.
export const eventsCache = new EventsCacheMap<string, AgentEvent[]>();

/**
 * A run's cached events with ``incoming`` added by id, in the server's
 * order, or null when ``incoming`` holds no event the list lacks (the
 * caller then keeps the list it has, same array). ``existing`` is in
 * the server's order, as every list in the cache is.
 */
export function mergeRunEvents(
  existing: readonly AgentEvent[] | undefined,
  incoming: readonly AgentEvent[],
): AgentEvent[] | null {
  const have = existing ?? [];
  // A single live event: no id set over the whole run and no sort.
  if (incoming.length === 1) return mergeOneEvent(have, incoming[0]!);
  const seen = new Set(have.map((e) => e.id));
  const fresh: AgentEvent[] = [];
  for (const e of incoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  if (fresh.length === 0) return null;
  const ordered = sortByEventOrder(fresh);
  // A live tick or a newer page lands after everything held: append.
  const last = have[have.length - 1];
  if (last === undefined || compareEventOrder(ordered[0]!, last) > 0) {
    return [...have, ...ordered];
  }
  return sortByEventOrder([...have, ...ordered]);
}

/**
 * ``mergeRunEvents`` for one event, the live path's case: a run gets
 * one event per WebSocket message, often in bursts. An event after the
 * run's last one (almost always) is appended; one that is not is put in
 * its place by binary search. Either way the run costs one copy, not an
 * id set and a sort, so a burst into a long run stays linear per event.
 */
function mergeOneEvent(have: readonly AgentEvent[], event: AgentEvent): AgentEvent[] | null {
  const last = have[have.length - 1];
  if (last === undefined) return [event];
  const vsLast = compareEventOrder(event, last);
  if (vsLast > 0) return [...have, event];
  if (vsLast === 0 || have.some((e) => e.id === event.id)) return null;
  let lo = 0;
  let hi = have.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEventOrder(have[mid]!, event) < 0) lo = mid + 1;
    else hi = mid;
  }
  const next = have.slice();
  next.splice(lo, 0, event);
  return next;
}

/** Merge one run's events into the cache by id. Returns whether its
 *  list changed. */
export function mergeSessionEvents(sessionId: string, incoming: readonly AgentEvent[]): boolean {
  const merged = mergeRunEvents(eventsCache.get(sessionId), incoming);
  if (merged === null) return false;
  eventsCache.set(sessionId, merged);
  return true;
}

/** Merge events of any runs into the cache by id, grouped by
 *  ``session_id``. Returns the ids of the runs whose list changed. */
export function mergeIntoEventsCache(events: readonly AgentEvent[]): Set<string> {
  const grouped = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const list = grouped.get(e.session_id);
    if (list) list.push(e);
    else grouped.set(e.session_id, [e]);
  }
  const changed = new Set<string>();
  grouped.forEach((list, sessionId) => {
    if (mergeSessionEvents(sessionId, list)) changed.add(sessionId);
  });
  return changed;
}

/**
 * The live feed with ``incoming`` added by event id (an event already
 * in the feed keeps its entry), ordered by arrival and capped at the
 * newest ``cap`` by arrival. History pages carry their events'
 * ``occurred_at`` as arrival and live events the moment they arrived,
 * so history that loads after live events never displaces them.
 * Returns ``prev`` itself when nothing is added.
 */
export function mergeFeedEvents(
  prev: readonly FeedEvent[],
  incoming: readonly FeedEvent[],
  cap: number,
): FeedEvent[] {
  const seen = new Set(prev.map((fe) => fe.event.id));
  const fresh: FeedEvent[] = [];
  for (const fe of incoming) {
    if (seen.has(fe.event.id)) continue;
    seen.add(fe.event.id);
    fresh.push(fe);
  }
  if (fresh.length === 0) return prev as FeedEvent[];
  // Live events arrive in order: append without sorting the feed.
  const last = prev[prev.length - 1];
  const inOrder = fresh.every(
    (fe, i) => fe.arrivedAt >= (i === 0 ? (last?.arrivedAt ?? -Infinity) : fresh[i - 1]!.arrivedAt),
  );
  const merged = inOrder
    ? [...prev, ...fresh]
    : [...prev, ...fresh].sort((a, b) => a.arrivedAt - b.arrivedAt);
  return merged.length > cap ? merged.slice(-cap) : merged;
}

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

// Runs whose whole history the cache holds: a fetch without an
// ``events_limit`` landed, a capped fetch came back short of its cap, or
// the run drawer's "Show older" reached the run's first event. Every
// later write only adds newer events, so the run stays whole. The
// ATTACH rule (lib/events.ts::attachmentStartIds) reads it: only then is
// the earliest cached start known to be the run's original one.
export const fullHistoryLoaded = new Set<string>();

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
        // The full history (no events_limit), marked before the merge
        // so the re-render it causes already reads it.
        fullHistoryLoaded.add(sessionId);
        // Merge, never replace: a live event injected while the fetch
        // was in flight stays.
        if (mergeSessionEvents(sessionId, detail.events ?? [])) {
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
