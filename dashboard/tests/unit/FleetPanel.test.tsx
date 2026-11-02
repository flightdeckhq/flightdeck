import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import type { AgentEvent, CustomDirective, FeedEvent, FlavorSummary } from "@/lib/types";

// POST /v1/directives answers with the last row and how many rows the
// request created (X-Directive-Count): for an agent-wide stop, how many
// runs it reached, which the page cannot know on its own.
vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ directive: { id: "dir-1" }, count: 3 })),
  triggerCustomDirective: vi.fn(() =>
    Promise.resolve({ directive: { id: "dir-2" }, count: 2 }),
  ),
}));

// Mock the fleet store so FleetPanel's new `customDirectives`
// lookup works without spinning up the real Zustand store + API
// fetch. Tests that need a non-empty directive list mutate
// mockCustomDirectives before rendering.
let mockCustomDirectives: CustomDirective[] = [];
const mockMarkShuttingDown = vi.fn();
vi.mock("@/store/fleet", () => ({
  useFleetStore: (selector: (state: unknown) => unknown) =>
    selector({ customDirectives: mockCustomDirectives, markShuttingDown: mockMarkShuttingDown }),
}));

import { createDirective, triggerCustomDirective } from "@/lib/api";

// A row's ``flavor`` carries its agent_id (buildFlavors), so the
// fixtures set the two equal.
const mockFlavors: FlavorSummary[] = [
  {
    flavor: "research-agent",
    agent_id: "research-agent",
    agent_type: "production",
    session_count: 3,
    active_count: 2,
    tokens_used_total: 10000,
    sessions: [
      { session_id: "s1", flavor: "research-agent", agent_type: "production", host: null, framework: null, model: null, state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 5000, token_limit: null },
      { session_id: "s2", flavor: "research-agent", agent_type: "production", host: null, framework: null, model: null, state: "active", started_at: "", last_seen_at: "", ended_at: null, tokens_used: 3000, token_limit: null },
      { session_id: "s3", flavor: "research-agent", agent_type: "production", host: null, framework: null, model: null, state: "closed", started_at: "", last_seen_at: "", ended_at: "", tokens_used: 2000, token_limit: null },
    ],
  },
];

const inactiveFlavors: FlavorSummary[] = [
  {
    flavor: "batch-agent",
    agent_id: "batch-agent",
    agent_type: "batch",
    session_count: 1,
    active_count: 0,
    tokens_used_total: 500,
    sessions: [
      { session_id: "s4", flavor: "batch-agent", agent_type: "batch", host: null, framework: null, model: null, state: "closed", started_at: "", last_seen_at: "", ended_at: "", tokens_used: 500, token_limit: null },
    ],
  },
];

describe("FleetPanel", () => {
  beforeEach(() => {
    mockCustomDirectives = [];
    localStorage.clear();
    vi.mocked(createDirective).mockClear();
    vi.mocked(triggerCustomDirective).mockClear();
    mockMarkShuttingDown.mockClear();
  });

  // A sidebar row is an agent: ``flavor`` carries its agent_id, while
  // a sensor registers directives under its sessions' flavor string.
  const AGENT_ID = "0b6f2e0e-1111-5222-8333-944455556666";
  const sensorDirective: CustomDirective = {
    id: "cd-sensor",
    fingerprint: "fp-sensor",
    name: "rotate-model",
    description: "",
    flavor: "research-agent",
    parameters: [],
    registered_at: "2026-11-01T10:00:00Z",
    last_seen_at: "2026-11-01T10:00:00Z",
  };
  function agentRow(context?: Record<string, unknown>, clientType = "flightdeck_sensor"): FlavorSummary[] {
    return [
      {
        ...mockFlavors[0],
        flavor: AGENT_ID,
        agent_id: AGENT_ID,
        agent_name: "sensor@host",
        client_type: clientType as FlavorSummary["client_type"],
        sessions: mockFlavors[0].sessions.map((s) => ({
          ...s,
          client_type: clientType as FlavorSummary["client_type"],
          context,
        })),
      },
    ];
  }

  it("offers a sensor agent the directives registered under its sessions' flavor", () => {
    mockCustomDirectives = [sensorDirective];
    render(<FleetPanel flavors={agentRow()} />);
    expect(screen.getByTestId(`flavor-directives-button-${AGENT_ID}`)).toBeInTheDocument();
  });

  it("offers no directives to an observer agent or a plugin agent whose flavor has some", () => {
    mockCustomDirectives = [sensorDirective];
    const { unmount } = render(
      <FleetPanel
        flavors={agentRow({ telemetry: "otlp", supports_directives: false }, "claude_code")}
      />,
    );
    expect(screen.queryByTestId(`flavor-directives-button-${AGENT_ID}`)).toBeNull();
    unmount();
    // Enforcement on: Stop works, custom directives do not.
    render(<FleetPanel flavors={agentRow({ supports_directives: true }, "claude_code")} />);
    expect(screen.queryByTestId(`flavor-directives-button-${AGENT_ID}`)).toBeNull();
    expect(screen.getByTestId(`flavor-stop-all-button-${AGENT_ID}`)).toBeInTheDocument();
  });

  it("Custom Directives sidebar section is gone", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    // The old child panel rendered under a "Custom Directives" card
    // title and included a dev-docs empty state. Both are gone now.
    expect(screen.queryByText("Custom Directives")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No custom directives registered/),
    ).not.toBeInTheDocument();
  });

  it("Directive Activity header is hidden when directiveEvents is empty", () => {
    // Previously the header rendered with a muted "No directive
    // activity yet" empty state. The cleanup hides both the header
    // and the body when there's nothing to show.
    render(<FleetPanel flavors={mockFlavors} directiveEvents={[]} />);
    expect(
      screen.queryByTestId("directive-activity-header"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Directive Activity")).not.toBeInTheDocument();
  });

  it("Policy Events header is hidden when policyEvents is empty", () => {
    // Mirror of the directive-activity-empty test above. Previously
    // POLICY EVENTS rendered an unconditional "No policy events yet."
    // stub even on a perfectly clean fleet; now the header AND body
    // are both gated on policyEvents.length so the sidebar carries
    // only operational sections that actually have something to show.
    render(<FleetPanel flavors={mockFlavors} policyEvents={[]} />);
    expect(
      screen.queryByTestId("policy-events-header"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Policy Events")).not.toBeInTheDocument();
  });

  it("Policy Events rows render with eventBadgeConfig color + getEventDetail text", () => {
    // Build one entry per enforcement event_type with canonical
    // payload shapes so getEventDetail returns its deterministic
    // strings ("warn at 80% · 8,000 of 10,000 tokens", etc.). Mirrors
    // the canonical e2e fixture (tests/e2e-fixtures/seed.py policy_*
    // branch) so the unit and E2E layers exercise identical wire
    // shapes.
    const baseEvent = {
      id: "",
      session_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: "",
      flavor: "research-agent",
      framework: null,
      model: null,
      tokens_input: null,
      tokens_output: null,
      tokens_total: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      latency_ms: null,
      tool_name: null,
      has_content: false,
    } as Partial<AgentEvent>;

    const events: FeedEvent[] = [
      {
        arrivedAt: 1_700_000_000_000,
        event: {
          ...baseEvent,
          id: "ev-warn",
          event_type: "policy_warn",
          payload: {
            source: "server",
            threshold_pct: 80,
            tokens_used: 8000,
            token_limit: 10000,
          },
        } as AgentEvent,
      },
      {
        arrivedAt: 1_700_000_001_000,
        event: {
          ...baseEvent,
          id: "ev-degrade",
          event_type: "policy_degrade",
          payload: {
            source: "server",
            threshold_pct: 90,
            tokens_used: 9100,
            token_limit: 10000,
            from_model: "claude-sonnet-4-6",
            to_model: "claude-haiku-4-5",
          },
        } as AgentEvent,
      },
      {
        arrivedAt: 1_700_000_002_000,
        event: {
          ...baseEvent,
          id: "ev-block",
          event_type: "policy_block",
          payload: {
            source: "server",
            threshold_pct: 100,
            tokens_used: 10100,
            token_limit: 10000,
            intended_model: "claude-opus-4-7",
          },
        } as AgentEvent,
      },
    ];

    render(<FleetPanel flavors={mockFlavors} policyEvents={events} />);

    // Header shows up.
    expect(screen.getByTestId("policy-events-header")).toBeInTheDocument();

    // One row per event_type, anchored by data-testid so theme /
    // wrapping changes don't break the assertion.
    expect(screen.getByTestId("policy-event-row-policy_warn")).toBeInTheDocument();
    expect(screen.getByTestId("policy-event-row-policy_degrade")).toBeInTheDocument();
    expect(screen.getByTestId("policy-event-row-policy_block")).toBeInTheDocument();

    // Top line uses getEventDetail. Spot-check each variant: the
    // strings are the same ones T17 asserts in the drawer detail
    // surface so the unit + E2E vocabularies stay locked together.
    expect(
      screen.getByText("warn at 80% · 8,000 of 10,000 tokens"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("degraded from claude-sonnet-4-6 to claude-haiku-4-5"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("blocked at 10,100 of 10,000 tokens"),
    ).toBeInTheDocument();

    // Bottom-line badge label per row -- WARN / BLOCK / DEGRADE
    // pulled from eventBadgeConfig so a future relabel flows through
    // every surface that shares the config.
    expect(screen.getByText("WARN")).toBeInTheDocument();
    expect(screen.getByText("BLOCK")).toBeInTheDocument();
    expect(screen.getByText("DEGRADE")).toBeInTheDocument();
  });

  it("Tokens row shows the count scoped to the time range", () => {
    render(
      <FleetPanel
        flavors={mockFlavors}
        tokensInRange={12_450}
        timeRange="1h"
      />,
    );
    // Label carries the time-range suffix so the value can't be
    // misread as an all-time fleet total.
    expect(screen.getByText("Tokens (1h)")).toBeInTheDocument();
    // Localised value -- "12,450" not "12450".
    expect(screen.getByText("12,450")).toBeInTheDocument();
  });

  it("Tokens row falls back to plain 'Tokens' label when timeRange is omitted", () => {
    render(<FleetPanel flavors={mockFlavors} tokensInRange={42} />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.queryByText(/Tokens \(/)).not.toBeInTheDocument();
  });

  it("flavor list scroll container has flexShrink: 0 and minHeight to prevent flex collapse", () => {
    // Root cause of the prior collapse bug: FleetPanel is a flex
    // column with overflow-y auto, and flex children default to
    // shrink: 1. Without these two props the flavor list would
    // compress to min-content (~1 row) whenever sidebar content
    // exceeded the viewport height. This test locks in the props
    // that make the collapse impossible.
    render(<FleetPanel flavors={mockFlavors} />);
    const firstFlavor = screen.getByText("research-agent");
    const container = firstFlavor.closest(".thin-scrollbar") as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.style.flexShrink).toBe("0");
    expect(container.style.minHeight).toBe("80px");
    expect(container.style.maxHeight).toBe("240px");
  });

  it("renders correct active session count in session states", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    const activeCount = screen.getByTestId("state-count-active");
    expect(activeCount).toHaveTextContent("2");
  });

  it("renders session state counts", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    // State counts shown as numbers with labels below
    const activeCount = screen.getByTestId("state-count-active");
    expect(activeCount).toHaveTextContent("2");
    const closedCount = screen.getByTestId("state-count-closed");
    expect(closedCount).toHaveTextContent("1");
  });

  it("does not show Stop All button when no active sessions", () => {
    render(<FleetPanel flavors={inactiveFlavors} />);
    // Stop All is icon-only now -- assert via testid since the
    // visible glyph is a lucide OctagonX SVG with no text node.
    expect(
      screen.queryByTestId("flavor-stop-all-button-batch-agent"),
    ).not.toBeInTheDocument();
  });

  it("shows Stop All icon button when flavor has active sessions", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(
      screen.getByTestId("flavor-stop-all-button-research-agent"),
    ).toBeInTheDocument();
  });

  it("opens confirmation dialog on Stop All click", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(
      screen.getByTestId("flavor-stop-all-button-research-agent"),
    );
    expect(
      screen.getByText("Stop all runs of research-agent?"),
    ).toBeInTheDocument();
    // The page holds only some of an agent's runs, so the dialog
    // promises no count.
    expect(
      screen.getByText(/Every active or idle run of this agent that can take a stop/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/All \d+ active/)).toBeNull();
  });

  it("Stop All sends one stop addressed to the agent and names the API's count", async () => {
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(
      screen.getByTestId("flavor-stop-all-button-research-agent"),
    );
    // The dialog body contains a "Stop All" submit button -- the
    // outer trigger is icon-only so the only "Stop All" text node
    // is the confirm button inside the dialog.
    fireEvent.click(screen.getByText("Stop All"));
    // One request for the agent: the API stops every live run of it
    // that can take a stop, including runs this page has not loaded,
    // and none of another agent's runs that share the flavor. Neither
    // a per-session stop for the runs the page holds nor a flavor-wide
    // shutdown_flavor does that.
    await waitFor(() => {
      expect(createDirective).toHaveBeenCalledTimes(1);
    });
    expect(createDirective).toHaveBeenCalledWith({
      action: "shutdown",
      agent_id: "research-agent",
      reason: "manual_fleet_kill",
      grace_period_ms: 5000,
    });
    // The API reached three runs; the page holds two live ones.
    expect(await screen.findByRole("status")).toHaveTextContent("Stop sent to 3 runs");
    expect(screen.queryByTestId("flavor-stop-all-button-research-agent")).toBeNull();
    // The live runs the page holds show as shutting down at once.
    expect(mockMarkShuttingDown.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
  });

  it("Stop All without a count names none", async () => {
    vi.mocked(createDirective).mockResolvedValueOnce({
      directive: { id: "dir-1" } as never,
      count: null,
    });
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(screen.getByTestId("flavor-stop-all-button-research-agent"));
    fireEvent.click(screen.getByText("Stop All"));
    expect(await screen.findByRole("status")).toHaveTextContent(/^Stop sent$/);
  });

  it("a failed Stop All shows the API's reason and marks nothing", async () => {
    vi.mocked(createDirective).mockRejectedValueOnce(
      new Error("no live session of this agent can take this directive"),
    );
    render(<FleetPanel flavors={mockFlavors} />);
    fireEvent.click(screen.getByTestId("flavor-stop-all-button-research-agent"));
    fireEvent.click(screen.getByText("Stop All"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no live session of this agent can take this directive",
    );
    expect(screen.getByText("Stop all runs of research-agent?")).toBeInTheDocument();
    expect(mockMarkShuttingDown).not.toHaveBeenCalled();
  });

  it("a row without an agent_id offers neither control", () => {
    // A live update for a session with no agent_id builds a row keyed
    // by its flavor string, which no agent-scoped request can name.
    mockCustomDirectives = [sensorDirective];
    const { agent_id: _omit, ...noId } = mockFlavors[0]!;
    render(<FleetPanel flavors={[noId]} />);
    expect(screen.queryByTestId("flavor-stop-all-button-research-agent")).toBeNull();
    expect(screen.queryByTestId("flavor-directives-button-research-agent")).toBeNull();
  });

  it("names the agent, not its id, in the controls' labels and dialogs", () => {
    mockCustomDirectives = [sensorDirective];
    render(<FleetPanel flavors={agentRow()} />);
    const stop = screen.getByTestId(`flavor-stop-all-button-${AGENT_ID}`);
    expect(stop).toHaveAttribute("aria-label", "Stop all runs of sensor@host");
    expect(stop).toHaveAttribute("title", "Stop all runs of sensor@host");
    const trigger = screen.getByTestId(`flavor-directives-button-${AGENT_ID}`);
    expect(trigger).toHaveAttribute("aria-label", "Trigger directives on sensor@host");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveTextContent("Trigger directives on sensor@host");
    expect(screen.getByRole("dialog")).not.toHaveTextContent(AGENT_ID);
  });

  it("the directive trigger sends to the agent's runs of the directive's flavor", async () => {
    mockCustomDirectives = [sensorDirective];
    render(<FleetPanel flavors={agentRow()} />);
    fireEvent.click(screen.getByTestId(`flavor-directives-button-${AGENT_ID}`));
    fireEvent.click(screen.getByTestId("directive-run-rotate-model"));
    await waitFor(() => {
      expect(triggerCustomDirective).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(triggerCustomDirective).mock.calls[0]![0];
    // agent_id keeps it off another agent's runs that share the flavor;
    // the flavor keeps it to the runs whose flavor registered it.
    expect(call).toMatchObject({
      action: "custom",
      agent_id: AGENT_ID,
      flavor: "research-agent",
      fingerprint: "fp-sensor",
    });
    expect(call.session_id).toBeUndefined();
    expect(await screen.findByTestId("directive-sent-rotate-model")).toHaveTextContent(
      "Directive sent to 2 runs",
    );
  });

  it("confirming Stop All or cancelling it leaves the agent filter alone", async () => {
    // The dialogs render in a portal, but React bubbles their clicks
    // through the row, whose own click toggles the agent filter.
    const onFlavorClick = vi.fn();
    render(<FleetPanel flavors={mockFlavors} onFlavorClick={onFlavorClick} />);
    fireEvent.click(screen.getByTestId("flavor-stop-all-button-research-agent"));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByTestId("flavor-stop-all-button-research-agent"));
    fireEvent.click(screen.getByText("Stop All"));
    expect(await screen.findByRole("status")).toHaveTextContent("Stop sent to 3 runs");
    expect(onFlavorClick).not.toHaveBeenCalled();
  });

  it("running a directive from the row leaves the agent filter alone", async () => {
    mockCustomDirectives = [sensorDirective];
    const onFlavorClick = vi.fn();
    render(<FleetPanel flavors={agentRow()} onFlavorClick={onFlavorClick} />);
    fireEvent.click(screen.getByTestId(`flavor-directives-button-${AGENT_ID}`));
    fireEvent.click(screen.getByTestId("directive-run-rotate-model"));
    await screen.findByTestId("directive-sent-rotate-model");
    expect(onFlavorClick).not.toHaveBeenCalled();
    // A click on the row itself still toggles it.
    fireEvent.click(screen.getByTestId(`fleet-sidebar-agent-sensor@host`));
    expect(onFlavorClick).toHaveBeenCalledWith(AGENT_ID);
  });

  it("offers the directive trigger only with a live session that runs custom directives", () => {
    mockCustomDirectives = [sensorDirective];
    const row = agentRow()[0]!;
    const closed: FlavorSummary = {
      ...row,
      sessions: row.sessions.map((s) => ({ ...s, state: "closed" as const })),
    };
    render(<FleetPanel flavors={[closed]} />);
    expect(screen.queryByTestId(`flavor-directives-button-${AGENT_ID}`)).toBeNull();
  });

  it("hides Stop All for a flavor where every live session is observer-only", () => {
    // Pure claude-code flavor: every live session carries
    // context.supports_directives=false, so the kill switch is a
    // silent no-op and must not appear.
    const claudeCodeFlavor: FlavorSummary[] = [
      {
        flavor: "claude-code",
        agent_id: "claude-code",
        agent_type: "coding",
        session_count: 2,
        active_count: 2,
        tokens_used_total: 0,
        sessions: [
          {
            session_id: "cc1", flavor: "claude-code", agent_type: "coding",
            host: null, framework: null, model: null,
            state: "active", started_at: "", last_seen_at: "", ended_at: null,
            tokens_used: 0, token_limit: null,
            context: { supports_directives: false },
          },
          {
            session_id: "cc2", flavor: "claude-code", agent_type: "coding",
            host: null, framework: null, model: null,
            state: "idle", started_at: "", last_seen_at: "", ended_at: null,
            tokens_used: 0, token_limit: null,
            context: { supports_directives: false },
          },
        ],
      },
    ];
    render(<FleetPanel flavors={claudeCodeFlavor} />);
    expect(
      screen.queryByTestId("flavor-stop-all-button-claude-code"),
    ).not.toBeInTheDocument();
  });

  it("keeps Stop All for a mixed flavor (at least one directive-capable session)", () => {
    // Unusual but legal: one sensor-backed session, one hook-based
    // session under the same flavor name. Directive will reach the
    // sensor session; the hook-based one silently ignores it. UI
    // keeps the button because part of the cohort can still be stopped.
    const mixedFlavor: FlavorSummary[] = [
      {
        flavor: "mixed-flavor",
        agent_id: "mixed-flavor",
        agent_type: "production",
        session_count: 2,
        active_count: 2,
        tokens_used_total: 0,
        sessions: [
          {
            session_id: "m1", flavor: "mixed-flavor", agent_type: "production",
            host: null, framework: null, model: null,
            state: "active", started_at: "", last_seen_at: "", ended_at: null,
            tokens_used: 0, token_limit: null,
            // Sensor session: no supports_directives field = directive-capable.
          },
          {
            session_id: "m2", flavor: "mixed-flavor", agent_type: "production",
            host: null, framework: null, model: null,
            state: "active", started_at: "", last_seen_at: "", ended_at: null,
            tokens_used: 0, token_limit: null,
            context: { supports_directives: false },
          },
        ],
      },
    ];
    render(<FleetPanel flavors={mixedFlavor} />);
    expect(
      screen.getByTestId("flavor-stop-all-button-mixed-flavor"),
    ).toBeInTheDocument();
  });

  it("claude-code flavor row shows CODING AGENT pill, hides DEV pill", () => {
    // Specific-pill-wins rule: a claude-code flavor's developer-ness
    // is already conveyed by the CODING AGENT pill (plus the terminal
    // icon), so DEV would be redundant. The icon rule at
    // FleetPanel.tsx:550 uses the same flavor === "claude-code"
    // check, so icon and pill always flip together.
    const claudeCodeFlavor = [
      {
        flavor: "claude-code",
        agent_type: "coding",
        session_count: 1,
        active_count: 1,
        tokens_used_total: 0,
        sessions: [
          {
            session_id: "cc1", flavor: "claude-code", agent_type: "coding",
            host: null, framework: null, model: null,
            state: "active" as const, started_at: "", last_seen_at: "",
            ended_at: null, tokens_used: 0, token_limit: null,
            context: { supports_directives: false },
          },
        ],
      },
    ];
    render(<FleetPanel flavors={claudeCodeFlavor} />);
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("flavor-dev-badge")).not.toBeInTheDocument();
    // Belt and suspenders: the literal "DEV" text must not appear
    // anywhere in the claude-code row.
    expect(screen.queryByText("DEV")).not.toBeInTheDocument();
  });

  it("sensor-emitted coding agent shows Coding agent badge + Sensor client pill", () => {
    // Pill pair: agent_type=coding always flips the
    // CodingAgentBadge (no longer gated on flavor==="claude-code")
    // and the client_type pill surfaces the emitter (Sensor or
    // Claude Code). This fixture is a Python-sensor coding agent.
    const sensorCoding = [
      {
        flavor: "research-dev-agent",
        agent_type: "coding",
        session_count: 1,
        active_count: 1,
        tokens_used_total: 0,
        sessions: [
          {
            session_id: "rd1", flavor: "research-dev-agent", agent_type: "coding",
            host: null, framework: null, model: null,
            state: "active" as const, started_at: "", last_seen_at: "",
            ended_at: null, tokens_used: 0, token_limit: null,
          },
        ],
        agent_id: "11111111-1111-4111-8111-111111111111",
        agent_name: "research-dev-agent",
        client_type: "flightdeck_sensor" as const,
      },
    ];
    render(<FleetPanel flavors={sensorCoding} />);
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    expect(screen.getByTestId("flavor-client-type-pill")).toHaveTextContent(/sensor/i);
  });

  it("production agent shows no agent_type badge but still renders the client pill", () => {
    // Production autonomous-era flavors render without the
    // CodingAgentBadge (there's no equivalent "production" badge),
    // but the client_type pill still surfaces so the operator can
    // tell Sensor vs Claude Code at a glance.
    const prodSensor = [
      {
        flavor: "research-agent",
        agent_type: "production",
        session_count: 1,
        active_count: 1,
        tokens_used_total: 0,
        sessions: [
          {
            session_id: "pr1", flavor: "research-agent", agent_type: "production",
            host: null, framework: null, model: null,
            state: "active" as const, started_at: "", last_seen_at: "",
            ended_at: null, tokens_used: 0, token_limit: null,
          },
        ],
        agent_id: "22222222-2222-4222-8222-222222222222",
        agent_name: "research-agent",
        client_type: "flightdeck_sensor" as const,
      },
    ];
    render(<FleetPanel flavors={prodSensor} />);
    expect(screen.queryByTestId("coding-agent-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("flavor-client-type-pill")).toHaveTextContent(/sensor/i);
  });

  it("calls onFlavorClick when flavor name is clicked", () => {
    const onFlavorClick = vi.fn();
    render(<FleetPanel flavors={mockFlavors} onFlavorClick={onFlavorClick} />);
    fireEvent.click(screen.getByText("research-agent"));
    expect(onFlavorClick).toHaveBeenCalledWith("research-agent");
  });

  it("shows filter indicator when activeFlavorFilter is set", () => {
    render(
      <FleetPanel
        flavors={mockFlavors}
        activeFlavorFilter="research-agent"
      />
    );
    expect(screen.getByText("(filtered)")).toBeInTheDocument();
  });

  it("does not show filter indicator when no filter active", () => {
    render(<FleetPanel flavors={mockFlavors} />);
    expect(screen.queryByText("(filtered)")).not.toBeInTheDocument();
  });

  // FIX 1 -- counts must update live when flavors prop changes
  it("session counts update when flavors prop changes", () => {
    const fiveActive: FlavorSummary[] = [
      {
        flavor: "research-agent",
        agent_type: "production",
        session_count: 5,
        active_count: 5,
        tokens_used_total: 0,
        sessions: Array.from({ length: 5 }).map((_, i) => ({
          session_id: `s${i}`, flavor: "research-agent", agent_type: "production",
          host: null, framework: null, model: null, state: "active" as const,
          started_at: "", last_seen_at: "", ended_at: null, tokens_used: 0, token_limit: null,
        })),
      },
    ];
    const { rerender } = render(<FleetPanel flavors={fiveActive} />);
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("5");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("0");

    // Transition 2 of the 5 sessions to idle and re-render with new
    // flavors prop -- counts must reflect 3 active / 2 idle without
    // remounting the component.
    const twoIdle: FlavorSummary[] = [
      {
        ...fiveActive[0],
        active_count: 3,
        sessions: fiveActive[0].sessions.map((s, i) =>
          i < 2 ? { ...s, state: "idle" as const } : s,
        ),
      },
    ];
    rerender(<FleetPanel flavors={twoIdle} />);
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("3");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("2");
  });

  // CONTEXT sidebar facet panel
  it("renders CONTEXT section when at least one facet has 2+ values", () => {
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [
            { value: "kubernetes", count: 3 },
            { value: "docker", count: 1 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("fleet-panel-context")).toBeInTheDocument();
    expect(screen.getByTestId("context-facet-orchestration")).toBeInTheDocument();
    expect(
      screen.getByTestId("context-value-orchestration-kubernetes"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("context-value-orchestration-docker"),
    ).toBeInTheDocument();
  });

  it("renders curated CONTEXT keys even when they have a single value", () => {
    // Curated whitelist pattern: the sidebar CONTEXT section
    // lists the agreed-upon facet axes (os, hostname, user, git_repo,
    // orchestration) regardless of cardinality. Single-value facets
    // are informational today and become clickable filters the
    // moment a second value lands in the fleet. This replaces the
    // earlier "hide entirely when length < 2" behaviour whose
    // side-effect was that one-host / one-user deployments lost the
    // CONTEXT section entirely.
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [{ value: "kubernetes", count: 5 }],
          hostname: [{ value: "host-1", count: 5 }],
        }}
      />,
    );
    expect(screen.getByTestId("fleet-panel-context")).toBeInTheDocument();
    // Both curated keys render their single value.
    expect(screen.getByTestId("context-value-orchestration-kubernetes")).toBeInTheDocument();
    expect(screen.getByTestId("context-value-hostname-host-1")).toBeInTheDocument();
  });

  it("hides CONTEXT section when no curated key is populated", () => {
    // With the curated whitelist, a payload whose only keys are
    // noise values (pid, working_dir, frameworks, ...) renders
    // nothing -- those keys are not on the whitelist so they're
    // dropped before the length gate.
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          pid: [{ value: "1234", count: 3 }],
          working_dir: [{ value: "/tmp", count: 3 }],
        }}
      />,
    );
    expect(screen.queryByTestId("fleet-panel-context")).not.toBeInTheDocument();
  });

  it("invokes onContextFilter when a facet value is clicked", () => {
    const onContextFilter = vi.fn();
    render(
      <FleetPanel
        flavors={mockFlavors}
        contextFacets={{
          orchestration: [
            { value: "kubernetes", count: 3 },
            { value: "docker", count: 1 },
          ],
        }}
        onContextFilter={onContextFilter}
      />,
    );
    fireEvent.click(screen.getByTestId("context-value-orchestration-kubernetes"));
    expect(onContextFilter).toHaveBeenCalledWith("orchestration", "kubernetes");
  });

  it("uses sessionStateCounts prop when provided", () => {
    // When the parent passes pre-computed counts, the bar reads them
    // directly rather than re-deriving from flavors. This is the
    // path Fleet.tsx uses to lift the computation up to where the
    // flavors state lives. (FIX 1)
    render(
      <FleetPanel
        flavors={inactiveFlavors}
        sessionStateCounts={{ active: 7, idle: 1, stale: 0, closed: 0, lost: 0 }}
      />,
    );
    expect(screen.getByTestId("state-count-active")).toHaveTextContent("7");
    expect(screen.getByTestId("state-count-idle")).toHaveTextContent("1");
  });
});
