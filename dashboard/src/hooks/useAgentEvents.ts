import { useKeyedFetch } from "./useKeyedFetch";
import { fetchBulkEvents } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// An epoch ``from`` makes the time-window filter a no-op, so the
// ``agent_id`` filter plus offset pagination are the only bounds —
// the agent drawer's Events tab shows the agent's whole history,
// newest-first.
const FROM_EPOCH = "1970-01-01T00:00:00Z";

/** Stable empty list, so an idle result does not change identity. */
const EMPTY_EVENTS: AgentEvent[] = [];

export interface UseAgentEventsResult {
  events: AgentEvent[];
  total: number;
  loading: boolean;
  error: boolean;
}

/**
 * Paginated, newest-first event list for one agent, backed by
 * `GET /v1/events?agent_id=`. Re-fetches when the agent or the page
 * changes; an in-flight request is aborted on change / unmount.
 * Returns an idle empty result while `agentId` is null (the agent
 * drawer is closed).
 */
export function useAgentEvents(
  agentId: string | null,
  page: number,
  pageSize: number,
): UseAgentEventsResult {
  // The agent prefix lets the result tell this agent's data from the
  // previous agent's, which is never shown.
  const agentPrefix = `${agentId}|`;
  const { data, dataKey, loading, error } = useKeyedFetch(
    agentId ? `${agentPrefix}${page}|${pageSize}` : null,
    (signal) =>
      fetchBulkEvents(
        {
          from: FROM_EPOCH,
          agent_id: agentId ?? "",
          order: "desc",
          limit: pageSize,
          offset: page * pageSize,
        },
        signal,
      ),
  );
  const current = agentId !== null && dataKey?.startsWith(agentPrefix) && data;
  return {
    events: current ? data.events : EMPTY_EVENTS,
    total: current ? data.total : 0,
    loading,
    error: error !== null,
  };
}
