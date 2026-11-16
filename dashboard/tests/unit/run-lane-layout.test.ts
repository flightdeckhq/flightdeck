import { describe, it, expect } from "vitest";
import {
  FEED_MIN_HEIGHT_PX,
  MARKER_TEXT_CHAR_PX,
  MARKER_TEXT_CLEARANCE_PX,
  MARKER_TEXT_FONT_PX,
  MARKER_TEXT_GAP_PX,
  MARKER_TEXT_MAX_CHARS,
  MARKER_TEXT_STACKED_MIN_LANE_PX,
  MARKER_TEXT_STACK_GAP_PX,
  RUN_LANE_CIRCLE_HOVER_PX,
  RUN_LANE_CIRCLE_SIZE_PX,
  RUN_LANE_MAX_HEIGHT_PX,
  RUN_LANE_MIN_HEIGHT_PX,
  feedHeightCap,
  markerText,
  markerTextWidth,
  measureMarkerText,
  placeMarkerLabels,
  runLaneHeights,
  shortenMarkerText,
  type LaneMarker,
} from "@/lib/run-lane-layout";

// The per-agent modal's run lanes: how N lanes share the space above
// the Live feed, and which circles keep a short text beside them.

describe("runLaneHeights", () => {
  it("gives N lanes an equal whole-pixel share of the space between the bounds", () => {
    // 3 lanes in 380 px: 126 px each, 2 px left over (never overshoots).
    expect(runLaneHeights(3, 380)).toEqual({ laneHeight: 126, totalHeight: 378, scrolls: false });
    expect(runLaneHeights(2, 200)).toEqual({ laneHeight: 100, totalHeight: 200, scrolls: false });
  });

  it("stops a single run at the maximum rather than filling the modal", () => {
    expect(runLaneHeights(1, 600).laneHeight).toBe(RUN_LANE_MAX_HEIGHT_PX);
    expect(runLaneHeights(1, 600).scrolls).toBe(false);
    // Two lanes on a large screen stop there too.
    expect(runLaneHeights(2, 1000).laneHeight).toBe(RUN_LANE_MAX_HEIGHT_PX);
  });

  it("keeps lanes at the minimum and scrolls once their minimum no longer fits", () => {
    // 5 × 40 = 200 > 92: the lane area scrolls.
    expect(runLaneHeights(5, 92)).toEqual({
      laneHeight: RUN_LANE_MIN_HEIGHT_PX,
      totalHeight: 5 * RUN_LANE_MIN_HEIGHT_PX,
      scrolls: true,
    });
  });

  it("scrolls exactly past the threshold N × minimum", () => {
    const n = 4;
    const threshold = n * RUN_LANE_MIN_HEIGHT_PX;
    expect(runLaneHeights(n, threshold).scrolls).toBe(false);
    expect(runLaneHeights(n, threshold).laneHeight).toBe(RUN_LANE_MIN_HEIGHT_PX);
    expect(runLaneHeights(n, threshold - 1).scrolls).toBe(true);
  });

  it("never returns a lane outside the bounds, whatever the space", () => {
    for (const n of [1, 2, 3, 7, 20]) {
      for (const space of [-50, 0, 37, 120, 433, 2000, Number.NaN]) {
        const { laneHeight, totalHeight } = runLaneHeights(n, space);
        expect(laneHeight).toBeGreaterThanOrEqual(RUN_LANE_MIN_HEIGHT_PX);
        expect(laneHeight).toBeLessThanOrEqual(RUN_LANE_MAX_HEIGHT_PX);
        expect(Number.isInteger(laneHeight)).toBe(true);
        expect(totalHeight).toBe(laneHeight * n);
      }
    }
  });

  it("draws nothing for no lanes", () => {
    expect(runLaneHeights(0, 500)).toEqual({ laneHeight: 0, totalHeight: 0, scrolls: false });
  });

  it("names bounds that hold the lane's contents", () => {
    // The 28 px circle at its 1.25x hover scale fits the shortest lane.
    expect(RUN_LANE_CIRCLE_SIZE_PX * 1.25).toBeLessThan(RUN_LANE_MIN_HEIGHT_PX);
    // The tallest lane is three 48 px Fleet rows.
    expect(RUN_LANE_MAX_HEIGHT_PX).toBe(3 * 48);
  });
});

describe("markerText", () => {
  it("names a tool call's tool", () => {
    expect(markerText({ eventType: "tool_call", toolName: "Bash" })).toBe("Bash");
    expect(markerText({ eventType: "mcp_tool_call", toolName: "search_docs" })).toBe("search_docs");
  });

  it("names an LLM call's model without its date suffix", () => {
    expect(markerText({ eventType: "post_call", model: "claude-sonnet-4-5-20250929" })).toBe(
      "claude-sonnet-4-5",
    );
    expect(markerText({ eventType: "pre_call", model: "gpt-4o" })).toBe("gpt-4o");
    expect(markerText({ eventType: "embeddings", model: "text-embedding-3-small" })).toBe(
      "text-embedding-3-…",
    );
    expect(markerText({ eventType: "llm_error", model: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });

  it("gives other events, and calls without a name, no text", () => {
    expect(markerText({ eventType: "session_start", model: "x" })).toBeNull();
    expect(markerText({ eventType: "policy_warn", toolName: "Bash" })).toBeNull();
    expect(markerText({ eventType: "tool_call", toolName: "  " })).toBeNull();
    expect(markerText({ eventType: "post_call", model: null })).toBeNull();
  });

  it("cuts a long name to the maximum with an ellipsis", () => {
    const cut = shortenMarkerText("mcp__github__create_pull_request");
    expect(Array.from(cut)).toHaveLength(MARKER_TEXT_MAX_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(shortenMarkerText("Read")).toBe("Read");
  });

  it("measures text by its length in the mono font", () => {
    expect(markerTextWidth("Bash")).toBe(4 * MARKER_TEXT_CHAR_PX);
  });
});

describe("placeMarkerLabels", () => {
  const circleSize = 28;
  const half = circleSize / 2;
  const right = 881;
  const place = (markers: LaneMarker[]) => placeMarkerLabels(markers, { circleSize, right });

  it("places a text just right of its circle", () => {
    const kept = place([{ id: "a", x: 100, text: "Bash" }]);
    expect(kept.get("a")).toEqual({
      text: "Bash",
      left: 100 + half + MARKER_TEXT_GAP_PX,
      width: 4 * MARKER_TEXT_CHAR_PX,
      row: "beside",
    });
  });

  it("keeps the texts of markers far enough apart", () => {
    const kept = place([
      { id: "a", x: 100, text: "Bash" },
      { id: "b", x: 200, text: "Read" },
      { id: "c", x: 300, text: "Edit" },
    ]);
    expect([...kept.keys()]).toEqual(["a", "b", "c"]);
  });

  it("drops a text that would run into the next circle", () => {
    // "claude-sonnet-4-5" is 119 px: from 100 it would reach the circle at 200.
    const kept = place([
      { id: "a", x: 100, text: "claude-sonnet-4-5" },
      { id: "b", x: 200, text: "Read" },
    ]);
    expect(kept.has("a")).toBe(false);
    expect(kept.get("b")?.text).toBe("Read");
  });

  it("never lets two kept texts overlap, at any spacing", () => {
    const markers: LaneMarker[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      x: 20 + i * (7 + (i % 5) * 9),
      text: ["Bash", "Read", "claude-sonnet-4-5", "Edit", null][i % 5] ?? null,
    }));
    const kept = [...place(markers).values()].sort((a, b) => a.left - b.left);
    for (let i = 1; i < kept.length; i++) {
      const prev = kept[i - 1]!;
      expect(kept[i]!.left).toBeGreaterThanOrEqual(prev.left + prev.width + MARKER_TEXT_CLEARANCE_PX);
    }
    // And no kept text covers any circle but its own.
    const byId = new Map(markers.map((m) => [m.id, m]));
    for (const [id, label] of place(markers)) {
      for (const other of markers) {
        if (other.id === id) continue;
        const overlaps = other.x - half < label.left + label.width && other.x + half > label.left;
        expect(overlaps, `${id} over ${other.id}`).toBe(false);
      }
      expect(byId.get(id)!.text).toBe(label.text);
    }
  });

  it("drops a text that would cross the panel's right edge", () => {
    const kept = place([{ id: "a", x: right - half - 10, text: "Bash" }]);
    expect(kept.size).toBe(0);
  });

  it("keeps only the first of two markers at one instant", () => {
    const kept = place([
      { id: "b", x: 300, text: "Read" },
      { id: "a", x: 300, text: "Bash" },
    ]);
    expect([...kept.keys()]).toEqual(["a"]);
  });

  it("does not depend on the input order", () => {
    const markers: LaneMarker[] = [
      { id: "a", x: 100, text: "Bash" },
      { id: "b", x: 150, text: "Read" },
      { id: "c", x: 400, text: "Edit" },
    ];
    const forward = [...place(markers).keys()];
    const backward = [...place([...markers].reverse()).keys()];
    expect(backward).toEqual(forward);
  });

  it("lets a marker without text block another's text", () => {
    const kept = place([
      { id: "a", x: 100, text: "Bash" },
      { id: "b", x: 130, text: null },
    ]);
    expect(kept.size).toBe(0);
  });
});

describe("markerText on the run's own model", () => {
  it("drops an LLM call's text when it is the run's model, as the lane label shows it", () => {
    expect(
      markerText({ eventType: "post_call", model: "claude-sonnet-4-5-20250929" }, "claude-sonnet-4-5-20250929"),
    ).toBeNull();
    // Same model, one with its date suffix: still the run's model.
    expect(markerText({ eventType: "post_call", model: "claude-sonnet-4-5" }, "claude-sonnet-4-5-20250929")).toBeNull();
  });

  it("keeps an LLM call on another model, and every tool name", () => {
    expect(markerText({ eventType: "post_call", model: "claude-haiku-4-5" }, "claude-sonnet-4-5")).toBe(
      "claude-haiku-4-5",
    );
    expect(markerText({ eventType: "tool_call", toolName: "Bash" }, "claude-sonnet-4-5")).toBe("Bash");
    expect(markerText({ eventType: "post_call", model: "gpt-4o" }, null)).toBe("gpt-4o");
  });
});

describe("placeMarkerLabels inside the visible range", () => {
  const half = 14;
  const opts = { circleSize: 28, left: 200, right: 700 };

  it("keeps a text only when its whole circle is in view", () => {
    const kept = placeMarkerLabels(
      [
        { id: "under-label", x: 200 + half - 1, text: "Bash" },
        { id: "inside", x: 300, text: "Read" },
        { id: "past-edge", x: 700 - half + 1, text: "Edit" },
      ],
      opts,
    );
    expect([...kept.keys()]).toEqual(["inside"]);
  });

  it("drops a text that would run past the right of the range", () => {
    const kept = placeMarkerLabels([{ id: "a", x: 700 - half - 10, text: "Bash" }], opts);
    expect(kept.size).toBe(0);
  });
});

/** The quadratic scan placeMarkerLabels replaced: every circle against
 *  every text. The fast scan must keep exactly the same texts. */
function naivePlace(markers: readonly LaneMarker[], circleSize: number, right: number) {
  const sorted = [...markers].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const half = circleSize / 2;
  const kept = new Map<string, number>();
  let lastTextRight = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (!m.text || m.x + half > right) continue;
    const left = m.x + half + MARKER_TEXT_GAP_PX;
    const end = left + markerTextWidth(m.text);
    if (end > right || left < lastTextRight + MARKER_TEXT_CLEARANCE_PX) continue;
    let hit = false;
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue;
      const o = sorted[j]!;
      if (o.x - half < end + MARKER_TEXT_CLEARANCE_PX && o.x + half > left) hit = true;
    }
    if (hit) continue;
    kept.set(m.id, left);
    lastTextRight = end;
  }
  return kept;
}

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

function randomMarkers(n: number, width: number, seed: number): LaneMarker[] {
  const rand = mulberry32(seed);
  const texts = ["Bash", "Read", "Edit", "claude-sonnet-4-5", "WebFetch", null];
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(5, "0")}`,
    // Some markers share an instant, as events in one millisecond do.
    x: rand() < 0.1 && i > 0 ? Math.floor(rand() * width) : rand() * width,
    text: texts[Math.floor(rand() * texts.length)] ?? null,
  }));
}

describe("placeMarkerLabels scan", () => {
  it("keeps exactly what the full scan keeps, on random lanes", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const markers = randomMarkers(300 + seed * 20, 862, seed);
      const fast = placeMarkerLabels(markers, { circleSize: 28, right: 881 });
      const naive = naivePlace(markers, 28, 881);
      expect([...fast.keys()].sort(), `seed ${seed}`).toEqual([...naive.keys()].sort());
      for (const [id, left] of naive) expect(fast.get(id)!.left).toBe(left);
    }
  });

  it("stays fast on a busy run: thirty thousand markers well under a second", () => {
    // The full scan compares every circle with every text: 9e8 steps
    // here, seconds. The scan stops at the first circle past a text.
    const markers = randomMarkers(30_000, 862, 7);
    const t0 = performance.now();
    placeMarkerLabels(markers, { circleSize: 28, right: 881 });
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("placeMarkerLabels on a tall lane", () => {
  const tall = MARKER_TEXT_STACKED_MIN_LANE_PX;
  const place = (markers: LaneMarker[], laneHeight = tall) =>
    placeMarkerLabels(markers, { circleSize: 28, right: 881, laneHeight });

  it("names a threshold that holds the hover circle and a text above and below", () => {
    expect(MARKER_TEXT_STACKED_MIN_LANE_PX).toBe(
      RUN_LANE_CIRCLE_HOVER_PX + 2 * (MARKER_TEXT_STACK_GAP_PX + MARKER_TEXT_FONT_PX),
    );
    expect(MARKER_TEXT_STACKED_MIN_LANE_PX).toBeGreaterThan(RUN_LANE_MIN_HEIGHT_PX);
  });

  it("centres texts above and below their circles on alternating rows", () => {
    // 30 px apart: too close for texts beside the circles, room enough
    // for texts on alternating rows.
    const kept = place([
      { id: "a", x: 100, text: "Bash" },
      { id: "b", x: 130, text: "Read" },
      { id: "c", x: 160, text: "Edit" },
    ]);
    expect([...kept.values()].map((l) => l.row)).toEqual(["above", "below", "above"]);
    const a = kept.get("a")!;
    expect(a.left + a.width / 2).toBe(100);
  });

  it("only keeps a text clear of the texts on its row, not of circles", () => {
    // Three markers 10 px apart: a and b take the two rows; c fits on
    // neither, its circle stays.
    const kept = place([
      { id: "a", x: 100, text: "Bash" },
      { id: "b", x: 110, text: "Read" },
      { id: "c", x: 120, text: "Edit" },
    ]);
    expect([...kept.keys()]).toEqual(["a", "b"]);
  });

  it("puts a text on the other row when its turn's row is taken", () => {
    const kept = place([
      { id: "a", x: 100, text: "claude-sonnet-4-5" },
      { id: "b", x: 104, text: "Bash" },
      { id: "c", x: 140, text: "Read" },
    ]);
    // a above (119 px wide, to 159.5), b below (to 118). c's turn is
    // above, still taken by a's text; it goes below, clear of b's.
    expect([...kept.entries()].map(([id, l]) => [id, l.row])).toEqual([
      ["a", "above"],
      ["b", "below"],
      ["c", "below"],
    ]);
  });

  it("keeps texts beside the circles on a lane at the minimum height", () => {
    const kept = place([{ id: "a", x: 100, text: "Bash" }], RUN_LANE_MIN_HEIGHT_PX);
    expect(kept.get("a")!.row).toBe("beside");
  });
});

describe("feedHeightCap", () => {
  it("leaves the feed alone while the lanes fit", () => {
    // 3 lanes in 150 px fit at 40 px: the cap is above the feed's 240.
    expect(feedHeightCap({ laneCount: 3, laneSpacePx: 150, feedHeightPx: 240 })).toBeGreaterThanOrEqual(240);
  });

  it("gives up the shortfall so three lanes fit", () => {
    // 3 × 40 = 120 needed, 87 left: the feed gives up 33 px.
    expect(feedHeightCap({ laneCount: 3, laneSpacePx: 87, feedHeightPx: 240 })).toBe(207);
  });

  it("gives up only what three lanes need when there are more", () => {
    expect(feedHeightCap({ laneCount: 5, laneSpacePx: 87, feedHeightPx: 240 })).toBe(207);
  });

  it("never takes the feed below its minimum: past it, the lanes scroll", () => {
    expect(feedHeightCap({ laneCount: 3, laneSpacePx: 0, feedHeightPx: 130 })).toBe(FEED_MIN_HEIGHT_PX);
    // The column header and three 30 px rows.
    expect(FEED_MIN_HEIGHT_PX).toBe(24 + 3 * 30);
  });

  it("settles: once the feed has given up the shortfall, the cap holds", () => {
    const cap = feedHeightCap({ laneCount: 3, laneSpacePx: 87, feedHeightPx: 240 });
    // The feed now takes ``cap``; the lanes gained 240 - cap px.
    expect(feedHeightCap({ laneCount: 3, laneSpacePx: 87 + (240 - cap), feedHeightPx: cap })).toBe(cap);
  });

  it("asks nothing with no lanes", () => {
    expect(feedHeightCap({ laneCount: 0, laneSpacePx: -10, feedHeightPx: 240 })).toBe(230);
  });
});

describe("measureMarkerText", () => {
  it("falls back to the estimate without a font loading API (jsdom)", () => {
    expect(measureMarkerText("Bash")).toBe(markerTextWidth("Bash"));
  });
});
