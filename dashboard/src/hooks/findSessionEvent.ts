import { fetchBulkEvents } from "@/lib/api";
import { EVENT_LOOKUP_MAX_PAGES, EVENT_LOOKUP_PAGE_SIZE } from "@/lib/constants";
import type { AgentEvent } from "@/lib/types";
import { fullHistoryLoaded, mergeIntoEventsCache } from "./useSessionEvents";

/** The lowest timestamp the events filter accepts; the run's
 *  ``session_id`` is what narrows a run-scoped query. */
const RUN_START_FLOOR = "1970-01-01T00:00:00Z";

/** Events that share one microsecond with the one sought: a client that
 *  stamps whole seconds can post several at once. */
const SAME_INSTANT_LIMIT = 50;

export interface SessionEventTarget {
  sessionId: string;
  eventId: string;
  /** The event's ``occurred_at``, when the link carries it. */
  at?: string;
}

/**
 * Find one event of a run, wherever it sits in the run's history.
 *
 * With ``at``, one request bounded to that millisecond (``from`` and
 * ``to`` are both inclusive) returns the event and any sharing it.
 * Without it, or if that misses or fails, the run is read newest first
 * with the keyset cursor until the event turns up, the run ends, or
 * ``EVENT_LOOKUP_MAX_PAGES`` pages are read. Those pages reach back
 * from the run's newest event without a gap, so they are merged into
 * the events cache by id, like every other load; reaching the run's
 * start marks its history whole. The single-instant answer is not
 * merged: it would leave a gap in the run's cached events.
 *
 * Resolves to null when the event is not found. A failed page of the
 * run, or an abort, rejects.
 */
export async function findSessionEvent(
  target: SessionEventTarget,
  signal?: AbortSignal,
): Promise<AgentEvent | null> {
  const { sessionId, eventId, at } = target;
  const atMs = at ? Date.parse(at) : Number.NaN;
  if (!Number.isNaN(atMs)) {
    // The search API writes timestamps in Postgres's text form
    // ("2026-11-04 19:02:50.756123+00"), which ``GET /v1/events``
    // rejects; JavaScript reads it to the millisecond. The window runs
    // to the next millisecond (``to`` is inclusive), so microseconds
    // past the millisecond still fall inside it.
    try {
      const resp = await fetchBulkEvents(
        {
          from: new Date(atMs).toISOString(),
          to: new Date(atMs + 1).toISOString(),
          session_id: sessionId,
          limit: SAME_INSTANT_LIMIT,
        },
        signal,
      );
      const hit = (resp.events ?? []).find((e) => e.id === eventId);
      if (hit) return hit;
    } catch (e: unknown) {
      // An aborted lookup stops; any other failure falls back to
      // reading the run.
      if (signal?.aborted) throw e;
    }
  }
  let cursor: AgentEvent | undefined;
  for (let page = 0; page < EVENT_LOOKUP_MAX_PAGES; page++) {
    const resp = await fetchBulkEvents(
      {
        from: RUN_START_FLOOR,
        session_id: sessionId,
        order: "desc",
        limit: EVENT_LOOKUP_PAGE_SIZE,
        ...(cursor ? { before: cursor.occurred_at, before_id: cursor.id } : {}),
      },
      signal,
    );
    if (signal?.aborted) return null;
    const events = resp.events ?? [];
    if (!resp.has_more) fullHistoryLoaded.add(sessionId);
    mergeIntoEventsCache(events);
    const hit = events.find((e) => e.id === eventId);
    if (hit) return hit;
    if (!resp.has_more || events.length === 0) return null;
    cursor = events[events.length - 1];
  }
  return null;
}
