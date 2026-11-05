import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import type { AgentEvent } from "@/lib/types";

// The Prompts tab of an event without content reads the event's run
// (capture_enabled) through useSession, which calls fetchSession.
let mockCaptureEnabled = false;
let mockSessionFields: Record<string, unknown> = {};

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(null)),
  fetchSession: vi.fn((id: string) =>
    Promise.resolve({
      session: {
        session_id: id,
        flavor: "research-agent",
        capture_enabled: mockCaptureEnabled,
        ...mockSessionFields,
      },
      events: [],
      attachments: [],
    }),
  ),
}));

import { fetchEventContent } from "@/lib/api";
import { invalidateSessionCache } from "@/hooks/useSession";

beforeEach(() => {
  mockCaptureEnabled = false;
  mockSessionFields = {};
  invalidateSessionCache("s1-abcdef-1234");
});

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

  it("prompts tab shows disabled state when no content", async () => {
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("detail-tab-prompts"));
    expect(
      await screen.findByText("Prompt capture is not enabled for this deployment.")
    ).toBeInTheDocument();
  });

  it("prompts tab of an event without content on a capture-on run says the event recorded none", async () => {
    mockCaptureEnabled = true;
    render(<EventDetailDrawer event={postCallEvent} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("detail-tab-prompts"));
    expect(
      await screen.findByTestId("prompts-no-content-for-event"),
    ).toHaveTextContent("No content was recorded for this event.");
    expect(screen.queryByText(/Prompt capture is not enabled/)).toBeNull();
  });

  it("prompts tab of a Google ADK tool call on a capture-on run says where its content is", async () => {
    mockCaptureEnabled = true;
    mockSessionFields = {
      client_type: "otlp",
      framework: "google_adk",
      context: { telemetry: "otlp", frameworks: ["google_adk/2.13.0"] },
    };
    render(
      <EventDetailDrawer
        event={{ ...postCallEvent, event_type: "tool_call", tool_name: "get_weather", model: null }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("detail-tab-prompts"));
    expect(await screen.findByTestId("prompts-no-content-reason")).toHaveTextContent(
      "Google ADK records a tool's arguments and result only inside the next model call's messages",
    );
  });

  it("prompts tab fetches content when has_content", async () => {
    render(<EventDetailDrawer event={contentEvent} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("detail-tab-prompts"));
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
