import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Investigate } from "@/pages/Investigate";
import { fetchBulkEvents } from "@/lib/api";
import { useFleetStore } from "@/store/fleet";
import { ClientType } from "@/lib/agent-identity";
import type {
  AgentEvent,
  EventFacets,
  BulkEventsResponse,
} from "@/lib/types";

const h = vi.hoisted(() => {
  const emptyFacets: EventFacets = {
    event_type: [],
    model: [],
    framework: [],
    agent_id: [],
    error_type: [],
    close_reason: [],
    estimated_via: [],
    matched_entry_id: [],
    originating_call_context: [],
    mcp_server: [],
    terminal: [],
  };
  return {
    events: {
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
      has_more: false,
    } as BulkEventsResponse,
    facets: emptyFacets,
  };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBulkEvents: vi.fn(async () => h.events),
    fetchEventFacets: vi.fn(async () => h.facets),
  };
});

function mkEvent(id: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    session_id: `sess-${id}`,
    flavor: "agent-1",
    event_type: "post_call",
    model: "claude-sonnet-4-6",
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: "langchain",
    client_type: ClientType.ClaudeCode,
    agent_type: "coding",
    occurred_at: "2026-05-15T12:00:00Z",
    ...overrides,
  };
}

async function renderPage() {
  useFleetStore.setState({
    agents: [
      {
        agent_id: "agent-1",
        agent_name: "checkout-bot",
        agent_type: "coding",
        client_type: ClientType.ClaudeCode,
        user: "u",
        hostname: "h",
        first_seen_at: "2026-05-01T00:00:00Z",
        last_seen_at: "2026-05-15T12:00:00Z",
        total_sessions: 1,
        total_tokens: 0,
        state: "active",
        topology: "lone",
      },
    ],
  });
  const result = render(
    <MemoryRouter initialEntries={["/events"]}>
      <Investigate />
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
}

describe("Investigate (event-grain /events page)", () => {
  beforeEach(() => {
    h.events = { events: [], total: 0, limit: 50, offset: 0, has_more: false };
    h.facets = {
      event_type: [],
      model: [],
      framework: [],
      agent_id: [],
      error_type: [],
      close_reason: [],
      estimated_via: [],
      matched_entry_id: [],
      originating_call_context: [],
      mcp_server: [],
      terminal: [],
    };
  });

  it("mounts the event table and facet sidebar", async () => {
    await renderPage();
    expect(screen.getByTestId("events-page")).toBeInTheDocument();
    expect(screen.getByTestId("events-table")).toBeInTheDocument();
    expect(screen.getByTestId("investigate-sidebar")).toBeInTheDocument();
  });

  it("renders one row per fetched event", async () => {
    h.events = {
      events: [mkEvent("e1"), mkEvent("e2")],
      total: 2,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    expect(screen.getAllByTestId("events-row")).toHaveLength(2);
    expect(
      screen.getAllByTestId("events-row-run-badge"),
    ).toHaveLength(2);
  });

  it("shows the empty state when no events match", async () => {
    await renderPage();
    expect(screen.getByTestId("events-table-empty")).toBeInTheDocument();
  });

  it("renders a facet group for a server-returned dimension", async () => {
    h.facets = {
      ...h.facets,
      event_type: [{ value: "post_call", count: 3 }],
    };
    await renderPage();
    expect(
      screen.getByTestId("events-facet-event_type"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("events-facet-pill-event_type-post_call"),
    ).toBeInTheDocument();
  });

  // Polish Batch 2 Fix 1 — the facet sidebar gives every dimension
  // a leading icon. The MODEL chip carries a FacetIcon-wrapped
  // provider logo and the ERROR TYPE chip carries a lucide glyph,
  // both under the events-facet-icon-<key>-<value> testid.
  it("renders a FacetIcon on the MODEL and ERROR TYPE facet chips", async () => {
    h.facets = {
      ...h.facets,
      model: [{ value: "claude-sonnet-4-5", count: 4 }],
      error_type: [{ value: "rate_limit", count: 2 }],
    };
    await renderPage();
    expect(
      screen.getByTestId("events-facet-icon-model-claude-sonnet-4-5"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("events-facet-icon-error_type-rate_limit"),
    ).toBeInTheDocument();
  });

  // The FRAMEWORK chip renders a FrameworkPill (not a FacetIcon
  // glyph) — Fix 1 routes the framework dimension to the pill so it
  // matches the event row's MODEL-cell chrome.
  it("renders a FrameworkPill on the FRAMEWORK facet chip", async () => {
    h.facets = {
      ...h.facets,
      framework: [{ value: "langchain", count: 5 }],
    };
    await renderPage();
    expect(
      screen.getByTestId("events-facet-framework-pill-langchain"),
    ).toBeInTheDocument();
  });

  it("opens the event detail drawer on a row click", async () => {
    h.events = {
      events: [mkEvent("e1")],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    fireEvent.click(screen.getByTestId("events-row"));
    expect(
      screen.getByTestId("event-detail-drawer"),
    ).toBeInTheDocument();
  });

  it("renders pagination with next enabled when more pages exist", async () => {
    h.events = {
      events: [mkEvent("e1")],
      total: 100,
      limit: 50,
      offset: 0,
      has_more: true,
    };
    await renderPage();
    expect(screen.getByTestId("pagination-range")).toHaveTextContent(
      "of 100 events",
    );
    expect(screen.getByTestId("pagination-next")).not.toBeDisabled();
    expect(screen.getByTestId("pagination-prev")).toBeDisabled();
  });

  it("renders the session identity enrichment on an LLM event row", async () => {
    h.events = {
      events: [mkEvent("e1")],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    // AGENT cell — client_type pill + agent_type badge.
    expect(screen.getByTestId("events-row-client-pill")).toBeInTheDocument();
    expect(screen.getByTestId("events-row-agent-type")).toBeInTheDocument();
    // MODEL cell — provider logo + framework pill (LLM event).
    expect(
      screen.getByTestId("events-row-provider-logo"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("events-row-framework")).toBeInTheDocument();
  });

  it("shows the prompt-capture indicator only for has_content events", async () => {
    h.events = {
      events: [
        mkEvent("captured", { has_content: true }),
        mkEvent("bare", { has_content: false }),
      ],
      total: 2,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    // One indicator, on the captured row only.
    expect(
      screen.getAllByTestId("events-row-capture-indicator"),
    ).toHaveLength(1);
  });

  it("omits the provider/framework cluster for a non-LLM event but keeps the identity chrome", async () => {
    h.events = {
      events: [mkEvent("tool", { event_type: "tool_call", model: null })],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    // No model -> no provider logo, no framework pill.
    expect(
      screen.queryByTestId("events-row-provider-logo"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("events-row-framework"),
    ).not.toBeInTheDocument();
    // client_type / agent_type are session-scoped — still rendered.
    expect(screen.getByTestId("events-row-client-pill")).toBeInTheDocument();
    expect(screen.getByTestId("events-row-agent-type")).toBeInTheDocument();
  });

  it("renders no client_type pill and no agent_type badge when identity fields are null", async () => {
    h.events = {
      events: [mkEvent("anon", { agent_type: null, client_type: null })],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    // null identity values fail the isClientType / isAgentType guards
    // — the chrome is omitted rather than rendered blank.
    expect(
      screen.queryByTestId("events-row-agent-type"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("events-row-client-pill"),
    ).not.toBeInTheDocument();
    // The row itself still renders — flavor + run badge are unaffected.
    expect(screen.getByTestId("events-row")).toBeInTheDocument();
  });

  it("debounces the search box and fetches events carrying the typed q", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderPage();
      vi.mocked(fetchBulkEvents).mockClear();

      // Type a query string into the top-of-page search input.
      const input = screen.getByTestId("events-search-input");
      fireEvent.change(input, { target: { value: "checkout" } });

      // Before the debounce window elapses, no q-bearing fetch yet.
      expect(fetchBulkEvents).not.toHaveBeenCalled();

      // Advance past the 300 ms debounce — the URL `q` state updates,
      // which re-triggers doFetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // The most recent fetch carries the typed q in its params.
      expect(fetchBulkEvents).toHaveBeenCalled();
      const lastCall = vi.mocked(fetchBulkEvents).mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ q: "checkout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the prompt-capture indicator on a non-LLM event with captured content", async () => {
    h.events = {
      events: [
        mkEvent("mcp", {
          event_type: "mcp_tool_call",
          model: null,
          has_content: true,
        }),
      ],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    };
    await renderPage();
    // The capture indicator is a row-level affordance — it shows for
    // a has_content event of any type, not just LLM calls.
    expect(
      screen.getByTestId("events-row-capture-indicator"),
    ).toBeInTheDocument();
    // No model -> no provider cluster.
    expect(
      screen.queryByTestId("events-row-provider-logo"),
    ).not.toBeInTheDocument();
  });
});
