import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "@/components/search/CommandPalette";
import type { SearchResults } from "@/lib/types";

// Mock /v1/agents so the RecentAgents empty state has a
// deterministic fixture and doesn't try to hit the network.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchRecentAgents: vi.fn(() =>
      Promise.resolve({
        agents: [
          {
            agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            agent_name: "recent-agent-1",
            agent_type: "production",
            client_type: "flightdeck_sensor",
            state: "active",
            last_seen_at: "2026-04-17T09:00:00Z",
          },
          {
            agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            agent_name: "recent-agent-2",
            agent_type: "production",
            client_type: "flightdeck_sensor",
            state: "idle",
            last_seen_at: "2026-04-17T08:00:00Z",
          },
        ],
      }),
    ),
  };
});

const emptyResults: SearchResults = {
  agents: [],
  sessions: [],
  events: [],
};

const populatedResults: SearchResults = {
  agents: [
    {
      agent_id: "11111111-1111-4111-8111-111111111111",
      agent_name: "research-agent",
      agent_type: "production",
      client_type: "flightdeck_sensor",
      state: "active",
      last_seen: "2026-04-01T00:00:00Z",
    },
  ],
  sessions: [
    {
      session_id: "sess-1234-abcd-5678",
      flavor: "research-agent",
      host: "host-1",
      state: "active",
      started_at: "2026-04-01T00:00:00Z",
      ended_at: null,
      model: "claude-3-5-haiku",
      tokens_used: 0,
      token_limit: null,
      context: {},
    },
  ],
  events: [],
};

const navResults: SearchResults = {
  agents: [
    {
      agent_id: "22222222-2222-4222-8222-222222222222",
      agent_name: "alpha",
      agent_type: "production",
      client_type: "flightdeck_sensor",
      state: "active",
      last_seen: "2026-04-01T00:00:00Z",
    },
    {
      agent_id: "33333333-3333-4333-8333-333333333333",
      agent_name: "beta",
      agent_type: "production",
      client_type: "flightdeck_sensor",
      state: "idle",
      last_seen: "2026-04-01T00:00:00Z",
    },
  ],
  sessions: [],
  events: [],
};

// Mock the useSearch hook so we can control its output
let mockResults: SearchResults | null = null;
let mockLoading = false;
let mockError: string | null = null;

vi.mock("@/hooks/useSearch", () => ({
  useSearch: () => ({
    results: mockResults,
    loading: mockLoading,
    error: mockError,
  }),
}));

describe("CommandPalette", () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockResults = null;
    mockLoading = false;
    mockError = null;
  });

  it("opens on Cmd+K keydown", () => {
    render(
      <CommandPalette open={false} onOpenChange={onOpenChange} />,
    );
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("opens on Ctrl+K keydown", () => {
    render(
      <CommandPalette open={false} onOpenChange={onOpenChange} />,
    );
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("closes on Escape", () => {
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    // Dialog's own onOpenChange fires with false
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows loading state while fetching", () => {
    mockLoading = true;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    // Type enough to trigger search
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "res" } });
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
  });

  it("shows 'No results' when results are empty", () => {
    mockResults = emptyResults;
    mockLoading = false;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "xyz" } });
    expect(screen.getByText(/No results found/)).toBeInTheDocument();
  });

  it("shows grouped results when data is present", () => {
    mockResults = populatedResults;
    mockLoading = false;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "research" } });
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    // Highlight splits matched text across multiple DOM nodes; both
    // the agent and session rows contain a <mark> with "research".
    const marks = screen.getAllByTestId("highlight-match");
    expect(marks.filter((m) => m.textContent === "research").length).toBeGreaterThanOrEqual(2);
    // Session id should still be rendered (truncated to the first 8 chars).
    expect(
      screen.getAllByText((_, el) => el?.textContent?.includes("sess-123") ?? false).length,
    ).toBeGreaterThan(0);
  });

  it("does not render empty groups", () => {
    mockResults = populatedResults; // events is empty
    mockLoading = false;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "research" } });
    expect(screen.queryByText("Events")).not.toBeInTheDocument();
  });

  it("calls onSelectResult and closes when a result is clicked", async () => {
    mockResults = populatedResults;
    mockLoading = false;
    const onSelectResult = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        onSelectResult={onSelectResult}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "research" } });
    // Click the first agent result. With <Highlight> splitting the
    // text into multiple nodes, target the option button (the agent
    // row is the very first option, since agents render first).
    fireEvent.click(screen.getAllByRole("option")[0]);
    await waitFor(() => {
      expect(onSelectResult).toHaveBeenCalledWith("agent", populatedResults.agents[0]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("ArrowDown moves the focused-row marker", () => {
    mockResults = navResults;
    mockLoading = false;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a" } });

    // Initial state: first row is focused.
    expect(screen.getByTestId("search-result-focused")).toHaveTextContent("alpha");

    // ArrowDown moves to the second row.
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByTestId("search-result-focused")).toHaveTextContent("beta");

    // ArrowUp goes back.
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(screen.getByTestId("search-result-focused")).toHaveTextContent("alpha");
  });

  it("focused row carries the visible-highlight tokens", () => {
    mockResults = navResults;
    mockLoading = false;
    render(
      <CommandPalette open={true} onOpenChange={onOpenChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a" } });

    // Lock the contract — these solid tokens replace the broken
    // bg-primary/10 (which compiles to no background under the
    // hex-var theme). If a refactor reverts to an alpha modifier
    // on a custom-hex var, this test fails immediately.
    const focused = screen.getByTestId("search-result-focused");
    expect(focused.className).toContain("bg-surface-hover");
    expect(focused.className).toContain("border-primary");
    expect(focused.className).not.toMatch(/bg-primary\/\d/);
  });

  it("scrolls the focused row into view on arrow-key navigation", () => {
    mockResults = navResults;
    mockLoading = false;
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <CommandPalette open={true} onOpenChange={onOpenChange} />,
      );
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "a" } });
      // Initial mount calls scrollIntoView once for the default
      // focused row.
      const baseline = scrollIntoView.mock.calls.length;

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(baseline);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("renders a per-group count badge next to each group label", () => {
    mockResults = navResults; // 2 agents, 0 sessions, 0 events
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a" } });
    const badge = screen.getByTestId("search-group-count-agents");
    expect(badge.textContent).toBe("2");
    // No Runs / Events groups → no count badge for them.
    expect(screen.queryByTestId("search-group-count-sessions")).toBeNull();
    expect(screen.queryByTestId("search-group-count-events")).toBeNull();
  });

  it("bolds the matched substring inside each row via <Highlight>", () => {
    mockResults = navResults; // names: "alpha", "beta"
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    // Query "lph" matches "alpha". The Highlight helper wraps the
    // matched substring in a <mark data-testid="highlight-match">.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lph" } });
    const marks = screen.getAllByTestId("highlight-match");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent?.toLowerCase()).toBe("lph");
  });

  it("EventRow leads with the canonical EventTypePill", async () => {
    mockResults = {
      agents: [],
      sessions: [],
      events: [
        {
          event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          event_type: "post_call",
          tool_name: "",
          model: "claude-3-5-haiku",
          occurred_at: "2026-04-17T09:00:00Z",
        },
      ],
    };
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "po" } });
    // The canonical EventTypePill renders with a stable testid that
    // /events, the run drawer, and the agent drawer all share — the
    // palette using the same component is the surface-parity lock.
    const pill = await screen.findByTestId("event-type-pill");
    expect(pill.getAttribute("data-event-type")).toBe("post_call");
    expect(pill.textContent).toBe("LLM CALL");
  });

  it("AgentRow surfaces ClaudeCodeLogo + AgentTypeBadge + state chip (row parity)", () => {
    mockResults = {
      agents: [
        {
          agent_id: "44444444-4444-4444-8444-444444444444",
          agent_name: "claude-code-agent",
          agent_type: "coding",
          client_type: "claude_code",
          state: "active",
          last_seen: "2026-04-17T09:00:00Z",
        },
      ],
      sessions: [],
      events: [],
    };
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "claude" } });
    const agentOption = screen.getAllByRole("option")[0];
    // ClaudeCodeLogo carries a stable aria-label from PROVIDER_META;
    // matching it inside the row proves the icon mounted.
    expect(agentOption.querySelector("svg")).toBeTruthy();
    // AgentTypeBadge renders "CODING" (CSS-uppercase) inside the row.
    expect(agentOption.textContent?.toLowerCase()).toContain("coding");
    // State chip — green-tinted span when active.
    expect(agentOption.textContent).toContain("active");
  });

  it("SessionRow surfaces ProviderLogo + model (row parity)", () => {
    mockResults = {
      agents: [],
      sessions: [
        {
          session_id: "11111111-2222-3333-4444-555555555555",
          flavor: "claude-code",
          host: "host-1",
          state: "active",
          started_at: "2026-04-17T09:00:00Z",
          ended_at: null,
          model: "claude-3-5-haiku",
          tokens_used: 0,
          token_limit: null,
          context: {},
        },
      ],
      events: [],
    };
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "claude" } });
    const sessionOption = screen.getAllByRole("option")[0];
    // Model text is rendered inside the row.
    expect(sessionOption.textContent).toContain("claude-3-5-haiku");
    // Provider logo (svg) sits next to the model — covers both the
    // model treatment and the row layout.
    const svgs = sessionOption.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
  });

  it("renders RecentAgents in the empty state instead of the type-2-chars hint", async () => {
    mockResults = null;
    mockLoading = false;
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    // No query typed → RecentAgents block appears with fixture rows.
    await waitFor(() => {
      expect(screen.getByTestId("recent-agents")).toBeInTheDocument();
    });
    expect(screen.getByText("recent-agent-1")).toBeInTheDocument();
    expect(screen.getByText("recent-agent-2")).toBeInTheDocument();
    // The old hint copy must no longer appear.
    expect(
      screen.queryByText(/Type at least 2 characters/),
    ).not.toBeInTheDocument();
  });
});
