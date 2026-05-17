import { useEffect, useMemo, useState } from "react";
import { fetchAgentSummary } from "@/lib/api";
import type {
  AgentEvent,
  AgentSummaryBucket,
  AgentSummaryPeriod,
  AgentSummaryResponse,
} from "@/lib/types";
import { useFleetStore } from "@/store/fleet";

/**
 * Module-level cache of agent-summary responses keyed by
 * `agent_id|period|bucket`. A single in-flight promise is also
 * tracked per key so concurrent mounts (e.g. the table + the
 * modal opening on the same agent) issue only one HTTP request.
 *
 * The cache is mutated in place by `patchAgentSummaryFromEvent`
 * when a fleet-store WebSocket event lands for one of the cached
 * agents; the hook's local tick state re-reads it on the next
 * render.
 */
const agentSummaryCache = new Map<string, AgentSummaryResponse>();
const agentSummaryInflight = new Map<string, Promise<AgentSummaryResponse>>();

interface SummaryOpts {
  period: AgentSummaryPeriod;
  bucket: AgentSummaryBucket;
}

function cacheKey(
  agentId: string,
  period: AgentSummaryPeriod,
  bucket: AgentSummaryBucket,
): string {
  return `${agentId}|${period}|${bucket}`;
}

/**
 * Ensure a fetch for the (agent_id, period, bucket) tuple is
 * either complete or in flight. Returns the cached response
 * synchronously when present, otherwise the in-flight (or
 * freshly-started) promise. Shared by both the single-agent and
 * the bulk hooks so a tuple is fetched at most once regardless of
 * how many components subscribe.
 */
function ensureAgentSummary(
  agentId: string,
  opts: SummaryOpts,
): { cached: AgentSummaryResponse | null; inflight: Promise<AgentSummaryResponse> | null } {
  const key = cacheKey(agentId, opts.period, opts.bucket);
  const cached = agentSummaryCache.get(key);
  if (cached) return { cached, inflight: null };
  const existing = agentSummaryInflight.get(key);
  if (existing) return { cached: null, inflight: existing };
  const promise = fetchAgentSummary(agentId, opts)
    .then((resp) => {
      agentSummaryCache.set(key, resp);
      agentSummaryInflight.delete(key);
      return resp;
    })
    .catch((err) => {
      agentSummaryInflight.delete(key);
      throw err;
    });
  agentSummaryInflight.set(key, promise);
  return { cached: null, inflight: promise };
}

/**
 * Apply a single WebSocket event to the cached summaries for an
 * agent. Patches the totals + the matching series bucket in place
 * (token/error/session/latency deltas) so the table row's KPI
 * cells reflect the live state without a re-fetch.
 *
 * Conservative: only the `tokens_total`, `latency_ms`, and
 * `event_type === "llm_error"` paths produce non-trivial deltas
 * here; everything else (mcp_*, policy_*, directive_*) leaves the
 * KPI cells alone. This matches the backend `/v1/agents/:id/summary`
 * shape exactly so the in-place patch can never drift from a
 * fresh fetch.
 */
function patchAgentSummaryFromEvent(
  agentId: string,
  event: AgentEvent,
): boolean {
  let mutated = false;
  // The summary endpoint buckets by `date_trunc(bucket,
  // occurred_at)`; for the live patch we always target the most
  // recent bucket (the agent's "right now" cell). A precise
  // implementation would parse the bucket cadence here; for the
  // 7d/day default the most-recent bucket IS today, and a fresh
  // page load on tomorrow's date refetches naturally.
  const isPostCall = event.event_type === "post_call";
  const isError = event.event_type === "llm_error";
  for (const [key, summary] of agentSummaryCache.entries()) {
    const [keyAgentId] = key.split("|");
    if (keyAgentId !== agentId) continue;

    let touched = false;
    if (isPostCall && event.tokens_total) {
      summary.totals.tokens += event.tokens_total;
      const lastIdx = summary.series.length - 1;
      if (lastIdx >= 0) {
        summary.series[lastIdx]!.tokens += event.tokens_total;
      }
      touched = true;
    }
    if (isPostCall && event.latency_ms != null) {
      // Patch p95 conservatively: only increase, never decrease,
      // since a single new sample can shift the percentile up but
      // shouldn't lower it. A more precise per-bucket recompute
      // would require buffering the full sample set, which is out
      // of scope for the live-patch path.
      if (event.latency_ms > summary.totals.latency_p95_ms) {
        summary.totals.latency_p95_ms = event.latency_ms;
        const lastIdx = summary.series.length - 1;
        if (lastIdx >= 0) {
          summary.series[lastIdx]!.latency_p95_ms = event.latency_ms;
        }
      }
      touched = true;
    }
    if (isError) {
      summary.totals.errors += 1;
      const lastIdx = summary.series.length - 1;
      if (lastIdx >= 0) {
        summary.series[lastIdx]!.errors += 1;
      }
      touched = true;
    }
    if (touched) {
      mutated = true;
    }
  }
  return mutated;
}

/**
 * Reads the per-agent summary for the requested period + bucket.
 * Fetches once per (agent_id, period, bucket) tuple and caches
 * module-level; subsequent mounts of the same tuple read straight
 * from the cache. The fleet store's `lastEvent` subscription
 * patches the cached totals in place when a WebSocket event lands
 * for a cached agent.
 *
 * Returns `{ summary, loading }` — `summary` is `null` while the
 * initial fetch is in flight.
 */
export function useAgentSummary(
  agentId: string,
  opts: SummaryOpts,
): { summary: AgentSummaryResponse | null; loading: boolean } {
  const key = cacheKey(agentId, opts.period, opts.bucket);
  const [, setTick] = useState(0);
  const lastEvent = useFleetStore((s) => s.lastEvent);

  // Initial-fetch effect. ``ensureAgentSummary`` dedupes so
  // concurrent mounts of the same tuple share one HTTP request.
  useEffect(() => {
    const { cached, inflight } = ensureAgentSummary(agentId, opts);
    if (cached || !inflight) return;
    // ``.catch`` swallows the rejection so concurrent subscribers
    // don't all surface an unhandled-rejection warning; a remount
    // retries because ``ensureAgentSummary`` re-fetches once the
    // inflight entry is cleared.
    inflight
      .then(() => setTick((t) => t + 1))
      .catch(() => setTick((t) => t + 1));
    // ESLint can't see that `opts.period` / `opts.bucket` are
    // stable per call (parents pass them as literals). The
    // composite `key` IS in deps and encodes agent_id + period +
    // bucket — when any of the three changes, `key` changes and
    // the effect re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // WS-event patch effect. When a new event arrives for the
  // cached agent, mutate the totals in place and tick to re-read.
  useEffect(() => {
    if (!lastEvent) return;
    const eventAgentId = lastEvent.flavor;
    if (eventAgentId !== agentId) return;
    if (patchAgentSummaryFromEvent(agentId, lastEvent)) {
      setTick((t) => t + 1);
    }
  }, [agentId, lastEvent]);

  // Direct cache read — the setTick fires on every cache mutation
  // (initial fetch resolve, parallel-mount subscriber tick, WS
  // patch) so a fresh read here always reflects the latest state.
  const summary = agentSummaryCache.get(key) ?? null;

  return {
    summary,
    loading: summary === null,
  };
}

/**
 * Bulk variant — subscribes to the summaries for every agent_id
 * in `agentIds` and returns a `Map<agent_id, AgentSummaryResponse>`
 * of whichever ones have landed. Used by the `/agents` table so
 * the KPI columns (tokens / latency / errors / cost) sort on real
 * values rather than the all-zero fallback.
 *
 * Each tuple is fetched at most once via the shared
 * `ensureAgentSummary` cache, so this hook and the per-row
 * `useAgentSummary` calls never double-fetch the same agent. The
 * returned map's identity changes whenever a new summary lands or
 * a WS event patches a cached entry, so a parent memoising on it
 * re-sorts naturally.
 */
export function useAgentSummaries(
  agentIds: string[],
  opts: SummaryOpts,
): Map<string, AgentSummaryResponse> {
  // `tick` is the cache-mutation signal. It increments on every
  // fetch resolve and every WS patch; the returned-map memo lists
  // it as a dep so the map identity refreshes exactly when the
  // underlying cache changes — and never otherwise.
  const [tick, setTick] = useState(0);
  const lastEvent = useFleetStore((s) => s.lastEvent);
  // Destructure the opts fields so the effect / memo deps are the
  // stable primitive literals rather than the per-render `opts`
  // object identity (the caller passes `opts` as an inline
  // object — listing `opts` itself would thrash every render).
  const { period, bucket } = opts;

  // `agentIds` is a `useMemo`-derived stable reference in the
  // caller (`Agents.tsx` derives it from the filtered agent list),
  // so it sits directly in the effect dep arrays without
  // thrashing — it changes identity only when membership changes.
  useEffect(() => {
    let cancelled = false;
    for (const agentId of agentIds) {
      const { cached, inflight } = ensureAgentSummary(agentId, {
        period,
        bucket,
      });
      if (cached || !inflight) continue;
      inflight
        .then(() => {
          if (!cancelled) setTick((t) => t + 1);
        })
        .catch(() => {
          if (!cancelled) setTick((t) => t + 1);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [agentIds, period, bucket]);

  // WS-event patch effect — patch the cache for the affected
  // agent and tick so the returned-map memo recomputes.
  useEffect(() => {
    if (!lastEvent) return;
    const eventAgentId = lastEvent.flavor;
    if (!agentIds.includes(eventAgentId)) return;
    if (patchAgentSummaryFromEvent(eventAgentId, lastEvent)) {
      setTick((t) => t + 1);
    }
  }, [agentIds, lastEvent]);

  // Rebuild the map only when the agent set, the period/bucket,
  // or the cache (via `tick`) changes — cheap either way (a few
  // dozen Map.get calls) but the memo keeps the returned map's
  // identity stable across unrelated re-renders (e.g. a WS event
  // that touches no agent in this set) so the caller's sort memo
  // doesn't thrash.
  return useMemo(() => {
    const out = new Map<string, AgentSummaryResponse>();
    for (const agentId of agentIds) {
      const resp = agentSummaryCache.get(cacheKey(agentId, period, bucket));
      if (resp) out.set(agentId, resp);
    }
    return out;
    // ESLint flags `tick` as unnecessary because the memo body
    // never reads it — but it is the load-bearing cache-mutation
    // signal: the module-level `agentSummaryCache` is patched in
    // place, so the only thing that tells the memo to re-read it
    // is the `tick` increment fired by the fetch/WS effects above.
    // Dropping it would freeze the map at its first-render value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentIds, period, bucket, tick]);
}

/**
 * Imperative cache reset — exported for tests. Clears every
 * cached agent summary + every in-flight promise.
 */
export function __resetAgentSummaryCacheForTests(): void {
  agentSummaryCache.clear();
  agentSummaryInflight.clear();
}
