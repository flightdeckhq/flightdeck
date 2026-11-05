import type { AgentEvent, CloseReason, Session } from "@/lib/types";
import { ATTACH_MATCH_WINDOW_MS } from "@/lib/events";
import { EVENT_CIRCLE_SIZE } from "@/lib/constants";

// Pure layout for the runs on a swimlane row: where each run's
// segments start and end, which track each segment takes, which lane
// of the row it draws in, where each glyph goes so that no two cover
// each other, and where each run line runs. No React, no DOM, and no
// D3 beyond the caller's scale, passed in as ``toX``.

/**
 * Two segments whose extents overlap by no more than this are a
 * hand-off, not an overlap. The worker stamps a run's ``started_at``
 * and the previous run's ``ended_at`` with its own clock as it
 * processes each event, so an end processed just after the next start
 * leaves the two runs overlapping by a few milliseconds. One second
 * absorbs that skew and is still far below anything an operator reads
 * as two runs at once. The layout widens it to one pixel of the window
 * when that is longer (about 4 s at 1h): an overlap narrower than a
 * pixel cannot be seen, so it must not split the row.
 */
export const OVERLAP_TOLERANCE_MS = 1_000;

/** Width and height of the start glyph (▶). About the visual weight
 *  of an event circle's icon, so the start mark does not dominate the
 *  row. */
export const START_GLYPH_SIZE_PX = 10;

/** Side of the end glyph (■). Its area is about 1.3 times the
 *  triangle's bounding box (sqrt(1.3 × 10 × 10) ≈ 11.4, kept on the
 *  integer pixel grid), so the closure reads heavier than the start. */
export const END_GLYPH_SIZE_PX = 11;

/** Space between two glyphs packed side by side on one edge: enough
 *  for the eye and the pointer to tell them apart, small enough that a
 *  hand-off still reads as one instant. */
export const GLYPH_GAP_PX = 1;

/** How far inside its segment a glyph sits: the ▶'s flat base 1 px
 *  right of the segment's start, the ■'s right edge 1 px left of its
 *  end, so both marks stay inside the run's span. */
export const GLYPH_BOUNDARY_INSET_PX = 1;

/** The farthest packing moves a glyph from where its time puts it.
 *  It is the shift a zero-length segment's ■ needs to follow its own ▶
 *  (the ▶'s inset and width, the gap, the ■'s width and inset), about
 *  two glyph widths: far enough to spread a few glyphs that want one
 *  spot, near enough that a glyph still reads as its run's. Past it,
 *  glyphs overlap near their own time instead of drifting along a busy
 *  row. */
export const MAX_GLYPH_SHIFT_PX =
  GLYPH_BOUNDARY_INSET_PX + START_GLYPH_SIZE_PX + GLYPH_GAP_PX + END_GLYPH_SIZE_PX + GLYPH_BOUNDARY_INSET_PX;

/** The most lanes a row splits into. Four keeps apart the four runs of
 *  one agent seen open at once (a Claude Code coordinator fanning out
 *  same-role sub-agents) at circles still 10 px across; every run past
 *  the fourth lane shares it (the overflow lane). */
export const MAX_RUN_LANES = 4;

/** The height the lanes split: the 48 px row less its 1 px bottom
 *  border. */
export const ROW_CONTENT_HEIGHT_PX = 47;

/** Mark sizes at one lane count, in px. */
export interface LaneGeometry {
  /** Event circle diameter. */
  circle: number;
  /** The circle's icon; 0 draws none. */
  icon: number;
  /** The ▶'s width and height. */
  startGlyph: number;
  /** The ■'s side. */
  endGlyph: number;
}

/**
 * Mark sizes by lane count (index 0: one lane). Each circle leaves at
 * least 1.75 px between the circles of neighbouring lanes
 * (``ROW_CONTENT_HEIGHT_PX / lanes - circle``), so two lanes never
 * read as one blob, and each icon is about 60% of its circle, as the
 * one-line circle's 13 px icon is of 22 px. A 10 px circle has no room
 * for an icon that reads, so it is coloured only. The glyphs keep their
 * size until four lanes, where an 11 px ■ would nearly fill the
 * 11.75 px lane; there both shrink by 2 px, keeping the ■ heavier than
 * the ▶.
 */
export const LANE_GEOMETRY: readonly LaneGeometry[] = [
  { circle: EVENT_CIRCLE_SIZE, icon: 13, startGlyph: START_GLYPH_SIZE_PX, endGlyph: END_GLYPH_SIZE_PX },
  { circle: 18, icon: 11, startGlyph: START_GLYPH_SIZE_PX, endGlyph: END_GLYPH_SIZE_PX },
  { circle: 12, icon: 8, startGlyph: START_GLYPH_SIZE_PX, endGlyph: END_GLYPH_SIZE_PX },
  { circle: 10, icon: 0, startGlyph: START_GLYPH_SIZE_PX - 2, endGlyph: END_GLYPH_SIZE_PX - 2 },
];

/** The mark sizes for a row of ``laneCount`` lanes. */
export function laneGeometry(laneCount: number): LaneGeometry {
  const index = Math.min(Math.max(Math.round(laneCount), 1), LANE_GEOMETRY.length) - 1;
  return LANE_GEOMETRY[index]!;
}

/** The centre of ``lane`` as a percentage of the row's content height:
 *  50 on a one-line row. */
export function laneCentrePct(lane: number, laneCount: number): number {
  const count = Math.max(laneCount, 1);
  return ((Math.min(Math.max(lane, 0), count - 1) + 0.5) * 100) / count;
}

/** The ``close_reason`` of the ``session_end`` the worker's
 *  orphan-timeout reaper writes when it closes a run that stayed lost
 *  past ``FLIGHTDECK_ORPHAN_TIMEOUT_HOURS``. */
const REAPER_CLOSE_REASON: CloseReason = "orphan_timeout";

/** How a segment ends. ``open`` has no end yet; ``lost`` ends at the
 *  run's last signal (a lost run, or one the reaper closed). */
export type SegmentEndKind = "open" | "closed" | "lost";

/** One stretch of a run, from a ``session_start`` to the following
 *  ``session_end``. A run that ended and was resumed has several, with
 *  gaps between them. */
export interface RunSegment {
  sessionId: string;
  /** Position among the run's segments, oldest first. */
  index: number;
  /** How many segments the run has, as far as its loaded events tell. */
  count: number;
  startMs: number;
  /** ``Number.POSITIVE_INFINITY`` while the segment is open. */
  endMs: number;
  endKind: SegmentEndKind;
  /** On the open segment of a run the worker marked ``stale``: its
   *  ``last_seen_at``, from where the run has been quiet. */
  quietSinceMs?: number;
}

/** The session row fields ``runSegments`` reads. ``close_reasons`` is
 *  present on rows that came from ``GET /v1/sessions``. */
export type SegmentSession = Pick<
  Session,
  "session_id" | "state" | "started_at" | "ended_at" | "last_seen_at"
> & { close_reasons?: readonly string[] | null };

/** The event fields ``runSegments`` reads. */
export type SegmentEvent = Pick<AgentEvent, "id" | "event_type" | "occurred_at" | "payload">;

function parseMs(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// At one instant a session_end sorts before other events, and a
// session_start after them, so a run that ends and resumes in the same
// millisecond closes one segment before opening the next.
function boundaryRank(eventType: string): number {
  if (eventType === "session_end") return 0;
  if (eventType === "session_start") return 2;
  return 1;
}

/** The end of a run's last segment, as its session row describes it. */
function lastSegmentEnd(
  session: SegmentSession,
  segmentStartMs: number,
  lastSeenMs: number,
): { endMs: number; endKind: SegmentEndKind; quietSinceMs?: number } {
  if (session.state === "lost") {
    return { endMs: Math.max(lastSeenMs, segmentStartMs), endKind: "lost" };
  }
  if (session.state === "closed") {
    // The reaper stamps ended_at and leaves last_seen_at at the run's
    // last signal, so a reaped run ends there.
    if (session.close_reasons?.includes(REAPER_CLOSE_REASON)) {
      return { endMs: Math.max(lastSeenMs, segmentStartMs), endKind: "lost" };
    }
    const endedMs = parseMs(session.ended_at);
    return {
      endMs: Math.max(Number.isNaN(endedMs) ? lastSeenMs : endedMs, segmentStartMs),
      endKind: "closed",
    };
  }
  // active, idle and stale runs are open: the worker has not called
  // them lost, and a stale run can still revive. A stale run has been
  // quiet since its last signal.
  if (session.state === "stale") {
    return {
      endMs: Number.POSITIVE_INFINITY,
      endKind: "open",
      quietSinceMs: Math.max(lastSeenMs, segmentStartMs),
    };
  }
  return { endMs: Number.POSITIVE_INFINITY, endKind: "open" };
}

/**
 * Split a run into its segments: each stretch from a ``session_start``
 * to the following ``session_end``. The first segment starts at the
 * run's ``started_at``; a ``session_start`` inside a segment (a client
 * re-attaching to a run that never ended) continues it, and a second
 * ``session_end`` between segments changes nothing. The session row
 * describes the last segment (see ``lastSegmentEnd``).
 *
 * Boundaries come from ``events``, the run's events the page holds,
 * which may be only part of its history:
 * - with no events, the run is one segment from ``started_at``;
 * - when the earliest event is a resume's ``session_start``, the
 *   boundaries before it are not loaded, so nothing is drawn before it;
 * - when the row shows the run running again after the last loaded
 *   ``session_end``, its resume is not loaded, and the last segment
 *   starts at the first loaded event after that end, else at
 *   ``last_seen_at``.
 *
 * A segment the reaper closed (its ``session_end`` carries
 * ``close_reason: orphan_timeout``) ends at the run's last event before
 * that ``session_end``, and reads as lost.
 */
export function runSegments(
  session: SegmentSession,
  events: readonly SegmentEvent[] | undefined,
): RunSegment[] {
  const startedMs = parseMs(session.started_at);
  if (Number.isNaN(startedMs)) return [];
  const seenMs = parseMs(session.last_seen_at);
  const lastSeenMs = Number.isNaN(seenMs) ? startedMs : Math.max(seenMs, startedMs);

  // Events dated before the run's started_at are not its boundaries:
  // started_at is its first start, which a resume keeps, so such an
  // event belongs to no segment of it. The run's own session_start is
  // stamped by the client a moment before the worker stamps
  // started_at, which the attach match window allows for.
  const earliestMs = startedMs - ATTACH_MATCH_WINDOW_MS;
  const timed: { t: number; e: SegmentEvent }[] = [];
  for (const e of events ?? []) {
    const t = parseMs(e.occurred_at);
    if (!Number.isNaN(t) && t >= earliestMs) timed.push({ t, e });
  }
  timed.sort(
    (a, b) =>
      a.t - b.t ||
      boundaryRank(a.e.event_type) - boundaryRank(b.e.event_type) ||
      compareIds(a.e.id, b.e.id),
  );

  const spans: {
    startMs: number;
    endMs: number;
    endKind: SegmentEndKind;
    quietSinceMs?: number;
  }[] = [];
  const earliest = timed[0];
  let open = !(
    earliest &&
    earliest.e.event_type === "session_start" &&
    earliest.t > startedMs + ATTACH_MATCH_WINDOW_MS
  );
  let segmentStartMs = startedMs;
  // The latest event inside the open segment: where a reaped segment ends.
  let lastSignalMs = Number.NEGATIVE_INFINITY;
  // The last loaded session_end that closed a segment, and the first
  // event loaded after it.
  let lastEndMs = Number.NEGATIVE_INFINITY;
  let firstAfterEndMs = Number.NaN;

  for (const { t, e } of timed) {
    if (e.event_type === "session_end") {
      if (!open) continue;
      if (e.payload?.close_reason === REAPER_CLOSE_REASON) {
        spans.push({
          startMs: segmentStartMs,
          endMs: Math.max(lastSignalMs, segmentStartMs),
          endKind: "lost",
        });
      } else {
        spans.push({ startMs: segmentStartMs, endMs: Math.max(t, segmentStartMs), endKind: "closed" });
      }
      open = false;
      lastEndMs = t;
      firstAfterEndMs = Number.NaN;
      continue;
    }
    if (!open) {
      if (e.event_type === "session_start") {
        open = true;
        segmentStartMs = Math.max(t, lastEndMs);
        lastSignalMs = segmentStartMs;
      } else if (Number.isNaN(firstAfterEndMs)) {
        firstAfterEndMs = t;
      }
      continue;
    }
    if (t >= segmentStartMs) lastSignalMs = Math.max(lastSignalMs, t);
  }

  const lastSpan = spans[spans.length - 1];
  if (open) {
    spans.push({ startMs: segmentStartMs, ...lastSegmentEnd(session, segmentStartMs, lastSeenMs) });
  } else if (session.state !== "closed" || !lastSpan) {
    // The row shows the run running (or lost) after the last loaded
    // end: the resume's session_start is not loaded.
    const resumeMs = Number.isNaN(firstAfterEndMs)
      ? Math.max(lastSeenMs, lastEndMs)
      : firstAfterEndMs;
    spans.push({ startMs: resumeMs, ...lastSegmentEnd(session, resumeMs, lastSeenMs) });
  } else if (lastSpan.endKind === "lost") {
    // The run is closed and the reaper's session_end closed its last
    // segment. The row's last_seen_at is that segment's last signal,
    // also when the events before the reap are not loaded.
    lastSpan.endMs = Math.max(lastSpan.startMs, Math.min(lastSeenMs, lastEndMs));
  }
  // Otherwise the run is closed and its last loaded session_end closed
  // its last segment, which already carries that end.

  return spans.map((s, index) => ({
    sessionId: session.session_id,
    index,
    count: spans.length,
    ...s,
  }));
}

/** A segment's identity across layouts. */
export function segmentKey(segment: Pick<RunSegment, "sessionId" | "index">): string {
  return `${segment.sessionId}#${segment.index}`;
}

/**
 * Give every segment a track, in start order with ties broken by run
 * id and segment order: the lowest track that is free when the segment
 * starts (its last segment ended no later than ``toleranceMs`` after
 * the start) and whose last segment ended no more than ``rangeMs``
 * (one window span) before the start; otherwise a new track.
 *
 * A segment's track depends only on segments that started before it,
 * so a new segment never moves an older one, and the result is the
 * same in any input order. A gap frees its track, so a run that ran in
 * another run's gap shares that track. A track whose last segment
 * ended more than a window span earlier is cold and never reused, so a
 * new segment cannot reopen a track above the ones shown and push them
 * down. Cost is O(n × tracks).
 */
export function assignSegmentTracks(
  segments: readonly RunSegment[],
  rangeMs: number,
  toleranceMs: number,
): Map<string, number> {
  const sorted = [...segments].sort(
    (a, b) =>
      a.startMs - b.startMs || compareIds(a.sessionId, b.sessionId) || a.index - b.index,
  );
  const trackEnds: number[] = [];
  const tracks = new Map<string, number>();
  for (const segment of sorted) {
    let track = trackEnds.findIndex(
      (end) => end <= segment.startMs + toleranceMs && end >= segment.startMs - rangeMs,
    );
    if (track === -1) {
      track = trackEnds.length;
      trackEnds.push(segment.endMs);
    } else {
      trackEnds[track] = Math.max(trackEnds[track] ?? segment.endMs, segment.endMs);
    }
    tracks.set(segmentKey(segment), track);
  }
  return tracks;
}

/**
 * Whether two of ``segments`` overlap inside the window ``[d0, d1]``
 * by more than ``toleranceMs``. A hand-off (one ends as the next
 * starts) is not an overlap.
 */
export function overlapsInWindow(
  segments: readonly RunSegment[],
  d0: number,
  d1: number,
  toleranceMs: number,
): boolean {
  const clipped: { s: number; e: number }[] = [];
  for (const seg of segments) {
    const s = Math.max(seg.startMs, d0);
    const e = Math.min(seg.endMs, d1);
    if (e > s) clipped.push({ s, e });
  }
  clipped.sort((a, b) => a.s - b.s || a.e - b.e);
  let runningEnd = Number.NEGATIVE_INFINITY;
  for (const { s, e } of clipped) {
    if (s < runningEnd - toleranceMs) return true;
    runningEnd = Math.max(runningEnd, e);
  }
  return false;
}

/** One glyph to pack in a lane of the row. */
export interface GlyphBox {
  key: string;
  /** The lane the glyph sits in (0: the top lane). */
  lane: number;
  track: number;
  kind: "start" | "end";
  sessionId: string;
  segmentIndex: number;
  segmentStartMs: number;
  /** The instant the glyph marks. */
  timeMs: number;
  /** Where the glyph wants its left edge, inside its segment. */
  desiredLeft: number;
  width: number;
}

/**
 * Place glyphs so that, where it can, none in one lane overlaps
 * another, and return each glyph's left edge by key.
 *
 * Within a track the glyphs keep their order in time: each segment's ▶
 * before its ■, and a segment's ■ before the next segment's ▶. The
 * lane's tracks (several on a one-line row and in the overflow lane)
 * are then merged by those positions, an end before a
 * start at the same spot, so a hand-off reads ■▶, and each glyph sits
 * at least ``GLYPH_GAP_PX`` right of the one before. A glyph that would
 * cross ``visible.right`` is pulled back inside it, with as many glyphs
 * before it as that needs.
 *
 * No glyph moves more than ``MAX_GLYPH_SHIFT_PX`` from its
 * ``desiredLeft``: on a busy edge, where spreading would carry glyphs
 * far from their runs, the glyphs past that limit overlap near their
 * own time instead. Last, every glyph is clamped inside
 * ``[visible.left, visible.right]``.
 */
export function packGlyphs(
  boxes: readonly GlyphBox[],
  visible: { left: number; right: number },
): Map<string, number> {
  const lefts = new Map<string, number>();
  const lanes = [...new Set(boxes.map((box) => box.lane))].sort((a, b) => a - b);
  for (const lane of lanes) {
    const byTrack = new Map<number, GlyphBox[]>();
    for (const box of boxes) {
      if (box.lane !== lane) continue;
      const list = byTrack.get(box.track) ?? [];
      list.push(box);
      byTrack.set(box.track, list);
    }

    const items: { box: GlyphBox; left: number }[] = [];
    for (const list of byTrack.values()) {
      list.sort(
        (a, b) =>
          a.segmentStartMs - b.segmentStartMs ||
          compareIds(a.sessionId, b.sessionId) ||
          a.segmentIndex - b.segmentIndex ||
          (a.kind === b.kind ? 0 : a.kind === "start" ? -1 : 1),
      );
      let floor = Number.NEGATIVE_INFINITY;
      for (const box of list) {
        const left = Math.max(box.desiredLeft, floor);
        items.push({ box, left });
        floor = left + box.width + GLYPH_GAP_PX;
      }
    }

    // Within a track the lefts above strictly increase, so this sort
    // keeps each track's order.
    items.sort(
      (a, b) =>
        a.left - b.left ||
        (a.box.kind === b.box.kind ? 0 : a.box.kind === "end" ? -1 : 1) ||
        a.box.timeMs - b.box.timeMs ||
        compareIds(a.box.sessionId, b.box.sessionId) ||
        a.box.segmentIndex - b.box.segmentIndex,
    );
    let previousRight = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      item.left = Math.min(
        Math.max(item.left, previousRight + GLYPH_GAP_PX),
        item.box.desiredLeft + MAX_GLYPH_SHIFT_PX,
      );
      previousRight = item.left + item.box.width;
    }
    let limit = visible.right;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const maxLeft = limit - item.box.width;
      if (item.left <= maxLeft) break;
      item.left = Math.max(maxLeft, item.box.desiredLeft - MAX_GLYPH_SHIFT_PX);
      limit = item.left - GLYPH_GAP_PX;
    }
    for (const item of items) {
      item.left = Math.min(Math.max(item.left, visible.left), visible.right - item.box.width);
    }
    // A segment's ■ reads after its own ▶ even where capped glyphs
    // overlap, or the right edge clamped them: the ▶ goes no further
    // right than just before its ■. That stays within the cap, since the
    // ■'s own position is at least a ▶ width right of the ▶'s.
    const ends = new Map<string, { left: number }>();
    for (const item of items) {
      if (item.box.kind === "end") ends.set(`${item.box.sessionId}#${item.box.segmentIndex}`, item);
    }
    for (const start of items) {
      if (start.box.kind !== "start") continue;
      const end = ends.get(`${start.box.sessionId}#${start.box.segmentIndex}`);
      if (end) start.left = Math.min(start.left, end.left - GLYPH_GAP_PX);
    }
    for (const item of items) lefts.set(item.box.key, item.left);
  }
  return lefts;
}

/** A glyph SwimLane renders, with its packed position. */
export interface RowGlyph {
  key: string;
  segment: RunSegment;
  kind: "start" | "end";
  /** The lane the glyph sits in (0: the top lane). */
  lane: number;
  /** The row's lane count: 1 puts the glyph on the row's top edge,
   *  more on its lane's centre. */
  laneCount: number;
  /** How many runs draw in the glyph's lane: more than 1 only in the
   *  overflow lane. */
  sharedBy: number;
  /** Left edge in the panel's inset wrapper. */
  left: number;
  /** Width and height. */
  width: number;
}

/** A segment in view and the lane it draws in. */
export interface SegmentPlacement {
  segment: RunSegment;
  lane: number;
}

/** The line a segment draws along its lane on a split row. */
export interface RowLine {
  key: string;
  segment: RunSegment;
  lane: number;
  laneCount: number;
  /** How many runs draw in the line's lane (see ``RowGlyph``). */
  sharedBy: number;
  /** Left and right ends in the panel's inset wrapper. */
  x1: number;
  x2: number;
  /** Where the line turns dashed, the run having gone quiet there; null
   *  for a line solid to its end. */
  quietX: number | null;
  /** Neither of the segment's glyphs is in view, so the line is its
   *  segment's keyboard path. */
  focusable: boolean;
}

export interface RowLaneLayout {
  /** 1 while no two segments in view overlap, else the lanes drawn
   *  (2 to ``MAX_RUN_LANES``). */
  laneCount: number;
  /** More tracks are in view than lanes, so the last lane is shared. */
  overflow: boolean;
  /** Every segment in view with its lane. */
  placements: SegmentPlacement[];
  /** The glyphs of the segments in view, by lane and then left to
   *  right, the order a keyboard should visit them in. */
  glyphs: RowGlyph[];
  /** The run lines of a split row, by lane and then left to right;
   *  none on a one-line row. */
  lines: RowLine[];
}

/** Lines narrower than this are not drawn: a segment that only touches
 *  the window's edge has nothing to join. */
const MIN_LINE_WIDTH_PX = 1;

/**
 * Lay out the runs of one row.
 *
 * ``segments`` is every segment of every run the row holds; tracks
 * are assigned over all of them. A segment is in view when it overlaps
 * ``[d0, d1]``, and only segments in view draw. With no two in view
 * overlapping by more than the tolerance (``OVERLAP_TOLERANCE_MS`` or
 * one pixel of the window, whichever is longer), the row is one line:
 * every segment in lane 0, every glyph on the top edge, and no run
 * lines. Otherwise the tracks with a segment in view become lanes in
 * track order, so a track with nothing in view closes and the lanes
 * below it move up. Past ``MAX_RUN_LANES``, every track from the last
 * lane on shares it. Each glyph is drawn when its own time is in the
 * window.
 *
 * ``toX`` maps a time to an x in the panel's inset wrapper, and
 * ``visibleLeft`` / ``visibleRight`` are the panel's edges in those
 * coordinates.
 */
export function layoutRowLanes({
  segments,
  d0,
  d1,
  toX,
  visibleLeft,
  visibleRight,
}: {
  segments: readonly RunSegment[];
  d0: number;
  d1: number;
  toX: (ms: number) => number;
  visibleLeft: number;
  visibleRight: number;
}): RowLaneLayout {
  const rangeMs = d1 - d0;
  if (!(rangeMs > 0)) {
    return { laneCount: 1, overflow: false, placements: [], glyphs: [], lines: [] };
  }
  const spanPx = toX(d1) - toX(d0);
  const msPerPx = spanPx > 0 ? rangeMs / spanPx : 0;
  const toleranceMs = Math.max(OVERLAP_TOLERANCE_MS, msPerPx);

  const tracks = assignSegmentTracks(segments, rangeMs, toleranceMs);
  const inView = segments.filter((s) => s.startMs <= d1 && s.endMs >= d0);
  const split = overlapsInWindow(inView, d0, d1, toleranceMs);

  // The tracks in view become lanes, in track order.
  const shownTracks = [...new Set(inView.map((s) => tracks.get(segmentKey(s)) ?? 0))].sort(
    (a, b) => a - b,
  );
  const rank = new Map(shownTracks.map((track, i) => [track, i]));
  const laneCount = split ? Math.min(shownTracks.length, MAX_RUN_LANES) : 1;
  const overflow = split && shownTracks.length > MAX_RUN_LANES;
  const laneOf = (segment: RunSegment): number =>
    split ? Math.min(rank.get(tracks.get(segmentKey(segment)) ?? 0) ?? 0, MAX_RUN_LANES - 1) : 0;

  const placements: SegmentPlacement[] = inView.map((segment) => ({
    segment,
    lane: laneOf(segment),
  }));
  const runsByLane = new Map<number, Set<string>>();
  for (const { segment, lane } of placements) {
    const runs = runsByLane.get(lane) ?? new Set<string>();
    runs.add(segment.sessionId);
    runsByLane.set(lane, runs);
  }
  // On a one-line row every run shares lane 0, which is not an overflow.
  const sharedBy = (lane: number) => (split ? (runsByLane.get(lane)?.size ?? 1) : 1);
  const geometry = laneGeometry(laneCount);

  const boxes: GlyphBox[] = [];
  const placementByKey = new Map<string, SegmentPlacement>();
  for (const placement of placements) {
    const { segment, lane } = placement;
    const key = segmentKey(segment);
    placementByKey.set(key, placement);
    const base = {
      lane,
      track: tracks.get(key) ?? 0,
      sessionId: segment.sessionId,
      segmentIndex: segment.index,
      segmentStartMs: segment.startMs,
    };
    const startDrawn = segment.startMs >= d0 && segment.startMs <= d1;
    const startLeft = toX(segment.startMs) + GLYPH_BOUNDARY_INSET_PX;
    if (startDrawn) {
      boxes.push({
        ...base,
        key: `${key}:start`,
        kind: "start",
        timeMs: segment.startMs,
        desiredLeft: startLeft,
        width: geometry.startGlyph,
      });
    }
    if (segment.endKind !== "open" && segment.endMs >= d0 && segment.endMs <= d1) {
      const endLeft = toX(segment.endMs) - geometry.endGlyph - GLYPH_BOUNDARY_INSET_PX;
      boxes.push({
        ...base,
        key: `${key}:end`,
        kind: "end",
        timeMs: segment.endMs,
        // A segment narrower than its two glyphs puts its ■ right after
        // its own ▶: that is where its time puts it.
        desiredLeft: startDrawn
          ? Math.max(endLeft, startLeft + geometry.startGlyph + GLYPH_GAP_PX)
          : endLeft,
        width: geometry.endGlyph,
      });
    }
  }

  const lefts = packGlyphs(boxes, { left: visibleLeft, right: visibleRight });
  const glyphs: RowGlyph[] = boxes.map((box) => {
    const placed = placementByKey.get(
      segmentKey({ sessionId: box.sessionId, index: box.segmentIndex }),
    )!;
    return {
      key: box.key,
      segment: placed.segment,
      kind: box.kind,
      lane: box.lane,
      laneCount,
      sharedBy: sharedBy(box.lane),
      left: lefts.get(box.key) ?? box.desiredLeft,
      width: box.width,
    };
  });
  glyphs.sort((a, b) => a.lane - b.lane || a.left - b.left);

  const lines: RowLine[] = [];
  if (split) {
    const clampX = (x: number) => Math.min(Math.max(x, visibleLeft), visibleRight);
    for (const { segment, lane } of placements) {
      const startInView = segment.startMs >= d0 && segment.startMs <= d1;
      const endInView =
        segment.endKind !== "open" && segment.endMs >= d0 && segment.endMs <= d1;
      const x1 = startInView ? clampX(toX(segment.startMs)) : visibleLeft;
      const x2 = endInView ? clampX(toX(segment.endMs)) : visibleRight;
      if (x2 - x1 < MIN_LINE_WIDTH_PX) continue;
      const quiet = segment.quietSinceMs;
      const quietX =
        quiet !== undefined && segment.endKind === "open" && quiet < d1
          ? Math.min(Math.max(toX(quiet), x1), x2)
          : null;
      lines.push({
        key: `${segmentKey(segment)}:line`,
        segment,
        lane,
        laneCount,
        sharedBy: sharedBy(lane),
        x1,
        x2,
        quietX,
        focusable: !startInView && !endInView,
      });
    }
    lines.sort((a, b) => a.lane - b.lane || a.x1 - b.x1);
  }

  return { laneCount, overflow, placements, glyphs, lines };
}

/**
 * The lane a run's event at ``timeMs`` draws in, given that run's
 * ``placements``: the lane of the segment that holds the time (the
 * run's own ``session_start`` may be stamped up to the attach match
 * window before its segment), else of the run's segment nearest in
 * time, else 0 (the top lane) for a run with no segment in view, such
 * as the reaper's ``session_end`` long after a lost run's last signal.
 */
export function laneAt(
  placements: readonly SegmentPlacement[] | undefined,
  timeMs: number,
): number {
  if (!placements || placements.length === 0) return 0;
  let best = placements[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const placement of placements) {
    const { startMs, endMs } = placement.segment;
    const distance =
      timeMs < startMs - ATTACH_MATCH_WINDOW_MS
        ? startMs - timeMs
        : timeMs > endMs
          ? timeMs - endMs
          : 0;
    if (distance < bestDistance) {
      best = placement;
      bestDistance = distance;
    }
  }
  return best.lane;
}
