import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { AgentTableRow } from "@/components/agents/AgentTableRow";
import { ClientType } from "@/lib/agent-identity";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";

// AgentTableRow reaches the per-agent summary fetch via
// useAgentSummary; jsdom's fetch polyfill rejects the
// AbortController signal shape, so stub fetchAgentSummary
// directly (same pattern as AgentTable.test.tsx). KPI-value
// formatting is covered separately by agents-format.test.ts —
// these tests exercise the row's own focus / wiring logic.
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

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderRow(
  agent: AgentSummary,
  opts: {
    focused?: boolean;
    onOpenSwimlaneModal?: (a: AgentSummary) => void;
  } = {},
) {
  __resetAgentSummaryCacheForTests();
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/"
          element={
            <table>
              <tbody>
                <AgentTableRow
                  agent={agent}
                  focused={opts.focused ?? false}
                  onOpenSwimlaneModal={opts.onOpenSwimlaneModal ?? (() => {})}
                />
              </tbody>
            </table>
          }
        />
        <Route path="/events" element={<div data-testid="events-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentTableRow", () => {
  it("renders the agent identity cell", () => {
    renderRow(mkAgent({ agent_id: "a-1", agent_name: "checkout-bot" }));
    expect(screen.getByTestId("agent-row-a-1")).toBeInTheDocument();
    expect(screen.getByText("checkout-bot")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-row-agent-type-a-1"),
    ).toHaveTextContent("coding");
  });

  it("stamps data-focused only when focused", () => {
    const { unmount } = renderRow(mkAgent({ agent_id: "a-1" }), {
      focused: true,
    });
    expect(screen.getByTestId("agent-row-a-1")).toHaveAttribute(
      "data-focused",
      "true",
    );
    unmount();

    renderRow(mkAgent({ agent_id: "a-1" }), { focused: false });
    expect(screen.getByTestId("agent-row-a-1")).not.toHaveAttribute(
      "data-focused",
    );
  });

  it("calls onOpenSwimlaneModal with the agent on status-badge click", () => {
    const onOpen = vi.fn();
    const agent = mkAgent({ agent_id: "a-1" });
    renderRow(agent, { onOpenSwimlaneModal: onOpen });
    fireEvent.click(screen.getByTestId("agent-row-open-swimlane-modal-a-1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(agent);
  });

  it("navigates to the agent-scoped Events view on the Events action", () => {
    renderRow(mkAgent({ agent_id: "a-1" }));
    fireEvent.click(screen.getByTestId("agent-row-open-events-a-1"));
    expect(screen.getByTestId("events-page")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent(
      "/events?agent_id=a-1",
    );
  });

  it("data-stamps topology and state for E2E / sort selectors", () => {
    renderRow(mkAgent({ agent_id: "a-1", topology: "parent", state: "idle" }));
    const row = screen.getByTestId("agent-row-a-1");
    expect(row).toHaveAttribute("data-agent-topology", "parent");
    expect(row).toHaveAttribute("data-agent-state", "idle");
  });
});
