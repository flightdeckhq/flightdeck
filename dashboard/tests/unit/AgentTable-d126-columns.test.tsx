import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentTable } from "@/components/fleet/AgentTable";
import type { AgentSummary } from "@/lib/types";
import { AgentType, ClientType } from "@/lib/agent-identity";

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
    // Parent rows get the ⤴ glyph (spawns sub-agents). Child rows
    // get ↳ (spawned by a parent). The two glyphs are the visual
    // contract that the topology column is readable at a glance.
    expect(getByTestId("agent-table-topology-pill-parent").textContent).toContain("⤴");
    expect(getByTestId("agent-table-topology-pill-child").textContent).toContain("↳");
  });
});
