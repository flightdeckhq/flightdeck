import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopologyCell } from "@/components/fleet/TopologyCell";
import { useFleetStore } from "@/store/fleet";
import { ClientType } from "@/lib/agent-identity";
import type { FlavorSummary, Session } from "@/lib/types";

// The component dispatches scrolls via `scrollToAgentRow` from
// the relationship helper. We replace it with a mock so tests
// can assert the click target without depending on a real DOM
// row in JSDOM.
const scrollToAgentRowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/relationship", async (orig) => {
  const actual = await orig<typeof import("@/lib/relationship")>();
  return {
    ...actual,
    scrollToAgentRow: scrollToAgentRowMock,
  };
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    session_id: over.session_id ?? "s-1",
    flavor: "test",
    agent_type: "coding",
    agent_id: "agent-1",
    state: "active",
    started_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    ended_at: null,
    tokens_used: 0,
    capture_enabled: false,
    host: null,
    framework: null,
    model: null,
    context: {},
    token_name: null,
    parent_session_id: null,
    agent_role: null,
    ...over,
  };
}

function mkFlavor(over: Partial<FlavorSummary> = {}): FlavorSummary {
  return {
    flavor: "agent-1",
    agent_id: "agent-1",
    agent_name: "agent-1",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    last_seen_at: "2026-05-14T00:00:00Z",
    session_count: 1,
    active_count: 0,
    tokens_used_total: 0,
    sessions: [mkSession()],
    ...over,
  };
}

beforeEach(() => {
  scrollToAgentRowMock.mockClear();
  useFleetStore.setState({ flavors: [] });
});

describe("TopologyCell", () => {
  it("renders the lone pill when topology is lone", () => {
    useFleetStore.setState({ flavors: [mkFlavor()] });
    render(<TopologyCell agentId="agent-1" topology="lone" />);
    expect(
      screen.getByTestId("agent-table-topology-pill-lone"),
    ).toBeInTheDocument();
  });

  it("renders the child pill with the parent name when topology is child", () => {
    // Set up a parent + child pair in the fleet store so
    // ``deriveRelationship`` can resolve the child's parent.
    const parentSession = mkSession({
      session_id: "p-1",
      agent_id: "parent-agent",
    });
    const childSession = mkSession({
      session_id: "c-1",
      agent_id: "child-agent",
      parent_session_id: "p-1",
    });
    const parent = mkFlavor({
      flavor: "parent-agent",
      agent_id: "parent-agent",
      agent_name: "parent-agent",
      sessions: [parentSession],
    });
    const child = mkFlavor({
      flavor: "child-agent",
      agent_id: "child-agent",
      agent_name: "child-agent",
      sessions: [childSession],
    });
    useFleetStore.setState({ flavors: [parent, child] });

    render(<TopologyCell agentId="child-agent" topology="child" />);
    expect(
      screen.getByTestId("agent-table-topology-pill-child-child-agent"),
    ).toBeInTheDocument();
    expect(screen.getByText(/child of parent-agent/i)).toBeInTheDocument();
  });

  it("calls scrollToAgentRow with the parent's agent_id on child click", () => {
    const parentSession = mkSession({
      session_id: "p-1",
      agent_id: "parent-agent",
    });
    const childSession = mkSession({
      session_id: "c-1",
      agent_id: "child-agent",
      parent_session_id: "p-1",
    });
    useFleetStore.setState({
      flavors: [
        mkFlavor({
          flavor: "parent-agent",
          agent_id: "parent-agent",
          sessions: [parentSession],
        }),
        mkFlavor({
          flavor: "child-agent",
          agent_id: "child-agent",
          sessions: [childSession],
        }),
      ],
    });
    render(<TopologyCell agentId="child-agent" topology="child" />);
    fireEvent.click(
      screen.getByTestId("agent-table-topology-pill-child-child-agent"),
    );
    expect(scrollToAgentRowMock).toHaveBeenCalledWith("parent-agent");
  });

  it("renders the parent pill with child count when topology is parent", () => {
    const parentSession = mkSession({
      session_id: "p-1",
      agent_id: "parent-agent",
    });
    const child1Session = mkSession({
      session_id: "c-1",
      agent_id: "child-1",
      parent_session_id: "p-1",
    });
    const child2Session = mkSession({
      session_id: "c-2",
      agent_id: "child-2",
      parent_session_id: "p-1",
    });
    useFleetStore.setState({
      flavors: [
        mkFlavor({
          flavor: "parent-agent",
          agent_id: "parent-agent",
          sessions: [parentSession],
        }),
        mkFlavor({
          flavor: "child-1",
          agent_id: "child-1",
          sessions: [child1Session],
        }),
        mkFlavor({
          flavor: "child-2",
          agent_id: "child-2",
          sessions: [child2Session],
        }),
      ],
    });
    render(<TopologyCell agentId="parent-agent" topology="parent" />);
    const pill = screen.getByTestId(
      "agent-table-topology-pill-parent-parent-agent",
    );
    expect(pill).toBeInTheDocument();
    // Pill label reads "⤴ spawns N". Match on the count + plural
    // suffix together so the assertion catches a single-vs-plural
    // regression and a count regression at once.
    expect(pill.textContent).toMatch(/spawns\s*2/);
    expect(pill.getAttribute("aria-label")).toMatch(/2 sub-agents/);
  });

  it("pluralises parent count correctly (1 child → sub-agent, 2+ → sub-agents)", () => {
    const parentSession = mkSession({
      session_id: "p-1",
      agent_id: "parent-agent",
    });
    const childSession = mkSession({
      session_id: "c-1",
      agent_id: "child-1",
      parent_session_id: "p-1",
    });
    useFleetStore.setState({
      flavors: [
        mkFlavor({
          flavor: "parent-agent",
          agent_id: "parent-agent",
          sessions: [parentSession],
        }),
        mkFlavor({
          flavor: "child-1",
          agent_id: "child-1",
          sessions: [childSession],
        }),
      ],
    });
    render(<TopologyCell agentId="parent-agent" topology="parent" />);
    // 1 child → singular noun on the aria-label.
    const pill = screen.getByTestId(
      "agent-table-topology-pill-parent-parent-agent",
    );
    expect(pill.getAttribute("aria-label")).toMatch(/1 sub-agent\b/);
    expect(pill.getAttribute("aria-label")).not.toMatch(/sub-agents/);
  });
});
