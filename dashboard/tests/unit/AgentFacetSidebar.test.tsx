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

// ---- D161 runtime-context groups ----

describe("AgentFacetSidebar — D161 runtime-context groups", () => {
  it("renders the HOSTNAME / USER / OS / ARCH / GIT BRANCH / GIT REPO / ORCHESTRATION / PYTHON / PROCESS groups when at least one agent carries a value", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            hostname: "worker-1",
            user: "alice",
            os: "Linux",
            arch: "arm64",
            git_branch: "main",
            git_repo: "flightdeck",
            orchestration: "kubernetes",
            python_version: "3.12",
            process_name: "main.py",
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    for (const suffix of [
      "hostname",
      "user",
      "os",
      "arch",
      "git_branch",
      "git_repo",
      "orchestration",
      "python_version",
      "process_name",
    ]) {
      expect(
        screen.getByTestId(`agent-filter-${suffix}-group`),
      ).toBeInTheDocument();
    }
  });

  it("hides D161 groups that no agent populates", () => {
    // Mirror the FRAMEWORK group's empty behaviour: a dimension
    // with no values across the roster collapses entirely instead
    // of rendering an empty group header. The base mkAgent has
    // hostname + user but no context fields, so the seven JSONB-
    // derived groups must all hide.
    render(
      <AgentFacetSidebar
        agents={[mkAgent({ agent_id: "a" })]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    // hostname + user populated from agent columns, so present
    expect(
      screen.getByTestId("agent-filter-hostname-group"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-filter-user-group"),
    ).toBeInTheDocument();
    // The seven JSONB-derived groups have no values and stay hidden
    for (const suffix of [
      "os",
      "arch",
      "git_branch",
      "git_repo",
      "orchestration",
      "python_version",
      "process_name",
    ]) {
      expect(
        screen.queryByTestId(`agent-filter-${suffix}-group`),
      ).not.toBeInTheDocument();
    }
  });

  it("renders each unique value once per group with the correct count", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({ agent_id: "a", os: "Linux" }),
          mkAgent({ agent_id: "b", os: "Linux" }),
          mkAgent({ agent_id: "c", os: "Darwin" }),
          mkAgent({ agent_id: "d", os: null }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    expect(
      within(screen.getByTestId("agent-filter-os-Linux")).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("agent-filter-os-Darwin")).getByText("1"),
    ).toBeInTheDocument();
    // Null OS agent never contributes a chip — no row for it
    expect(
      screen.queryByText((_, el) => el?.textContent === "—"),
    ).toBeNull();
  });

  it("clicking an OS entry toggles oss in the filter via onChange", () => {
    const onChange = vi.fn();
    render(
      <AgentFacetSidebar
        agents={[mkAgent({ agent_id: "a", os: "Linux" })]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-filter-os-Linux"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as typeof EMPTY_FILTER;
    expect(next.oss.has("Linux")).toBe(true);
  });

  it("clicking a git_branch entry toggles gitBranches in the filter via onChange", () => {
    const onChange = vi.fn();
    render(
      <AgentFacetSidebar
        agents={[mkAgent({ agent_id: "a", git_branch: "main" })]}
        filter={EMPTY_FILTER}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-filter-git_branch-main"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as typeof EMPTY_FILTER;
    expect(next.gitBranches.has("main")).toBe(true);
  });

  it("uses the shared FacetIcon (same icons as /events) for each D161 dimension", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({
            agent_id: "a",
            hostname: "worker-1",
            user: "alice",
            os: "Linux",
            arch: "arm64",
            git_branch: "main",
            git_repo: "flightdeck",
            orchestration: "kubernetes",
            python_version: "3.12",
            process_name: "main.py",
          }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    // FacetIcon emits a testid wrapper around the resolved icon —
    // its presence proves the sidebar wired the shared component
    // (so a future change to /events icon mapping flows through).
    expect(
      screen.getByTestId("agent-facet-icon-hostname-worker-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-user-alice"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("agent-facet-icon-os-Linux")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-arch-arm64"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-git_branch-main"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-git_repo-flightdeck"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-orchestration-kubernetes"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-python_version-3.12"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-facet-icon-process_name-main.py"),
    ).toBeInTheDocument();
  });

  it("sorts D161 values by descending count then ascending value", () => {
    render(
      <AgentFacetSidebar
        agents={[
          mkAgent({ agent_id: "a", git_branch: "main" }),
          mkAgent({ agent_id: "b", git_branch: "main" }),
          mkAgent({ agent_id: "c", git_branch: "feature-z" }),
          mkAgent({ agent_id: "d", git_branch: "alpha" }),
        ]}
        filter={EMPTY_FILTER}
        onChange={vi.fn()}
      />,
    );
    // main (2) first; alpha + feature-z tied at 1 → sorted by value asc.
    const group = screen.getByTestId("agent-filter-git_branch-group");
    const rows = within(group).getAllByRole("button");
    expect(rows[0]!.getAttribute("data-testid")).toBe(
      "agent-filter-git_branch-main",
    );
    expect(rows[1]!.getAttribute("data-testid")).toBe(
      "agent-filter-git_branch-alpha",
    );
    expect(rows[2]!.getAttribute("data-testid")).toBe(
      "agent-filter-git_branch-feature-z",
    );
  });
});
