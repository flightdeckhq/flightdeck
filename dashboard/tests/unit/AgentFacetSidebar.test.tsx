import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AgentFacetSidebar } from "@/components/agents/AgentFacetSidebar";
import { EMPTY_FILTER } from "@/lib/agents-filter";
import { ClientType } from "@/lib/agent-identity";
import type { AgentSummary, RecentSession } from "@/lib/types";

function mkRecentSession(framework: string | null): RecentSession {
  return {
    session_id: "s",
    flavor: "f",
    agent_type: "coding",
    state: "closed",
    started_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    tokens_used: 0,
    capture_enabled: false,
    framework,
  };
}

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: "a",
    agent_name: "a",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

describe("AgentFacetSidebar", () => {
  it("renders the sidebar container", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("agents-facet-sidebar")).toBeInTheDocument();
  });

  it("renders the STATE, AGENT TYPE and CLIENT facet groups", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("agent-filter-state-group"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-agent-type-group"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-client-type-group"),
    ).toBeInTheDocument();
  });

  it("renders every state entry", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    for (const s of ["active", "idle", "stale", "lost", "closed"]) {
      expect(
        screen.getByTestId(`agent-filter-state-${s}`),
      ).toBeInTheDocument();
    }
  });

  it("renders the agent-type and client-type entries", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("agent-filter-agent-type-coding"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-agent-type-production"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-client-type-claude_code"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-client-type-flightdeck_sensor"),
    ).toBeInTheDocument();
  });

  it("renders a per-chip icon testid for every facet dimension", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            state: "active",
            agent_type: "coding",
            client_type: ClientType.ClaudeCode,
            recent_sessions: [mkRecentSession("langchain")],
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    // Each chip carries its dimension's icon/pill under an
    // agent-facet-icon-<dimension>-<value> testid — the prop the
    // FacetEntry threads into FacetIcon / AgentTypeBadge /
    // ClientTypePill / FrameworkPill. E2E T90 asserts the same on
    // the live page; this is the fast-feedback unit guard.
    for (const sel of [
      "agent-facet-icon-state-active",
      "agent-facet-icon-agent_type-coding",
      "agent-facet-icon-client_type-claude_code",
      "agent-facet-icon-framework-langchain",
    ]) {
      expect(
        document.querySelector(`[data-testid="${sel}"]`),
        `${sel} must be emitted`,
      ).not.toBeNull();
    }
  });

  it("shows an absolute per-value count on each entry", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({ agent_id: "a", state: "active" }),
          mkAgent({ agent_id: "b", state: "active" }),
          mkAgent({ agent_id: "c", state: "closed" }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      within(screen.getByTestId("agent-filter-state-active")).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("agent-filter-state-closed")).getByText("1"),
    ).toBeInTheDocument();
    // No agent is idle — the entry still renders with a zero count.
    expect(
      within(screen.getByTestId("agent-filter-state-idle")).getByText("0"),
    ).toBeInTheDocument();
  });

  it("fires onChange and toggles the value when a state entry is clicked", () => {
    const onChange = vi.fn();
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-filter-state-active"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as typeof EMPTY_FILTER;
    expect(next.states.has("active")).toBe(true);
  });

  it("reflects the active selection via data-active", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={{ ...EMPTY_FILTER, states: new Set(["active"]) }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("agent-filter-state-active")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("agent-filter-state-idle")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("hides the framework group when no agent declares a framework", () => {
    render(
      <AgentFacetSidebar
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("agent-filter-framework-group")).toBeNull();
  });

  it("renders a framework entry per distinct recent-session framework", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            recent_sessions: [mkRecentSession("langchain")],
          }),
          mkAgent({
            agent_id: "b",
            recent_sessions: [
              mkRecentSession("crewai"),
              mkRecentSession(null),
            ],
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("agent-filter-framework-group"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-framework-crewai"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-framework-langchain"),
    ).toBeInTheDocument();
  });

  it("toggles a framework into the filter set when its entry is clicked", () => {
    const onChange = vi.fn();
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            recent_sessions: [mkRecentSession("langgraph")],
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-filter-framework-langgraph"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as typeof EMPTY_FILTER;
    expect(next.frameworks.has("langgraph")).toBe(true);
  });

  it("counts a framework once per agent that carries it", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            recent_sessions: [
              mkRecentSession("langchain"),
              mkRecentSession("langchain"),
            ],
          }),
          mkAgent({
            agent_id: "b",
            recent_sessions: [mkRecentSession("langchain")],
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      within(
        screen.getByTestId("agent-filter-framework-langchain"),
      ).getByText("2"),
    ).toBeInTheDocument();
  });
});
