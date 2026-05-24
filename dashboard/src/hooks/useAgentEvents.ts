import { useEffect, useState } from "react";
import { fetchBulkEvents } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// An epoch ``from`` makes the time-window filter a no-op, so the
// ``agent_id`` filter plus offset pagination are the only bounds —
// the agent drawer's Events tab shows the agent's whole history,
// newest-first.
const FROM_EPOCH = "1970-01-01T00:00:00Z";

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
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setEvents([]);
      setTotal(0);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetchBulkEvents(
      {
        from: FROM_EPOCH,
        agent_id: agentId,
        order: "desc",
        limit: pageSize,
        offset: page * pageSize,
      },
      controller.signal,
    )
      .then((resp) => {
        setEvents(resp.events);
        setTotal(resp.total);
        setLoading(false);
      })
      .catch(() => {
        // An aborted request is a superseded fetch, not a failure.
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [agentId, page, pageSize]);

  return { events, total, loading, error };
}
