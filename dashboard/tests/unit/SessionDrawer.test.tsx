import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionDrawer } from "@/components/session/SessionDrawer";

// Mock useSession hook
vi.mock("@/hooks/useSession", () => ({
  useSession: (id: string | null) => {
    if (!id) return { data: null, loading: false, error: null };
    return {
      data: {
        session: {
          session_id: "s1",
          flavor: "test-agent",
          agent_type: "autonomous",
          host: null,
          framework: null,
          model: "claude-sonnet-4-20250514",
          state: "active",
          started_at: "2026-04-07T10:00:00Z",
          last_seen_at: "2026-04-07T10:05:00Z",
          ended_at: null,
          tokens_used: 5000,
          token_limit: null,
        },
        events: [
          { id: "e1", session_id: "s1", flavor: "test", event_type: "session_start", model: null, tokens_input: null, tokens_output: null, tokens_total: null, latency_ms: null, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:00:00Z" },
          { id: "e2", session_id: "s1", flavor: "test", event_type: "post_call", model: "claude-sonnet-4-20250514", tokens_input: 100, tokens_output: 50, tokens_total: 150, latency_ms: 1200, tool_name: null, has_content: false, occurred_at: "2026-04-07T10:01:00Z" },
        ],
      },
      loading: false,
      error: null,
    };
  },
}));

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
});
