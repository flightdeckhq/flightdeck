import { useEffect, useMemo, useState } from "react";
import { fetchBulkEvents } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";
import {
  HISTORY_DRAIN_MAX_EVENTS,
  HISTORY_PAGE_SIZE,
  TIMELINE_RANGE_MS,
  type TimeRange,
} from "@/lib/constants";

/** Stable empty list, so an idle result does not change identity. */
const NO_EVENTS: AgentEvent[] = [];

/** One load of a window. A new object per range pick and per reload,
 *  so picking a range again (1m → 1h → 1m) or a reload after the live
 *  stream reconnected is a new load, not the old one. */
interface WindowRequest {
  range: TimeRange;
  reloadKey: number;
}

interface DrainState {
  /** The selection these events answer; null before the first page. */
  request: WindowRequest | null;
  /** The events loaded so far, oldest first. */
  events: AgentEvent[];
  /** No more pages will come for ``request``. */
  done: boolean;
  error: string | null;
}

/** What one step of a drain reports: the events loaded so far (null
 *  when a first page failed, so the previous range's events stay), and
 *  whether the drain has ended. */
type DrainReport = (events: AgentEvent[] | null, done: boolean, error: string | null) => void;

/**
 * Load a window's events newest first, one page after another, until
 * the window is complete or ``HISTORY_DRAIN_MAX_EVENTS`` are loaded.
 * Each page after the first continues strictly before the oldest event
 * the previous page returned (the ``before`` + ``before_id`` keyset),
 * so pages never overlap or skip. Reports after every page; a failed
 * page ends the drain with its message, and an aborted one ends it
 * silently.
 */
async function drainWindow(
  from: string,
  to: string,
  signal: AbortSignal,
  report: DrainReport,
): Promise<void> {
  const newestFirst: AgentEvent[] = [];
  let cursor: AgentEvent | undefined;
  for (;;) {
    const limit = Math.min(HISTORY_PAGE_SIZE, HISTORY_DRAIN_MAX_EVENTS - newestFirst.length);
    let page: AgentEvent[];
    let hasMore: boolean;
    try {
      const resp = await fetchBulkEvents(
        {
          from,
          to,
          order: "desc",
          limit,
          ...(cursor ? { before: cursor.occurred_at, before_id: cursor.id } : {}),
        },
        signal,
      );
      page = resp.events ?? [];
      hasMore = resp.has_more;
    } catch (e: unknown) {
      if (signal.aborted) return;
      report(
        newestFirst.length > 0 ? [...newestFirst].reverse() : null,
        true,
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    if (signal.aborted) return;
    newestFirst.push(...page);
    const done = !hasMore || page.length === 0 || newestFirst.length >= HISTORY_DRAIN_MAX_EVENTS;
    report([...newestFirst].reverse(), done, null);
    if (done) return;
    cursor = page[page.length - 1];
  }
}

/**
 * The selected window's events, loaded newest first so a window busier
 * than ``HISTORY_DRAIN_MAX_EVENTS`` loses its oldest events, never its
 * newest. ``from`` and ``to`` are fixed when the range is picked.
 * Returns the events loaded so far, oldest first, updated after every
 * page; the previous range's events stay until the new range's first
 * page arrives. A range change or unmount aborts the drain in flight.
 * A new ``reloadKey`` loads the window again, ending now: Fleet passes
 * the store's ``resyncSeq``, so events sent while the live stream was
 * down are loaded once it is back.
 */
export function useHistoricalEvents(timeRange: TimeRange, reloadKey = 0) {
  const request = useMemo<WindowRequest>(
    () => ({ range: timeRange, reloadKey }),
    [timeRange, reloadKey],
  );
  const [state, setState] = useState<DrainState>({
    request: null,
    events: NO_EVENTS,
    done: false,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const toMs = Date.now();
    const from = new Date(toMs - TIMELINE_RANGE_MS[request.range]).toISOString();
    const to = new Date(toMs).toISOString();
    void drainWindow(from, to, controller.signal, (events, done, error) => {
      setState((prev) => ({ request, events: events ?? prev.events, done, error }));
    });
    return () => controller.abort();
  }, [request]);

  const current = state.request === request;
  return {
    events: state.events,
    loading: !current || !state.done,
    error: current ? state.error : null,
  };
}
