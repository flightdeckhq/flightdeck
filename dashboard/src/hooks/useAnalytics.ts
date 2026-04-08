import { useState, useEffect, useCallback, useRef } from "react";
import { fetchAnalytics } from "@/lib/api";
import type { AnalyticsParams, AnalyticsResponse } from "@/lib/types";

export function useAnalytics(params: AnalyticsParams) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchAnalytics(params);
      if (!controller.signal.aborted) {
        setData(result);
        setLoading(false);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to load analytics");
        setLoading(false);
      }
    }
  }, [params]);

  useEffect(() => {
    void load();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [load]);

  const refetch = useCallback(() => {
    void load();
  }, [load]);

  return { data, loading, error, refetch };
}
