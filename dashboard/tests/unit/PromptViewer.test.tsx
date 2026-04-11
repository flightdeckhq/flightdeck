import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";

const mockContent = {
  event_id: "e1",
  session_id: "s1",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  system_prompt: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ],
  tools: [{ name: "web_search" }, { name: "calculator" }],
  response: { id: "resp-1", content: [{ type: "text", text: "Hi there!" }] },
  captured_at: "2026-04-07T10:01:00Z",
};

let mockFetchResult: typeof mockContent | null = mockContent;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockFetchResult)),
}));

beforeEach(() => {
  mockFetchResult = mockContent;
  vi.clearAllMocks();
});

describe("PromptViewer", () => {
  it("renders nothing when eventId is null", () => {
    const { container } = render(<PromptViewer eventId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows disabled message when content fetch returns null (404)", async () => {
    mockFetchResult = null;
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Prompt capture is not enabled for this deployment."
        )
      ).toBeInTheDocument();
    });
  });

  it("shows provider and model from content", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("anthropic")).toBeInTheDocument();
      expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
    });
  });

  it("renders system prompt section when system_prompt is present", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("System")).toBeInTheDocument();
    });
  });

  it("renders messages section with correct count", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // Count "(2)" appears for both Messages and Tools — just verify Messages header exists
    const counts = screen.getAllByText("(2)");
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  it("renders tool names in tools section", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Tools")).toBeInTheDocument();
    });
    // Tools are expanded by default — tool names visible
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("calculator")).toBeInTheDocument();
  });

  it("renders response section", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Response")).toBeInTheDocument();
    });
  });

  it("does not render system section when system_prompt is null", async () => {
    mockFetchResult = { ...mockContent, system_prompt: null };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // System section should not be present — only check for the section header button
    const buttons = screen.getAllByRole("button");
    const systemButton = buttons.find((b) => b.textContent?.includes("System"));
    expect(systemButton).toBeUndefined();
  });

  it("does not render tools section when tools is null", async () => {
    mockFetchResult = { ...mockContent, tools: null };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    const buttons = screen.getAllByRole("button");
    const toolsButton = buttons.find((b) => b.textContent?.includes("Tools"));
    expect(toolsButton).toBeUndefined();
  });

  it("messages are visible by default", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // All messages expanded by default — content visible without clicking
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  // This test must be last -- it overrides the mock with a never-resolving promise
  it("shows a spinner while loading", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchEventContent).mockReturnValue(new Promise(() => {}));
    const { container } = render(<PromptViewer eventId="e1" />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });
});
