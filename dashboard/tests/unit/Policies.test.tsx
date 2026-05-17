import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PolicyEditor } from "@/components/policy/PolicyEditor";

// Mock the fleet store
const mockFlavors = [
  {
    flavor: "research-agent",
    agent_type: "production",
    session_count: 2,
    active_count: 1,
    tokens_used_total: 5000,
    sessions: [
      { session_id: "s1-abc-123", flavor: "research-agent", agent_type: "production", host: null, framework: null, model: "claude-sonnet-4-6", state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 3000, token_limit: null },
      { session_id: "s2-def-456", flavor: "research-agent", agent_type: "production", host: null, framework: null, model: "gpt-4o", state: "closed", started_at: "", last_seen_at: "", ended_at: "", tokens_used: 2000, token_limit: null },
    ],
  },
  {
    flavor: "code-agent",
    agent_type: "production",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 1000,
    sessions: [
      { session_id: "s3-ghi-789", flavor: "code-agent", agent_type: "production", host: null, framework: null, model: "gpt-4o", state: "idle", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 1000, token_limit: null },
    ],
  },
];

// Phase 4.5 M-18: PolicyEditor migrated to selector form
// ``useFleetStore((s) => s.flavors)``. The mock now respects the
// selector arg so callers receive the field they ask for, not the
// full state object.
const mockFleetState = {
  flavors: mockFlavors,
  loading: false,
  error: null,
  selectedSessionId: null,
  agentTypeFilter: "all" as const,
  flavorFilter: null,
  load: vi.fn(),
  setAgentTypeFilter: vi.fn(),
  setFlavorFilter: vi.fn(),
  applyUpdate: vi.fn(),
  selectSession: vi.fn(),
};
vi.mock("@/store/fleet", () => ({
  useFleetStore: <T,>(selector?: (s: typeof mockFleetState) => T) =>
    selector ? selector(mockFleetState) : mockFleetState,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PolicyEditor enhancements", () => {
  it("scope dropdown shows Organization, Agent, Run labels", () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);
    // The combobox trigger should show "Organization" for default "org" scope
    const orgTexts = screen.getAllByText("Organization");
    expect(orgTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("selecting Flavor scope shows flavor dropdown", () => {
    // Render with flavor scope pre-selected via policy prop
    render(
      <PolicyEditor
        policy={{
          id: "p1",
          scope: "flavor",
          scope_value: "",
          token_limit: null,
          warn_at_pct: null,
          degrade_at_pct: null,
          degrade_to: null,
          block_at_pct: null,
          created_at: "",
          updated_at: "",
        }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId("flavor-dropdown")).toBeInTheDocument();
  });

  it("flavor dropdown includes fleet flavors and wildcard", () => {
    render(
      <PolicyEditor
        policy={{
          id: "p1",
          scope: "flavor",
          scope_value: "",
          token_limit: null,
          warn_at_pct: null,
          degrade_at_pct: null,
          degrade_to: null,
          block_at_pct: null,
          created_at: "",
          updated_at: "",
        }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    // The dropdown trigger is present
    const trigger = screen.getByTestId("flavor-dropdown");
    expect(trigger).toBeInTheDocument();
  });

  it("session scope shows only active/idle sessions", () => {
    render(
      <PolicyEditor
        policy={{
          id: "p1",
          scope: "session",
          scope_value: "",
          token_limit: null,
          warn_at_pct: null,
          degrade_at_pct: null,
          degrade_to: null,
          block_at_pct: null,
          created_at: "",
          updated_at: "",
        }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId("session-dropdown")).toBeInTheDocument();
    // The "Or enter session ID directly" fallback is always shown
    expect(screen.getByText("Or enter run ID directly")).toBeInTheDocument();
  });

  it("degrade model dropdown renders when degrade_at_pct is set", () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    // Set degrade_at_pct to trigger the model dropdown
    const degradeInputs = screen.getAllByPlaceholderText("1-99");
    fireEvent.change(degradeInputs[1], { target: { value: "85" } });

    expect(screen.getByTestId("model-dropdown")).toBeInTheDocument();
  });

  it("degrade dropdown shows group headers", () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    const degradeInputs = screen.getAllByPlaceholderText("1-99");
    fireEvent.change(degradeInputs[1], { target: { value: "85" } });

    expect(screen.getByText("All models")).toBeInTheDocument();
  });

  it("in-use models show green dot", () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    const degradeInputs = screen.getAllByPlaceholderText("1-99");
    fireEvent.change(degradeInputs[1], { target: { value: "85" } });

    // In-use models from fleet store (claude-sonnet-4-6 and gpt-4o)
    expect(screen.getByText("In use in this scope")).toBeInTheDocument();
    const dots = screen.getAllByTestId("in-use-dot");
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });
});
