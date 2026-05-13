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
import { parseUrlState } from "@/pages/Investigate";

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

function agent(
  agentName: string,
  agentId = "11111111-2222-3333-4444-555555555555",
): SearchResultAgent {
  return {
    agent_id: agentId,
    agent_name: agentName,
    agent_type: "coding",
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
// buildSearchResultHref -- the pure routing function
// ---------------------------------------------------------------

describe("buildSearchResultHref", () => {
  it("agent click routes to ?agent_id=<uuid> (F2)", () => {
    // F2: agent search clicks now route on agent_id, not
    // flavor=agent_name. Sensor-keyed agents whose agent_name is
    // ``user@hostname`` never matched any session.flavor; agent_id
    // resolves correctly via the D115 filter.
    const href = buildSearchResultHref(
      "agent",
      agent("claude-code", "deadbeef-1234-5678-9abc-def012345678"),
    );
    expect(href).toBe("/events?agent_id=deadbeef-1234-5678-9abc-def012345678");
    const sp = new URL("http://x" + href).searchParams;
    expect(parseUrlState(sp).agentId).toBe("deadbeef-1234-5678-9abc-def012345678");
  });

  it("session click sets ?session=<id>", () => {
    const href = buildSearchResultHref("session", session("abc-123", "claude-code"));
    expect(href).toBe("/events?session=abc-123");
    const sp = new URL("http://x" + href).searchParams;
    expect(parseUrlState(sp).session).toBe("abc-123");
  });

  it("event click routes to the parent session's drawer", () => {
    // Per-event deep-link (directEventDetail) is a separate follow-up.
    // For now, event results open the parent session at the timeline,
    // which is the "no dead UI" behaviour called out in the brief.
    const href = buildSearchResultHref("event", event("e1", "s1"));
    expect(href).toBe("/events?session=s1");
  });

  it("URL-encodes special characters in the agent_id (F2)", () => {
    const href = buildSearchResultHref(
      "agent",
      agent("any-name", "id with/slash"),
    );
    expect(href).toBe("/events?agent_id=id%20with%2Fslash");
  });
});

// ---------------------------------------------------------------
// CommandPalette integration -- click + keyboard Enter
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
// Investigate ?session= URL round-trip
// ---------------------------------------------------------------

describe("Investigate parseUrlState `session` param", () => {
  it("reads ?session= into state.session", () => {
    const sp = new URLSearchParams("session=abc-123");
    expect(parseUrlState(sp).session).toBe("abc-123");
  });

  it("defaults to empty string when absent", () => {
    expect(parseUrlState(new URLSearchParams()).session).toBe("");
  });
});
