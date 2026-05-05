import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentTable } from "@/components/fleet/AgentTable";
import type { AgentSummary, FlavorSummary, Session } from "@/lib/types";
import { AgentType, ClientType } from "@/lib/agent-identity";
import { useFleetStore } from "@/store/fleet";

function mkAgent(partial: Partial<AgentSummary>): AgentSummary {
  return {
    agent_id: partial.agent_id ?? "00000000-0000-0000-0000-000000000000",
    agent_name: partial.agent_name ?? "agent",
    agent_type: partial.agent_type ?? AgentType.Coding,
    client_type: partial.client_type ?? ClientType.ClaudeCode,
    user: partial.user ?? "u",
    hostname: partial.hostname ?? "h",
    first_seen_at: partial.first_seen_at ?? "2026-04-20T00:00:00Z",
    last_seen_at: partial.last_seen_at ?? "2026-04-23T00:00:00Z",
    total_sessions: partial.total_sessions ?? 0,
    total_tokens: partial.total_tokens ?? 0,
    state: partial.state ?? "active",
    agent_role: partial.agent_role,
    topology: partial.topology ?? "lone",
  };
}

function renderTable(agents: AgentSummary[]) {
  return render(
    <MemoryRouter>
      <AgentTable agents={agents} loading={false} />
    </MemoryRouter>,
  );
}

/**
 * Seed the fleet store's ``flavors`` field with sessions that
 * encode the parent / child / lone relationships the test wants to
 * exercise. The TopologyCell reads this directly via
 * ``useFleetStore``; without seeded sessions the cell would render
 * every row as "lone" regardless of the agent's reported topology.
 */
function seedFleetForTopology(input: {
  parent?: { agentId: string; agentName: string; sessionId: string };
  child?: { agentId: string; agentName: string; sessionId: string; parentSessionId: string };
}) {
  const flavors: FlavorSummary[] = [];
  const mkSession = (id: string, parentId?: string): Session => ({
    session_id: id,
    flavor: "",
    agent_type: "production",
    host: null,
    framework: null,
    model: null,
    state: "closed",
    started_at: "",
    last_seen_at: "",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parentId,
  });
  if (input.parent) {
    flavors.push({
      flavor: input.parent.agentId,
      agent_type: "production",
      session_count: 1,
      active_count: 0,
      tokens_used_total: 0,
      sessions: [mkSession(input.parent.sessionId)],
      agent_id: input.parent.agentId,
      agent_name: input.parent.agentName,
    });
  }
  if (input.child) {
    flavors.push({
      flavor: input.child.agentId,
      agent_type: "production",
      session_count: 1,
      active_count: 0,
      tokens_used_total: 0,
      sessions: [mkSession(input.child.sessionId, input.child.parentSessionId)],
      agent_id: input.child.agentId,
      agent_name: input.child.agentName,
    });
  }
  useFleetStore.setState({ flavors });
}

beforeEach(() => {
  // Reset the global zustand store between tests so leakage from
  // the previous fixture doesn't poison the next render.
  useFleetStore.setState({ flavors: [] });
});

describe("AgentTable D126 ROLE + TOPOLOGY columns", () => {
  it("renders the role string for sub-agent rows and em-dash for lone rows", () => {
    const child = mkAgent({
      agent_id: "child-id",
      agent_role: "Researcher",
      topology: "child",
    });
    const lone = mkAgent({ agent_id: "lone-id", topology: "lone" });
    const { getByTestId } = renderTable([child, lone]);
    expect(getByTestId("agent-table-role-child-id").textContent).toContain("Researcher");
    // The muted em-dash on lone rows tells the operator "no role
    // applies here" without leaving the column visually empty —
    // rendering an empty cell would read as a data-loading bug.
    expect(getByTestId("agent-table-role-lone-id").textContent).toContain("—");
  });

  it("renders the lone/parent/child topology distinguishably", () => {
    // Seed sessions so the TopologyCell's deriveRelationship can
    // resolve the parent ↔ child link. The pill text reflects the
    // *parent's* name on child rows and a count on parent rows —
    // that's the spec for D126 § 7.fix.H, distinct from the ROLE
    // column which still surfaces the role string.
    seedFleetForTopology({
      parent: { agentId: "parent", agentName: "parent-agent", sessionId: "sess-parent" },
      child: {
        agentId: "child",
        agentName: "child-agent",
        sessionId: "sess-child",
        parentSessionId: "sess-parent",
      },
    });
    const lone = mkAgent({ agent_id: "lone", topology: "lone" });
    const parent = mkAgent({ agent_id: "parent", topology: "parent" });
    const child = mkAgent({
      agent_id: "child",
      topology: "child",
      agent_role: "Writer",
    });
    const { getByTestId } = renderTable([lone, parent, child]);
    // Lone rows render the literal "lone" label — distinct from
    // the pill style applied to parent/child rows.
    expect(getByTestId("agent-table-topology-pill-lone").textContent).toContain("lone");
    // Parent rows get the ⤴ glyph + "spawns N" count (1 child in
    // this fixture). The count communicates fan-out at a glance.
    const parentPill = getByTestId("agent-table-topology-pill-parent-parent");
    expect(parentPill.textContent).toContain("⤴");
    expect(parentPill.textContent).toContain("1");
    // Child rows get ↳ + "child of <parent_name>" — the parent's
    // name (NOT the child's role) so the column surfaces the
    // upstream relationship rather than restating ROLE.
    const childPill = getByTestId("agent-table-topology-pill-child-child");
    expect(childPill.textContent).toContain("↳");
    expect(childPill.textContent).toContain("parent-agent");
  });

  it("ROLE column shows the role string distinct from TOPOLOGY", () => {
    // The two columns now surface distinct information per
    // D126 § 7.fix.H: ROLE renders the agent_role pill;
    // TOPOLOGY renders the relationship label.
    seedFleetForTopology({
      parent: { agentId: "parent", agentName: "parent-agent", sessionId: "sess-parent" },
      child: {
        agentId: "child",
        agentName: "child-agent",
        sessionId: "sess-child",
        parentSessionId: "sess-parent",
      },
    });
    const child = mkAgent({
      agent_id: "child",
      topology: "child",
      agent_role: "Writer",
    });
    const { getByTestId } = renderTable([child]);
    expect(getByTestId("agent-table-role-child").textContent).toContain("Writer");
    expect(getByTestId("agent-table-topology-pill-child-child").textContent).not.toContain("Writer");
  });
});
