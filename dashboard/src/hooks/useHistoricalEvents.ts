import { useState, useEffect, useCallback, useRef } from "react";
import { fetchBulkEvents } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";
import type { TimeRange } from "@/pages/Fleet";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

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
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const offsetRef = useRef(0);
  const inflightControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (append = false) => {
    const rangeMs = TIME_RANGE_MS[timeRange];
    const from = new Date(Date.now() - rangeMs).toISOString();
    const offset = append ? offsetRef.current : 0;

    // Cancel any inflight request; the new fetch supersedes it.
    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;

    if (!append) {
      setLoading(true);
      setError(null);
    }

    try {
      const resp = await fetchBulkEvents(
        { from, limit: 500, offset },
        controller.signal,
      );
      // Bail if a newer fetch superseded us mid-flight.
      if (controller.signal.aborted) return;
      const newEvents = resp.events ?? [];

      if (append) {
        setEvents((prev) => [...prev, ...newEvents]);
      } else {
        setEvents(newEvents);
      }

      offsetRef.current = offset + newEvents.length;
      setTotal(resp.total);
      setHasMore(resp.has_more);
    } catch (e) {
      // Aborted fetches throw — swallow them since they're our own
      // cancellation, not a real failure.
      if ((e as Error).name === "AbortError" || controller.signal.aborted) {
        return;
      }
      setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [timeRange]);

  // Fetch on mount and when timeRange changes. The cleanup aborts any
  // inflight request so an unmount or timeRange change mid-fetch doesn't
  // leak a stale setState onto a no-longer-mounted hook.
  useEffect(() => {
    offsetRef.current = 0;
    load(false);
    return () => {
      inflightControllerRef.current?.abort();
    };
  }, [load]);

  const loadMore = useCallback(() => {
    if (hasMore) load(true);
  }, [hasMore, load]);

  return { events, loading, error, hasMore, total, loadMore };
}
