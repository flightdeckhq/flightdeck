import type { AgentSummary, SessionState } from "@/lib/types";
import type { AgentType, ClientType } from "@/lib/agent-identity";

/**
 * Active filter chip selection on the `/agents` table. Each
 * dimension is a Set of allowed values; an empty Set means "no
 * filter on this dimension". Filters compose AND across
 * dimensions and OR within (the standard chips pattern matching
 * the Investigate page).
 */
export interface AgentFilterState {
  states: Set<SessionState>;
  agentTypes: Set<AgentType>;
  clientTypes: Set<ClientType>;
  /** Bare-name frameworks observed on the agent's recent
   *  sessions (`recent_sessions[].framework`). */
  frameworks: Set<string>;
  /** Free-text search from the top-of-page search bar. Matched
   *  case-insensitively against the agent name, agent_type,
   *  client_type, the agent's frameworks, and the models on its
   *  recent sessions. Empty string means no text filter. ANDs with
   *  the chip dimensions. */
  search: string;
}

export const EMPTY_FILTER: AgentFilterState = {
  states: new Set(),
  agentTypes: new Set(),
  clientTypes: new Set(),
  frameworks: new Set(),
  search: "",
};

/**
 * Distinct bare-name frameworks observed across the agent's
 * recent sessions (`recent_sessions[].framework`). Returns an
 * empty array when the agent has no sessions or every recent
 * session ran without a framework (direct-SDK). The recent
 * window is capped server-side at `RecentSessionsPerAgent`, so an
 * agent that last used a framework more than that many sessions
 * ago surfaces only its more-recent attributions.
 */
export function agentFrameworks(agent: AgentSummary): string[] {
  const seen = new Set<string>();
  for (const s of agent.recent_sessions ?? []) {
    if (s.framework) seen.add(s.framework);
  }
  return [...seen].sort();
}

/**
 * Build the dynamic framework chip set from the visible agent
 * list. The chip set is the union of every agent's framework
 * list — empty when no agent carries a framework (the chip group
 * then renders empty + hidden).
 */
export function deriveFrameworkOptions(agents: AgentSummary[]): string[] {
  const seen = new Set<string>();
  for (const a of agents) {
    for (const fw of agentFrameworks(a)) seen.add(fw);
  }
  return [...seen].sort();
}

/**
 * Case-insensitive substring match of the free-text search against
 * an agent's name, agent_type, client_type, its frameworks, and the
 * models on its recent sessions. An empty / whitespace query matches
 * every agent.
 */
export function agentMatchesSearch(
  agent: AgentSummary,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack: string[] = [
    agent.agent_name,
    agent.agent_type,
    agent.client_type,
    ...agentFrameworks(agent),
  ];
  for (const s of agent.recent_sessions ?? []) {
    if (s.model) haystack.push(s.model);
  }
  return haystack.some((field) => field.toLowerCase().includes(q));
}

/**
 * Apply the active filter chip selection + free-text search to an
 * agent list. Returns a new array; the input is never mutated.
 */
export function filterAgents(
  agents: AgentSummary[],
  filter: AgentFilterState,
): AgentSummary[] {
  return agents.filter((a) => {
    if (filter.states.size > 0 && !filter.states.has(a.state as SessionState)) {
      return false;
    }
    if (filter.agentTypes.size > 0 && !filter.agentTypes.has(a.agent_type)) {
      return false;
    }
    if (filter.clientTypes.size > 0 && !filter.clientTypes.has(a.client_type)) {
      return false;
    }
    if (filter.frameworks.size > 0) {
      const fws = agentFrameworks(a);
      if (!fws.some((fw) => filter.frameworks.has(fw))) return false;
    }
    if (!agentMatchesSearch(a, filter.search)) return false;
    return true;
  });
}

/**
 * Toggle a value in a filter dimension. Returns a new Set so
 * React's referential-equality state update fires.
 */
export function toggleFilterValue<T>(dim: Set<T>, value: T): Set<T> {
  const next = new Set(dim);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
