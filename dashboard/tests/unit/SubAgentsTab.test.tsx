import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentEvent, Session, SessionListItem, SubagentMessage } from "@/lib/types";

// D126 § 7.fix.K — SubAgentsTab unit suite. Covers the three case
// shapes (parent only, child only, depth-2), the per-child MESSAGES
// preview lifecycle (200-char preview + expand-on-click for inline,
// fetch via /v1/events/{id}/content for D126 § 6 overflow), the
// capture_prompts=false disabled state (Rule 21), and the drawer
// rebind via onSwitchSession.

const fetchSessionsMock = vi.fn();
const fetchSessionMock = vi.fn();
const fetchEventContentMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchSessions: (...args: unknown[]) => fetchSessionsMock(...args),
  fetchSession: (...args: unknown[]) => fetchSessionMock(...args),
  fetchEventContent: (...args: unknown[]) => fetchEventContentMock(...args),
}));

import { SubAgentsTab } from "@/components/session/SubAgentsTab";

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: overrides.session_id ?? "sess-1",
    flavor: overrides.flavor ?? "test",
    agent_type: overrides.agent_type ?? "production",
    host: null,
    framework: null,
    model: null,
    state: overrides.state ?? "active",
    started_at: "2026-05-03T00:00:00Z",
    last_seen_at: "2026-05-03T00:01:00Z",
    ended_at: null,
    tokens_used: overrides.tokens_used ?? 0,
    token_limit: null,
    capture_enabled: overrides.capture_enabled,
    parent_session_id: overrides.parent_session_id,
    agent_role: overrides.agent_role,
  };
}

function mkChild(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: overrides.session_id ?? "child-1",
    flavor: "child-flavor",
    agent_type: "production",
    host: null,
    model: null,
    state: overrides.state ?? "closed",
    started_at: "2026-05-03T00:00:00Z",
    ended_at: null,
    last_seen_at: "2026-05-03T00:00:30Z",
    duration_s: 30,
    tokens_used: 100,
    token_limit: null,
    context: {},
    agent_role: overrides.agent_role,
    parent_session_id: overrides.parent_session_id,
  };
}

function renderTab(props: {
  session: Session;
  events?: AgentEvent[];
  onOpenSession?: (id: string) => void;
}) {
  return render(
    <MemoryRouter>
      <SubAgentsTab
        session={props.session}
        events={props.events ?? []}
        onOpenSession={props.onOpenSession ?? (() => {})}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchSessionsMock.mockReset();
  fetchSessionMock.mockReset();
  fetchEventContentMock.mockReset();
  // Default: no children, no parent. Tests override per case.
  fetchSessionsMock.mockResolvedValue({
    sessions: [],
    total: 0,
    limit: 100,
    offset: 0,
    has_more: false,
  });
  fetchSessionMock.mockResolvedValue({
    session: null,
    events: [],
  });
  fetchEventContentMock.mockResolvedValue(null);
});

describe("SubAgentsTab — three layout cases (D126 § 4.2)", () => {
  it("Parent only: renders SUB-AGENTS but NOT SPAWNED FROM", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "c-1", agent_role: "Researcher" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    renderTab({ session: mkSession({ session_id: "p-1" }) });
    await waitFor(() =>
      expect(screen.getByTestId("sub-agents-children")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sub-agents-spawned-from")).toBeNull();
  });

  it("Child only: renders SPAWNED FROM but NOT SUB-AGENTS section", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({
        session_id: "p-1",
        flavor: "parent",
      }),
      events: [],
    });
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        agent_role: "Researcher",
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("sub-agents-spawned-from")).toBeTruthy(),
    );
    // SUB-AGENTS section should not render — fetchSessions returned
    // an empty children list, the section returns null in that case.
    expect(screen.queryByTestId("sub-agents-children")).toBeNull();
  });

  it("Depth-2 (child + parent): renders BOTH sections, SPAWNED FROM on top", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "grandparent" }),
      events: [],
    });
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "gc-1", agent_role: "Writer" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    const { container } = renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        agent_role: "Researcher",
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("sub-agents-spawned-from")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sub-agents-children")).toBeTruthy(),
    );
    // SPAWNED FROM precedes SUB-AGENTS in the rendered DOM order
    // so the "you came from above" reading flows top-to-bottom.
    const spawnedFromEl = screen.getByTestId("sub-agents-spawned-from");
    const childrenEl = screen.getByTestId("sub-agents-children");
    expect(
      container.contains(spawnedFromEl) && container.contains(childrenEl),
    ).toBe(true);
    expect(
      spawnedFromEl.compareDocumentPosition(childrenEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("Lone session (no parent, no children): SubAgentsTab renders empty (gating moved to parent drawer)", async () => {
    renderTab({ session: mkSession({ session_id: "lone-1" }) });
    // Tab renders neither section because: no parent → no SPAWNED
    // FROM; fetchSessions returns no children → SUB-AGENTS section
    // hides via its null-return branch.
    await waitFor(() =>
      expect(screen.queryByTestId("sub-agents-children")).toBeNull(),
    );
    expect(screen.queryByTestId("sub-agents-spawned-from")).toBeNull();
  });
});

describe("SubAgentsTab — MESSAGES preview", () => {
  // session_start carrying an inline incoming_message + session_end
  // carrying an inline outgoing_message. The 200-char truncation
  // applies to the rendered preview body.
  function mkEvents(opts: {
    incomingMessage?: SubagentMessage;
    outgoingMessage?: SubagentMessage;
  }): AgentEvent[] {
    return [
      {
        id: "evt-start",
        session_id: "c-1",
        flavor: "test",
        event_type: "session_start",
        model: null,
        tokens_input: null,
        tokens_output: null,
        tokens_total: null,
        latency_ms: null,
        tool_name: null,
        has_content: false,
        payload: {
          incoming_message: opts.incomingMessage,
        },
        occurred_at: "2026-05-03T00:00:00Z",
      },
      {
        id: "evt-end",
        session_id: "c-1",
        flavor: "test",
        event_type: "session_end",
        model: null,
        tokens_input: null,
        tokens_output: null,
        tokens_total: null,
        latency_ms: null,
        tool_name: null,
        has_content: false,
        payload: {
          outgoing_message: opts.outgoingMessage,
        },
        occurred_at: "2026-05-03T00:01:00Z",
      },
    ];
  }

  it("inline INPUT preview surfaces own session_start incoming_message (200-char truncation)", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    const longBody = "x".repeat(500);
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        capture_enabled: true,
      }),
      events: mkEvents({
        incomingMessage: { body: longBody, captured_at: "" },
      }),
    });
    // Per the D126 UX revision, message previews render INSIDE the
    // chevron-expanded body. Expand the SPAWNED FROM card first.
    const cardToggle = await screen.findByTestId(
      "sub-agents-spawned-from-toggle",
    );
    fireEvent.click(cardToggle);
    await waitFor(() =>
      expect(screen.getByTestId("sub-agents-own-input")).toBeTruthy(),
    );
    const input = screen.getByTestId("sub-agents-own-input");
    // The collapsed preview shows the first 200 characters.
    expect(input.textContent).toContain("x".repeat(200));
    // Expand button is present because the body exceeds the
    // preview length.
    expect(screen.getByTestId("sub-agents-own-input-expand")).toBeTruthy();
  });

  it("expand-on-click reveals the full inline body without an extra fetch", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    const longBody = "abcdefg".repeat(50); // 350 chars, > 200
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        capture_enabled: true,
      }),
      events: mkEvents({
        incomingMessage: { body: longBody, captured_at: "" },
      }),
    });
    // Two-step expansion: card chevron, then message-level expand.
    fireEvent.click(
      await screen.findByTestId("sub-agents-spawned-from-toggle"),
    );
    const expandBtn = await screen.findByTestId("sub-agents-own-input-expand");
    fireEvent.click(expandBtn);
    // Inline body fully visible after expand; fetchEventContent
    // must NOT be called for has_content=false bodies.
    await waitFor(() => {
      expect(screen.getByTestId("sub-agents-own-input").textContent).toContain(longBody);
    });
    expect(fetchEventContentMock).not.toHaveBeenCalled();
  });

  it("overflow body (has_content=true) lazy-fetches /v1/events/{id}/content on expand", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    fetchEventContentMock.mockResolvedValue({
      event_id: "evt-start",
      session_id: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      system_prompt: null,
      messages: null,
      tools: null,
      response: null,
      input: "OVERFLOW BODY CONTENT FROM EVENT_CONTENT TABLE",
      captured_at: "2026-05-03T00:00:01Z",
    });
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        capture_enabled: true,
      }),
      events: mkEvents({
        incomingMessage: { has_content: true, content_bytes: 9000, captured_at: "" },
      }),
    });
    fireEvent.click(
      await screen.findByTestId("sub-agents-spawned-from-toggle"),
    );
    const expandBtn = await screen.findByTestId("sub-agents-own-input-expand");
    fireEvent.click(expandBtn);
    await waitFor(() => {
      expect(fetchEventContentMock).toHaveBeenCalledWith("evt-start");
    });
    await waitFor(() => {
      expect(screen.getByTestId("sub-agents-own-input").textContent).toContain(
        "OVERFLOW BODY CONTENT FROM EVENT_CONTENT TABLE",
      );
    });
  });

  it("capture_prompts=false AND no message bodies renders Rule 21 disabled state", async () => {
    // SubAgentsTab's capture-enabled gate fires when EITHER the
    // API flag is true OR the session's events carry an inline
    // message body (D126 § 6 — sub-agent messages bypass the
    // existing has_content=true convention used for LLM prompts).
    // A user with capture_prompts=false produces no message body;
    // both conditions are false → the Rule 21 disabled state
    // surfaces. The fixture below builds that scenario by passing
    // events without an incoming_message payload.
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
        capture_enabled: false,
      }),
      events: mkEvents({}), // no incoming/outgoing message
    });
    // Capture-off disabled state lives inside the chevron-expanded
    // body per the UX revision (alongside metrics + mini-timeline);
    // expand the card first to assert it's visible.
    fireEvent.click(
      await screen.findByTestId("sub-agents-spawned-from-toggle"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-spawned-from").textContent,
      ).toContain("Prompt capture is not enabled"),
    );
    expect(screen.queryByTestId("sub-agents-own-input")).toBeNull();
  });

  it("per-child INPUT/OUTPUT renders on expand (parent-side)", async () => {
    // Per-child detail expansion fires fetchSession({child_id}) →
    // returns the child's session_start / session_end events with
    // incoming/outgoing messages.
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "c-1", agent_role: "Researcher" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "c-1", capture_enabled: true }),
      events: [
        {
          id: "child-start",
          session_id: "c-1",
          flavor: "child",
          event_type: "session_start",
          model: null,
          tokens_input: null,
          tokens_output: null,
          tokens_total: null,
          latency_ms: null,
          tool_name: null,
          has_content: false,
          payload: {
            incoming_message: {
              body: "do the research",
              captured_at: "",
            },
          },
          occurred_at: "2026-05-03T00:00:00Z",
        },
        {
          id: "child-end",
          session_id: "c-1",
          flavor: "child",
          event_type: "session_end",
          model: null,
          tokens_input: null,
          tokens_output: null,
          tokens_total: null,
          latency_ms: null,
          tool_name: null,
          has_content: false,
          payload: {
            outgoing_message: {
              body: "found the answer",
              captured_at: "",
            },
          },
          occurred_at: "2026-05-03T00:01:00Z",
        },
      ],
    });
    renderTab({
      session: mkSession({ session_id: "p-1", capture_enabled: true }),
    });
    const toggleBtn = await screen.findByTestId(
      "sub-agents-child-toggle-c-1",
    );
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      expect(screen.getByTestId("sub-agents-child-input-c-1")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("sub-agents-child-output-c-1")).toBeTruthy();
    });
    expect(
      screen.getByTestId("sub-agents-child-input-c-1").textContent,
    ).toContain("do the research");
    expect(
      screen.getByTestId("sub-agents-child-output-c-1").textContent,
    ).toContain("found the answer");
  });
});

describe("SubAgentsTab — drawer rebind via onSwitchSession", () => {
  it("clicking the SPAWNED FROM card invokes onOpenSession with the parent id", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    const onOpenSession = vi.fn();
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
      }),
      onOpenSession,
    });
    const link = await screen.findByTestId("sub-agents-spawned-from-link");
    fireEvent.click(link);
    expect(onOpenSession).toHaveBeenCalledWith("p-1");
  });

  it("clicking a child row's session id link invokes onOpenSession with the child id", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "c-99" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    const onOpenSession = vi.fn();
    renderTab({
      session: mkSession({ session_id: "p-1" }),
      onOpenSession,
    });
    const childLink = await screen.findByTestId("sub-agents-child-open-c-99");
    fireEvent.click(childLink);
    expect(onOpenSession).toHaveBeenCalledWith("c-99");
  });
});

// D126 UX revision (post-merge polish, pre-merge land):
// chevron-expand-inline + session-id-link-navigate split. The
// chevron and the session-id link are independent affordances —
// clicking one does NOT invoke the other's behaviour. Inline
// expansion shows summary metrics + mini-timeline + IN/OUT
// messages so the user can see what the related session did
// without leaving the parent's drawer.
describe("SubAgentsTab — UX revision: chevron-expand-inline split", () => {
  it("SPAWNED FROM chevron click toggles expansion WITHOUT invoking onOpenSession", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    const onOpenSession = vi.fn();
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
      }),
      onOpenSession,
    });
    const toggle = await screen.findByTestId(
      "sub-agents-spawned-from-toggle",
    );
    fireEvent.click(toggle);
    // Mini-timeline appears (loading then resolved) — clear signal
    // that the row is now expanded.
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-spawned-from-mini-timeline"),
      ).toBeTruthy(),
    );
    // Chevron click MUST NOT have triggered drawer navigation.
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("SPAWNED FROM session-id link click invokes onOpenSession AND does not toggle expansion", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [],
    });
    const onOpenSession = vi.fn();
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
      }),
      onOpenSession,
    });
    const link = await screen.findByTestId("sub-agents-spawned-from-link");
    fireEvent.click(link);
    expect(onOpenSession).toHaveBeenCalledWith("p-1");
    // No mini-timeline — the link click does NOT expand. The
    // expansion body element (which would carry the mini-timeline
    // testid) should not exist.
    expect(
      screen.queryByTestId("sub-agents-spawned-from-mini-timeline"),
    ).toBeNull();
  });

  it("child-row chevron toggles expansion WITHOUT invoking onOpenSession", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "c-99" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "c-99" }),
      events: [],
    });
    const onOpenSession = vi.fn();
    renderTab({
      session: mkSession({ session_id: "p-1" }),
      onOpenSession,
    });
    const toggle = await screen.findByTestId(
      "sub-agents-child-toggle-c-99",
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-child-c-99-mini-timeline"),
      ).toBeTruthy(),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("inline mini-timeline renders the SAME EventRow component the Timeline tab uses (Timeline-fidelity)", async () => {
    // D126 UX revision 2026-05-04 — Issue 2. The supervisor's
    // explicit contract: the inline mini-timeline must reuse the
    // EXACT same event-row component the Timeline tab uses, not a
    // simplified copy. ``EventRow``'s row contract carries an
    // ``event-badge`` testid (the colour-coded type pill) on
    // every event, plus the per-type testids
    // (``embeddings-event-row-...``, etc.). Pre-fix the mini-
    // timeline used a stripped-down ``EventDetail`` that emitted
    // none of those testids — the bare-event-list state the
    // supervisor flagged. Asserting the post-fix testid presence
    // pins the contract that the row component is shared.
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "p-1", flavor: "parent" }),
      events: [
        {
          id: "e-post",
          session_id: "p-1",
          flavor: "parent",
          event_type: "post_call",
          model: "claude-sonnet-4-6",
          tokens_input: 100,
          tokens_output: 50,
          tokens_total: 150,
          latency_ms: 200,
          tool_name: null,
          has_content: false,
          payload: null,
          occurred_at: "2026-05-03T00:00:01Z",
        },
        {
          id: "e-tool",
          session_id: "p-1",
          flavor: "parent",
          event_type: "tool_call",
          model: null,
          tokens_input: null,
          tokens_output: null,
          tokens_total: null,
          latency_ms: null,
          tool_name: "Bash",
          has_content: false,
          payload: null,
          occurred_at: "2026-05-03T00:00:02Z",
        },
      ],
    });
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
      }),
    });
    fireEvent.click(
      await screen.findByTestId("sub-agents-spawned-from-toggle"),
    );
    // Wait for the mini-timeline container to mount.
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-spawned-from-mini-timeline"),
      ).toBeTruthy(),
    );
    // Two ``event-badge`` testids appear inside the mini-timeline
    // — one per event row. EventRow emits this testid on the
    // colour pill; the legacy ``EventDetail`` did not.
    const miniTimeline = screen.getByTestId(
      "sub-agents-spawned-from-mini-timeline",
    );
    const badges = miniTimeline.querySelectorAll(
      '[data-testid="event-badge"]',
    );
    expect(badges.length).toBe(2);
    // Per-event-type generic ``event-row`` testid (set by EventRow
    // for non-special types) — confirms the row container is
    // EventRow, not EventDetail (which uses no testid at the
    // outer wrapper).
    const tooLcallRows = miniTimeline.querySelectorAll(
      '[data-testid="event-row"]',
    );
    expect(tooLcallRows.length).toBeGreaterThanOrEqual(1);
  });

  it("inline-expanded SPAWNED FROM body shows metrics summary + mini-timeline", async () => {
    fetchSessionMock.mockResolvedValue({
      session: mkSession({
        session_id: "p-1",
        flavor: "parent",
        tokens_used: 12345,
      }),
      events: [
        {
          id: "e-1",
          session_id: "p-1",
          flavor: "parent",
          event_type: "post_call",
          model: "claude-sonnet-4-6",
          tokens_input: 100,
          tokens_output: 50,
          tokens_total: 150,
          latency_ms: 200,
          tool_name: null,
          has_content: false,
          payload: null,
          occurred_at: "2026-05-03T00:00:01Z",
        },
        {
          id: "e-2",
          session_id: "p-1",
          flavor: "parent",
          event_type: "tool_call",
          model: null,
          tokens_input: null,
          tokens_output: null,
          tokens_total: null,
          latency_ms: null,
          tool_name: "Bash",
          has_content: false,
          payload: null,
          occurred_at: "2026-05-03T00:00:02Z",
        },
      ],
    });
    renderTab({
      session: mkSession({
        session_id: "c-1",
        parent_session_id: "p-1",
      }),
    });
    fireEvent.click(
      await screen.findByTestId("sub-agents-spawned-from-toggle"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-spawned-from-mini-timeline"),
      ).toBeTruthy(),
    );
    const metrics = screen.getByTestId("sub-agents-expansion-metrics");
    // 12,345 tokens (session rollup) + 1 LLM call + 1 tool call.
    expect(metrics.textContent).toContain("12,345");
    expect(metrics.textContent).toContain("1 LLM call");
    expect(metrics.textContent).toContain("1 tool call");
  });

  it("multiple child rows expand independently (each chevron only toggles its own row)", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        mkChild({ session_id: "c-1", agent_role: "Researcher" }),
        mkChild({ session_id: "c-2", agent_role: "Writer" }),
      ],
      total: 2,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchSessionMock.mockImplementation(async (id: string) => ({
      session: mkSession({ session_id: id }),
      events: [],
    }));
    renderTab({ session: mkSession({ session_id: "p-1" }) });
    fireEvent.click(
      await screen.findByTestId("sub-agents-child-toggle-c-1"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-child-c-1-mini-timeline"),
      ).toBeTruthy(),
    );
    // c-2's mini-timeline should NOT have rendered — only c-1 is
    // expanded. Independent expansion state per row.
    expect(
      screen.queryByTestId("sub-agents-child-c-2-mini-timeline"),
    ).toBeNull();
    // Now expand c-2 too — both should coexist.
    fireEvent.click(screen.getByTestId("sub-agents-child-toggle-c-2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("sub-agents-child-c-2-mini-timeline"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId("sub-agents-child-c-1-mini-timeline"),
    ).toBeTruthy();
  });

  it("child-row mini-timeline lazy-fetches /v1/sessions/{id} only on first expand", async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [mkChild({ session_id: "c-99" })],
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchSessionMock.mockResolvedValue({
      session: mkSession({ session_id: "c-99" }),
      events: [],
    });
    renderTab({ session: mkSession({ session_id: "p-1" }) });
    // Wait for the children list to render. fetchSession should NOT
    // have been called yet — the child row is collapsed by default,
    // and lazy-fetch only fires on first expand.
    await screen.findByTestId("sub-agents-child-toggle-c-99");
    expect(fetchSessionMock).not.toHaveBeenCalled();
    // First expand fires the fetch.
    fireEvent.click(screen.getByTestId("sub-agents-child-toggle-c-99"));
    await waitFor(() => {
      expect(fetchSessionMock).toHaveBeenCalledWith("c-99");
    });
    // Collapse + re-expand must NOT re-fetch (cached for the
    // component instance's lifetime).
    fireEvent.click(screen.getByTestId("sub-agents-child-toggle-c-99"));
    fireEvent.click(screen.getByTestId("sub-agents-child-toggle-c-99"));
    expect(fetchSessionMock).toHaveBeenCalledTimes(1);
  });
});
