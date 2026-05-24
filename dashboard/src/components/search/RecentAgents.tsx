import { useEffect, useState } from "react";
import { fetchRecentAgents, type RecentAgent } from "@/lib/api";
import {
  ClientType,
  isAgentType,
  isClientType,
} from "@/lib/agent-identity";
import { AgentTypeBadge } from "@/components/facets/AgentTypeBadge";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";

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
      {agents.map((agent) => {
        const showClaudeLogo =
          isClientType(agent.client_type) &&
          agent.client_type === ClientType.ClaudeCode;
        return (
          <button
            key={agent.agent_id}
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-text-muted transition-colors hover:bg-surface-hover"
            onClick={() => onSelect(agent)}
          >
            {showClaudeLogo && <ClaudeCodeLogo size={12} title="" />}
            {isAgentType(agent.agent_type) && (
              <AgentTypeBadge agentType={agent.agent_type} />
            )}
            {agent.state && (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                  agent.state === "active"
                    ? "bg-green-500/20 text-green-400"
                    : "bg-surface-hover text-text-muted"
                }`}
              >
                {agent.state}
              </span>
            )}
            <span className="font-medium text-text">{agent.agent_name}</span>
          </button>
        );
      })}
    </div>
  );
}
