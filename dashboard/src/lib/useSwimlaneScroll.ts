import { useCallback, useEffect, useRef, useState } from "react";
import { SWIM_KEYBOARD_SCROLL_FRACTION } from "@/lib/constants";

/**
 * Pure flag math for the swimlane scroll indicators. Extracted so
 * vitest can cover the threshold logic (especially the >= /
 * <-1-pixel edge cases) without needing JSDOM to mock scrollWidth /
 * clientWidth on a real DOM node.
 *
 * `canScrollRight` uses ``scrollLeft + clientWidth < scrollWidth -
 * 1``: the -1 absorbs sub-pixel rounding (Chrome, Firefox, and
 * WebKit each truncate scrollLeft slightly differently when the
 * container is at the rightmost edge), so the right-edge fade does
 * not flicker on at the maximum scroll position.
 */
export function computeScrollFlags(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { canScrollLeft: boolean; canScrollRight: boolean } {
  const overflow = scrollWidth - clientWidth;
  if (overflow <= 0) {
    return { canScrollLeft: false, canScrollRight: false };
  }
  return {
    canScrollLeft: scrollLeft > 0,
    canScrollRight: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

/**
 * Pure step-size math for ArrowLeft / ArrowRight scroll. Extracted
 * for the same reason as computeScrollFlags.
 */
export function computeKeyboardScrollDelta(
  key: string,
  clientWidth: number,
): number {
  if (key === "ArrowLeft") return -clientWidth * SWIM_KEYBOARD_SCROLL_FRACTION;
  if (key === "ArrowRight") return clientWidth * SWIM_KEYBOARD_SCROLL_FRACTION;
  return 0;
}

export interface SwimlaneScrollState {
  /**
   * Attach to the DOM node that establishes the horizontal scroll
   * context (Fleet's main-content `flex-1` div with overflow-x:auto).
   * Setting the ref triggers the rightmost-on-mount alignment.
   */
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  /** True when there is content scrolled out of view to the LEFT.  */
  canScrollLeft: boolean;
  /** True when there is content scrolled out of view to the RIGHT. */
  canScrollRight: boolean;
  /**
   * Keyboard handler — wire to the scroll container's onKeyDown so
   * ArrowLeft / ArrowRight scroll the swimlane horizontally. Calls
   * preventDefault on the matched keys to keep the browser's default
   * caret-style page scroll from racing the smooth scroll we issue.
   */
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * Manages horizontal-scroll affordances for the Fleet swimlane:
 *
 *  - On first attach, scrolls the container all the way to the right
 *    so the user lands on "now" rather than the oldest end of the
 *    timeline window. Matches the operator's mental model — they
 *    open Fleet expecting the live edge.
 *  - Tracks whether the container has any content beyond the viewport
 *    in either direction (`canScrollLeft`, `canScrollRight`) so the
 *    caller can render edge-fade / sticky-shadow indicators only when
 *    they're meaningful.
 *  - Recomputes both flags on scroll AND on container resize. The
 *    sidebar drag, the live-feed resize, and viewport resize all
 *    change the scroll geometry without firing a `scroll` event;
 *    a ResizeObserver covers them.
 *  - Exposes a keyboard handler that scrolls by half the visible
 *    width per ArrowLeft / ArrowRight press, with smooth behaviour.
 *
 * Containers whose content fits entirely in the viewport
 * (scrollWidth <= clientWidth) report both flags false and the
 * keyboard handler becomes a no-op — the table view, or wide
 * viewports, never get spurious indicators.
 */
export function useSwimlaneScroll(): SwimlaneScrollState {
  const elRef = useRef<HTMLDivElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const initialAlignmentRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const recompute = useCallback(() => {
    const el = elRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const flags = computeScrollFlags(
      el.scrollLeft,
      el.scrollWidth,
      el.clientWidth,
    );
    setCanScrollLeft(flags.canScrollLeft);
    setCanScrollRight(flags.canScrollRight);
  }, []);

  // The ref callback is the single attach/detach site so the scroll
  // listener and ResizeObserver lifecycle is tied to the DOM node
  // identity rather than React's effect ordering. Under StrictMode
  // dev double-invocation the previous useEffect-based attachment
  // raced with the ref callback and the listener never bound, so
  // programmatic scrolls reached the DOM but never updated the
  // canScrollLeft / canScrollRight state.
  const scrollContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      // Tear down any previous binding before swapping.
      if (teardownRef.current) {
        teardownRef.current();
        teardownRef.current = null;
      }
      elRef.current = el;
      if (!el) {
        initialAlignmentRef.current = false;
        return;
      }

      const onScroll = () => recompute();
      el.addEventListener("scroll", onScroll, { passive: true });
      const ro = new ResizeObserver(() => recompute());
      ro.observe(el);
      teardownRef.current = () => {
        el.removeEventListener("scroll", onScroll);
        ro.disconnect();
      };

      // Defer the rightmost alignment to the next animation frame so
      // the container has its post-layout scrollWidth — setting
      // scrollLeft synchronously inside the ref callback runs while
      // children may still be mounting.
      if (!initialAlignmentRef.current) {
        initialAlignmentRef.current = true;
        requestAnimationFrame(() => {
          if (elRef.current === el) {
            el.scrollLeft = el.scrollWidth;
            recompute();
          }
        });
      } else {
        recompute();
      }
    },
    [recompute],
  );

  useEffect(() => {
    return () => {
      if (teardownRef.current) {
        teardownRef.current();
        teardownRef.current = null;
      }
    };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const el = elRef.current;
      if (!el) return;
      if (el.scrollWidth <= el.clientWidth) return;
      const delta = computeKeyboardScrollDelta(e.key, el.clientWidth);
      if (delta === 0) return;
      e.preventDefault();
      el.scrollBy({ left: delta, behavior: "smooth" });
    },
    [],
  );

  return { scrollContainerRef, canScrollLeft, canScrollRight, onKeyDown };
}
