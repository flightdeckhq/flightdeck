import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { lanesOutOfView } from "@/lib/run-lane-layout";

// The cues of the per-agent modal's lane area: "2 more below" at its
// bottom edge while lanes are below the fold, and "1 more above" under
// the time axis once scrolled. A click scrolls the next hidden lane into
// full view. They hold their own state and read the scroll viewport
// themselves, so a scroll re-renders the cues alone. No live region:
// a screen reader is not told of every scroll.

/** Each run lane, which the cues count. */
const LANE_SELECTOR = "[data-run-lane-row]";

/** The Timeline's sticky time axis: lanes scrolled under it are out of
 *  view. */
const AXIS_SELECTOR = '[data-timeline-axis="true"]';

/** Space between a cue and the edge of the lane area it sits on. */
const CUE_EDGE_GAP_PX = 6;

interface FoldState {
  above: number;
  below: number;
  scrollUpPx: number;
  scrollDownPx: number;
  /** The lane area's top (the time axis's bottom), from the viewport's. */
  topInset: number;
  /** The viewport's bottom edge less the lane area's: its horizontal
   *  scrollbar and border. */
  bottomInset: number;
}

const NOTHING_HIDDEN: FoldState = {
  above: 0,
  below: 0,
  scrollUpPx: 0,
  scrollDownPx: 0,
  topInset: 0,
  bottomInset: 0,
};

/** The lanes out of ``el``'s view, read from the page in one pass. */
export function measureLaneFold(el: HTMLElement): FoldState {
  const box = el.getBoundingClientRect();
  const top = box.top + el.clientTop;
  const axis = el.querySelector<HTMLElement>(AXIS_SELECTOR);
  const viewTop = axis ? Math.max(top, axis.getBoundingClientRect().bottom) : top;
  const viewBottom = top + el.clientHeight;
  const lanes = Array.from(el.querySelectorAll<HTMLElement>(LANE_SELECTOR), (lane) => {
    const r = lane.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  return {
    ...lanesOutOfView(lanes, viewTop, viewBottom),
    topInset: viewTop - box.top,
    bottomInset: box.bottom - viewBottom,
  };
}

function sameFold(a: FoldState, b: FoldState): boolean {
  return (
    a.above === b.above &&
    a.below === b.below &&
    a.scrollUpPx === b.scrollUpPx &&
    a.scrollDownPx === b.scrollDownPx &&
    a.topInset === b.topInset &&
    a.bottomInset === b.bottomInset
  );
}

export interface LaneFoldCuesProps {
  /** The modal's lane scroll viewport. */
  scrollEl: HTMLElement | null;
  /** Changes when the lanes may have changed without a resize or a
   *  scroll (a run opening a lane in place of one that left). */
  lanesKey?: unknown;
}

export function LaneFoldCues({ scrollEl, lanesKey }: LaneFoldCuesProps) {
  const [fold, setFold] = useState<FoldState>(NOTHING_HIDDEN);
  const update = useCallback((next: FoldState) => {
    setFold((prev) => (sameFold(prev, next) ? prev : next));
  }, []);

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
        update(measureLaneFold(scrollEl));
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
    const now = measureLaneFold(scrollEl);
    const by = direction === "below" ? Math.ceil(now.scrollDownPx) : Math.floor(now.scrollUpPx);
    scrollEl.scrollBy({ top: by });
    const after = measureLaneFold(scrollEl);
    // The cue goes once nothing is left on its side; focus moves to the
    // lanes it scrolled rather than being dropped with it.
    if (after[direction] === 0) scrollEl.focus({ preventScroll: true });
    update(after);
  };

  if (!scrollEl) return null;
  return (
    <>
      {fold.above > 0 && (
        <FoldCue
          testId="swimlane-lanes-more-above"
          text={`${fold.above} more above`}
          icon="up"
          style={{ top: fold.topInset + CUE_EDGE_GAP_PX }}
          onClick={() => scrollToNext("above")}
        />
      )}
      {fold.below > 0 && (
        <FoldCue
          testId="swimlane-lanes-more-below"
          text={`${fold.below} more below`}
          icon="down"
          style={{ bottom: fold.bottomInset + CUE_EDGE_GAP_PX }}
          onClick={() => scrollToNext("below")}
        />
      )}
    </>
  );
}

function FoldCue({
  testId,
  text,
  icon,
  style,
  onClick,
}: {
  testId: string;
  text: string;
  icon: "up" | "down";
  style: React.CSSProperties;
  onClick: () => void;
}) {
  const Icon = icon === "up" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-(--bg-elevated) font-mono text-[11px] shadow-md hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        // Above the lanes' sticky labels and the time axis.
        zIndex: 20,
        padding: "2px 10px 2px 6px",
        border: "1px solid var(--accent-border)",
        color: "var(--text)",
        ...style,
      }}
    >
      <Icon size={12} aria-hidden="true" style={{ color: "var(--accent)" }} />
      {text}
    </button>
  );
}
