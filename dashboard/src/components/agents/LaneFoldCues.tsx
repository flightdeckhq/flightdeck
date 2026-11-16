import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  LANE_FOLD_CUE_HEIGHT_PX,
  LANE_FOLD_FOOTER_HEIGHT_PX,
  lanesOutOfView,
} from "@/lib/run-lane-layout";

// The cues of the per-agent modal's lane area: "1 more above" in the
// empty label-column cell of the sticky time axis once scrolled, and
// "2 more below" on a footer strip under the scroll viewport, at the
// label column's right edge, while the lanes overflow. Each has space of
// its own that nothing scrolls under: the axis cell holds nothing else,
// and the strip is outside the viewport (it takes its height from it).
// A click scrolls the next hidden lane into full view. The cues hold their own
// state and read the scroll viewport themselves, so a scroll re-renders
// the cues alone. No live region: a screen reader is not told of every
// scroll.

/** Each run lane, which the cues count. */
const LANE_SELECTOR = "[data-run-lane-row]";

/** The Timeline's sticky time axis: lanes scrolled under it are out of
 *  view. */
const AXIS_SELECTOR = '[data-timeline-axis="true"]';

/** The axis row's label-column cell, which the "more above" cue sits in
 *  and whose left edge and width are the label column's. */
const AXIS_LABEL_SELECTOR = '[data-timeline-axis-label="true"]';

/** Space between a cue and the label column's right border, wider than
 *  half the column's resize handle (10 px), so the cue never sits on it. */
const CUE_INSET_PX = 10;

/** A box relative to the lane area (the scroll viewport's border box). */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LaneFold {
  above: number;
  below: number;
  scrollUpPx: number;
  scrollDownPx: number;
  /** The Timeline is taller than the lane area (the viewport and the
   *  strip's height): the lanes scroll, and the footer strip shows. */
  overflow: boolean;
  /** The axis row's label-column cell. */
  axisCell: Box;
}

const NO_BOX: Box = { top: 0, left: 0, width: 0, height: 0 };

const NOTHING_HIDDEN: LaneFold = {
  above: 0,
  below: 0,
  scrollUpPx: 0,
  scrollDownPx: 0,
  overflow: false,
  axisCell: NO_BOX,
};

/**
 * The lanes out of ``el``'s view, read from the page in one pass. A lane
 * is in view between the sticky axis and the viewport's bottom. The lanes
 * overflow when the Timeline is taller than the viewport with
 * ``stripPx`` (the footer strip's height, when it shows) given back, so
 * the strip showing does not decide whether it shows.
 */
export function measureLaneFold(el: HTMLElement, stripPx = 0): LaneFold {
  const box = el.getBoundingClientRect();
  const top = box.top + el.clientTop;
  const viewBottom = top + el.clientHeight;
  const axis = el.querySelector<HTMLElement>(AXIS_SELECTOR)?.getBoundingClientRect();
  const viewTop = axis ? Math.max(top, axis.bottom) : top;
  const content = el.firstElementChild?.getBoundingClientRect();
  const overflow = content !== undefined && content.height > el.clientHeight + stripPx + 0.5;
  const lanes = Array.from(el.querySelectorAll<HTMLElement>(LANE_SELECTOR), (lane) => {
    const r = lane.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  // The label column: the axis cell's left edge and width (it is sticky,
  // so it stays at the viewport's left as the lanes scroll sideways).
  const cell = el.querySelector<HTMLElement>(AXIS_LABEL_SELECTOR)?.getBoundingClientRect();
  const left = cell ? cell.left - box.left : el.clientLeft;
  return {
    ...lanesOutOfView(lanes, viewTop, viewBottom),
    overflow,
    axisCell: cell
      ? { top: cell.top - box.top, left, width: cell.width, height: cell.height }
      : { top: el.clientTop, left, width: 0, height: 0 },
  };
}

function sameBox(a: Box, b: Box): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function sameFold(a: LaneFold, b: LaneFold): boolean {
  return (
    a.above === b.above &&
    a.below === b.below &&
    a.scrollUpPx === b.scrollUpPx &&
    a.scrollDownPx === b.scrollDownPx &&
    a.overflow === b.overflow &&
    sameBox(a.axisCell, b.axisCell)
  );
}

export interface LaneFoldCuesProps {
  /** The modal's lane scroll viewport. */
  scrollEl: HTMLElement | null;
  /** Changes when the lanes may have changed without a resize or a
   *  scroll (a run opening a lane in place of one that left). */
  lanesKey?: unknown;
  /** Whether the lanes overflow, and so the footer strip shows: the
   *  modal counts its height with the viewport's when it sizes the feed. */
  onOverflowChange?: (overflow: boolean) => void;
}

export function LaneFoldCues({ scrollEl, lanesKey, onOverflowChange }: LaneFoldCuesProps) {
  const [fold, setFold] = useState<LaneFold>(NOTHING_HIDDEN);
  // The strip's height while it shows, which the next reading gives back
  // to the viewport. A ref, read in frame callbacks and click handlers.
  const stripPx = useRef(0);
  const update = useCallback(
    (next: LaneFold) => {
      stripPx.current = next.overflow ? LANE_FOLD_FOOTER_HEIGHT_PX : 0;
      setFold((prev) => (sameFold(prev, next) ? prev : next));
      onOverflowChange?.(next.overflow);
    },
    [onOverflowChange],
  );

  // Read the lanes once a frame at most: on mount and whenever the lanes
  // may have changed, on scroll, and when the viewport or its content
  // resizes (lanes open, close or change height).
  useEffect(() => {
    if (!scrollEl) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(measureLaneFold(scrollEl, stripPx.current));
      });
    };
    schedule();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scrollEl);
    const content = scrollEl.firstElementChild;
    if (content) observer?.observe(content);
    return () => {
      scrollEl.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [scrollEl, lanesKey, update]);

  const scrollToNext = (direction: "above" | "below") => {
    if (!scrollEl) return;
    const now = measureLaneFold(scrollEl, stripPx.current);
    const by = direction === "below" ? Math.ceil(now.scrollDownPx) : Math.floor(now.scrollUpPx);
    scrollEl.scrollBy({ top: by });
    const after = measureLaneFold(scrollEl, stripPx.current);
    // The cue goes once nothing is left on its side; focus moves to the
    // lanes it scrolled rather than being dropped with it.
    if (after[direction] === 0) scrollEl.focus({ preventScroll: true });
    update(after);
  };

  if (!scrollEl) return null;
  return (
    <>
      {fold.above > 0 && (
        // The axis row's label-column cell: empty, sticky and opaque, so
        // the cue covers nothing and nothing scrolls over it.
        <div
          data-testid="swimlane-lanes-above-cell"
          style={{ ...cueHolder(fold.axisCell), pointerEvents: "none" }}
        >
          <FoldCue
            testId="swimlane-lanes-more-above"
            text={`${fold.above} more above`}
            icon="up"
            onClick={() => scrollToNext("above")}
          />
        </div>
      )}
      {fold.overflow && (
        // A strip of its own under the viewport while the lanes overflow:
        // its cue sits at the label column's right edge, as the top one
        // does, and nothing scrolls under it.
        <div
          data-testid="swimlane-lanes-fold-footer"
          style={{
            position: "relative",
            flexShrink: 0,
            height: LANE_FOLD_FOOTER_HEIGHT_PX,
            boxSizing: "border-box",
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              ...cueHolder({ top: 0, left: fold.axisCell.left, width: fold.axisCell.width, height: 0 }),
              height: "100%",
              borderRight: "1px solid var(--border)",
              pointerEvents: "none",
            }}
          >
            {fold.below > 0 && (
              <FoldCue
                testId="swimlane-lanes-more-below"
                text={`${fold.below} more below`}
                icon="down"
                onClick={() => scrollToNext("below")}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** A box over the lane area that holds a cue at its right, centred. */
function cueHolder(box: Box): React.CSSProperties {
  return {
    position: "absolute",
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingRight: CUE_INSET_PX,
    // Above the time axis and the label column's resize handle.
    zIndex: 20,
  };
}

function FoldCue({
  testId,
  text,
  icon,
  onClick,
}: {
  testId: string;
  text: string;
  icon: "up" | "down";
  onClick: () => void;
}) {
  const Icon = icon === "up" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-(--bg-elevated) font-mono text-[11px] leading-none whitespace-nowrap hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
      style={{
        height: LANE_FOLD_CUE_HEIGHT_PX,
        maxWidth: "100%",
        overflow: "hidden",
        padding: "0 8px 0 4px",
        border: "1px solid var(--accent-border)",
        color: "var(--text)",
        pointerEvents: "auto",
      }}
    >
      <Icon size={12} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
      {text}
    </button>
  );
}
