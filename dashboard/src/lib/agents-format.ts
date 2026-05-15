/**
 * Display formatters for the `/agents` table and the per-agent
 * swimlane modal. Kept in one module so the table row and the
 * modal header render identical strings for the same KPI value.
 */

/** Compact token count: `1.2k`, `3.4M`, or the bare integer below 1k. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

/** Latency in ms: `—` for zero, `1.2s` at or above 1000ms, else `999ms`. */
export function formatLatencyMs(n: number): string {
  if (n === 0) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

/** USD cost: `—` for zero, then 3/2/0 decimal places by magnitude. */
export function formatCost(n: number): string {
  if (n === 0) return "—";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** Relative "time ago" string from an ISO timestamp, second/minute/
 *  hour/day buckets. */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
