import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentFilterChips } from "@/components/agents/AgentFilterChips";
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

describe("AgentFilterChips", () => {
  it("renders every state chip", () => {
    const onChange = vi.fn();
    render(
      <AgentFilterChips
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    for (const s of ["active", "idle", "stale", "lost", "closed"]) {
      expect(screen.getByTestId(`agent-filter-state-${s}`)).toBeInTheDocument();
    }
  });

  it("toggles active flag + fires onChange when a state chip is clicked", () => {
    const onChange = vi.fn();
    render(
      <AgentFilterChips
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

  it("renders the active chip styled via data-active", () => {
    const onChange = vi.fn();
    render(
      <AgentFilterChips
        agents={[mkAgent()]}
        filter={{ ...EMPTY_FILTER, states: new Set(["active"]) }}
        onChange={onChange}
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
    const onChange = vi.fn();
    render(
      <AgentFilterChips
        agents={[mkAgent()]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("agent-filter-framework-group")).toBeNull();
  });

  it("renders a framework chip per distinct recent-session framework", () => {
    const onChange = vi.fn();
    render(
      <AgentFilterChips
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
        onChange={onChange}
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

  it("toggles a framework into the filter set when its chip is clicked", () => {
    const onChange = vi.fn();
    render(
      <AgentFilterChips
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
});
