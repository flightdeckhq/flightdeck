import { useEffect, useState } from "react";

/**
 * Returns the current time in epoch milliseconds, refreshed every
 * ``intervalMs``. Components that compare timestamps against "now"
 * read it from here instead of calling ``Date.now()`` during render,
 * which would give each render a different answer for the same
 * props and state (and keeps a time-based window from sliding unless
 * something else happens to re-render).
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);

  return now;
}
