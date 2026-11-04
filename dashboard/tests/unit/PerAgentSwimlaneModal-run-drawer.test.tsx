import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { ClientType } from "@/lib/agent-identity";
import { __resetAgentSummaryCacheForTests } from "@/hooks/useAgentSummary";
import type { AgentEvent, AgentSummary, AgentSummaryResponse } from "@/lib/types";

// The run drawer wiring inside the per-agent modal. The swimlane and
// the drawers are stubbed: the stub Timeline exposes a run glyph click
// (onNodeClick with a run id and no event) and an event circle click
// (with the event), and the stub drawers report what they were given.

const EVENT: AgentEvent = {
  id: "evt-1",
  session_id: "run-from-event",
  flavor: "f",
  event_type: "tool_call",
  model: null,
  tokens_input: null,
  tokens_output: null,
  tokens_total: null,
  latency_ms: null,
  tool_name: "noop",
  has_content: false,
  occurred_at: "2026-05-15T12:00:00Z",
};

vi.mock("@/components/timeline/Timeline", () => ({
  Timeline: (props: {
    onNodeClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  }) => (
    <div>
      <button type="button" data-testid="stub-glyph" onClick={() => props.onNodeClick("run-1")} />
      <button
        type="button"
        data-testid="stub-circle"
        onClick={() => props.onNodeClick(EVENT.session_id, EVENT.id, EVENT)}
      />
    </div>
  ),
}));

vi.mock("@/components/session/SessionDrawer", () => ({
  SessionDrawer: (props: { sessionId: string | null; onClose: () => void }) =>
    props.sessionId ? (
      <div data-testid="session-drawer" data-session-id={props.sessionId}>
        <button type="button" data-testid="stub-run-close" onClick={props.onClose} />
      </div>
    ) : null,
}));

vi.mock("@/components/fleet/EventDetailDrawer", () => ({
  EventDetailDrawer: (props: {
    event: AgentEvent | null;
    onViewRun?: (sessionId: string) => void;
  }) =>
    props.event ? (
      <div data-testid="event-detail-drawer">
        <button
          type="button"
          data-testid="event-detail-view-run"
          onClick={() => props.onViewRun?.(props.event!.session_id)}
        />
      </div>
    ) : null,
}));

vi.mock("@/components/fleet/LiveFeed", () => ({
  LiveFeed: () => <div data-testid="livefeed-stub" />,
}));

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
          partial_estimate: false,
          models_unpriced: [],
          billing_modes: [],
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

function renderModal(agent: AgentSummary | null, onClose = () => {}) {
  return render(
    <MemoryRouter>
      <PerAgentSwimlaneModal agent={agent} onClose={onClose} />
    </MemoryRouter>,
  );
}

/** Press Esc the way a user does: on the focused element, inside the
 *  dialog. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

beforeEach(() => {
  __resetAgentSummaryCacheForTests();
});

describe("PerAgentSwimlaneModal run drawer", () => {
  it("a run glyph click opens the run drawer on that run", () => {
    renderModal(mkAgent());
    expect(screen.queryByTestId("session-drawer")).toBeNull();
    fireEvent.click(screen.getByTestId("stub-glyph"));
    expect(screen.getByTestId("session-drawer")).toHaveAttribute("data-session-id", "run-1");
    // The modal stays open under it.
    expect(screen.getByTestId("per-agent-swimlane-modal")).toBeInTheDocument();
  });

  it("the event drawer's View entire run closes it and opens that run", () => {
    renderModal(mkAgent());
    fireEvent.click(screen.getByTestId("stub-circle"));
    expect(screen.getByTestId("event-detail-drawer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("event-detail-view-run"));
    expect(screen.queryByTestId("event-detail-drawer")).toBeNull();
    expect(screen.getByTestId("session-drawer")).toHaveAttribute(
      "data-session-id",
      "run-from-event",
    );
  });

  it("Esc closes the event drawer, then the run drawer, then the modal", () => {
    const onClose = vi.fn();
    renderModal(mkAgent(), onClose);
    fireEvent.click(screen.getByTestId("stub-glyph"));
    fireEvent.click(screen.getByTestId("stub-circle"));
    expect(screen.getByTestId("event-detail-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("session-drawer")).toBeInTheDocument();

    pressEscape();
    expect(screen.queryByTestId("event-detail-drawer")).toBeNull();
    expect(screen.getByTestId("session-drawer")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape();
    expect(screen.queryByTestId("session-drawer")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-pointing the modal at another agent clears the selected run", () => {
    const { rerender } = renderModal(mkAgent());
    fireEvent.click(screen.getByTestId("stub-glyph"));
    expect(screen.getByTestId("session-drawer")).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <PerAgentSwimlaneModal agent={mkAgent({ agent_id: "agent-2" })} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("session-drawer")).toBeNull();
  });
});
