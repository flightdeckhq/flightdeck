import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentTable } from "@/components/agents/AgentTable";
import { ClientType } from "@/lib/agent-identity";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";

// The row reaches into the per-agent summary fetch via
// useAgentSummary. The HTTP path uses fetchJson with an
// AbortController; jsdom's polyfilled fetch rejects that
// AbortSignal shape with an unhelpful "Expected an instance of
// AbortSignal" error, so we stub fetchAgentSummary directly.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAgentSummary: vi.fn(
      async (agentId: string): Promise<AgentSummaryResponse> => ({
        agent_id: agentId,
        period: "7d",
        bucket: "day",
        totals: {
          tokens: 0,
          errors: 0,
          sessions: 0,
          cost_usd: 0,
          latency_p50_ms: 0,
          latency_p95_ms: 0,
        },
        series: [],
      }),
    ),
  };
});

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: over.agent_id ?? "agent-1",
    agent_name: over.agent_name ?? "agent-1",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

function mkSummary(agentId: string, tokens: number): AgentSummaryResponse {
  return {
    agent_id: agentId,
    period: "7d",
    bucket: "day",
    totals: {
      tokens,
      errors: 0,
      sessions: 1,
      cost_usd: 0,
      latency_p50_ms: 0,
      latency_p95_ms: 0,
    },
    series: [],
  };
}

function renderTable(agents: AgentSummary[]) {
  __resetAgentSummaryCacheForTests();
  return render(
    <MemoryRouter>
      <AgentTable
        agents={agents}
        summariesByAgentId={
          new Map(
            agents.map((a) => [a.agent_id, mkSummary(a.agent_id, 100)]),
          )
        }
        focusedAgentId={null}
        onOpenSwimlaneModal={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("AgentTable", () => {
  it("renders every locked column header", () => {
    renderTable([mkAgent()]);
    expect(screen.getByTestId("agent-table-th-agent_name")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-topology")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-tokens_7d")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-latency_p95_7d")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-errors_7d")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-sessions_7d")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-cost_usd_7d")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-last_seen_at")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-th-state")).toBeInTheDocument();
  });

  it("renders a row per agent", () => {
    const agents = [
      mkAgent({ agent_id: "a-1" }),
      mkAgent({ agent_id: "a-2" }),
      mkAgent({ agent_id: "a-3" }),
    ];
    renderTable(agents);
    expect(screen.getByTestId("agent-row-a-1")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-a-2")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-a-3")).toBeInTheDocument();
  });

  it("renders the empty placeholder when no agents match", () => {
    renderTable([]);
    expect(screen.getByTestId("agent-table-empty")).toBeInTheDocument();
  });

  it("flips sort direction when the same header is clicked twice", () => {
    renderTable([mkAgent()]);
    const header = screen.getByTestId("agent-table-th-tokens_7d");
    fireEvent.click(header);
    expect(header.getAttribute("data-sort-direction")).toBe("desc");
    fireEvent.click(header);
    expect(header.getAttribute("data-sort-direction")).toBe("asc");
  });

  it("hides pagination when total rows ≤ page size", () => {
    renderTable([mkAgent()]);
    expect(screen.queryByTestId("agent-table-pagination")).toBeNull();
  });

  it("shows pagination + advances pages when total > 50", () => {
    const agents = Array.from({ length: 75 }, (_, i) =>
      mkAgent({ agent_id: `a-${String(i).padStart(3, "0")}` }),
    );
    renderTable(agents);
    expect(screen.getByTestId("agent-table-pagination")).toBeInTheDocument();
    expect(screen.getByTestId("agent-table-pagination-counts").textContent).toContain(
      "1-50 of 75",
    );
    fireEvent.click(screen.getByTestId("agent-table-page-next"));
    expect(screen.getByTestId("agent-table-pagination-counts").textContent).toContain(
      "51-75 of 75",
    );
  });
});
