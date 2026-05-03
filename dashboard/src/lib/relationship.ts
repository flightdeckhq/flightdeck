import type { FlavorSummary, Session } from "@/lib/types";

/**
 * D126 sub-agent relationship rollup. Derives a per-agent place in
 * the sub-agent graph from session-level linkage data already in
 * the fleet store. Pure function so unit tests can drive it without
 * mounting a component (the +11-vs-+40-60 test gap on D126 step 7
 * was tightly correlated with components without unit tests; the
 * helper lives here so SwimLane and AgentTable can share both the
 * implementation and the test surface).
 *
 * Result modes:
 *   * { mode: "child", parentName, parentAgentId } — at least one
 *     of this agent's sessions has a parent_session_id pointing to
 *     a session under a different agent in the fleet store.
 *   * { mode: "parent", childCount, firstChildAgentId } — at least
 *     one session in the store has a parent_session_id pointing to
 *     one of this agent's sessions. childCount is the number of
 *     distinct child agents.
 *   * { mode: "lone" } — neither relationship applies.
 *
 * Priority: child > parent > lone. A sub-agent that itself spawns
 * grandchildren reports "child" because the upstream relationship
 * is the more salient one in the swimlane chrome (the parent's row
 * still surfaces the child entry pointing back, so the
 * relationship is visible from both sides).
 */
export type RelationshipResult =
  | { mode: "lone" }
  | { mode: "child"; parentName: string; parentAgentId: string }
  | { mode: "parent"; childCount: number; firstChildAgentId: string | undefined };

export function deriveRelationship(
  agentId: string,
  sessions: Session[],
  fleetFlavors: FlavorSummary[],
): RelationshipResult {
  // Build a session_id → (agent_id, agent_name) lookup from the
  // fleet store. The store partitions sessions per agent under
  // ``flavors[].sessions`` and ``flavors[].flavor === agent_id``
  // for D115 swimlanes.
  const sessionToAgent = new Map<
    string,
    { agentId: string; agentName: string }
  >();
  const ownSessionIds = new Set<string>();
  for (const f of fleetFlavors) {
    const aName = f.agent_id && f.agent_name ? f.agent_name : f.flavor;
    for (const s of f.sessions) {
      sessionToAgent.set(s.session_id, {
        agentId: f.flavor,
        agentName: aName,
      });
      if (f.flavor === agentId) ownSessionIds.add(s.session_id);
    }
  }
  // Belt-and-suspenders: also catalog the caller-supplied
  // ``sessions`` slice in case the store's flavors view is ahead
  // of / behind the caller (window mismatch during a fleet
  // refresh).
  for (const s of sessions) ownSessionIds.add(s.session_id);

  // Child branch — any of our sessions points to a parent_session_id
  // that resolves to a different agent.
  for (const s of sessions) {
    if (!s.parent_session_id) continue;
    const parent = sessionToAgent.get(s.parent_session_id);
    if (parent && parent.agentId !== agentId) {
      return {
        mode: "child",
        parentName: parent.agentName,
        parentAgentId: parent.agentId,
      };
    }
  }

  // Parent branch — any session in the store points back to one of
  // ours. Distinct agent count → child count; first hit drives the
  // click navigation target.
  const childAgents = new Set<string>();
  let firstChildAgentId: string | undefined;
  for (const f of fleetFlavors) {
    if (f.flavor === agentId) continue;
    for (const s of f.sessions) {
      if (!s.parent_session_id) continue;
      if (ownSessionIds.has(s.parent_session_id)) {
        childAgents.add(f.flavor);
        if (!firstChildAgentId) firstChildAgentId = f.flavor;
        break; // one hit per child agent is enough for the count
      }
    }
  }
  if (childAgents.size > 0) {
    return {
      mode: "parent",
      childCount: childAgents.size,
      firstChildAgentId,
    };
  }

  return { mode: "lone" };
}

/**
 * Scroll an agent's row into view via the ``data-agent-id``
 * attribute stamped on SwimLane (and AgentTable rows). Shared by
 * both surfaces so the navigation behaviour matches one-to-one
 * across views.
 */
export function scrollToAgentRow(agentId: string): void {
  const target = document.querySelector(
    `[data-agent-id="${CSS.escape(agentId)}"]`,
  );
  if (target && "scrollIntoView" in target) {
    (target as HTMLElement).scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
}
