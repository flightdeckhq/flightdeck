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
 */
export function useHistoricalEvents(timeRange: TimeRange) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const offsetRef = useRef(0);

  const load = useCallback(async (append = false) => {
    const rangeMs = TIME_RANGE_MS[timeRange];
    const from = new Date(Date.now() - rangeMs).toISOString();
    const offset = append ? offsetRef.current : 0;

    if (!append) {
      setLoading(true);
      setError(null);
    }

    try {
      const resp = await fetchBulkEvents({ from, limit: 500, offset });
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
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  // Fetch on mount and when timeRange changes
  useEffect(() => {
    offsetRef.current = 0;
    load(false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (hasMore) load(true);
  }, [hasMore, load]);

  return { events, loading, error, hasMore, total, loadMore };
}
