import { EVENT_CIRCLE_SIZE } from "@/lib/constants";

// Pure layout for the per-agent swimlane modal's run lanes: how tall
// each lane is, and which event circles carry a short text beside them.
// No React and no DOM; the components pass measured or estimated sizes
// in.

/** The Fleet view's agent row height, the unit the lane bounds below
 *  are reasoned in. */
const FLEET_ROW_HEIGHT_PX = 48;

/** An event circle in a modal lane: larger than the Fleet row's 22 px
 *  one-line circle, so a run read on its own lane is easier to scan and
 *  to hit. */
export const RUN_LANE_CIRCLE_SIZE_PX = 28;

/** The run-lane circle's icon: about 60% of the circle, as the Fleet
 *  row's 13 px icon is of its 22 px circle. */
export const RUN_LANE_ICON_SIZE_PX = 17;

/** The hover scale ``EventNode`` applies to a circle. */
export const CIRCLE_HOVER_SCALE = 1.25;

/** A run-lane circle's footprint at its hover scale, rounded up. */
export const RUN_LANE_CIRCLE_HOVER_PX = Math.ceil(RUN_LANE_CIRCLE_SIZE_PX * CIRCLE_HOVER_SCALE);

/**
 * The shortest lane: room for a circle at its hover scale (28 px × 1.25
 * = 35 px) with a few pixels above and below, and for the lane label's
 * two 11 px lines (the run id with its state, then the model and tokens).
 * Below it the lanes stop shrinking and the lane area scrolls.
 */
export const RUN_LANE_MIN_HEIGHT_PX = 40;

/**
 * The tallest lane: three Fleet rows. A lane's marks and their text are
 * one line, so a taller lane holds nothing more, and a single run (or
 * two runs on a large screen) stops here rather than filling the modal.
 */
export const RUN_LANE_MAX_HEIGHT_PX = 3 * FLEET_ROW_HEIGHT_PX;

/** The heading above an agent's lanes, which carries the row's label
 *  strip: the strip's 18 px pills with 7 px above and below. */
export const RUN_LANE_HEADING_HEIGHT_PX = 32;

export interface RunLaneHeights {
  /** Each lane's height, a whole number of px. */
  laneHeight: number;
  /** All lanes together. */
  totalHeight: number;
  /** The lanes at their minimum still exceed the space, so the lane
   *  area scrolls. */
  scrolls: boolean;
}

/**
 * The height of each of ``laneCount`` lanes sharing ``availablePx``: an
 * equal whole-pixel share, so the lanes never overshoot the space by a
 * rounding pixel, kept between ``RUN_LANE_MIN_HEIGHT_PX`` and
 * ``RUN_LANE_MAX_HEIGHT_PX``. A single lane therefore stops at the
 * maximum, and lanes whose minimum does not fit stay at the minimum and
 * scroll. With no lanes, nothing is drawn.
 */
export function runLaneHeights(laneCount: number, availablePx: number): RunLaneHeights {
  const count = Math.max(0, Math.floor(laneCount));
  if (count === 0) return { laneHeight: 0, totalHeight: 0, scrolls: false };
  const share = Number.isFinite(availablePx) ? Math.floor(Math.max(availablePx, 0) / count) : 0;
  const laneHeight = Math.min(Math.max(share, RUN_LANE_MIN_HEIGHT_PX), RUN_LANE_MAX_HEIGHT_PX);
  const totalHeight = laneHeight * count;
  return { laneHeight, totalHeight, scrolls: totalHeight > Math.max(availablePx, 0) };
}

/**
 * The Live feed's column-header row and one of its event rows, in px
 * (``LiveFeed``'s ``h-6`` header and ``h-[30px]`` rows).
 */
const FEED_COLUMN_HEADER_PX = 24;
const FEED_ROW_PX = 30;

/**
 * The shortest the per-agent modal's Live feed body gets when it gives
 * up height to the lanes: its column header plus three event rows,
 * enough to read the newest events and see the feed move.
 */
export const FEED_MIN_HEIGHT_PX = FEED_COLUMN_HEADER_PX + 3 * FEED_ROW_PX;

/** How many lanes the feed gives up height for before the lanes scroll:
 *  three runs side by side, the fan-out an operator most often opens
 *  the modal to read. */
export const RUN_LANES_FEED_YIELDS_FOR = 3;

/**
 * The most height the Live feed body may take so the lanes fit: when
 * ``laneCount`` lanes at the minimum do not fit in ``laneSpacePx`` (the
 * space left for them now, with the feed body at ``feedHeightPx``), the
 * feed gives up the shortfall, down to ``FEED_MIN_HEIGHT_PX``, until
 * ``RUN_LANES_FEED_YIELDS_FOR`` of them fit; past that the lanes scroll.
 * With room to spare the cap rises above the feed, which then keeps its
 * own height.
 */
export function feedHeightCap({
  laneCount,
  laneSpacePx,
  feedHeightPx,
}: {
  laneCount: number;
  laneSpacePx: number;
  feedHeightPx: number;
}): number {
  const need = Math.min(Math.max(0, laneCount), RUN_LANES_FEED_YIELDS_FOR) * RUN_LANE_MIN_HEIGHT_PX;
  return Math.max(FEED_MIN_HEIGHT_PX, feedHeightPx + laneSpacePx - need);
}

/** Space between a circle's right edge and its text. */
export const MARKER_TEXT_GAP_PX = 4;

/** The marker text's font size; the text is set in the mono font. */
export const MARKER_TEXT_FONT_PX = 11;

/** Space between the marker text's bottom and the lane's centre, where
 *  the 2 px run line runs: a text beside its circle sits just above the
 *  line, so the line never strikes through it. */
export const MARKER_TEXT_LINE_CLEARANCE_PX = 3;

/** The advance of one character of the mono font at
 *  ``MARKER_TEXT_FONT_PX``: GeistMono, measured in Chromium, advances
 *  7 px per character at 11 px, every Latin character alike. It is the
 *  estimate; in a browser ``measureMarkerText`` also measures the text
 *  with a canvas and takes the wider, so a wide glyph (CJK) is not
 *  undercounted. A browser minimum font size above 11 px still widens
 *  the drawn text past both. */
export const MARKER_TEXT_CHAR_PX = 7;

/** The longest text a marker carries, the ellipsis included: a tool
 *  name reads whole (Bash, Read, Edit, WebFetch), and a model name keeps
 *  its family and version (``claude-sonnet-4-5``). */
export const MARKER_TEXT_MAX_CHARS = 18;

/** Clear space kept between one marker's text and the next mark. */
export const MARKER_TEXT_CLEARANCE_PX = 2;

/** Space between a circle at its hover scale and a text stacked above
 *  or below it. */
export const MARKER_TEXT_STACK_GAP_PX = 3;

/**
 * The lane height from which marker texts stack above and below their
 * circle instead of beside it: the circle at its hover scale, and a
 * text line with its gap above and below it.
 */
export const MARKER_TEXT_STACKED_MIN_LANE_PX =
  RUN_LANE_CIRCLE_HOVER_PX + 2 * (MARKER_TEXT_STACK_GAP_PX + MARKER_TEXT_FONT_PX);

const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set(["tool_call", "mcp_tool_call"]);
const LLM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "pre_call",
  "post_call",
  "embeddings",
  "llm_error",
]);

// A model id's dated snapshot suffix (``claude-sonnet-4-5-20250929``).
const MODEL_DATE_SUFFIX = /-\d{8}$/;

/** ``text`` cut to ``MARKER_TEXT_MAX_CHARS``, ending in an ellipsis
 *  when cut. */
export function shortenMarkerText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MARKER_TEXT_MAX_CHARS) return text;
  return `${chars.slice(0, MARKER_TEXT_MAX_CHARS - 1).join("")}…`;
}

function modelText(model: string | null | undefined): string | null {
  const name = model?.trim().replace(MODEL_DATE_SUFFIX, "");
  return name ? shortenMarkerText(name) : null;
}

/**
 * The short text beside an event's circle: a tool call's tool name, an
 * LLM call's model without its date suffix, else null (no text). An LLM
 * call on the run's own model (``runModel``, which the lane label shows)
 * carries none, so the room goes to the tool names.
 */
export function markerText(
  event: { eventType: string; toolName?: string | null; model?: string | null },
  runModel?: string | null,
): string | null {
  if (TOOL_EVENT_TYPES.has(event.eventType)) {
    const tool = event.toolName?.trim();
    return tool ? shortenMarkerText(tool) : null;
  }
  if (LLM_EVENT_TYPES.has(event.eventType)) {
    const text = modelText(event.model);
    return text !== null && text === modelText(runModel) ? null : text;
  }
  return null;
}

/** The events that count as one LLM call each. A ``pre_call`` is the
 *  start of a call its ``post_call`` or ``llm_error`` ends, so it does
 *  not count again. */
const MODEL_CALL_EVENT_TYPES: ReadonlySet<string> = new Set(["post_call", "embeddings", "llm_error"]);

/** Each model's LLM calls among ``events`` inside ``[d0, d1]``. */
export function modelCallCounts(
  events: readonly { event_type: string; model?: string | null; occurred_at: string }[] | undefined,
  d0: number,
  d1: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events ?? []) {
    if (!MODEL_CALL_EVENT_TYPES.has(event.event_type) || !event.model) continue;
    const t = Date.parse(event.occurred_at);
    if (!(t >= d0 && t <= d1)) continue;
    counts.set(event.model, (counts.get(event.model) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many more calls in the window another model needs than the lane's
 * model before the lane takes it: one call entering or leaving the
 * window moves a count by one, so an evenly mixed run cannot flip the
 * lane's model as the window slides, while a run that has moved to
 * another model takes it within two calls.
 */
export const LANE_MODEL_SWITCH_LEAD = 2;

/**
 * The model a run's lane names, and leaves out of its marker text, given
 * the model it names now (``current``, null on the lane's first render),
 * each model's calls in the window and the session row's model.
 *
 * On the first render: the model of most calls, ties going to the
 * session row's model, then to name order; with no call in the window,
 * the session row's model. Afterwards the lane keeps its model until
 * another one has ``LANE_MODEL_SWITCH_LEAD`` more calls in the window.
 * Neither choice depends on which call is oldest in the window, so the
 * window's sliding edge alone cannot change it.
 */
export function chooseLaneModel(
  current: string | null,
  counts: ReadonlyMap<string, number>,
  sessionModel: string | null,
): string | null {
  if (current === null) {
    // Most calls; a tie goes to the session row's model, then to name order.
    const preferOnTie = (a: string, b: string) =>
      a === sessionModel ? true : b === sessionModel ? false : a < b;
    let best: string | null = null;
    let bestCalls = 0;
    for (const [model, calls] of counts) {
      if (best === null || calls > bestCalls || (calls === bestCalls && preferOnTie(model, best))) {
        best = model;
        bestCalls = calls;
      }
    }
    return best ?? sessionModel;
  }
  // The strongest other model, ties to name order, takes over only with
  // the lead.
  const held = counts.get(current) ?? 0;
  let leader: string | null = null;
  let leaderCalls = 0;
  for (const [model, calls] of counts) {
    if (model === current) continue;
    if (leader === null || calls > leaderCalls || (calls === leaderCalls && model < leader)) {
      leader = model;
      leaderCalls = calls;
    }
  }
  return leader !== null && leaderCalls - held >= LANE_MODEL_SWITCH_LEAD ? leader : current;
}

/** A circle on a lane, for ``placeMarkerLabels``. */
export interface LaneMarker {
  id: string;
  /** The circle's centre. */
  x: number;
  /** The text beside it, or null for none. */
  text: string | null;
}

/** Where a kept text sits: beside its circle (right of it, just above
 *  the run line), or centred above or below it on a tall lane. */
export type MarkerTextRow = "beside" | "above" | "below";

/** A kept marker text: where it starts, how wide it is, and its row. */
export interface PlacedMarkerLabel {
  text: string;
  left: number;
  width: number;
  row: MarkerTextRow;
}

/** The estimated width of ``text`` in the marker font. */
export function markerTextWidth(text: string): number {
  return Array.from(text).length * MARKER_TEXT_CHAR_PX;
}

let monoMeasure: ((text: string) => number) | null | undefined;

/**
 * The width of ``text`` in the marker font: the estimate, or wider where
 * a canvas measures it wider (a CJK glyph). Without the font loading API
 * (jsdom) or a 2D canvas, the estimate.
 */
export function measureMarkerText(text: string): number {
  if (monoMeasure === undefined) {
    monoMeasure = null;
    if (typeof document !== "undefined" && "fonts" in document) {
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx) {
        const family = getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim();
        ctx.font = `${MARKER_TEXT_FONT_PX}px ${family || "monospace"}`;
        monoMeasure = (t) => ctx.measureText(t).width;
      }
    }
  }
  const estimate = markerTextWidth(text);
  return monoMeasure ? Math.max(estimate, monoMeasure(text)) : estimate;
}

/**
 * Which markers keep their text, by marker id, inside the visible range
 * ``[left, right]`` of the panel (the part not under the sticky label
 * column, not past the scroll viewport's edge, and not past "now"). A
 * text is kept only when its circle is wholly in the range and the text
 * is too.
 *
 * On a lane shorter than ``MARKER_TEXT_STACKED_MIN_LANE_PX``, taking
 * markers left to right, a text starts ``MARKER_TEXT_GAP_PX`` right of
 * its circle and must stay ``MARKER_TEXT_CLEARANCE_PX`` clear of the
 * last kept text and of every other circle. Only circles to the right
 * can reach it, so the scan stops at the first circle past its end:
 * O(n log n + n·k), k the circles a text spans.
 *
 * On a taller lane, a text is centred above or below its circle, on the
 * row other than the last kept text's when it fits there, else on the
 * other row; it only has to stay clear of the texts on its row.
 *
 * A text that does not fit is dropped; its circle stays.
 */
export function placeMarkerLabels(
  markers: readonly LaneMarker[],
  {
    circleSize = EVENT_CIRCLE_SIZE,
    left = Number.NEGATIVE_INFINITY,
    right,
    laneHeight = 0,
    measure = markerTextWidth,
  }: {
    circleSize?: number;
    left?: number;
    right: number;
    laneHeight?: number;
    measure?: (text: string) => number;
  },
): Map<string, PlacedMarkerLabel> {
  const sorted = [...markers].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const half = circleSize / 2;
  const stacked = laneHeight >= MARKER_TEXT_STACKED_MIN_LANE_PX;
  const kept = new Map<string, PlacedMarkerLabel>();
  let lastTextRight = Number.NEGATIVE_INFINITY;
  const rowRight: Record<"above" | "below", number> = {
    above: Number.NEGATIVE_INFINITY,
    below: Number.NEGATIVE_INFINITY,
  };
  let lastRow: "above" | "below" = "below";
  for (let i = 0; i < sorted.length; i++) {
    const marker = sorted[i]!;
    if (!marker.text) continue;
    if (marker.x - half < left || marker.x + half > right) continue;
    const width = measure(marker.text);
    if (stacked) {
      const textLeft = marker.x - width / 2;
      const end = textLeft + width;
      if (textLeft < left || end > right) continue;
      const preferred: "above" | "below" = lastRow === "above" ? "below" : "above";
      const other: "above" | "below" = preferred === "above" ? "below" : "above";
      const row: "above" | "below" | null =
        textLeft >= rowRight[preferred] + MARKER_TEXT_CLEARANCE_PX
          ? preferred
          : textLeft >= rowRight[other] + MARKER_TEXT_CLEARANCE_PX
            ? other
            : null;
      if (row === null) continue;
      kept.set(marker.id, { text: marker.text, left: textLeft, width, row });
      rowRight[row] = end;
      lastRow = row;
      continue;
    }
    const textLeft = marker.x + half + MARKER_TEXT_GAP_PX;
    const end = textLeft + width;
    if (end > right) continue;
    if (textLeft < lastTextRight + MARKER_TEXT_CLEARANCE_PX) continue;
    // A circle at or left of this one ends before the text starts.
    let hitsCircle = false;
    for (let j = i + 1; j < sorted.length; j++) {
      const circleLeft = sorted[j]!.x - half;
      if (circleLeft >= end + MARKER_TEXT_CLEARANCE_PX) break;
      if (sorted[j]!.x + half > textLeft) {
        hitsCircle = true;
        break;
      }
    }
    if (hitsCircle) continue;
    kept.set(marker.id, { text: marker.text, left: textLeft, width, row: "beside" });
    lastTextRight = end;
  }
  return kept;
}
