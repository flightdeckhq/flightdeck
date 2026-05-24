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
  /** Runtime-context dimensions. ``hostnames`` and ``users``
   *  filter the agent-table columns of the same name (single-
   *  valued per agent). The other seven filter the
   *  ``AgentSummary`` projection of the agent's MOST RECENT
   *  session's ``context`` JSONB; an agent with no value (null
   *  field) never matches any non-empty filter on that dim. */
  hostnames: Set<string>;
  users: Set<string>;
  oss: Set<string>;
  archs: Set<string>;
  gitBranches: Set<string>;
  gitRepos: Set<string>;
  orchestrations: Set<string>;
  pythonVersions: Set<string>;
  processNames: Set<string>;
  /** Free-text search from the top-of-page search bar. Matched
   *  case-insensitively against the agent name, agent_type,
   *  client_type, the agent's frameworks, runtime-context fields,
   *  and the models on its recent sessions. Empty string means
   *  no text filter. ANDs with the chip dimensions. */
  search: string;
}

export const EMPTY_FILTER: AgentFilterState = {
  states: new Set(),
  agentTypes: new Set(),
  clientTypes: new Set(),
  frameworks: new Set(),
  hostnames: new Set(),
  users: new Set(),
  oss: new Set(),
  archs: new Set(),
  gitBranches: new Set(),
  gitRepos: new Set(),
  orchestrations: new Set(),
  pythonVersions: new Set(),
  processNames: new Set(),
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
 * an agent's name, agent_type, client_type, its frameworks, the
 * runtime-context fields, and the models on its recent sessions.
 * An empty / whitespace query matches every agent.
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
    agent.hostname,
    agent.user,
    ...agentFrameworks(agent),
  ];
  // Runtime-context dims fold into the haystack only when non-null;
  // a search for "Linux" should match an agent whose latest session
  // ran on Linux without forcing the user to switch sidebar chips.
  for (const v of agentRuntimeContextValues(agent)) {
    haystack.push(v);
  }
  for (const s of agent.recent_sessions ?? []) {
    if (s.model) haystack.push(s.model);
  }
  return haystack.some((field) => field.toLowerCase().includes(q));
}

/**
 * Project the seven JSONB-derived runtime-context fields off an
 * agent as a compact string list (nulls dropped). Used by
 * `agentMatchesSearch` for free-text folding. NOT consumed by
 * `filterAgents` — the chip filter predicates inspect each field
 * individually so a misspelled OS value in one dim cannot
 * accidentally match a chip in another.
 */
function agentRuntimeContextValues(agent: AgentSummary): string[] {
  const out: string[] = [];
  for (const v of [
    agent.os,
    agent.arch,
    agent.git_branch,
    agent.git_repo,
    agent.orchestration,
    agent.python_version,
    agent.process_name,
  ]) {
    if (v != null && v !== "") out.push(v);
  }
  return out;
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
    // Runtime-context dims. Each chip filter is single-valued:
    // an agent matches the chip iff its field is non-null AND the
    // value is in the active set. A null field can never satisfy a
    // non-empty filter for that dim — operators searching by, say,
    // "git_branch=main" should not see agents with no git context.
    if (filter.hostnames.size > 0 && !filter.hostnames.has(a.hostname)) {
      return false;
    }
    if (filter.users.size > 0 && !filter.users.has(a.user)) {
      return false;
    }
    if (
      filter.oss.size > 0 &&
      (a.os == null || !filter.oss.has(a.os))
    ) {
      return false;
    }
    if (
      filter.archs.size > 0 &&
      (a.arch == null || !filter.archs.has(a.arch))
    ) {
      return false;
    }
    if (
      filter.gitBranches.size > 0 &&
      (a.git_branch == null || !filter.gitBranches.has(a.git_branch))
    ) {
      return false;
    }
    if (
      filter.gitRepos.size > 0 &&
      (a.git_repo == null || !filter.gitRepos.has(a.git_repo))
    ) {
      return false;
    }
    if (
      filter.orchestrations.size > 0 &&
      (a.orchestration == null || !filter.orchestrations.has(a.orchestration))
    ) {
      return false;
    }
    if (
      filter.pythonVersions.size > 0 &&
      (a.python_version == null ||
        !filter.pythonVersions.has(a.python_version))
    ) {
      return false;
    }
    if (
      filter.processNames.size > 0 &&
      (a.process_name == null || !filter.processNames.has(a.process_name))
    ) {
      return false;
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
