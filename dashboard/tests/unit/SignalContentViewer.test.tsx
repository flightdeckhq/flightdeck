import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchEventContent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  fetchEventContent,
}));

import { SignalContentViewer, SignalPromptsPanel } from "@/components/session/SignalContentViewer";
import { EventRow } from "@/components/session/EventRow";
import type { AgentEvent } from "@/lib/types";

beforeEach(() => {
  fetchEventContent.mockReset();
});

describe("SignalContentViewer", () => {
  it("renders each captured text under its heading", async () => {
    fetchEventContent.mockResolvedValue({
      event_id: "e1",
      provider: "flightdeck-signal",
      response: { compact_summary: "Line one.\nLine two." },
    });
    render(<SignalContentViewer eventId="e1" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "text"));
    const section = screen.getByTestId("signal-content-compact_summary");
    expect(section).toHaveTextContent("Compaction summary");
    expect(section).toHaveTextContent("Line one. Line two.");
  });

  it("does not fetch when nothing was captured", () => {
    render(<SignalContentViewer eventId="e1" hasContent={false} />);
    expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty");
    expect(fetchEventContent).not.toHaveBeenCalled();
  });

  it("shows the empty state when the content is gone or holds no text", async () => {
    fetchEventContent.mockResolvedValue(null);
    const { unmount } = render(<SignalContentViewer eventId="e1" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty"));
    unmount();
    fetchEventContent.mockResolvedValue({ event_id: "e2", provider: "flightdeck-signal", response: { x: 3 } });
    render(<SignalContentViewer eventId="e2" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty"));
  });
});


function signalEvent(signal: string, hasContent: boolean): AgentEvent {
  return {
    id: `evt-${signal}`,
    session_id: "s1",
    flavor: "claude-code",
    event_type: "session_signal",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: hasContent,
    occurred_at: "2026-10-30T10:00:00Z",
    payload: { signal, signal_data: { trigger: "auto" } },
  } as AgentEvent;
}

describe("SignalPromptsPanel", () => {
  it("shows the captured text when the event has content", async () => {
    fetchEventContent.mockResolvedValue({ event_id: "x", provider: "flightdeck-signal", response: { compact_summary: "S." } });
    render(<SignalPromptsPanel event={signalEvent("context_compacted", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-compact_summary")).toHaveTextContent("S."));
  });

  it("says capture is off for a compaction without its summary (rule 21)", () => {
    render(<SignalPromptsPanel event={signalEvent("context_compacted", false)} />);
    expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent(
      "Prompt capture is not enabled for this deployment.",
    );
    expect(fetchEventContent).not.toHaveBeenCalled();
  });

  it("shows a notification's title before its message, and says capture is off without them", async () => {
    fetchEventContent.mockResolvedValue({
      event_id: "x",
      provider: "flightdeck-signal",
      response: { message: "Claude needs your permission", title: "Permission needed" },
    });
    const { unmount } = render(<SignalPromptsPanel event={signalEvent("notification", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-title")).toHaveTextContent("Permission needed"));
    const sections = screen.getAllByTestId(/^signal-content-(title|message)$/).map((el) => el.dataset.testid);
    expect(sections).toEqual(["signal-content-title", "signal-content-message"]);
    unmount();
    render(<SignalPromptsPanel event={signalEvent("notification", false)} />);
    expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent(
      "Prompt capture is not enabled for this deployment.",
    );
  });

  it("shows a task's subject before its description, and says capture is off without them", async () => {
    fetchEventContent.mockResolvedValue({
      event_id: "x",
      provider: "flightdeck-signal",
      response: { task_description: "Move them to the new fixture", task_subject: "Migrate the auth tests" },
    });
    const { unmount } = render(<SignalPromptsPanel event={signalEvent("task_created", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-task_subject")).toHaveTextContent("Subject"));
    const sections = screen.getAllByTestId(/^signal-content-task_/).map((el) => el.dataset.testid);
    expect(sections).toEqual(["signal-content-task_subject", "signal-content-task_description"]);
    expect(screen.getByTestId("signal-content-task_description")).toHaveTextContent("Description");
    unmount();
    for (const signal of ["task_created", "task_completed"]) {
      const { unmount: off } = render(<SignalPromptsPanel event={signalEvent(signal, false)} />);
      expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent(
        "Prompt capture is not enabled for this deployment.",
      );
      off();
    }
  });

  it("heads an elicitation's form and answer, and says capture is off for a request without its message", async () => {
    fetchEventContent.mockResolvedValue({
      event_id: "x",
      provider: "flightdeck-signal",
      response: {
        message: "Sign in to continue",
        url: "https://auth.example.com/approve",
        requested_schema: '{\n  "type": "object"\n}',
      },
    });
    const { unmount } = render(<SignalPromptsPanel event={signalEvent("elicitation_requested", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-requested_schema")).toHaveTextContent("Requested fields"));
    expect(screen.getByTestId("signal-content-message")).toHaveTextContent("Sign in to continue");
    expect(screen.getByTestId("signal-content-url")).toHaveTextContent("URL");
    expect(screen.getByTestId("signal-content-url")).toHaveTextContent("https://auth.example.com/approve");
    unmount();
    fetchEventContent.mockResolvedValue({ event_id: "y", provider: "flightdeck-signal", response: { content: '{"code":"4242"}' } });
    const { unmount: answered } = render(<SignalPromptsPanel event={signalEvent("elicitation_responded", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-content")).toHaveTextContent("Answer"));
    expect(screen.getByTestId("signal-content-content")).toHaveTextContent('{"code":"4242"}');
    answered();
    const { unmount: off } = render(<SignalPromptsPanel event={signalEvent("elicitation_requested", false)} />);
    expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent("Prompt capture is not enabled for this deployment.");
    off();
    render(<SignalPromptsPanel event={signalEvent("elicitation_responded", false)} />);
    expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent("This event carries no captured text.");
  });

  it("heads a command's arguments", async () => {
    fetchEventContent.mockResolvedValue({ event_id: "x", provider: "flightdeck-signal", response: { command_args: "the auth module" } });
    render(<SignalPromptsPanel event={signalEvent("command_expanded", true)} />);
    await waitFor(() => expect(screen.getByTestId("signal-content-command_args")).toHaveTextContent("Arguments"));
    expect(screen.getByTestId("signal-content-command_args")).toHaveTextContent("the auth module");
  });

  it("says a signal that may carry no text carries none", () => {
    for (const signal of ["model_switched", "context_compaction_started", "command_expanded", "cwd_changed", "config_changed"]) {
      const { unmount } = render(<SignalPromptsPanel event={signalEvent(signal, false)} />);
      expect(screen.getByTestId("signal-prompts-empty")).toHaveTextContent("This event carries no captured text.");
      unmount();
    }
  });
});

describe("EventRow for a session_signal", () => {
  it("renders the text inline and offers no View Prompts link", async () => {
    fetchEventContent.mockResolvedValue({ event_id: "x", provider: "flightdeck-signal", response: { compact_summary: "S." } });
    render(
      <EventRow
        event={signalEvent("context_compacted", true)}
        attachments={[]}
        isExpanded
        onToggleExpand={() => {}}
        onViewPrompts={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("signal-content-compact_summary")).toBeInTheDocument());
    expect(screen.queryByText("View Prompts →")).toBeNull();
  });

  it("renders no text box for a signal without content", () => {
    render(
      <EventRow
        event={signalEvent("model_switched", false)}
        attachments={[]}
        isExpanded
        onToggleExpand={() => {}}
      />,
    );
    expect(screen.queryByTestId("signal-content-viewer")).toBeNull();
  });
});
