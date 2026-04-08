import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionDrawer } from "@/components/session/SessionDrawer";

// Base session data
const baseSession = {
  session_id: "s1",
  flavor: "test-agent",
  agent_type: "autonomous",
  host: null,
  framework: null,
  model: "claude-sonnet-4-20250514",
  state: "active" as const,
  started_at: "2026-04-07T10:00:00Z",
  last_seen_at: "2026-04-07T10:05:00Z",
  ended_at: null,
  tokens_used: 5000,
  token_limit: null,
  has_pending_directive: false,
};

const baseEvents = [
  { id: "e1", session_id: "s1", flavor: "test", event_type: "session_start" as const, model: null, tokens_input: null, tokens_output: null, tokens_total: null, latency_ms: null, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:00:00Z" },
  { id: "e2", session_id: "s1", flavor: "test", event_type: "post_call" as const, model: "claude-sonnet-4-20250514", tokens_input: 100, tokens_output: 50, tokens_total: 150, latency_ms: 1200, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:01:00Z" },
];

const eventsWithContent = [
  ...baseEvents,
  { id: "e3", session_id: "s1", flavor: "test", event_type: "post_call" as const, model: "claude-sonnet-4-20250514", tokens_input: 200, tokens_output: 100, tokens_total: 300, latency_ms: 800, tool_name: null, has_content: true, occurred_at: "2026-04-07T10:02:00Z" },
];

// Session state per mock call -- reset each test
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

  it("opens and renders event list when session selected", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("test-agent")).toBeInTheDocument();
    expect(screen.getByText("session_start")).toBeInTheDocument();
    expect(screen.getByText("post_call")).toBeInTheDocument();
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
    // Click the confirm button inside the dialog
    const buttons = screen.getAllByText("Stop Agent");
    const confirmBtn = buttons[buttons.length - 1];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(createDirective).toHaveBeenCalledWith({
        action: "shutdown",
        session_id: "s1",
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

  it("defaults to Timeline tab showing events", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText("session_start")).toBeInTheDocument();
    expect(screen.getByText("post_call")).toBeInTheDocument();
  });

  it("expands event row to show JSON on click", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    // Click the post_call event row
    fireEvent.click(screen.getByText("post_call").closest("div[class*='cursor-pointer']")!);
    // Should show expanded JSON with event details
    expect(screen.getByText(/"event_type": "post_call"/)).toBeInTheDocument();
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
    // The content event should appear as a clickable item
    // It should show "post_call" in the prompts list
    const postCallItems = screen.getAllByText("post_call");
    expect(postCallItems.length).toBeGreaterThanOrEqual(1);
  });

  it("switches back to Timeline tab", () => {
    render(<SessionDrawer sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    fireEvent.click(screen.getByText("Timeline"));
    expect(screen.getByText("session_start")).toBeInTheDocument();
  });

  it("has 480px width", () => {
    const { container } = render(
      <SessionDrawer sessionId="s1" onClose={() => {}} />
    );
    const drawer = container.querySelector("[class*='w-\\[480px\\]']");
    expect(drawer).toBeInTheDocument();
  });
});
