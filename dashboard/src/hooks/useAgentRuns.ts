import { useEffect, useState } from "react";
import { fetchSessions } from "@/lib/api";
import type { SessionListItem } from "@/lib/types";

// An epoch ``from`` makes the time-window filter a no-op so the
// ``agent_id`` filter plus offset pagination are the only bounds —
// the agent drawer's Runs tab shows the agent's whole run history.
const FROM_EPOCH = "1970-01-01T00:00:00Z";

/** Server-backed sort columns for the Runs tab. Each maps to an
 *  entry in the `/v1/sessions` `allowedSorts` whitelist; the
 *  error-count column is not server-sortable and is omitted. */
export type RunSortColumn =
  | "started_at"
  | "duration"
  | "tokens_used"
  | "state";

export interface RunSortState {
  column: RunSortColumn;
  direction: "asc" | "desc";
}

export interface UseAgentRunsResult {
  runs: SessionListItem[];
  total: number;
  loading: boolean;
  error: boolean;
}

/**
 * Paginated run (session) list for one agent, backed by
 * `GET /v1/sessions?agent_id=`, sortable on the server-supported
 * columns. Re-fetches when the agent, page, or sort changes; an
 * in-flight request is aborted on change / unmount. Returns an idle
 * empty result while `agentId` is null (the agent drawer is closed).
 */
export function useAgentRuns(
  agentId: string | null,
  page: number,
  pageSize: number,
  sort: RunSortState,
): UseAgentRunsResult {
  const [runs, setRuns] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setRuns([]);
      setTotal(0);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetchSessions(
      {
        from: FROM_EPOCH,
        agent_id: agentId,
        sort: sort.column,
        order: sort.direction,
        limit: pageSize,
        offset: page * pageSize,
      },
      controller.signal,
    )
      .then((resp) => {
        setRuns(resp.sessions);
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
  }, [agentId, page, pageSize, sort.column, sort.direction]);

  return { runs, total, loading, error };
}
