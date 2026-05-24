import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "@/components/search/CommandPalette";
import { buildSearchResultHref } from "@/App";
import type {
  SearchResultAgent,
  SearchResultEvent,
  SearchResultSession,
  SearchResults,
} from "@/lib/types";
import { parseEventsUrlState } from "@/pages/Investigate";

// Mock the search hook so the palette renders deterministic results
// without hitting the network. A single test toggles the fixture via
// ``setFixture``; default is no results.
let searchFixture: SearchResults = { agents: [], sessions: [], events: [] };
vi.mock("@/hooks/useSearch", () => ({
  useSearch: () => ({
    results: searchFixture,
    loading: false,
    error: null,
  }),
}));

// Mock RecentAgents so the empty-state path doesn't try to fetch
// real /v1/agents data in these click-routing tests.
vi.mock("@/components/search/RecentAgents", () => ({
  RecentAgents: () => <div data-testid="recent-agents-stub" />,
}));

function agent(
  agentName: string,
  agentId = "11111111-2222-3333-4444-555555555555",
): SearchResultAgent {
  return {
    agent_id: agentId,
    agent_name: agentName,
    agent_type: "coding",
    client_type: "claude_code",
    state: "active",
    last_seen: "2026-04-17T09:00:00Z",
  };
}

function session(id: string, flavor: string): SearchResultSession {
  return {
    session_id: id,
    flavor,
    host: "h",
    state: "active",
    started_at: "2026-04-17T09:00:00Z",
    ended_at: null,
    model: "claude-sonnet-4-6",
    tokens_used: 0,
    token_limit: null,
    context: {},
  };
}

function event(eventId: string, sessionId: string): SearchResultEvent {
  return {
    event_id: eventId,
    session_id: sessionId,
    event_type: "post_call",
    tool_name: "",
    model: "claude-sonnet-4-6",
    occurred_at: "2026-04-17T09:00:00Z",
  };
}

// ---------------------------------------------------------------
// buildSearchResultHref — the pure routing helper
//
// New D supersedes F2: agent and event hits open overlay drawers
// via URL params on the current route, so the navigate path is
// only the session branch. The helper still returns hrefs for the
// other two types so deep-link / bookmark callers have one
// canonical place to read the param shape.
// ---------------------------------------------------------------

describe("buildSearchResultHref", () => {
  it("session click navigates to /events?run=<id>", () => {
    const href = buildSearchResultHref("session", session("abc-123", "claude-code"));
    expect(href).toBe("/events?run=abc-123");
    const sp = new URL("http://x" + href).searchParams;
    expect(parseEventsUrlState(sp).run).toBe("abc-123");
  });

  it("agent helper returns a relative ?agent_drawer=<uuid> for deep links", () => {
    const href = buildSearchResultHref(
      "agent",
      agent("claude-code", "deadbeef-1234-5678-9abc-def012345678"),
    );
    expect(href).toBe("?agent_drawer=deadbeef-1234-5678-9abc-def012345678");
  });

  it("event helper returns ?event=&event_session= (distinct from ?run=)", () => {
    const href = buildSearchResultHref(
      "event",
      event("e1-aaaa-bbbb-cccc-dddd", "s1-aaaa-bbbb-cccc-dddd"),
    );
    expect(href).toBe(
      "?event=e1-aaaa-bbbb-cccc-dddd&event_session=s1-aaaa-bbbb-cccc-dddd",
    );
    // Critical: the event helper must NOT emit ?run= — that param
    // opens the run drawer and would stack two drawers.
    expect(href).not.toContain("run=");
  });
});

// ---------------------------------------------------------------
// CommandPalette integration — click + keyboard Enter
// ---------------------------------------------------------------

describe("CommandPalette result click routing", () => {
  it("agent row click fires onSelectResult then closes the modal", () => {
    searchFixture = {
      agents: [agent("claude-code"), agent("research-agent")],
      sessions: [],
      events: [],
    };
    const onSelectResult = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        onSelectResult={onSelectResult}
      />,
    );
    fireEvent.click(screen.getByText("claude-code"));
    expect(onSelectResult).toHaveBeenCalledTimes(1);
    expect(onSelectResult.mock.calls[0][0]).toBe("agent");
    expect(
      (onSelectResult.mock.calls[0][1] as SearchResultAgent).agent_name,
    ).toBe("claude-code");
    // Modal-close side effect from handleSelect -> onOpenChange(false).
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("session row click fires onSelectResult with the session item", () => {
    searchFixture = {
      agents: [],
      sessions: [session("sess-abc", "claude-code")],
      events: [],
    };
    const onSelectResult = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        onSelectResult={onSelectResult}
      />,
    );
    // SessionRow truncates the session_id; click whatever's rendered.
    fireEvent.click(
      screen.getByRole("option", { name: /sess-abc/i }),
    );
    expect(onSelectResult).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({ session_id: "sess-abc" }),
    );
  });

  it("event row click fires onSelectResult with type=event", () => {
    searchFixture = {
      agents: [],
      sessions: [],
      events: [event("evt-1", "sess-xyz")],
    };
    const onSelectResult = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        onSelectResult={onSelectResult}
      />,
    );
    const eventRow = screen.getAllByRole("option")[0];
    fireEvent.click(eventRow);
    expect(onSelectResult).toHaveBeenCalledWith(
      "event",
      expect.objectContaining({ event_id: "evt-1", session_id: "sess-xyz" }),
    );
  });

  it("keyboard Enter on the focused row has the same effect as click", () => {
    // One result, auto-focused at index 0. Enter triggers handleSelect
    // via the same path as onClick -- one handler, two triggers.
    searchFixture = {
      agents: [agent("claude-code")],
      sessions: [],
      events: [],
    };
    const onSelectResult = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        onSelectResult={onSelectResult}
      />,
    );
    // Fire Enter on the dialog content -- keydown bubbles from
    // wherever the focus is. The palette's onKeyDown handler reads
    // the focused index (0) and dispatches.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onSelectResult).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ agent_name: "claude-code" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------
// Events page ?run= URL round-trip
// ---------------------------------------------------------------

describe("Events page parseEventsUrlState `run` param", () => {
  it("reads ?run= into state.run", () => {
    const sp = new URLSearchParams("run=abc-123");
    expect(parseEventsUrlState(sp).run).toBe("abc-123");
  });

  it("defaults to empty string when absent", () => {
    expect(parseEventsUrlState(new URLSearchParams()).run).toBe("");
  });
});
