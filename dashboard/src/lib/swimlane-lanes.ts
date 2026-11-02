import type { AgentEvent, CloseReason, Session } from "@/lib/types";
import { ATTACH_MATCH_WINDOW_MS } from "@/lib/events";

// Pure layout for the run glyphs on a swimlane row: where each run's
// segments start and end, which track each segment takes, which edge
// of the row its glyphs sit on, and where each glyph goes so that no
// two cover each other. No React, no DOM, and no D3 beyond the
// caller's scale, passed in as ``toX``.

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
): { endMs: number; endKind: SegmentEndKind } {
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
  // them lost, and a stale run can still revive.
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

  const spans: { startMs: number; endMs: number; endKind: SegmentEndKind }[] = [];
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

/** One glyph to pack on an edge of the row. */
export interface GlyphBox {
  key: string;
  /** 0: the row's top edge; 1: its bottom edge. */
  lane: 0 | 1;
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
 * Place glyphs so that none on one edge overlaps another, and return
 * each glyph's left edge by key.
 *
 * Within a track the glyphs keep their order in time: each segment's ▶
 * before its ■, so a segment narrower than the two glyphs reads ▶■
 * with the ■ past the segment's end, and a segment's ■ before the next
 * segment's ▶. The edge's tracks are then merged by those positions,
 * an end before a start at the same spot, so a hand-off reads ■▶, and
 * each glyph sits at least ``GLYPH_GAP_PX`` right of the one before.
 * A glyph that would cross ``visibleRight`` is pulled back inside it,
 * with as many glyphs before it as that needs.
 */
export function packGlyphs(
  boxes: readonly GlyphBox[],
  visibleRight: number,
): Map<string, number> {
  const lefts = new Map<string, number>();
  for (const lane of [0, 1] as const) {
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
      item.left = Math.max(item.left, previousRight + GLYPH_GAP_PX);
      previousRight = item.left + item.box.width;
    }
    let limit = visibleRight;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const maxLeft = limit - item.box.width;
      if (item.left <= maxLeft) break;
      item.left = maxLeft;
      limit = item.left - GLYPH_GAP_PX;
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
  /** 0: the row's top edge; 1: its bottom edge. */
  lane: 0 | 1;
  /** Left edge in the panel's inset wrapper. */
  left: number;
  width: number;
}

export interface RowGlyphLayout {
  /** 1 when every glyph sits on the top edge, 2 while segments in view
   *  overlap and some sit on the bottom edge. */
  laneCount: 1 | 2;
  /** The glyphs of the segments in view, by edge and then left to
   *  right, the order a keyboard should visit them in. */
  glyphs: RowGlyph[];
}

/**
 * Lay out the run glyphs of one row.
 *
 * ``segments`` is every segment of every run the row holds; tracks
 * are assigned over all of them. A segment is in view when it overlaps
 * ``[d0, d1]``, and only segments in view draw glyphs. With no two in
 * view overlapping by more than the tolerance (``OVERLAP_TOLERANCE_MS``
 * or one pixel of the window, whichever is longer), every glyph sits
 * on the top edge. Otherwise the segments of the topmost track in view
 * keep the top edge and every other segment's glyphs share the bottom
 * edge. Each glyph is drawn when its own time is in the window.
 *
 * ``toX`` maps a time to an x in the panel's inset wrapper, and
 * ``visibleRight`` is the panel's right edge in those coordinates.
 */
export function layoutRowGlyphs({
  segments,
  d0,
  d1,
  toX,
  visibleRight,
}: {
  segments: readonly RunSegment[];
  d0: number;
  d1: number;
  toX: (ms: number) => number;
  visibleRight: number;
}): RowGlyphLayout {
  const rangeMs = d1 - d0;
  if (!(rangeMs > 0)) return { laneCount: 1, glyphs: [] };
  const spanPx = toX(d1) - toX(d0);
  const msPerPx = spanPx > 0 ? rangeMs / spanPx : 0;
  const toleranceMs = Math.max(OVERLAP_TOLERANCE_MS, msPerPx);

  const tracks = assignSegmentTracks(segments, rangeMs, toleranceMs);
  const inView = segments.filter((s) => s.startMs <= d1 && s.endMs >= d0);
  const split = overlapsInWindow(inView, d0, d1, toleranceMs);
  let topTrack = Number.POSITIVE_INFINITY;
  for (const s of inView) topTrack = Math.min(topTrack, tracks.get(segmentKey(s)) ?? 0);

  const boxes: GlyphBox[] = [];
  const bySegmentKey = new Map<string, { segment: RunSegment; lane: 0 | 1 }>();
  for (const segment of inView) {
    const key = segmentKey(segment);
    const track = tracks.get(key) ?? 0;
    const lane: 0 | 1 = split && track !== topTrack ? 1 : 0;
    bySegmentKey.set(key, { segment, lane });
    const base = {
      lane,
      track,
      sessionId: segment.sessionId,
      segmentIndex: segment.index,
      segmentStartMs: segment.startMs,
    };
    if (segment.startMs >= d0 && segment.startMs <= d1) {
      boxes.push({
        ...base,
        key: `${key}:start`,
        kind: "start",
        timeMs: segment.startMs,
        desiredLeft: toX(segment.startMs) + GLYPH_BOUNDARY_INSET_PX,
        width: START_GLYPH_SIZE_PX,
      });
    }
    if (segment.endKind !== "open" && segment.endMs >= d0 && segment.endMs <= d1) {
      boxes.push({
        ...base,
        key: `${key}:end`,
        kind: "end",
        timeMs: segment.endMs,
        desiredLeft: toX(segment.endMs) - END_GLYPH_SIZE_PX - GLYPH_BOUNDARY_INSET_PX,
        width: END_GLYPH_SIZE_PX,
      });
    }
  }

  const lefts = packGlyphs(boxes, visibleRight);
  const glyphs: RowGlyph[] = boxes.map((box) => {
    const placed = bySegmentKey.get(segmentKey({ sessionId: box.sessionId, index: box.segmentIndex }))!;
    return {
      key: box.key,
      segment: placed.segment,
      kind: box.kind,
      lane: box.lane,
      left: lefts.get(box.key) ?? box.desiredLeft,
      width: box.width,
    };
  });
  glyphs.sort((a, b) => a.lane - b.lane || a.left - b.left);
  return { laneCount: split ? 2 : 1, glyphs };
}
