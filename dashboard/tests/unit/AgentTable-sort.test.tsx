import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  AgentTable,
  sortAgents,
  type AgentTableSortColumn,
} from "@/components/fleet/AgentTable";
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
  };
}

describe("sortAgents pure function", () => {
  it("sorts by agent_name asc/desc", () => {
    const a = mkAgent({ agent_id: "a", agent_name: "alpha" });
    const z = mkAgent({ agent_id: "z", agent_name: "zebra" });
    expect(sortAgents([z, a], "agent_name", "asc").map((x) => x.agent_id))
      .toEqual(["a", "z"]);
    expect(sortAgents([a, z], "agent_name", "desc").map((x) => x.agent_id))
      .toEqual(["z", "a"]);
  });

  it("sorts by total_tokens numerically, not lexically", () => {
    const low = mkAgent({ agent_id: "low", total_tokens: 9 });
    const mid = mkAgent({ agent_id: "mid", total_tokens: 100 });
    const high = mkAgent({ agent_id: "high", total_tokens: 1000 });
    // desc: 1000 > 100 > 9. Lexical would put "9" first because "9" > "1".
    expect(
      sortAgents([low, mid, high], "total_tokens", "desc").map((x) => x.agent_id),
    ).toEqual(["high", "mid", "low"]);
  });

  it("sorts by state ordinal (active first on desc, last on asc)", () => {
    const active = mkAgent({ agent_id: "active", state: "active" });
    const idle = mkAgent({ agent_id: "idle", state: "idle" });
    const closed = mkAgent({ agent_id: "closed", state: "closed" });
    // desc ordinal: active (5) > idle (4) > closed (2)
    expect(
      sortAgents([closed, active, idle], "state", "desc").map((x) => x.agent_id),
    ).toEqual(["active", "idle", "closed"]);
    // asc flips it
    expect(
      sortAgents([active, idle, closed], "state", "asc").map((x) => x.agent_id),
    ).toEqual(["closed", "idle", "active"]);
  });

  it("tie-breaks on agent_id asc when the primary column is equal", () => {
    const a = mkAgent({ agent_id: "aaa", agent_name: "same", total_sessions: 5 });
    const b = mkAgent({ agent_id: "bbb", agent_name: "same", total_sessions: 5 });
    // Both have total_sessions=5; secondary key is agent_id asc.
    expect(
      sortAgents([b, a], "total_sessions", "desc").map((x) => x.agent_id),
    ).toEqual(["aaa", "bbb"]);
  });

  it("sorts last_seen_at as timestamp, not string", () => {
    const older = mkAgent({ agent_id: "older", last_seen_at: "2026-04-20T00:00:00Z" });
    const newer = mkAgent({ agent_id: "newer", last_seen_at: "2026-04-23T00:00:00Z" });
    expect(
      sortAgents([older, newer], "last_seen_at", "desc").map((x) => x.agent_id),
    ).toEqual(["newer", "older"]);
  });
});

describe("AgentTable sort header interactions", () => {
  const agents = [
    mkAgent({ agent_id: "a1", agent_name: "alpha", total_tokens: 100 }),
    mkAgent({ agent_id: "a2", agent_name: "bravo", total_tokens: 200 }),
  ];

  function renderTable(
    sort: AgentTableSortColumn | null,
    onSortChange: (c: AgentTableSortColumn) => void,
    order: "asc" | "desc" = "desc",
  ) {
    return render(
      <MemoryRouter>
        <AgentTable
          agents={agents}
          loading={false}
          sort={sort}
          order={order}
          onSortChange={onSortChange}
        />
      </MemoryRouter>,
    );
  }

  it("invokes onSortChange with the clicked column", () => {
    const onSortChange = vi.fn();
    const { getByTestId } = renderTable(null, onSortChange);
    fireEvent.click(getByTestId("agent-table-header-total_tokens"));
    expect(onSortChange).toHaveBeenCalledWith("total_tokens");
  });

  it("marks only the active column with aria-sort", () => {
    const { getByTestId } = renderTable("total_tokens", () => {}, "desc");
    const active = getByTestId("agent-table-header-total_tokens");
    expect(active.getAttribute("aria-sort")).toBe("descending");
    const other = getByTestId("agent-table-header-agent_name");
    expect(other.getAttribute("aria-sort")).toBe("none");
  });

  it("renders all seven sortable headers", () => {
    const { getByTestId } = renderTable(null, () => {});
    for (const col of [
      "agent_name",
      "client_type",
      "agent_type",
      "total_sessions",
      "total_tokens",
      "last_seen_at",
      "state",
    ]) {
      expect(getByTestId(`agent-table-header-${col}`)).toBeDefined();
    }
  });
});
