import { describe, it, expect } from "vitest";
import {
  END_GLYPH_SIZE_PX,
  GLYPH_BOUNDARY_INSET_PX,
  GLYPH_GAP_PX,
  MAX_GLYPH_SHIFT_PX,
  OVERLAP_TOLERANCE_MS,
  START_GLYPH_SIZE_PX,
  assignSegmentTracks,
  layoutRowGlyphs,
  overlapsInWindow,
  packGlyphs,
  runSegments,
  segmentKey,
  type GlyphBox,
  type RunSegment,
  type SegmentEvent,
  type SegmentSession,
} from "@/lib/swimlane-lanes";

/** The panel's edges in the inset wrapper's coordinates (900 px panel,
 *  19 px inset). */
const PANEL = { left: -19, right: 881 };

// A fixed "now" all fixtures are relative to.
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const S = 1000;
const MIN = 60 * S;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function run(overrides: Partial<SegmentSession> & { session_id?: string } = {}): SegmentSession {
  return {
    session_id: "aaaaaaaa-0000-0000-0000-000000000001",
    state: "active",
    started_at: iso(-10 * MIN),
    ended_at: null,
    last_seen_at: iso(-1 * S),
    ...overrides,
  };
}

let eventSeq = 0;
function ev(
  eventType: string,
  offsetMs: number,
  closeReason?: string,
): SegmentEvent {
  eventSeq += 1;
  return {
    id: `evt-${String(eventSeq).padStart(5, "0")}`,
    event_type: eventType as SegmentEvent["event_type"],
    occurred_at: iso(offsetMs),
    payload: closeReason ? { close_reason: closeReason as never } : undefined,
  };
}

function seg(
  sessionId: string,
  startMs: number,
  endMs: number,
  endKind: RunSegment["endKind"] = "closed",
  index = 0,
  count = 1,
): RunSegment {
  return { sessionId, index, count, startMs, endMs, endKind };
}

/** Pixel mapping for a window ending at NOW with the panel's 900 px. */
function scaleFor(rangeMs: number) {
  const d0 = NOW - rangeMs;
  const d1 = NOW;
  const toX = (ms: number) => ((ms - d0) / rangeMs) * 900;
  return { d0, d1, toX, visibleLeft: -19, visibleRight: 900 - 19 };
}

describe("runSegments", () => {
  it("an open run with no events loaded is one open segment from started_at", () => {
    const segments = runSegments(run(), undefined);
    expect(segments).toEqual([
      {
        sessionId: "aaaaaaaa-0000-0000-0000-000000000001",
        index: 0,
        count: 1,
        startMs: NOW - 10 * MIN,
        endMs: Number.POSITIVE_INFINITY,
        endKind: "open",
      },
    ]);
  });

  it("idle and stale runs are open too: only the worker calls a run lost", () => {
    for (const state of ["idle", "stale"] as const) {
      const [only] = runSegments(run({ state, last_seen_at: iso(-50 * MIN) }), []);
      expect(only?.endKind).toBe("open");
      expect(only?.endMs).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("a closed run ends at its ended_at", () => {
    const [only] = runSegments(
      run({ state: "closed", ended_at: iso(-2 * MIN), last_seen_at: iso(-2 * MIN) }),
      [],
    );
    expect(only).toMatchObject({ endMs: NOW - 2 * MIN, endKind: "closed" });
  });

  it("a closed run without ended_at ends at its last_seen_at", () => {
    const [only] = runSegments(
      run({ state: "closed", ended_at: null, last_seen_at: iso(-3 * MIN) }),
      [],
    );
    expect(only).toMatchObject({ endMs: NOW - 3 * MIN, endKind: "closed" });
  });

  it("a lost run ends at its last_seen_at, as lost", () => {
    const [only] = runSegments(
      run({ state: "lost", last_seen_at: iso(-115 * MIN), started_at: iso(-120 * MIN) }),
      [],
    );
    expect(only).toMatchObject({ endMs: NOW - 115 * MIN, endKind: "lost" });
  });

  it("a run the reaper closed ends at its last_seen_at, as lost, from its close_reasons", () => {
    const [only] = runSegments(
      run({
        state: "closed",
        started_at: iso(-30 * 60 * MIN),
        last_seen_at: iso(-26 * 60 * MIN),
        ended_at: iso(-1 * MIN),
        close_reasons: ["orphan_timeout"],
      }),
      undefined,
    );
    expect(only).toMatchObject({ endMs: NOW - 26 * 60 * MIN, endKind: "lost" });
  });

  it("a closed run whose close_reasons name no reap is closed at ended_at", () => {
    const [only] = runSegments(
      run({
        state: "closed",
        last_seen_at: iso(-90 * MIN),
        ended_at: iso(-1 * MIN),
        close_reasons: ["normal_exit"],
      }),
      undefined,
    );
    expect(only).toMatchObject({ endMs: NOW - 1 * MIN, endKind: "closed" });
  });

  it("a reaped close loaded as an event ends at last_seen_at even with nothing before it loaded", () => {
    const segments = runSegments(
      run({
        state: "closed",
        started_at: iso(-30 * 60 * MIN),
        last_seen_at: iso(-26 * 60 * MIN),
        ended_at: iso(-1 * MIN),
      }),
      [ev("session_end", -1 * MIN, "orphan_timeout")],
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ endMs: NOW - 26 * 60 * MIN, endKind: "lost" });
  });

  it("the run's own last session_end decides over its close_reasons", () => {
    const [only] = runSegments(
      run({
        state: "closed",
        last_seen_at: iso(-1 * MIN),
        ended_at: iso(-1 * MIN),
        close_reasons: ["orphan_timeout", "normal_exit"],
      }),
      [ev("session_start", -10 * MIN), ev("session_end", -1 * MIN, "normal_exit")],
    );
    expect(only).toMatchObject({ endMs: NOW - 1 * MIN, endKind: "closed" });
  });

  it("a resumed run is one segment per session_start .. session_end stretch", () => {
    const segments = runSegments(run({ state: "active" }), [
      ev("session_start", -10 * MIN),
      ev("post_call", -9 * MIN),
      ev("session_end", -8 * MIN),
      ev("session_start", -6 * MIN),
      ev("session_end", -5 * MIN),
      ev("session_start", -3 * MIN),
      ev("tool_call", -1 * MIN),
    ]);
    expect(segments.map((s) => [s.startMs - NOW, s.endMs - NOW, s.endKind])).toEqual([
      [-10 * MIN, -8 * MIN, "closed"],
      [-6 * MIN, -5 * MIN, "closed"],
      [-3 * MIN, Number.POSITIVE_INFINITY, "open"],
    ]);
    expect(segments.map((s) => [s.index, s.count])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it("a closed resumed run's last segment ends at its last loaded session_end", () => {
    const segments = runSegments(
      run({ state: "closed", ended_at: iso(-1 * MIN), last_seen_at: iso(-1 * MIN) }),
      [
        ev("session_start", -10 * MIN),
        ev("session_end", -8 * MIN),
        ev("session_start", -4 * MIN),
        ev("session_end", -1 * MIN),
      ],
    );
    expect(segments.map((s) => [s.startMs - NOW, s.endMs - NOW, s.endKind])).toEqual([
      [-10 * MIN, -8 * MIN, "closed"],
      [-4 * MIN, -1 * MIN, "closed"],
    ]);
  });

  it("a session_start inside a segment continues it, and a second session_end changes nothing", () => {
    const segments = runSegments(
      run({ state: "closed", ended_at: iso(-1 * MIN), last_seen_at: iso(-1 * MIN) }),
      [
        ev("session_start", -10 * MIN),
        ev("session_start", -7 * MIN),
        ev("session_end", -5 * MIN),
        ev("session_end", -4 * MIN),
      ],
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startMs: NOW - 10 * MIN, endMs: NOW - 5 * MIN });
  });

  it("an end and a resume in the same millisecond close one segment and open the next", () => {
    const segments = runSegments(run({ state: "active" }), [
      ev("session_start", -10 * MIN),
      ev("session_start", -2 * MIN),
      ev("session_end", -2 * MIN),
    ]);
    expect(segments.map((s) => [s.startMs - NOW, s.endMs - NOW])).toEqual([
      [-10 * MIN, -2 * MIN],
      [-2 * MIN, Number.POSITIVE_INFINITY],
    ]);
  });

  it("draws nothing before a resume whose earlier boundaries are not loaded", () => {
    const segments = runSegments(run({ state: "active" }), [
      ev("session_start", -3 * MIN),
      ev("tool_call", -2 * MIN),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startMs: NOW - 3 * MIN, endKind: "open" });
  });

  it("the run's own first session_start, a moment off started_at, starts at started_at", () => {
    const segments = runSegments(run({ state: "active" }), [
      ev("session_start", -10 * MIN + 1500),
      ev("tool_call", -9 * MIN),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startMs).toBe(NOW - 10 * MIN);
  });

  it("a run running again after its last loaded end starts at its next loaded event", () => {
    const segments = runSegments(run({ state: "active", last_seen_at: iso(-10 * S) }), [
      ev("session_start", -10 * MIN),
      ev("session_end", -8 * MIN),
      ev("tool_call", -2 * MIN),
    ]);
    expect(segments.map((s) => [s.startMs - NOW, s.endKind])).toEqual([
      [-10 * MIN, "closed"],
      [-2 * MIN, "open"],
    ]);
  });

  it("with no loaded event after the last end, the resumed segment starts at last_seen_at", () => {
    const segments = runSegments(
      run({ state: "lost", last_seen_at: iso(-40 * MIN), started_at: iso(-100 * MIN) }),
      [ev("session_start", -100 * MIN), ev("session_end", -90 * MIN)],
    );
    expect(segments.map((s) => [s.startMs - NOW, s.endMs - NOW, s.endKind])).toEqual([
      [-100 * MIN, -90 * MIN, "closed"],
      [-40 * MIN, -40 * MIN, "lost"],
    ]);
  });

  it("an earlier segment the reaper closed ends at its last event, as lost", () => {
    const segments = runSegments(run({ state: "active", started_at: iso(-50 * 60 * MIN) }), [
      ev("session_start", -50 * 60 * MIN),
      ev("post_call", -49 * 60 * MIN),
      ev("session_end", -25 * 60 * MIN, "orphan_timeout"),
      ev("session_start", -5 * MIN),
    ]);
    expect(segments.map((s) => [s.startMs - NOW, s.endMs - NOW, s.endKind])).toEqual([
      [-50 * 60 * MIN, -49 * 60 * MIN, "lost"],
      [-5 * MIN, Number.POSITIVE_INFINITY, "open"],
    ]);
  });

  it("clamps a last_seen_at before started_at to the start", () => {
    const [only] = runSegments(
      run({ state: "lost", started_at: iso(-5 * MIN), last_seen_at: iso(-6 * MIN) }),
      [],
    );
    expect(only).toMatchObject({ startMs: NOW - 5 * MIN, endMs: NOW - 5 * MIN });
  });

  it("ignores boundaries dated before the run's started_at", () => {
    // A session_end older than the run's first start belongs to no
    // segment of it; the row's own state describes the run.
    const [only, ...rest] = runSegments(
      run({ state: "closed", started_at: iso(-15 * S), ended_at: iso(-3 * S), last_seen_at: iso(-3 * S) }),
      [ev("session_start", -40 * MIN), ev("session_end", -39 * MIN)],
    );
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ startMs: NOW - 15 * S, endMs: NOW - 3 * S, endKind: "closed" });
  });

  it("returns no segment for a run without a usable started_at", () => {
    expect(runSegments(run({ started_at: "" }), [])).toEqual([]);
  });

  it("ignores events without a usable time", () => {
    const segments = runSegments(run(), [{ ...ev("session_end", 0), occurred_at: "garbage" }]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.endKind).toBe("open");
  });
});

describe("assignSegmentTracks", () => {
  const RANGE = 5 * MIN;
  const TOL = OVERLAP_TOLERANCE_MS;

  it("sequential runs reuse one track", () => {
    const tracks = assignSegmentTracks(
      [seg("a", 0, 10 * S), seg("b", 20 * S, 30 * S), seg("c", 40 * S, 50 * S)],
      RANGE,
      TOL,
    );
    expect([...tracks.values()]).toEqual([0, 0, 0]);
  });

  it("a hand-off reuses the track, also when the worker's clock overlaps the two by milliseconds", () => {
    const tracks = assignSegmentTracks(
      [seg("a", 0, 10 * S + 3), seg("b", 10 * S, 30 * S, "open")],
      RANGE,
      TOL,
    );
    expect(tracks.get("b#0")).toBe(0);
  });

  it("an overlap longer than the tolerance takes a new track", () => {
    const tracks = assignSegmentTracks(
      [seg("a", 0, 10 * S + 2 * TOL), seg("b", 10 * S, 30 * S)],
      RANGE,
      TOL,
    );
    expect(tracks.get("b#0")).toBe(1);
  });

  it("runs started together get separate tracks, ordered by run id", () => {
    const tracks = assignSegmentTracks(
      [seg("c", 0, Infinity, "open"), seg("a", 0, Infinity, "open"), seg("b", 0, Infinity, "open")],
      RANGE,
      TOL,
    );
    expect([tracks.get("a#0"), tracks.get("b#0"), tracks.get("c#0")]).toEqual([0, 1, 2]);
  });

  it("a freed lower track is reused before a new one opens", () => {
    const tracks = assignSegmentTracks(
      [
        seg("a", -240 * S, -180 * S),
        seg("b", -200 * S, Infinity, "open"),
        seg("c", -150 * S, Infinity, "open"),
      ],
      RANGE,
      TOL,
    );
    expect([tracks.get("a#0"), tracks.get("b#0"), tracks.get("c#0")]).toEqual([0, 1, 0]);
  });

  it("a track whose last segment ended more than a window span ago is cold", () => {
    const tracks = assignSegmentTracks(
      [seg("old", -60 * MIN, -55 * MIN, "lost"), seg("b", -2 * MIN, Infinity, "open")],
      RANGE,
      TOL,
    );
    expect(tracks.get("b#0")).toBe(1);
  });

  it("an open run holds its track", () => {
    const tracks = assignSegmentTracks(
      [seg("a", 0, Infinity, "open"), seg("b", 60 * S, 90 * S)],
      RANGE,
      TOL,
    );
    expect(tracks.get("b#0")).toBe(1);
  });

  it("a gap frees the track: a run inside another run's gap shares it", () => {
    const tracks = assignSegmentTracks(
      [
        seg("a", 0, 10 * S, "closed", 0, 2),
        seg("b", 15 * S, 25 * S),
        seg("a", 30 * S, 40 * S, "closed", 1, 2),
      ],
      RANGE,
      TOL,
    );
    expect([tracks.get("a#0"), tracks.get("b#0"), tracks.get("a#1")]).toEqual([0, 0, 0]);
  });

  it("zero-length segments take and free a track like any other", () => {
    const tracks = assignSegmentTracks(
      [seg("a", 0, 0, "lost"), seg("b", 0, 0, "lost"), seg("c", 5 * S, 6 * S)],
      RANGE,
      TOL,
    );
    expect([tracks.get("a#0"), tracks.get("b#0"), tracks.get("c#0")]).toEqual([0, 0, 0]);
  });

  it("does not depend on input order", () => {
    const segments = [
      seg("a", 0, 30 * S),
      seg("b", 5 * S, Infinity, "open"),
      seg("c", 31 * S, 50 * S),
      seg("d", 5 * S, 20 * S),
      seg("e", 21 * S, 60 * S),
    ];
    const expected = assignSegmentTracks(segments, RANGE, TOL);
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]]) {
      const shuffled = order.map((i) => segments[i]!);
      expect(assignSegmentTracks(shuffled, RANGE, TOL)).toEqual(expected);
    }
  });
});

describe("overlapsInWindow", () => {
  const D0 = 0;
  const D1 = 60 * S;

  it("is false for runs that do not overlap, and for a hand-off", () => {
    expect(overlapsInWindow([seg("a", 0, 20 * S), seg("b", 20 * S, 40 * S)], D0, D1, 1000)).toBe(false);
  });

  it("is false for an overlap of a few milliseconds", () => {
    expect(overlapsInWindow([seg("a", 0, 20 * S + 5), seg("b", 20 * S, 40 * S)], D0, D1, 1000)).toBe(false);
  });

  it("is true for an overlap inside the window", () => {
    expect(overlapsInWindow([seg("a", 0, 30 * S), seg("b", 20 * S, 40 * S)], D0, D1, 1000)).toBe(true);
  });

  it("is false when the runs overlap only before the window", () => {
    expect(
      overlapsInWindow([seg("a", -50 * S, 1 * S), seg("b", -40 * S, Infinity, "open")], 10 * S, 70 * S, 1000),
    ).toBe(false);
  });
});

function box(overrides: Partial<GlyphBox> & Pick<GlyphBox, "key" | "desiredLeft">): GlyphBox {
  return {
    lane: 0,
    track: 0,
    kind: "start",
    sessionId: overrides.key,
    segmentIndex: 0,
    segmentStartMs: 0,
    timeMs: 0,
    width: START_GLYPH_SIZE_PX,
    ...overrides,
  };
}

describe("packGlyphs", () => {
  it("moves no glyph more than MAX_GLYPH_SHIFT_PX: past it, glyphs overlap near their time", () => {
    // Twenty runs that start together want one spot; spread 11 px apart
    // they would reach 209 px away.
    const boxes = Array.from({ length: 20 }, (_, i) =>
      box({ key: `r${String(i).padStart(2, "0")}`, desiredLeft: 300, track: i }),
    );
    const lefts = packGlyphs(boxes, PANEL);
    for (const b of boxes) {
      expect(Math.abs(lefts.get(b.key)! - 300)).toBeLessThanOrEqual(MAX_GLYPH_SHIFT_PX);
    }
    // The first few still spread apart.
    expect(lefts.get("r01")! - lefts.get("r00")!).toBe(START_GLYPH_SIZE_PX + GLYPH_GAP_PX);
  });

  it("caps the right-edge pull-back too, and clamps every glyph inside the panel", () => {
    const boxes = Array.from({ length: 20 }, (_, i) =>
      box({ key: `r${String(i).padStart(2, "0")}`, desiredLeft: 878, track: i }),
    );
    const lefts = packGlyphs(boxes, PANEL);
    for (const b of boxes) {
      const left = lefts.get(b.key)!;
      expect(left).toBeGreaterThanOrEqual(878 - MAX_GLYPH_SHIFT_PX);
      expect(left + b.width).toBeLessThanOrEqual(PANEL.right);
    }
  });

  it("clamps a glyph at the window's left edge inside the panel", () => {
    const lefts = packGlyphs(
      [box({ key: "e", desiredLeft: -40, kind: "end", width: END_GLYPH_SIZE_PX })],
      PANEL,
    );
    expect(lefts.get("e")).toBe(PANEL.left);
  });

  it("leaves glyphs that are apart where they want to be", () => {
    const lefts = packGlyphs(
      [box({ key: "a", desiredLeft: 100 }), box({ key: "b", desiredLeft: 300, track: 1 })],
      PANEL,
    );
    expect(lefts.get("a")).toBe(100);
    expect(lefts.get("b")).toBe(300);
  });

  it("spreads glyphs that want the same spot 1 px apart, in run-id order", () => {
    const lefts = packGlyphs(
      [
        box({ key: "c", desiredLeft: 500, track: 2 }),
        box({ key: "a", desiredLeft: 500, track: 0 }),
        box({ key: "b", desiredLeft: 500, track: 1 }),
      ],
      PANEL,
    );
    expect([lefts.get("a"), lefts.get("b"), lefts.get("c")]).toEqual([
      500,
      500 + START_GLYPH_SIZE_PX + GLYPH_GAP_PX,
      500 + 2 * (START_GLYPH_SIZE_PX + GLYPH_GAP_PX),
    ]);
  });

  it("puts an end before a start at the same spot (a hand-off reads ■▶)", () => {
    const lefts = packGlyphs(
      [
        box({ key: "next", desiredLeft: 400, track: 1, sessionId: "a" }),
        box({ key: "prev", desiredLeft: 400, track: 0, kind: "end", width: END_GLYPH_SIZE_PX, sessionId: "b" }),
      ],
      PANEL,
    );
    expect(lefts.get("prev")).toBe(400);
    expect(lefts.get("next")).toBe(400 + END_GLYPH_SIZE_PX + GLYPH_GAP_PX);
  });

  it("keeps a short segment's ■ after its own ▶, past the segment's end", () => {
    // A segment 5 px wide: the ■ wants to start 7 px left of the ▶.
    const lefts = packGlyphs(
      [
        box({ key: "s", desiredLeft: 201, sessionId: "short" }),
        box({
          key: "e",
          desiredLeft: 194,
          kind: "end",
          width: END_GLYPH_SIZE_PX,
          timeMs: 5,
          sessionId: "short",
        }),
      ],
      PANEL,
    );
    expect(lefts.get("s")).toBe(201);
    expect(lefts.get("e")).toBe(201 + START_GLYPH_SIZE_PX + GLYPH_GAP_PX);
  });

  it("keeps a short segment's ■ before the next segment's ▶ on its track", () => {
    const lefts = packGlyphs(
      [
        box({ key: "a-start", desiredLeft: 201, sessionId: "a" }),
        box({ key: "a-end", desiredLeft: 194, kind: "end", width: END_GLYPH_SIZE_PX, sessionId: "a", timeMs: 5 }),
        box({ key: "b-start", desiredLeft: 207, sessionId: "b", segmentStartMs: 5, timeMs: 5 }),
      ],
      PANEL,
    );
    const order = ["a-start", "a-end", "b-start"].map((k) => lefts.get(k)!);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
  });

  it("pulls glyphs back inside the panel's right edge", () => {
    const lefts = packGlyphs(
      [
        box({ key: "a", desiredLeft: 878, track: 0 }),
        box({ key: "b", desiredLeft: 878, track: 1 }),
      ],
      PANEL,
    );
    expect(lefts.get("b")).toBe(881 - START_GLYPH_SIZE_PX);
    expect(lefts.get("a")).toBe(881 - 2 * START_GLYPH_SIZE_PX - GLYPH_GAP_PX);
  });

  it("packs each edge on its own", () => {
    const lefts = packGlyphs(
      [box({ key: "top", desiredLeft: 300, lane: 0 }), box({ key: "bottom", desiredLeft: 300, lane: 1, track: 1 })],
      PANEL,
    );
    expect(lefts.get("top")).toBe(300);
    expect(lefts.get("bottom")).toBe(300);
  });
});

describe("layoutRowGlyphs", () => {
  it("puts every glyph on the top edge when no two runs overlap in the window", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("a", NOW - 4 * MIN, NOW - 3 * MIN), seg("b", NOW - 2 * MIN, Infinity, "open")],
    });
    expect(layout.laneCount).toBe(1);
    expect(layout.glyphs.every((g) => g.lane === 0)).toBe(true);
    expect(layout.glyphs.map((g) => g.key)).toEqual(["a#0:start", "a#0:end", "b#0:start"]);
  });

  it("stays on one edge when the runs overlap only before the window", () => {
    const w = scaleFor(1 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [
        seg("a", NOW - 5 * MIN, NOW - 70 * S),
        seg("b", NOW - 4 * MIN, NOW - 40 * S),
        seg("c", NOW - 30 * S, Infinity, "open"),
      ],
    });
    expect(layout.laneCount).toBe(1);
    expect(layout.glyphs.map((g) => g.key)).toEqual(["b#0:end", "c#0:start"]);
  });

  it("splits the row while runs overlap in the window: the topmost track in view keeps the top edge", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("a", NOW - 4 * MIN, Infinity, "open"), seg("b", NOW - 3 * MIN, Infinity, "open")],
    });
    expect(layout.laneCount).toBe(2);
    const lanes = Object.fromEntries(layout.glyphs.map((g) => [g.segment.sessionId, g.lane]));
    expect(lanes).toEqual({ a: 0, b: 1 });
  });

  it("an earlier lost run does not take the top edge", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [
        seg("lost", NOW - 26 * 60 * MIN, NOW - 25 * 60 * MIN, "lost"),
        seg("a", NOW - 4 * MIN, Infinity, "open"),
        seg("b", NOW - 3 * MIN, Infinity, "open"),
      ],
    });
    const lanes = Object.fromEntries(layout.glyphs.map((g) => [g.segment.sessionId, g.lane]));
    expect(lanes).toEqual({ a: 0, b: 1 });
  });

  it("reuses a freed top edge", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [
        seg("a", NOW - 240 * S, NOW - 180 * S),
        seg("b", NOW - 200 * S, Infinity, "open"),
        seg("c", NOW - 150 * S, Infinity, "open"),
      ],
    });
    expect(layout.laneCount).toBe(2);
    const byKey = Object.fromEntries(layout.glyphs.map((g) => [g.key, g.lane]));
    expect(byKey).toEqual({ "a#0:start": 0, "a#0:end": 0, "b#0:start": 1, "c#0:start": 0 });
  });

  it("draws only the end of a segment that started before the window", () => {
    const w = scaleFor(1 * MIN);
    const layout = layoutRowGlyphs({ ...w, segments: [seg("a", NOW - 2 * 60 * MIN, NOW - 20 * S)] });
    expect(layout.glyphs.map((g) => g.kind)).toEqual(["end"]);
    expect(layout.glyphs[0]!.left).toBeCloseTo(w.toX(NOW - 20 * S) - END_GLYPH_SIZE_PX - 1, 6);
  });

  it("ends a lost run at its last signal with its own end glyph", () => {
    const w = scaleFor(60 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("lost", NOW - 50 * MIN, NOW - 40 * MIN, "lost")],
    });
    const end = layout.glyphs.find((g) => g.kind === "end");
    expect(end?.segment.endKind).toBe("lost");
    expect(end?.left).toBeCloseTo(w.toX(NOW - 40 * MIN) - END_GLYPH_SIZE_PX - 1, 6);
  });

  it("draws nothing for segments out of view", () => {
    const w = scaleFor(1 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("old", NOW - 60 * MIN, NOW - 50 * MIN), seg("now", NOW - 30 * S, Infinity, "open")],
    });
    expect(layout.glyphs.map((g) => g.segment.sessionId)).toEqual(["now"]);
  });

  it("a run inside another run's gap does not split the row", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [
        seg("a", NOW - 280 * S, NOW - 200 * S, "closed", 0, 2),
        seg("b", NOW - 180 * S, NOW - 120 * S),
        seg("a", NOW - 100 * S, Infinity, "open", 1, 2),
      ],
    });
    expect(layout.laneCount).toBe(1);
    expect(layout.glyphs.filter((g) => g.segment.sessionId === "a").map((g) => g.kind)).toEqual([
      "start",
      "end",
      "start",
    ]);
  });

  it("two runs the worker stamped a few milliseconds apart do not split the row", () => {
    const w = scaleFor(1 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("a", NOW - 50 * S, NOW - 25 * S + 4), seg("b", NOW - 25 * S, Infinity, "open")],
    });
    expect(layout.laneCount).toBe(1);
    // ■▶: the hand-off's end sits left of the next start.
    const end = layout.glyphs.find((g) => g.key === "a#0:end");
    const start = layout.glyphs.find((g) => g.key === "b#0:start");
    expect(end!.left + end!.width).toBeLessThan(start!.left);
  });

  it("widens the tolerance to one pixel at wide windows", () => {
    // At 1h a pixel is 4 s, so a 2 s overlap is not a split.
    const w = scaleFor(60 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [seg("a", NOW - 30 * MIN, NOW - 20 * MIN + 2 * S), seg("b", NOW - 20 * MIN, Infinity, "open")],
    });
    expect(layout.laneCount).toBe(1);
  });

  it("keeps a short run's ▶ before its ■", () => {
    const w = scaleFor(60 * MIN);
    // 30 s at 1h is 7.5 px, narrower than ▶ + ■.
    const layout = layoutRowGlyphs({ ...w, segments: [seg("short", NOW - 30 * MIN, NOW - 30 * MIN + 30 * S)] });
    const [start, end] = layout.glyphs;
    expect(start?.kind).toBe("start");
    expect(end?.kind).toBe("end");
    expect(start!.left).toBeCloseTo(w.toX(NOW - 30 * MIN) + 1, 6);
    expect(end!.left).toBe(start!.left + START_GLYPH_SIZE_PX + GLYPH_GAP_PX);
  });

  it("keeps a run that has just started inside the panel", () => {
    const w = scaleFor(1 * MIN);
    const layout = layoutRowGlyphs({ ...w, segments: [seg("new", NOW - 200, Infinity, "open")] });
    const [start] = layout.glyphs;
    expect(start!.left + start!.width).toBeLessThanOrEqual(w.visibleRight);
  });

  it("orders glyphs by edge, then left to right", () => {
    const w = scaleFor(5 * MIN);
    const layout = layoutRowGlyphs({
      ...w,
      segments: [
        seg("b", NOW - 3 * MIN, Infinity, "open"),
        seg("a", NOW - 4 * MIN, NOW - 1 * MIN),
      ],
    });
    const order = layout.glyphs.map((g) => [g.lane, g.left]);
    const sorted = [...order].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!);
    expect(order).toEqual(sorted);
  });

  it("returns nothing for an empty window", () => {
    expect(layoutRowGlyphs({ segments: [seg("a", 0, 1)], d0: 5, d1: 5, toX: () => 0, visibleLeft: -19, visibleRight: 881 })).toEqual({
      laneCount: 1,
      glyphs: [],
    });
  });
});

// A small deterministic PRNG so the property test is repeatable.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSegments(rand: () => number, spanMs: number): RunSegment[] {
  const segments: RunSegment[] = [];
  const runs = 6 + Math.floor(rand() * 10);
  for (let r = 0; r < runs; r++) {
    const id = `run-${String(r).padStart(2, "0")}`;
    const pieces = 1 + Math.floor(rand() * 3);
    let t = NOW - spanMs + Math.floor(rand() * spanMs * 0.8);
    for (let i = 0; i < pieces; i++) {
      const length = Math.floor(rand() * spanMs * 0.3);
      const last = i === pieces - 1;
      const open = last && rand() < 0.3;
      const short = rand() < 0.15;
      const end = open ? Infinity : t + (short ? Math.floor(rand() * 3 * S) : length);
      segments.push({
        sessionId: id,
        index: i,
        count: pieces,
        startMs: t,
        endMs: end,
        endKind: open ? "open" : rand() < 0.2 ? "lost" : "closed",
      });
      if (open) break;
      t = end + Math.floor(rand() * spanMs * 0.2);
    }
  }
  return segments;
}

describe("layoutRowGlyphs properties", () => {
  // Sliding windows over random rows, sampled so the test stays fast.
  it.each([
    ["1m", 1 * MIN],
    ["5m", 5 * MIN],
    ["15m", 15 * MIN],
  ])("holds its invariants at %s windows sliding 1 s per frame", (_label, rangeMs) => {
    const rand = mulberry32(rangeMs);
    for (let row = 0; row < 12; row++) {
      const all = randomSegments(rand, rangeMs * 3);
      for (let frame = 0; frame < 120; frame += 7) {
        const d1 = NOW - rangeMs * 2 + frame * S + Math.floor(rand() * rangeMs);
        const d0 = d1 - rangeMs;
        const toX = (ms: number) => ((ms - d0) / rangeMs) * 900;
        const layout = layoutRowGlyphs({ segments: all, d0, d1, toX, visibleLeft: -19, visibleRight: 881 });
        const toleranceMs = Math.max(OVERLAP_TOLERANCE_MS, rangeMs / 900);

        // Glyphs on one edge overlap only where spreading them further
        // would move one past the shift cap or out of the panel.
        const natural = naturalLefts(all, d0, d1, toX);
        const pinned = (g: { key: string; left: number; width: number }) => {
          const shift = Math.abs(g.left - natural.get(g.key)!);
          return (
            shift >= MAX_GLYPH_SHIFT_PX - 1e-6 ||
            g.left <= -19 + 1e-6 ||
            g.left + g.width >= 881 - 1e-6
          );
        };
        for (const lane of [0, 1]) {
          const boxes = layout.glyphs
            .filter((g) => g.lane === lane)
            .sort((a, b) => a.left - b.left);
          for (let i = 1; i < boxes.length; i++) {
            const a = boxes[i - 1]!;
            const b = boxes[i]!;
            if (b.left < a.left + a.width) expect(pinned(a) || pinned(b)).toBe(true);
          }
        }

        // A single-edge frame has no overlap in view; a split frame has one.
        const inView = all.filter((s) => s.startMs <= d1 && s.endMs >= d0);
        expect(layout.laneCount === 2).toBe(overlapsInWindow(inView, d0, d1, toleranceMs));

        // Segments on the top edge of a split frame never overlap each other.
        if (layout.laneCount === 2) {
          const topKeys = new Set(
            layout.glyphs.filter((g) => g.lane === 0).map((g) => segmentKey(g.segment)),
          );
          const top = inView.filter((s) => topKeys.has(segmentKey(s)));
          expect(overlapsInWindow(top, d0, d1, toleranceMs)).toBe(false);
        }

        // A segment's ▶ is left of its ■ when both are drawn.
        const bySegment = new Map<string, { start?: number; end?: number }>();
        for (const g of layout.glyphs) {
          const entry = bySegment.get(segmentKey(g.segment)) ?? {};
          entry[g.kind] = g.left;
          bySegment.set(segmentKey(g.segment), entry);
        }
        for (const { start, end } of bySegment.values()) {
          if (start !== undefined && end !== undefined) expect(start).toBeLessThan(end);
        }
      }

      // No two segments on one track overlap, and a segment's track
      // never moves when segments that start later arrive.
      const tracks = assignSegmentTracks(all, rangeMs, OVERLAP_TOLERANCE_MS);
      const perTrack = new Map<number, RunSegment[]>();
      for (const s of all) {
        const t = tracks.get(segmentKey(s))!;
        perTrack.set(t, [...(perTrack.get(t) ?? []), s]);
      }
      for (const list of perTrack.values()) {
        list.sort((a, b) => a.startMs - b.startMs);
        for (let i = 1; i < list.length; i++) {
          expect(list[i]!.startMs + OVERLAP_TOLERANCE_MS).toBeGreaterThanOrEqual(list[i - 1]!.endMs);
        }
      }
      const cut = NOW - rangeMs * 2 + Math.floor(rand() * rangeMs * 2);
      const earlier = all.filter((s) => s.startMs < cut);
      const earlierTracks = assignSegmentTracks(earlier, rangeMs, OVERLAP_TOLERANCE_MS);
      for (const s of earlier) {
        expect(earlierTracks.get(segmentKey(s))).toBe(tracks.get(segmentKey(s)));
      }
    }
  });
});

// Every glyph's left edge as its time alone puts it: the ▶ just inside
// the start, the ■ just inside the end, or right after its own ▶ for a
// segment narrower than the two glyphs.
function naturalLefts(
  segments: readonly RunSegment[],
  d0: number,
  d1: number,
  toX: (ms: number) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of segments) {
    if (!(s.startMs <= d1 && s.endMs >= d0)) continue;
    const key = segmentKey(s);
    const startDrawn = s.startMs >= d0 && s.startMs <= d1;
    const startLeft = toX(s.startMs) + GLYPH_BOUNDARY_INSET_PX;
    if (startDrawn) out.set(`${key}:start`, startLeft);
    if (s.endKind !== "open" && s.endMs >= d0 && s.endMs <= d1) {
      const endLeft = toX(s.endMs) - END_GLYPH_SIZE_PX - GLYPH_BOUNDARY_INSET_PX;
      out.set(
        `${key}:end`,
        startDrawn ? Math.max(endLeft, startLeft + START_GLYPH_SIZE_PX + GLYPH_GAP_PX) : endLeft,
      );
    }
  }
  return out;
}

describe("layoutRowGlyphs on dense rows", () => {
  // A busy row: hundreds of short runs, a few seconds each, as an
  // integration suite or a fan-out storm produces (one live row drew 192
  // glyphs in a minute).
  it.each([
    ["1m", 1 * MIN, 300],
    ["5m", 5 * MIN, 600],
    ["15m", 15 * MIN, 400],
  ])("keeps every glyph within the shift cap and inside the panel at %s", (_label, rangeMs, runs) => {
    const rand = mulberry32(runs + rangeMs);
    const segments: RunSegment[] = [];
    for (let r = 0; r < runs; r++) {
      const start = NOW - rangeMs * 1.2 + rand() * rangeMs * 1.2;
      const length = rand() < 0.1 ? 0 : rand() * 4 * S;
      segments.push({
        sessionId: `dense-${String(r).padStart(4, "0")}`,
        index: 0,
        count: 1,
        startMs: start,
        endMs: rand() < 0.05 ? Infinity : start + length,
        endKind: rand() < 0.2 ? "lost" : "closed",
      });
    }
    for (const shift of [0, 7 * S, 31 * S]) {
      const d1 = NOW - shift;
      const d0 = d1 - rangeMs;
      const toX = (ms: number) => ((ms - d0) / rangeMs) * 900;
      const layout = layoutRowGlyphs({ segments, d0, d1, toX, visibleLeft: PANEL.left, visibleRight: PANEL.right });
      const natural = naturalLefts(segments, d0, d1, toX);
      expect(layout.glyphs.length).toBe(natural.size);
      const byKey = new Map(layout.glyphs.map((g) => [g.key, g]));
      for (const g of layout.glyphs) {
        // Inside the panel, never under the label column.
        expect(g.left).toBeGreaterThanOrEqual(PANEL.left);
        expect(g.left + g.width).toBeLessThanOrEqual(PANEL.right);
        // Within the cap of its own time, or of the panel edge its time
        // lies past.
        const nat = Math.min(Math.max(natural.get(g.key)!, PANEL.left), PANEL.right - g.width);
        expect(Math.abs(g.left - nat)).toBeLessThanOrEqual(MAX_GLYPH_SHIFT_PX + 1e-6);
      }
      // A segment's ▶ never reads after its own ■.
      for (const g of layout.glyphs) {
        if (g.kind !== "start") continue;
        const end = byKey.get(g.key.replace(/:start$/, ":end"));
        if (end) expect(g.left).toBeLessThan(end.left);
      }
    }
  });
});
