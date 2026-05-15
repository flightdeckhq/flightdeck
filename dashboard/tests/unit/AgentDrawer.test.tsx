import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentDrawer } from "@/components/agents/AgentDrawer";
import { useFleetStore } from "@/store/fleet";
import { ClientType } from "@/lib/agent-identity";
import type {
  AgentSummary,
  FlavorSummary,
  Session,
  SessionsResponse,
} from "@/lib/types";

// The drawer's tabs + header panels fetch via the hooks; stub the
// API so the tests exercise the drawer chrome, not the network.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  const emptySessions: SessionsResponse = {
    sessions: [],
    total: 0,
    limit: 50,
    offset: 0,
    has_more: false,
  };
  return {
    ...actual,
    fetchSessions: vi.fn(async () => emptySessions),
    fetchBulkEvents: vi.fn(async () => ({
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
      has_more: false,
    })),
  };
});

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: over.agent_id ?? "agent-1",
    agent_name: over.agent_name ?? "checkout-bot",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-15T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

function mkSession(sessionId: string, parentSessionId?: string): Session {
  return {
    session_id: sessionId,
    flavor: "f",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "closed",
    started_at: "2026-05-15T00:00:00Z",
    last_seen_at: "2026-05-15T00:00:00Z",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parentSessionId ?? null,
  };
}

function mkFlavor(
  agentId: string,
  agentName: string,
  sessions: Session[],
): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: 0,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentName,
  };
}

function seedStore(agents: AgentSummary[], flavors: FlavorSummary[]) {
  useFleetStore.setState({ agents, flavors });
}

function renderDrawer(
  agentId: string | null,
  handlers: { onClose?: () => void; onSelectAgent?: (id: string) => void } = {},
) {
  return render(
    <MemoryRouter>
      <AgentDrawer
        agentId={agentId}
        onClose={handlers.onClose ?? (() => {})}
        onSelectAgent={handlers.onSelectAgent ?? (() => {})}
      />
    </MemoryRouter>,
  );
}

describe("AgentDrawer", () => {
  beforeEach(() => {
    seedStore([], []);
  });

  it("renders nothing while agentId is null", () => {
    renderDrawer(null);
    expect(screen.queryByTestId("agent-drawer")).toBeNull();
  });

  it("renders the agent identity header when opened", async () => {
    seedStore([mkAgent({ agent_id: "agent-1", agent_name: "checkout-bot" })], []);
    renderDrawer("agent-1");
    await act(async () => {});
    expect(screen.getByTestId("agent-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("agent-drawer-name")).toHaveTextContent(
      "checkout-bot",
    );
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    seedStore([mkAgent({ agent_id: "agent-1" })], []);
    renderDrawer("agent-1", { onClose });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("agent-drawer-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders sub-agent linkage pills and re-points on a pill click", async () => {
    const onSelectAgent = vi.fn();
    seedStore(
      [
        mkAgent({ agent_id: "agent-parent", agent_name: "parent-agent" }),
        mkAgent({ agent_id: "agent-child", agent_name: "child-agent" }),
      ],
      [
        mkFlavor("agent-parent", "parent-agent", [mkSession("s-p1")]),
        mkFlavor("agent-child", "child-agent", [
          mkSession("s-c1", "s-p1"),
        ]),
      ],
    );
    renderDrawer("agent-parent", { onSelectAgent });
    await act(async () => {});
    const childPill = screen.getByTestId("agent-drawer-child-pill");
    expect(childPill).toHaveTextContent("child-agent");
    fireEvent.click(childPill);
    expect(onSelectAgent).toHaveBeenCalledWith("agent-child");
  });

  it("switches from the Events tab to the Runs tab", async () => {
    seedStore([mkAgent({ agent_id: "agent-1" })], []);
    renderDrawer("agent-1");
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-events-tab"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agent-drawer-tab-runs"));
    expect(screen.getByTestId("agent-drawer-runs-tab")).toBeInTheDocument();
    // Flush the Runs tab's mount-time fetch so its state settles
    // inside act().
    await act(async () => {});
  });
});
