import { useKeyedFetch } from "./useKeyedFetch";
import { fetchSearch } from "@/lib/api";
import type { SearchResults } from "@/lib/types";

/** Pause after the last keystroke before a search request is sent. */
const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

/** Resolves after ``ms``, or rejects as soon as ``signal`` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/**
 * Debounced search: a query of at least MIN_QUERY_LENGTH characters is
 * sent DEBOUNCE_MS after it stops changing; a newer query cancels the
 * pending wait or the in-flight request. Shorter queries clear the
 * results.
 */
export function useSearch(query: string) {
  const active = query.length >= MIN_QUERY_LENGTH;
  const { data, loading, error } = useKeyedFetch<SearchResults>(
    active ? query : null,
    async (signal) => {
      await delay(DEBOUNCE_MS, signal);
      return fetchSearch(query, signal);
    },
  );
  return {
    results: active ? (data ?? null) : null,
    loading,
    error:
      error === null ? null : error instanceof Error ? error.message : "Search failed",
  };
}
