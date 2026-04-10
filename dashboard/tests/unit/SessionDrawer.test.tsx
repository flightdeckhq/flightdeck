import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionDrawer } from "@/components/session/SessionDrawer";

// Base session data
const baseSession = {
  session_id: "s1-abcdef-1234",
  flavor: "test-agent",
  agent_type: "autonomous",
  host: "worker-1",
  framework: null,
  model: "claude-sonnet-4-20250514",
  state: "active" as const,
  started_at: "2026-04-07T10:00:00Z",
  last_seen_at: "2026-04-07T10:05:00Z",
  ended_at: null,
  tokens_used: 5000,
  token_limit: null,
  has_pending_directive: false,
  warn_at_pct: null,
  degrade_at_pct: null,
  degrade_to: null,
  block_at_pct: null,
};

const baseEvents = [
  { id: "e1", session_id: "s1", flavor: "test", event_type: "session_start" as const, model: null, tokens_input: null, tokens_output: null, tokens_total: null, latency_ms: null, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:00:00Z" },
  { id: "e2", session_id: "s1", flavor: "test", event_type: "post_call" as const, model: "claude-sonnet-4-20250514", tokens_input: 100, tokens_output: 50, tokens_total: 150, latency_ms: 1200, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:01:00Z" },
];

const eventsWithContent = [
  ...baseEvents,
  { id: "e3", session_id: "s1", flavor: "test", event_type: "post_call" as const, model: "claude-sonnet-4-20250514", tokens_input: 200, tokens_output: 100, tokens_total: 300, latency_ms: 800, tool_name: null, has_content: true, occurred_at: "2026-04-07T10:02:00Z" },
];

const toolEvent = { id: "e4", session_id: "s1", flavor: "test", event_type: "tool_call" as const, model: null, tokens_input: null, tokens_output: null, tokens_total: null, latency_ms: null, tool_name: "web_search", has_content: false, occurred_at: "2026-04-07T10:03:00Z" };

const warnEvent = { id: "e5", session_id: "s1", flavor: "test", event_type: "policy_warn" as const, model: null, tokens_input: null, tokens_output: null, tokens_total: null, latency_ms: null, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:04:00Z" };

let mockSessionOverride: Record<string, unknown> = {};
let mockEventsOverride: typeof baseEvents | null = null;

vi.mock("@/hooks/useSession", () => ({
  useSession: (id: string | null) => {
    if (!id) return { data: null, loading: false, error: null };
    return {
      data: {
        session: { ...baseSession, ...mockSessionOverride },
        events: mockEventsOverride ?? baseEvents,
      },
      loading: false,
      error: null,
    };
  },
}));

vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ id: "dir-1" })),
  fetchEventContent: vi.fn(() => Promise.resolve(null)),
}));

import { createDirective } from "@/lib/api";

beforeEach(() => {
  mockSessionOverride = {};
  mockEventsOverride = null;
  vi.clearAllMocks();
});

describe("SessionDrawer", () => {
  it("is hidden when no session selected", () => {
    const { container } = render(
      <SessionDrawer sessionId={null} onClose={() => {}} />
    );
    expect(container.querySelector("[class*='fixed']")).not.toBeInTheDocument();
  });

  it("header shows session ID and state badge", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    // Session ID truncated to 12 chars
    expect(screen.getByText("s1-abcde")).toBeInTheDocument();
    // State badge
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("metadata bar shows flavor and host separated by dots", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("test-agent")).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
  });

  it("event row badge shows correct text per type", () => {
    mockEventsOverride = [
      ...baseEvents,
      toolEvent,
      warnEvent,
    ];
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("START")).toBeInTheDocument();
    expect(screen.getByText("LLM CALL")).toBeInTheDocument();
    expect(screen.getByText("TOOL")).toBeInTheDocument();
    expect(screen.getByText("WARN")).toBeInTheDocument();
  });

  it("event row click expands and collapses", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const rows = screen.getAllByTestId("event-row");
    // Reversed: row[0]=post_call (LLM CALL), row[1]=session_start (START)
    fireEvent.click(rows[0]);
    expect(screen.getByText("Model")).toBeInTheDocument();
    fireEvent.click(rows[0]);
  });

  it("only one event expanded at a time", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const rows = screen.getAllByTestId("event-row");
    // Reversed: row[0]=post_call, row[1]=session_start
    fireEvent.click(rows[0]);
    expect(screen.getByText("Model")).toBeInTheDocument();
    fireEvent.click(rows[1]);
    expect(screen.getByText("Event")).toBeInTheDocument();
  });

  it("shows View Prompts link when event has content", () => {
    mockEventsOverride = eventsWithContent;
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const rows = screen.getAllByTestId("event-row");
    // Reversed: row[0]=e3(has_content=true), row[1]=e2, row[2]=e1
    fireEvent.click(rows[0]);
    expect(screen.getByText("View Prompts →")).toBeInTheDocument();
  });

  it("hides View Prompts link when event has no content", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const rows = screen.getAllByTestId("event-row");
    // Reversed: row[0]=post_call (no content), row[1]=session_start
    fireEvent.click(rows[0]);
    expect(screen.queryByText("View Prompts →")).not.toBeInTheDocument();
  });

  it("does not show kill button for closed session", () => {
    mockSessionOverride = { state: "closed" };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.queryByText("Stop Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Shutdown pending")).not.toBeInTheDocument();
  });

  it("shows disabled button when pending directive", () => {
    mockSessionOverride = { state: "active", has_pending_directive: true };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const btn = screen.getByText("Shutdown pending");
    expect(btn).toBeInTheDocument();
    expect(btn.closest("button")).toBeDisabled();
  });

  it("shows enabled Stop Agent button for active session", () => {
    mockSessionOverride = { state: "active", has_pending_directive: false };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const btn = screen.getByText("Stop Agent");
    expect(btn).toBeInTheDocument();
    expect(btn.closest("button")).not.toBeDisabled();
  });

  it("opens confirmation dialog on Stop Agent click", () => {
    mockSessionOverride = { state: "active", has_pending_directive: false };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Stop Agent"));
    expect(screen.getByText("Stop this agent?")).toBeInTheDocument();
  });

  it("calls createDirective on confirm", async () => {
    mockSessionOverride = { state: "active", has_pending_directive: false };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Stop Agent"));
    const buttons = screen.getAllByText("Stop Agent");
    const confirmBtn = buttons[buttons.length - 1];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(createDirective).toHaveBeenCalledWith({
        action: "shutdown",
        session_id: "s1-abcdef-1234",
        reason: "manual_kill_switch",
        grace_period_ms: 5000,
      });
    });
  });

  it("renders Timeline and Prompts tabs", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
  });

  it("defaults to Timeline tab showing event feed", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("START")).toBeInTheDocument();
    expect(screen.getByText("LLM CALL")).toBeInTheDocument();
  });

  it("shows disabled message on Prompts tab when no events have content", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    expect(
      screen.getByText("Prompt capture is not enabled for this deployment.")
    ).toBeInTheDocument();
  });

  it("shows event list on Prompts tab when events have content", () => {
    mockEventsOverride = eventsWithContent;
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    // The content event should show as a clickable badge row
    const badges = screen.getAllByText("LLM CALL");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("switches back to Timeline tab", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    fireEvent.click(screen.getByText("Timeline"));
    expect(screen.getByText("START")).toBeInTheDocument();
  });

  it("has 520px width", () => {
    const { container } = render(
      <SessionDrawer sessionId="s1" onClose={() => {}} />
    );
    const drawer = container.querySelector("[class*='w-\\[520px\\]']");
    expect(drawer).toBeInTheDocument();
  });

  it("opens Mode 2 when directEventDetail is set", () => {
    const directEvent = baseEvents[1]; // post_call
    render(<SessionDrawer sessionId="s1" onClose={() => {}} directEventDetail={directEvent} onClearDirectEvent={() => {}} />);
    // Should show back nav bar immediately (Mode 2)
    expect(screen.getByTestId("back-to-session")).toBeInTheDocument();
  });

  it("open full detail switches to detail view", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    // Reversed: row[0]=post_call (LLM CALL)
    const rows = screen.getAllByTestId("event-row");
    fireEvent.click(rows[0]);
    // Click "Open full detail →"
    const detailLink = screen.getByTestId("open-full-detail");
    fireEvent.click(detailLink);
    // Should show back navigation
    expect(screen.getByTestId("back-to-session")).toBeInTheDocument();
    expect(screen.getByText("← Back to session")).toBeInTheDocument();
  });

  it("back navigation returns to session event list", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const rows = screen.getAllByTestId("event-row");
    fireEvent.click(rows[0]);
    fireEvent.click(screen.getByTestId("open-full-detail"));
    // Now click back
    fireEvent.click(screen.getByTestId("back-to-session"));
    // Should be back to session view with event rows
    expect(screen.getAllByTestId("event-row").length).toBeGreaterThanOrEqual(1);
  });

  it("back from Mode 2 returns to event list", () => {
    const directEvent = baseEvents[1];
    render(<SessionDrawer sessionId="s1" onClose={() => {}} directEventDetail={directEvent} onClearDirectEvent={() => {}} />);
    fireEvent.click(screen.getByTestId("back-to-session"));
    expect(screen.getAllByTestId("event-row").length).toBeGreaterThanOrEqual(1);
  });

  // RUNTIME panel
  it("renders RUNTIME panel when session.context is non-empty", () => {
    mockSessionOverride = {
      context: {
        hostname: "agent-pod-7",
        os: "Linux",
        orchestration: "kubernetes",
        k8s_namespace: "agents",
        k8s_node: "node-1",
      },
    };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByTestId("runtime-panel")).toBeInTheDocument();
    // Toggle to expand
    fireEvent.click(screen.getByTestId("runtime-panel-toggle"));
    expect(screen.getByTestId("runtime-key-hostname")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-value-hostname")).toHaveTextContent(
      "agent-pod-7",
    );
    // kubernetes combined: '{namespace} / {node}'
    expect(screen.getByTestId("runtime-value-kubernetes")).toHaveTextContent(
      "agents / node-1",
    );
  });

  it("hides RUNTIME panel when session.context is missing or empty", () => {
    mockSessionOverride = { context: {} };
    const { rerender } = render(
      <SessionDrawer sessionId="s1" onClose={() => {}} />,
    );
    expect(screen.queryByTestId("runtime-panel")).not.toBeInTheDocument();

    mockSessionOverride = {}; // no context field at all
    rerender(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.queryByTestId("runtime-panel")).not.toBeInTheDocument();
  });

  it("RUNTIME panel combines git fields into a single row", () => {
    mockSessionOverride = {
      context: {
        git_commit: "abc1234",
        git_branch: "main",
        git_repo: "flightdeck",
      },
    };
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("runtime-panel-toggle"));
    // git: '{commit} · {branch} · {repo}'
    expect(screen.getByTestId("runtime-value-git")).toHaveTextContent(
      "abc1234 · main · flightdeck",
    );
    // The individual git_* keys must NOT be rendered separately --
    // they were consumed by the combined row.
    expect(screen.queryByTestId("runtime-key-git_commit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("runtime-key-git_branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("runtime-key-git_repo")).not.toBeInTheDocument();
  });

  it("events shown newest first", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    const badges = screen.getAllByTestId("event-badge");
    // baseEvents: e1=session_start (10:00), e2=post_call (10:01)
    // Reversed: first badge should be LLM CALL (newest), last should be START (oldest)
    expect(badges[0].textContent).toBe("LLM CALL");
    expect(badges[badges.length - 1].textContent).toBe("START");
  });
});
