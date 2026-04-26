/**
 * Phase 4.5 S-SWIM — Fleet swimlane horizontal-scroll affordances.
 *
 * Covers the pure flag math and step-size math behind
 * useSwimlaneScroll. The hook itself is exercised end-to-end by the
 * T24 Playwright spec; this file pins the boundary cases the live
 * test cannot easily reach (sub-pixel rightmost rounding, exact-
 * fit clientWidth==scrollWidth, non-arrow key noop).
 */

import { describe, it, expect } from "vitest";

import {
  computeKeyboardScrollDelta,
  computeScrollFlags,
} from "@/lib/useSwimlaneScroll";
import { SWIM_KEYBOARD_SCROLL_FRACTION } from "@/lib/constants";

describe("computeScrollFlags — S-SWIM-3/4 indicator math", () => {
  it("returns both false when content fits in the viewport", () => {
    expect(computeScrollFlags(0, 1000, 1000)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
    // Content narrower than viewport — also a no-overflow case.
    expect(computeScrollFlags(0, 800, 1000)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
  });

  it("flags right-only at scrollLeft=0 with overflowing content", () => {
    expect(computeScrollFlags(0, 1500, 1000)).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
  });

  it("flags both edges in the middle of the scroll range", () => {
    expect(computeScrollFlags(200, 1500, 1000)).toEqual({
      canScrollLeft: true,
      canScrollRight: true,
    });
  });

  it("flags left-only at the rightmost scroll position", () => {
    // scrollLeft + clientWidth === scrollWidth → fully scrolled.
    expect(computeScrollFlags(500, 1500, 1000)).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });

  it("absorbs sub-pixel rounding at the rightmost edge", () => {
    // Browsers round scrollLeft slightly when the container is at
    // its right edge. The -1 in canScrollRight prevents the right
    // fade from flickering on in this case.
    expect(computeScrollFlags(499.5, 1500, 1000)).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });
});

describe("computeKeyboardScrollDelta — S-SWIM-5 keyboard step", () => {
  it("ArrowLeft scrolls left by half the visible width", () => {
    expect(computeKeyboardScrollDelta("ArrowLeft", 1000)).toBe(
      -1000 * SWIM_KEYBOARD_SCROLL_FRACTION,
    );
  });

  it("ArrowRight scrolls right by half the visible width", () => {
    expect(computeKeyboardScrollDelta("ArrowRight", 1000)).toBe(
      1000 * SWIM_KEYBOARD_SCROLL_FRACTION,
    );
  });

  it("returns 0 for keys that are not horizontal arrows", () => {
    expect(computeKeyboardScrollDelta("ArrowUp", 1000)).toBe(0);
    expect(computeKeyboardScrollDelta("ArrowDown", 1000)).toBe(0);
    expect(computeKeyboardScrollDelta("Tab", 1000)).toBe(0);
    expect(computeKeyboardScrollDelta("Enter", 1000)).toBe(0);
  });

  it("step scales with clientWidth", () => {
    const narrow = computeKeyboardScrollDelta("ArrowRight", 600);
    const wide = computeKeyboardScrollDelta("ArrowRight", 1200);
    expect(wide).toBe(narrow * 2);
  });
});
