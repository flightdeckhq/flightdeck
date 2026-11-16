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

/** Space between a circle's right edge and its text. */
export const MARKER_TEXT_GAP_PX = 4;

/** The marker text's font size; the text is set in the mono font. */
export const MARKER_TEXT_FONT_PX = 11;

/** Space between the marker text's bottom and the lane's centre, where
 *  the 2 px run line runs: the text sits just above the line, so the
 *  line never strikes through it. */
export const MARKER_TEXT_LINE_CLEARANCE_PX = 3;

/** The advance of one character of the mono font at
 *  ``MARKER_TEXT_FONT_PX``: GeistMono, measured in Chromium, advances
 *  7 px per character at 11 px, every character alike. The text's width
 *  is its length times this; the narrower ``ui-monospace`` fallback
 *  only leaves more room. */
export const MARKER_TEXT_CHAR_PX = 7;

/** The longest text a marker carries, the ellipsis included: a tool
 *  name reads whole (Bash, Read, Edit, WebFetch), and a model name keeps
 *  its family and version (``claude-sonnet-4-5``). */
export const MARKER_TEXT_MAX_CHARS = 18;

/** Clear space kept between one marker's text and the next mark. */
export const MARKER_TEXT_CLEARANCE_PX = 2;

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

/**
 * The short text beside an event's circle: a tool call's tool name, an
 * LLM call's model without its date suffix, else null (no text).
 */
export function markerText(event: {
  eventType: string;
  toolName?: string | null;
  model?: string | null;
}): string | null {
  if (TOOL_EVENT_TYPES.has(event.eventType)) {
    const tool = event.toolName?.trim();
    return tool ? shortenMarkerText(tool) : null;
  }
  if (LLM_EVENT_TYPES.has(event.eventType)) {
    const model = event.model?.trim().replace(MODEL_DATE_SUFFIX, "");
    return model ? shortenMarkerText(model) : null;
  }
  return null;
}

/** A circle on a lane, for ``placeMarkerLabels``. */
export interface LaneMarker {
  id: string;
  /** The circle's centre. */
  x: number;
  /** The text beside it, or null for none. */
  text: string | null;
}

/** A kept marker text: where it starts and how wide it is. */
export interface PlacedMarkerLabel {
  text: string;
  left: number;
  width: number;
}

/** The width of ``text`` in the marker font. */
export function markerTextWidth(text: string): number {
  return Array.from(text).length * MARKER_TEXT_CHAR_PX;
}

/**
 * Which markers keep their text, by marker id. Taking markers left to
 * right, a text starts ``MARKER_TEXT_GAP_PX`` right of its circle and
 * is kept when it ends inside ``right`` (the panel's edge) and stays
 * ``MARKER_TEXT_CLEARANCE_PX`` clear of the last kept text and of every
 * other circle. A text that would collide is dropped; its circle stays.
 */
export function placeMarkerLabels(
  markers: readonly LaneMarker[],
  {
    circleSize = EVENT_CIRCLE_SIZE,
    right,
    measure = markerTextWidth,
  }: { circleSize?: number; right: number; measure?: (text: string) => number },
): Map<string, PlacedMarkerLabel> {
  const sorted = [...markers].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const half = circleSize / 2;
  const kept = new Map<string, PlacedMarkerLabel>();
  let lastTextRight = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < sorted.length; i++) {
    const marker = sorted[i]!;
    if (!marker.text) continue;
    const left = marker.x + half + MARKER_TEXT_GAP_PX;
    const width = measure(marker.text);
    const end = left + width;
    if (end > right) continue;
    if (left < lastTextRight + MARKER_TEXT_CLEARANCE_PX) continue;
    let hitsCircle = false;
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue;
      const other = sorted[j]!;
      const circleLeft = other.x - half;
      const circleRight = other.x + half;
      if (circleLeft < end + MARKER_TEXT_CLEARANCE_PX && circleRight > left) {
        hitsCircle = true;
        break;
      }
    }
    if (hitsCircle) continue;
    kept.set(marker.id, { text: marker.text, left, width });
    lastTextRight = end;
  }
  return kept;
}
