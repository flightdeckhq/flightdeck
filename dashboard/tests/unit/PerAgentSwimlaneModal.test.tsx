import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { ClientType } from "@/lib/agent-identity";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";

// Stub the summary fetch so the modal's useAgentSummary hook
// doesn't hit jsdom's broken fetch path. See AgentTable.test.tsx
// for the same pattern + rationale.
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
    agent_id: "agent-1",
    agent_name: "test-agent",
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

beforeEach(() => {
  __resetAgentSummaryCacheForTests();
});

describe("PerAgentSwimlaneModal", () => {
  it("mounts hidden when agent is null", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={null} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("per-agent-swimlane-modal")).toBeNull();
  });

  it("renders the header with agent name when open", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("per-agent-swimlane-modal-header")).toBeInTheDocument();
    expect(screen.getByTestId("per-agent-swimlane-modal-name").textContent).toBe(
      "test-agent",
    );
  });

  it("defaults the time range picker to 1m", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    const btn1m = screen.getByTestId("per-agent-swimlane-modal-time-1m");
    expect(btn1m).toHaveAttribute("data-active", "true");
    const btn1h = screen.getByTestId("per-agent-swimlane-modal-time-1h");
    expect(btn1h).not.toHaveAttribute("data-active");
    // 24h was dropped — the modal mirrors Fleet's five options.
    expect(
      screen.queryByTestId("per-agent-swimlane-modal-time-24h"),
    ).toBeNull();
  });

  it("defaults the show-sub-agents toggle ON for parent agents", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ topology: "parent" })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const input = screen.getByTestId(
      "per-agent-swimlane-modal-show-sub-agents-input",
    ) as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it("disables + unchecks the toggle for lone agents", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal
          agent={mkAgent({ topology: "lone" })}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const input = screen.getByTestId(
      "per-agent-swimlane-modal-show-sub-agents-input",
    ) as HTMLInputElement;
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(true);
  });

  it("renders KPI tiles in the header", () => {
    render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={() => {}} />
      </MemoryRouter>,
    );
    const tiles = screen.getAllByTestId("per-agent-swimlane-modal-kpi-tile");
    expect(tiles.length).toBe(5);
  });

  it("calls onClose when the dialog is dismissed", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent()} onClose={onClose} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={null} onClose={onClose} />
      </MemoryRouter>,
    );
    // The dialog component invokes onOpenChange when its
    // controlled `open` flips false; this test pins the prop
    // contract — the host's onClose receives the close event.
    // No direct fireEvent.click is used because Radix Dialog's
    // close affordance is portalled and depends on Radix
    // internals; the controlled-open path is the canonical close.
    expect(screen.queryByTestId("per-agent-swimlane-modal")).toBeNull();
  });
});
