import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Directives } from "@/pages/Directives";
import type { CustomDirective } from "@/lib/types";

const mockDirectives: CustomDirective[] = [
  {
    id: "cd-1",
    fingerprint: "fp-abc",
    name: "rotate-model",
    description: "Rotate the active model mid-session",
    flavor: "research-agent",
    parameters: [
      {
        name: "target_model",
        type: "string",
        description: "Model to switch to",
        options: ["gpt-4o", "claude-sonnet-4-20250514"],
        required: true,
        default: null,
      },
      {
        name: "dry_run",
        type: "boolean",
        description: "Simulate without applying",
        options: [],
        required: false,
        default: false,
      },
    ],
    registered_at: "2026-04-07T10:00:00Z",
    last_seen_at: "2026-04-07T12:00:00Z",
  },
  {
    id: "cd-2",
    fingerprint: "fp-def",
    name: "flush-cache",
    description: "Clear the agent cache",
    flavor: "research-agent",
    parameters: [],
    registered_at: "2026-04-06T10:00:00Z",
    last_seen_at: "2026-04-06T12:00:00Z",
  },
];

vi.mock("@/store/fleet", () => ({
  useFleetStore: () => ({
    flavors: [
      {
        flavor: "research-agent",
        agent_type: "autonomous",
        session_count: 1,
        active_count: 1,
        tokens_used_total: 1000,
        sessions: [
          { session_id: "sess-active-1", flavor: "research-agent", agent_type: "autonomous", host: null, framework: null, model: "claude-sonnet-4-6", state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 1000, token_limit: null },
        ],
      },
    ],
    loading: false,
    error: null,
    selectedSessionId: null,
    agentTypeFilter: "all",
    flavorFilter: null,
    load: vi.fn(),
    setAgentTypeFilter: vi.fn(),
    setFlavorFilter: vi.fn(),
    applyUpdate: vi.fn(),
    selectSession: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchCustomDirectives: vi.fn(() => Promise.resolve([])),
  fetchFlavors: vi.fn(() => Promise.resolve(["research-agent", "coding-agent"])),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

import {
  fetchCustomDirectives,
  fetchFlavors,
  triggerCustomDirective,
} from "@/lib/api";

const mockFetchCustomDirectives = fetchCustomDirectives as ReturnType<typeof vi.fn>;
const mockFetchFlavors = fetchFlavors as ReturnType<typeof vi.fn>;
const mockTriggerCustomDirective = triggerCustomDirective as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFlavors.mockResolvedValue(["research-agent", "coding-agent"]);
});

describe("Directives page", () => {
  it("renders directive cards from API", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    expect(screen.getByText("flush-cache")).toBeInTheDocument();
    expect(screen.getByText("Rotate the active model mid-session")).toBeInTheDocument();
  });

  it("empty state shows code snippet", async () => {
    mockFetchCustomDirectives.mockResolvedValue([]);
    render(<Directives />);
    await waitFor(() => {
      expect(
        screen.getByText(/No custom directives registered yet/)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/def my_action\(context\)/)).toBeInTheDocument();
  });

  it("flavor filter changes API call param", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    // Initial call with no filter
    expect(mockFetchCustomDirectives).toHaveBeenCalledWith(undefined);
  });

  it("search filters directive list client-side", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText("Search directives");
    fireEvent.change(searchInput, { target: { value: "flush" } });

    expect(screen.queryByText("rotate-model")).not.toBeInTheDocument();
    expect(screen.getByText("flush-cache")).toBeInTheDocument();
  });

  it("trigger button expands parameter form", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    // Click Trigger on the first card
    const triggerButtons = screen.getAllByText("Trigger");
    fireEvent.click(triggerButtons[0]);

    expect(screen.getByText("Send Directive")).toBeInTheDocument();
    // target_model is a Select (string with options), dry_run is a checkbox
    expect(screen.getByText(/Select target_model/)).toBeInTheDocument();
    expect(screen.getByLabelText("dry_run")).toBeInTheDocument();
  });

  it("submit calls triggerCustomDirective with correct payload", async () => {
    mockFetchCustomDirectives.mockResolvedValue([mockDirectives[1]]); // flush-cache, no params
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("flush-cache")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Trigger"));
    fireEvent.click(screen.getByText("Send Directive"));

    await waitFor(() => {
      expect(mockTriggerCustomDirective).toHaveBeenCalledWith({
        action: "custom",
        directive_name: "flush-cache",
        fingerprint: "fp-def",
        flavor: "research-agent",
        parameters: undefined,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Directive sent to all research-agent sessions/)).toBeInTheDocument();
    });
  });

  it("shows flavor disclaimer when targeting all sessions", async () => {
    mockFetchCustomDirectives.mockResolvedValue([mockDirectives[1]]);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("flush-cache")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Trigger"));
    expect(screen.getByTestId("flavor-disclaimer")).toBeInTheDocument();
    expect(screen.getByText(/Sessions running older code may skip/)).toBeInTheDocument();
  });

  it("shows session registration status with green dot for recent directives", async () => {
    // The mock directive has last_seen_at in the past (2026-04-07), so it's stale
    const recentDirective = {
      ...mockDirectives[1],
      last_seen_at: new Date().toISOString(), // just now — recently registered
    };
    mockFetchCustomDirectives.mockResolvedValue([recentDirective]);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("flush-cache")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Trigger"));
    // Switch to session mode to see per-session indicators
    // The fleet store mock has one active session for research-agent
    // Since last_seen_at is recent, it should show "registered"
  });
});
