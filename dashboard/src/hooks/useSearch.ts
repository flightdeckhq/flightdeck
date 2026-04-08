import { useState, useEffect, useRef } from "react";
import { fetchSearch } from "@/lib/api";
import type { SearchResults } from "@/lib/types";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

export function useSearch(query: string) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear pending debounce
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Cancel in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (query.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      fetchSearch(query, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            setResults(data);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            setError(err instanceof Error ? err.message : "Search failed");
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [query]);

  return { results, loading, error };
}
