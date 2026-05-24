import { useEffect, useState } from "react";
import { fetchRecentAgents, type RecentAgent } from "@/lib/api";

interface RecentAgentsProps {
  /** Called when the operator picks an agent. The host wires this
   *  to the same ``?agent_drawer=`` setter the search-result click
   *  uses, so the empty-state and the populated-state share one
   *  routing path. */
  onSelect: (agent: RecentAgent) => void;
}

/**
 * Replacement for the "Type at least 2 characters" hint. Shows the
 * 5 most-recently-seen agents so an idle Cmd+K opens a useful
 * jump-list instead of an empty prompt.
 */
export function RecentAgents({ onSelect }: RecentAgentsProps) {
  const [agents, setAgents] = useState<RecentAgent[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchRecentAgents(controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setAgents(r.agents ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-muted">
        Type to search agents, runs, and events.
      </div>
    );
  }
  if (agents === null) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-muted">
        Loading recent agents…
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-muted">
        Type to search agents, runs, and events.
      </div>
    );
  }

  return (
    <div className="max-h-80 overflow-y-auto" data-testid="recent-agents">
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Recent agents
      </div>
      {agents.map((agent) => (
        <button
          key={agent.agent_id}
          type="button"
          className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-text-muted transition-colors hover:bg-surface-hover"
          onClick={() => onSelect(agent)}
        >
          <span className="font-medium text-text">{agent.agent_name}</span>
          <span className="text-text-muted">{agent.agent_type}</span>
        </button>
      ))}
    </div>
  );
}
