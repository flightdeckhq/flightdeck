import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import type { AgentEvent } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(null)),
}));

import { fetchEventContent } from "@/lib/api";

const postCallEvent: AgentEvent = {
  id: "e1",
  session_id: "s1-abcdef-1234",
  flavor: "research-agent",
  event_type: "post_call",
  model: "claude-sonnet-4-20250514",
  tokens_input: 100,
  tokens_output: 50,
  tokens_total: 150,
  latency_ms: 1200,
  tool_name: null,
  has_content: false,
  occurred_at: "2026-04-07T10:00:00Z",
};

const contentEvent: AgentEvent = {
  ...postCallEvent,
  id: "e2",
  has_content: true,
};

describe("EventDetailDrawer", () => {
  it("renders event type badge", () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    expect(screen.getByTestId("detail-badge")).toHaveTextContent("LLM CALL");
  });

  it("renders flavor and session ID in header", () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("s1-abcde")).toBeInTheDocument();
  });

  it("metadata bar shows timestamp", () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    const metadata = screen.getByTestId("detail-metadata");
    expect(metadata).toBeInTheDocument();
  });

  it("details tab shows summary grid", () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Tokens input")).toBeInTheDocument();
  });

  it("prompts tab shows disabled state when no content", () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    expect(
      screen.getByText("Prompt capture is not enabled for this deployment.")
    ).toBeInTheDocument();
  });

  it("prompts tab fetches content when has_content", async () => {
    render(<EventDetailDrawer event={contentEvent} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Prompts"));
    await waitFor(() => {
      expect(fetchEventContent).toHaveBeenCalledWith("e2");
    });
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(<EventDetailDrawer event={postCallEvent} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
