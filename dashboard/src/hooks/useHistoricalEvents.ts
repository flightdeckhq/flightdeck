import { useCallback, useMemo, useState } from "react";
import { useKeyedFetch } from "./useKeyedFetch";
import { fetchBulkEvents } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";
import { TIMELINE_RANGE_MS, type TimeRange } from "@/lib/constants";

/** Events per request. */
const PAGE_SIZE = 500;

/** Stable empty list, so an idle result does not change identity. */
const NO_EVENTS: AgentEvent[] = [];

interface ExtraPages {
  /** The range whose first page these pages extend. */
  range: TimeRange;
  from: string;
  events: AgentEvent[];
  total: number;
  hasMore: boolean;
}

/**
 * Fetches all events for the selected time range in one bulk request.
 * Returns events sorted by occurred_at ascending.
 * Provides loadMore() for pagination.
 *
 * Race guard: every fetch is paired with an AbortController so a
 * timeRange flip mid-fetch (e.g. user toggling 1m → 1h) cancels the
 * stale request before its response can clobber state. Without this
 * guard the last response to settle wins, which lets a slow "1h"
 * response paint on top of a fresh "1m" selection.
 */
export function useHistoricalEvents(timeRange: TimeRange) {
  const first = useKeyedFetch(timeRange, async (signal) => {
    const from = new Date(Date.now() - TIMELINE_RANGE_MS[timeRange]).toISOString();
    const resp = await fetchBulkEvents({ from, limit: PAGE_SIZE, offset: 0 }, signal);
    return { from, range: timeRange, resp };
  });
  // Pages added by loadMore, kept with the range they extend so a
  // range change drops them without an effect.
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  // The last loaded first page stays visible while a new range loads,
  // so the swimlane does not flash empty on a range change.
  const base = first.data;
  const more = base && extra?.range === base.range && extra.from === base.from ? extra : null;
  const baseEvents = base?.resp.events ?? NO_EVENTS;
  const events = useMemo(
    () => (more ? [...baseEvents, ...more.events] : baseEvents),
    [baseEvents, more],
  );
  const total = more ? more.total : (base?.resp.total ?? 0);
  const hasMore = more ? more.hasMore : (base?.resp.has_more ?? false);

  const loadMore = useCallback(() => {
    // Only extend the current range's first page.
    if (!base || base.range !== timeRange || !hasMore) return;
    const offset = events.length;
    fetchBulkEvents({ from: base.from, limit: PAGE_SIZE, offset })
      .then((resp) => {
        const page = resp.events ?? [];
        setExtra((prev) => ({
          range: base.range,
          from: base.from,
          events: [
            ...(prev && prev.range === base.range && prev.from === base.from ? prev.events : []),
            ...page,
          ],
          total: resp.total,
          hasMore: resp.has_more,
        }));
        setMoreError(null);
      })
      .catch((e: unknown) => setMoreError(e instanceof Error ? e.message : String(e)));
  }, [base, timeRange, hasMore, events.length]);

  const baseError =
    first.error === null
      ? null
      : first.error instanceof Error
        ? first.error.message
        : String(first.error);
  return {
    events,
    loading: first.loading,
    error: baseError ?? (more ? moreError : null),
    hasMore,
    total,
    loadMore,
  };
}
