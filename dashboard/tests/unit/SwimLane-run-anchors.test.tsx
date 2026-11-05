import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { scaleTime } from "d3-scale";
import type { AgentEvent, Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { SwimLane } from "@/components/timeline/SwimLane";
import { attachmentsCache, eventsCache } from "@/hooks/useSessionEvents";

// SwimLane places each run's glyphs with the lanes layout: segments
// from the run's cached session_start / session_end events, the top
// edge for the topmost track in view, packed glyphs. The real events
// cache is used so a run's history fetch landing re-derives the row.

const { fetchSession } = vi.hoisted(() => ({
  fetchSession: vi.fn<(id: string) => Promise<SessionDetail>>(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSession,
}));

const NOW = Date.parse("2026-11-02T10:00:00Z");
const S = 1000;
const MIN = 60 * S;

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${String(idSeq).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36);
}

function mkSession(overrides: Partial<Session> & { session_id: string }): Session {
  return {
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: new Date(NOW - 30 * S).toISOString(),
    last_seen_at: new Date(NOW).toISOString(),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

function mkEvent(sessionId: string, eventType: string, offsetMs: number): AgentEvent {
  idSeq += 1;
  return {
    id: `evt-${idSeq}`,
    session_id: sessionId,
    flavor: "e2e",
    event_type: eventType as AgentEvent["event_type"],
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: null,
    client_type: null,
    agent_type: null,
    occurred_at: new Date(NOW + offsetMs).toISOString(),
  };
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function renderRow(sessions: Session[], rangeMs: number) {
  const scale = scaleTime()
    .domain([new Date(NOW - rangeMs), new Date(NOW)])
    .range([0, 900]);
  return render(
    <MemoryRouter>
      <SwimLane
        flavor="agent-row"
        agentName="row"
        agentType="coding"
        sessions={sessions}
        scale={scale}
        onSessionClick={() => {}}
        timelineWidth={900}
        leftPanelWidth={460}
      />
    </MemoryRouter>,
  );
}

function row() {
  return screen.getByTestId("swimlane-agent-row-row");
}

function glyph(kind: "start" | "end", sessionId: string) {
  return within(row()).getByTestId(`swimlane-run-bracket-${kind}-${sessionId.slice(0, 8)}`);
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
  fetchSession.mockReset();
  // A run's own history fetch never lands unless a test resolves it.
  fetchSession.mockImplementation(() => new Promise<SessionDetail>(() => {}));
});

describe("SwimLane run anchors", () => {
  it("an earlier lost run does not take the top edge", () => {
    const lost = mkSession({
      session_id: nextId("a"),
      state: "lost",
      started_at: at(-26 * 60 * MIN),
      last_seen_at: at(-25 * 60 * MIN),
    });
    const first = mkSession({ session_id: nextId("b"), started_at: at(-4 * MIN) });
    const second = mkSession({ session_id: nextId("c"), started_at: at(-3 * MIN) });
    renderRow([lost, first, second], 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "2");
    expect(glyph("start", first.session_id)).toHaveAttribute("data-run-lane", "0");
    expect(glyph("start", second.session_id)).toHaveAttribute("data-run-lane", "1");
    expect(within(row()).queryByTestId(`swimlane-run-bracket-end-${lost.session_id.slice(0, 8)}`)).toBeNull();
  });

  it("reuses a freed top edge", () => {
    const a = mkSession({
      session_id: nextId("d"),
      state: "closed",
      started_at: at(-240 * S),
      ended_at: at(-180 * S),
      last_seen_at: at(-180 * S),
    });
    const b = mkSession({ session_id: nextId("e"), started_at: at(-200 * S) });
    const c = mkSession({ session_id: nextId("f"), started_at: at(-150 * S) });
    renderRow([a, b, c], 5 * MIN);
    expect(glyph("start", a.session_id)).toHaveAttribute("data-run-lane", "0");
    expect(glyph("start", c.session_id)).toHaveAttribute("data-run-lane", "0");
    expect(glyph("start", b.session_id)).toHaveAttribute("data-run-lane", "1");
  });

  it("draws the end of a closed run whose start is off-screen", () => {
    const long = mkSession({
      session_id: nextId("g"),
      state: "closed",
      started_at: at(-2 * 60 * MIN),
      ended_at: at(-20 * S),
      last_seen_at: at(-20 * S),
    });
    renderRow([long], 1 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "1");
    expect(glyph("end", long.session_id)).toHaveAttribute("data-end-kind", "closed");
    expect(within(row()).queryByTestId(`swimlane-run-bracket-start-${long.session_id.slice(0, 8)}`)).toBeNull();
  });

  it("gives runs started together a lane each", () => {
    const started = at(-30 * S);
    const runs = [nextId("h"), nextId("i"), nextId("j")].map((id) =>
      mkSession({ session_id: id, started_at: started }),
    );
    renderRow(runs, 5 * MIN);
    const placed = runs.map((r) => {
      const g = glyph("start", r.session_id);
      return { lane: g.getAttribute("data-run-lane"), left: parseFloat(g.style.left) };
    });
    // In run-id order, one lane each, so their ▶ glyphs sit at one x
    // on three lane centres.
    expect(row()).toHaveAttribute("data-lane-count", "3");
    expect(placed.map((p) => p.lane)).toEqual(["0", "1", "2"]);
    expect(new Set(placed.map((p) => p.left)).size).toBe(1);
  });

  it("draws glyphs only for runs in view", () => {
    const old = mkSession({
      session_id: nextId("k"),
      state: "closed",
      started_at: at(-3 * 60 * MIN),
      ended_at: at(-2 * 60 * MIN),
      last_seen_at: at(-2 * 60 * MIN),
    });
    const now = mkSession({ session_id: nextId("l"), started_at: at(-20 * S) });
    renderRow([old, now], 1 * MIN);
    const glyphs = within(row()).getAllByTestId(/^swimlane-run-bracket-(start|end)-/);
    expect(glyphs.map((g) => g.getAttribute("data-session-id"))).toEqual([now.session_id]);
    expect(row()).toHaveAttribute("data-lane-count", "1");
  });

  it("draws a lost run's end as a hollow square at its last signal", () => {
    const lost = mkSession({
      session_id: nextId("m"),
      state: "lost",
      started_at: at(-50 * MIN),
      last_seen_at: at(-40 * MIN),
    });
    renderRow([lost], 60 * MIN);
    expect(glyph("end", lost.session_id)).toHaveAttribute("data-end-kind", "lost");
  });

  it("draws a resumed run as segments, and a run in its gap does not split the row", () => {
    const resumed = mkSession({ session_id: nextId("n"), started_at: at(-280 * S) });
    const inGap = mkSession({
      session_id: nextId("o"),
      state: "closed",
      started_at: at(-180 * S),
      ended_at: at(-120 * S),
      last_seen_at: at(-120 * S),
    });
    eventsCache.set(resumed.session_id, [
      mkEvent(resumed.session_id, "session_start", -280 * S),
      mkEvent(resumed.session_id, "session_end", -200 * S),
      mkEvent(resumed.session_id, "session_start", -100 * S),
    ]);
    eventsCache.set(inGap.session_id, [mkEvent(inGap.session_id, "session_start", -180 * S)]);
    renderRow([resumed, inGap], 5 * MIN);
    expect(row()).toHaveAttribute("data-lane-count", "1");
    const resumedGlyphs = within(row())
      .getAllByTestId(/^swimlane-run-bracket-(start|end)-/)
      .filter((g) => g.getAttribute("data-session-id") === resumed.session_id);
    expect(resumedGlyphs.map((g) => g.getAttribute("data-bracket-kind"))).toEqual([
      "start",
      "end",
      "start",
    ]);
  });

  it("re-derives a run's segments when its history fetch lands", async () => {
    const run = mkSession({ session_id: nextId("p"), started_at: at(-4 * MIN) });
    fetchSession.mockImplementation(async () => ({
      session: run,
      events: [
        mkEvent(run.session_id, "session_start", -4 * MIN),
        mkEvent(run.session_id, "session_end", -3 * MIN),
        mkEvent(run.session_id, "session_start", -1 * MIN),
      ],
      attachments: [],
    }) as unknown as SessionDetail);
    renderRow([run], 5 * MIN);
    await waitFor(() => {
      const kinds = within(row())
        .getAllByTestId(/^swimlane-run-bracket-(start|end)-/)
        .map((g) => g.getAttribute("data-bracket-kind"));
      expect(kinds).toEqual(["start", "end", "start"]);
    });
    expect(fetchSession).toHaveBeenCalledWith(run.session_id);
  });

  it("colours a late-stamped re-attach after the drawer's capped fetch cached only the resume", () => {
    // The run drawer fetched the run's newest events (a cap that
    // stopped at the resume) and stored its attachments; the Fleet row
    // then holds a suffix that opens on the resume's start. That start
    // is the attachment's, stamped 4 s after it, not the run's original.
    const run = mkSession({ session_id: nextId("q"), started_at: at(-60 * MIN) });
    const resume = mkEvent(run.session_id, "session_start", -2 * MIN);
    const call = mkEvent(run.session_id, "tool_call", -2 * MIN + 5 * S);
    eventsCache.set(run.session_id, [resume, call]);
    attachmentsCache.set(run.session_id, [at(-2 * MIN + 4 * S)]);
    try {
      renderRow([run], 5 * MIN);
      const circle = within(row())
        .getAllByTestId(`session-circle-${run.session_id}`)
        .find((c) => c.getAttribute("data-event-id") === resume.id);
      expect(circle?.outerHTML).toContain("var(--warning)");
    } finally {
      attachmentsCache.delete(run.session_id);
    }
  });
});
