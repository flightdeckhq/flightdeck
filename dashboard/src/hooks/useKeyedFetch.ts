import { useCallback, useEffect, useRef, useState } from "react";

interface Settled<T> {
  key: string;
  revision: number;
  hasData: boolean;
  data: T | undefined;
  dataKey: string | null;
  error: unknown;
}

export interface KeyedFetchResult<T> {
  /** Data from the most recent request that succeeded, for any key.
   *  Kept while a request for a new key is in flight, so a list keeps
   *  showing its previous page instead of flashing empty. */
  data: T | undefined;
  /** The key ``data`` was fetched for (null before any success), so a
   *  caller can decline to show data that belongs to a different
   *  subject than the current key. */
  dataKey: string | null;
  /** True while the current key's request has not settled. */
  loading: boolean;
  /** The current key's failure, or null. A failure for an earlier key
   *  is not reported once the key has moved on. */
  error: unknown;
  /** Re-run the current key's request. */
  refetch: () => void;
}

/**
 * Runs ``fetcher`` whenever ``key`` changes (or ``refetch`` is called)
 * and exposes the result without any state being set synchronously in
 * an effect: ``loading`` and ``error`` are derived from which key the
 * last settled request belonged to, and state is only written when a
 * request settles. A ``null`` key means "nothing to fetch": no request
 * runs and ``loading`` is false.
 *
 * ``key`` must change exactly when the request's inputs change; the
 * fetcher is read from the render that produced the key, so it may
 * close over the same inputs. A superseded request is aborted through
 * the signal passed to the fetcher and its result is discarded.
 */
export function useKeyedFetch<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
): KeyedFetchResult<T> {
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const fetcherRef = useRef(fetcher);

  // Declared before the request effect so it runs first and the
  // request sees the fetcher from the same render as its key.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setSettled({ key, revision, hasData: true, data, dataKey: key, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled((prev) => ({
          key,
          revision,
          hasData: prev?.hasData ?? false,
          data: prev?.data,
          dataKey: prev?.dataKey ?? null,
          error,
        }));
      },
    );
    return () => controller.abort();
  }, [key, revision]);

  const refetch = useCallback(() => setRevision((r) => r + 1), []);
  const current =
    settled !== null && settled.key === key && settled.revision === revision;

  return {
    data: settled?.hasData ? settled.data : undefined,
    dataKey: settled?.dataKey ?? null,
    loading: key !== null && !current,
    error: current ? settled.error : null,
    refetch,
  };
}

/**
 * The key whose data a form-style preview should show: the current
 * key once its request has succeeded, or, while it loads, the key that
 * was showing before. A null key or a failure in between drops the old
 * data, so an emptied or failed input never brings back a result that
 * belongs to different inputs. Returns null when nothing should show.
 */
export function useShownKey<T>(
  key: string | null,
  fetch: KeyedFetchResult<T>,
): string | null {
  const [shown, setShown] = useState<string | null>(null);
  const next =
    key === null || fetch.error !== null
      ? null
      : !fetch.loading && fetch.dataKey === key
        ? key
        : shown;
  if (next !== shown) setShown(next);
  return next;
}
