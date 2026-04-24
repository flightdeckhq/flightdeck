import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import type { AgentSummary } from "./types";

/**
 * Agent-identity cache for the Investigate chip (+ any other consumer
 * that needs ``agent_id -> agent_name`` resolution without waiting on
 * the fleet store to hydrate).
 *
 * The fleet store already hydrates agents[] on Investigate mount so
 * the common path resolves via that cache; this module backs the
 * UUID-prefix fallback path with an authoritative ``/v1/agents/{id}``
 * lookup. The resolved name is cached for the conversation lifetime
 * so subsequent renders and sibling chips do not refetch. A 404 (or
 * any fetch failure) pins a ``{ status: "miss" }`` entry so the UI
 * falls back to the UUID prefix exactly once and stops refetching.
 *
 * Consumers call ``useAgentName(id)`` which triggers the background
 * fetch if needed and returns the resolved name (or null while
 * pending / on failure). Internally it uses useSyncExternalStore so
 * every subscriber re-renders the moment the fetch resolves.
 */

/** Cache entry. ``pending`` suppresses duplicate in-flight fetches. */
type Entry =
  | { status: "pending" }
  | { status: "hit"; agent: AgentSummary }
  | { status: "miss" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot returns a stable reference; the cache Map itself mutates. */
function getSnapshot(): Map<string, Entry> {
  return cache;
}

/**
 * Seed the cache from a list of agents the caller already has in
 * hand (e.g. the fleet store's ``agents[]`` result). Avoids an
 * extra round-trip to ``/v1/agents/{id}`` when the agent happened
 * to be in the hydrated roster. Only overwrites ``pending`` /
 * missing entries; a concrete hit or miss stays put so an in-flight
 * fetch's outcome is not clobbered.
 */
export function seedAgents(agents: AgentSummary[]): void {
  let changed = false;
  for (const a of agents) {
    const prev = cache.get(a.agent_id);
    if (!prev || prev.status === "pending") {
      cache.set(a.agent_id, { status: "hit", agent: a });
      changed = true;
    }
  }
  if (changed) notify();
}

/**
 * Trigger a background fetch for one agent_id. Idempotent — if the
 * id is already pending or cached the function returns immediately.
 * Exported so non-hook callers (tests, imperative prefetch) can
 * prime the cache.
 */
export function requestAgent(agentId: string): void {
  if (!agentId) return;
  const existing = cache.get(agentId);
  if (existing) return;
  cache.set(agentId, { status: "pending" });
  notify();

  void apiFetch(`/v1/agents/${encodeURIComponent(agentId)}`)
    .then(async (res) => {
      if (res.ok) {
        const agent = (await res.json()) as AgentSummary;
        cache.set(agentId, { status: "hit", agent });
      } else {
        // 404 is the expected miss path (agent rolled up / purged);
        // any other status is still a miss from the UI's perspective,
        // we just log so the console warn tells operators the API
        // call itself failed rather than the id being unknown.
        if (res.status !== 404) {
          console.warn(
            `agent identity fetch ${res.status} for ${agentId}`,
          );
        }
        cache.set(agentId, { status: "miss" });
      }
    })
    .catch((err: unknown) => {
      console.warn(
        `agent identity fetch failed for ${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      cache.set(agentId, { status: "miss" });
    })
    .finally(() => {
      notify();
    });
}

/**
 * Test-only cache reset. Exercised by unit tests that need a clean
 * slate between cases; production code should never call this.
 */
export function __resetAgentIdentityCache(): void {
  cache.clear();
  notify();
}

/**
 * React hook — returns the cached agent (or null if pending/miss)
 * and triggers a background fetch the first time a new id is seen.
 */
export function useAgentIdentity(agentId: string | undefined): AgentSummary | null {
  useEffect(() => {
    if (!agentId) return;
    if (!cache.has(agentId)) {
      requestAgent(agentId);
    }
  }, [agentId]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!agentId) return null;
  const entry = snapshot.get(agentId);
  if (!entry || entry.status !== "hit") return null;
  return entry.agent;
}

/**
 * Synchronous peek. Returns the cached agent_name or null when the
 * cache has no hit for the id. Used by pure helpers that want to
 * benefit from the cache without becoming hooks themselves.
 */
export function peekAgentName(agentId: string): string | null {
  const entry = cache.get(agentId);
  if (!entry || entry.status !== "hit") return null;
  return entry.agent.agent_name;
}
