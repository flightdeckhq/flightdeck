import { useKeyedFetch } from "./useKeyedFetch";
import { fetchAnalytics } from "@/lib/api";
import type { AnalyticsParams, AnalyticsResponse } from "@/lib/types";

/** Fetches one analytics query, re-running when any parameter changes. */
export function useAnalytics(params: AnalyticsParams) {
  const { data, loading, error, refetch } = useKeyedFetch<AnalyticsResponse>(
    JSON.stringify(params),
    (signal) => fetchAnalytics(params, signal),
  );
  return {
    data: data ?? null,
    loading,
    error:
      error === null
        ? null
        : error instanceof Error
          ? error.message
          : "Failed to load analytics",
    refetch,
  };
}
