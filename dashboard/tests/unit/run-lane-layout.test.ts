import { describe, it, expect } from "vitest";
import {
  MARKER_TEXT_CHAR_PX,
  MARKER_TEXT_CLEARANCE_PX,
  MARKER_TEXT_GAP_PX,
  MARKER_TEXT_MAX_CHARS,
  RUN_LANE_CIRCLE_SIZE_PX,
  RUN_LANE_MAX_HEIGHT_PX,
  RUN_LANE_MIN_HEIGHT_PX,
  markerText,
  markerTextWidth,
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
