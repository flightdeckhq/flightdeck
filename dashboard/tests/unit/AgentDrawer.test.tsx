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

  it("renders the header as a fixed four-row stack (identity / status / actions / sub-agents)", async () => {
    // Lock the deterministic vertical order. The first three
    // rows always render; the sub-agent row mounts only when
    // a parent or child linkage exists. The action-link row
    // lives in its own container so a wide topology label or
    // a sub-agent linkage row can't push the action links onto
    // a wrapping line.
    seedStore(
      [
        mkAgent({
          agent_id: "agent-parent",
          agent_name: "parent-agent",
        }),
        mkAgent({ agent_id: "agent-child", agent_name: "child-agent" }),
      ],
      [
        mkFlavor("agent-parent", "parent-agent", [mkSession("s-p1")]),
        mkFlavor("agent-child", "child-agent", [mkSession("s-c1", "s-p1")]),
      ],
    );
    renderDrawer("agent-parent");
    await act(async () => {});
    const identity = screen.getByTestId("agent-drawer-header-identity");
    const status = screen.getByTestId("agent-drawer-header-status");
    const actions = screen.getByTestId("agent-drawer-header-actions");
    const subagents = screen.getByTestId("agent-drawer-header-subagents");
    for (const row of [identity, status, actions, subagents]) {
      expect(row).toBeInTheDocument();
    }
    // Source-order assertion: each header row is a sibling
    // under the drawer header strip and they appear in the
    // expected sequence. Walk previousElementSibling chains so
    // a future addition between them surfaces here.
    expect(status.previousElementSibling).toBe(identity);
    expect(actions.previousElementSibling).toBe(status);
    expect(subagents.previousElementSibling).toBe(actions);
    // Action-link row contents are stable regardless of the
    // sub-agent linkage row's presence.
    expect(
      actions.querySelector('[data-testid="agent-drawer-open-swimlane"]'),
    ).not.toBeNull();
    expect(
      actions.querySelector('[data-testid="agent-drawer-open-in-events"]'),
    ).not.toBeNull();
  });

  it("omits the sub-agent row entirely when no linkage exists", async () => {
    seedStore([mkAgent({ agent_id: "agent-1" })], []);
    renderDrawer("agent-1");
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-header-identity"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-drawer-header-subagents"),
    ).toBeNull();
  });

  it("lone agent: status row shows label only, no topology descriptor", async () => {
    // Lone topology contract: row 2 stops at the status label.
    // No pipe separator, no topology suffix. Row 4 is hidden.
    seedStore(
      [mkAgent({ agent_id: "agent-lone", agent_name: "lone-agent" })],
      [mkFlavor("agent-lone", "lone-agent", [mkSession("s-l1")])],
    );
    renderDrawer("agent-lone");
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-status-label"),
    ).toHaveTextContent("Active");
    expect(
      screen.queryByTestId("agent-drawer-topology-descriptor"),
    ).toBeNull();
    expect(
      screen.queryByTestId("agent-drawer-header-subagents"),
    ).toBeNull();
  });

  it("parent agent: status row shows 'spawns N'; row 4 has the SUB-AGENTS section only", async () => {
    seedStore(
      [
        mkAgent({ agent_id: "agent-parent", agent_name: "parent-agent" }),
        mkAgent({ agent_id: "agent-child-a", agent_name: "child-a" }),
        mkAgent({ agent_id: "agent-child-b", agent_name: "child-b" }),
      ],
      [
        mkFlavor("agent-parent", "parent-agent", [mkSession("s-p1")]),
        mkFlavor("agent-child-a", "child-a", [mkSession("s-ca1", "s-p1")]),
        mkFlavor("agent-child-b", "child-b", [mkSession("s-cb1", "s-p1")]),
      ],
    );
    renderDrawer("agent-parent");
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-topology-descriptor"),
    ).toHaveTextContent("spawns 2");
    // The PARENT section is absent (this agent has no parent);
    // the SUB-AGENTS section renders the 2 child pills.
    expect(
      screen.queryByTestId("agent-drawer-linkage-parent-section"),
    ).toBeNull();
    expect(
      screen.getByTestId("agent-drawer-linkage-children-section"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("agent-drawer-child-pill")).toHaveLength(2);
  });

  it("child agent: status row shows 'sub-agent' (no parent name); row 4 has PARENT section only", async () => {
    // Anti-duplication contract: row 2 must NOT name the parent.
    // The parent name lives exclusively in the row-4 pill.
    seedStore(
      [
        mkAgent({ agent_id: "agent-parent", agent_name: "parent-agent" }),
        mkAgent({ agent_id: "agent-child", agent_name: "child-agent" }),
      ],
      [
        mkFlavor("agent-parent", "parent-agent", [mkSession("s-p1")]),
        mkFlavor("agent-child", "child-agent", [mkSession("s-c1", "s-p1")]),
      ],
    );
    renderDrawer("agent-child");
    await act(async () => {});
    const descriptor = screen.getByTestId(
      "agent-drawer-topology-descriptor",
    );
    // Strict equality — the descriptor's textContent must be
    // EXACTLY "sub-agent" for a leaf child. Anything else
    // (parent name leakage, agent_id leakage, stray
    // whitespace, doubled descriptor halves) regresses the
    // anti-duplication contract.
    expect(descriptor.textContent).toBe("sub-agent");
    expect(
      screen.getByTestId("agent-drawer-linkage-parent-section"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-drawer-linkage-children-section"),
    ).toBeNull();
  });

  it("parent pill label follows '← parent: <name>' format", async () => {
    // Locks the pill label template against silent reshape.
    // The parent name is the only place the actual name string
    // surfaces — row 2 is name-free by contract — so the format
    // is load-bearing for the operator's ability to identify
    // the parent at a glance.
    seedStore(
      [
        mkAgent({ agent_id: "p", agent_name: "my-parent" }),
        mkAgent({ agent_id: "c", agent_name: "my-child" }),
      ],
      [
        mkFlavor("p", "my-parent", [mkSession("sp")]),
        mkFlavor("c", "my-child", [mkSession("sc", "sp")]),
      ],
    );
    renderDrawer("c");
    await act(async () => {});
    const pill = screen.getByTestId("agent-drawer-parent-pill");
    expect(pill).toHaveTextContent("← parent: my-parent");
  });

  it("depth-2 middle agent: row 2 reads 'sub-agent • spawns N'; row 4 has BOTH sections", async () => {
    seedStore(
      [
        mkAgent({ agent_id: "agent-grand", agent_name: "grand-agent" }),
        mkAgent({ agent_id: "agent-middle", agent_name: "middle-agent" }),
        mkAgent({ agent_id: "agent-leaf", agent_name: "leaf-agent" }),
      ],
      [
        mkFlavor("agent-grand", "grand-agent", [mkSession("s-g1")]),
        mkFlavor("agent-middle", "middle-agent", [
          mkSession("s-m1", "s-g1"),
        ]),
        mkFlavor("agent-leaf", "leaf-agent", [mkSession("s-l1", "s-m1")]),
      ],
    );
    renderDrawer("agent-middle");
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-topology-descriptor"),
    ).toHaveTextContent("sub-agent • spawns 1");
    expect(
      screen.getByTestId("agent-drawer-linkage-parent-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-drawer-linkage-children-section"),
    ).toBeInTheDocument();
  });

  it("action row renders both buttons with icon + label structure", async () => {
    // Pre-fix the actions were bare accent-coloured text that
    // didn't read as buttons. The redesign uses bordered
    // icon + label buttons; assert each button hosts both an
    // SVG icon node (lucide-react renders <svg>) and a text
    // label, so a regression that drops the icon OR collapses
    // back to bare text surfaces here. The visual border
    // contract (``1px solid``) is locked by T101 against a
    // real browser — JSDOM cannot resolve
    // ``var(--border)`` in ``style.border`` consistently, so
    // pinning border longhand here is fragile.
    seedStore([mkAgent({ agent_id: "agent-1" })], []);
    renderDrawer("agent-1");
    await act(async () => {});
    const swimlane = screen.getByTestId("agent-drawer-open-swimlane");
    const events = screen.getByTestId("agent-drawer-open-in-events");
    for (const el of [swimlane, events]) {
      // lucide-react renders an inline SVG; presence of the
      // <svg> child is the structural icon contract.
      expect(el.querySelector("svg")).not.toBeNull();
      // Non-empty text content (label) must coexist.
      expect((el.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});
