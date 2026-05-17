import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { AgentTableRow } from "@/components/agents/AgentTableRow";
import { ClientType } from "@/lib/agent-identity";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";
import { fetchAgentSummary } from "@/lib/api";

// AgentTableRow reaches the per-agent summary fetch via
// useAgentSummary; jsdom's fetch polyfill rejects the
// AbortController signal shape, so stub fetchAgentSummary
// directly (same pattern as AgentTable.test.tsx). KPI-value
// formatting is covered separately by agents-format.test.ts —
// these tests exercise the row's own click-wiring logic.
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

/** Build an `AgentSummaryResponse` with a specific cost total —
 *  the sensor cost-cell test overrides the mock with this so the
 *  `formatCost` path produces a non-em-dash string. */
function mkSummary(
  agentId: string,
  costUsd: number,
): AgentSummaryResponse {
  return {
    agent_id: agentId,
    period: "7d",
    bucket: "day",
    totals: {
      tokens: 0,
      errors: 0,
      sessions: 0,
      cost_usd: costUsd,
      latency_p50_ms: 0,
      latency_p95_ms: 0,
    },
    series: [],
  };
}

const fetchAgentSummaryMock = vi.mocked(fetchAgentSummary);

// Each test starts from the zero-cost default; cost-cell tests
// that need a non-zero total override the impl explicitly.
beforeEach(() => {
  fetchAgentSummaryMock.mockImplementation(async (agentId: string) =>
    mkSummary(agentId, 0),
  );
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
    onOpenDrawer?: (a: AgentSummary) => void;
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
                  onOpenDrawer={opts.onOpenDrawer ?? (() => {})}
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

  it("calls onOpenDrawer with the agent on a row click", () => {
    const onOpenDrawer = vi.fn();
    const agent = mkAgent({ agent_id: "a-1" });
    renderRow(agent, { onOpenDrawer });
    fireEvent.click(screen.getByTestId("agent-row-a-1"));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onOpenDrawer).toHaveBeenCalledWith(agent);
  });

  it("opens the swimlane modal on status-badge click without opening the drawer", () => {
    const onOpenDrawer = vi.fn();
    const onOpenSwimlaneModal = vi.fn();
    const agent = mkAgent({ agent_id: "a-1" });
    renderRow(agent, { onOpenDrawer, onOpenSwimlaneModal });
    fireEvent.click(screen.getByTestId("agent-row-open-swimlane-modal-a-1"));
    expect(onOpenSwimlaneModal).toHaveBeenCalledTimes(1);
    expect(onOpenSwimlaneModal).toHaveBeenCalledWith(agent);
    // The badge click must not bubble to the row's drawer handler.
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it("navigates to the Events view on the Events action without opening the drawer", () => {
    const onOpenDrawer = vi.fn();
    renderRow(mkAgent({ agent_id: "a-1" }), { onOpenDrawer });
    fireEvent.click(screen.getByTestId("agent-row-open-events-a-1"));
    expect(screen.getByTestId("events-page")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent(
      "/events?agent_id=a-1",
    );
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it("data-stamps topology and state for E2E / sort selectors", () => {
    renderRow(mkAgent({ agent_id: "a-1", topology: "parent", state: "idle" }));
    const row = screen.getByTestId("agent-row-a-1");
    expect(row).toHaveAttribute("data-agent-topology", "parent");
    expect(row).toHaveAttribute("data-agent-state", "idle");
  });

  it("renders a bare em-dash in the cost cell for a Claude Code agent", async () => {
    // Claude Code agents bill independently — the cost cell always
    // shows "—" regardless of any summary totals fetched.
    renderRow(
      mkAgent({ agent_id: "a-cc", client_type: ClientType.ClaudeCode }),
    );
    const cell = await screen.findByTestId("agent-row-cost-a-cc");
    expect(cell.textContent).toBe("—");
  });

  it("renders the formatted cost for a sensor agent with a non-zero total", async () => {
    // Sensor agents carry estimated cost — with a non-zero total
    // the cell takes the formatCost path and renders a dollar
    // figure rather than the em-dash.
    fetchAgentSummaryMock.mockImplementation(async (agentId: string) =>
      mkSummary(agentId, 4.2),
    );
    renderRow(
      mkAgent({
        agent_id: "a-sensor",
        client_type: ClientType.FlightdeckSensor,
      }),
    );
    const cell = await screen.findByTestId("agent-row-cost-a-sensor");
    expect(cell.textContent).toBe("$4.20");
  });

  it("renders an em-dash for a sensor agent with no summary totals", async () => {
    // No summary → no totals; the cell falls through to the
    // shared em-dash regardless of client_type.
    fetchAgentSummaryMock.mockRejectedValue(new Error("no summary"));
    renderRow(
      mkAgent({
        agent_id: "a-sensor-empty",
        client_type: ClientType.FlightdeckSensor,
      }),
    );
    const cell = await screen.findByTestId("agent-row-cost-a-sensor-empty");
    expect(cell.textContent).toBe("—");
  });
});
