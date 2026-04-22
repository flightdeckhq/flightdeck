import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "@/components/search/CommandPalette";
import type { SearchResults } from "@/lib/types";

const emptyResults: SearchResults = {
  agents: [],
  sessions: [],
  events: [],
};

const populatedResults: SearchResults = {
  agents: [
    { flavor: "research-agent", agent_type: "production", last_seen: "2026-04-01T00:00:00Z" },
  ],
  sessions: [
    {
      session_id: "sess-1234-abcd-5678",
      flavor: "research-agent",
      host: "host-1",
      state: "active",
      started_at: "2026-04-01T00:00:00Z",
    },
  ],
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
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    // "research-agent" appears in both agent and session rows
    expect(screen.getAllByText("research-agent")).toHaveLength(2);
    expect(screen.getByText("sess-123")).toBeInTheDocument(); // truncated session id
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
    // Click the agent result (first occurrence -- the agent row's flavor)
    fireEvent.click(screen.getAllByText("research-agent")[0]);
    await waitFor(() => {
      expect(onSelectResult).toHaveBeenCalledWith("agent", populatedResults.agents[0]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
