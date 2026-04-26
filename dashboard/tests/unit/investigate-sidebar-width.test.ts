import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampInvestigateSidebarWidth,
  persistInvestigateSidebarWidth,
  readPersistedInvestigateSidebarWidth,
} from "@/lib/investigate-sidebar-width";
import {
  INVESTIGATE_SIDEBAR_DEFAULT_WIDTH,
  INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION,
  INVESTIGATE_SIDEBAR_MIN_WIDTH,
  INVESTIGATE_SIDEBAR_WIDTH_KEY,
} from "@/lib/constants";

const VIEWPORT_1080 = 1920;

describe("clampInvestigateSidebarWidth", () => {
  it("returns the candidate when it falls inside [MIN, MAX]", () => {
    expect(clampInvestigateSidebarWidth(300, VIEWPORT_1080)).toBe(300);
  });

  it("clamps below the floor up to MIN", () => {
    expect(clampInvestigateSidebarWidth(50, VIEWPORT_1080)).toBe(
      INVESTIGATE_SIDEBAR_MIN_WIDTH,
    );
  });

  it("clamps above the cap down to floor(viewport * fraction)", () => {
    const expectedCap = Math.floor(
      VIEWPORT_1080 * INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION,
    );
    expect(clampInvestigateSidebarWidth(99_999, VIEWPORT_1080)).toBe(expectedCap);
  });

  it("falls back to the default when candidate is NaN", () => {
    expect(clampInvestigateSidebarWidth(Number.NaN, VIEWPORT_1080)).toBe(
      INVESTIGATE_SIDEBAR_DEFAULT_WIDTH,
    );
  });

  it("uses an absolute fallback cap when viewport is 0 or negative", () => {
    // 800 is the helper's no-viewport fallback. Asserts a value
    // above the floor and below 800 round-trips, and a value
    // above 800 clamps down.
    expect(clampInvestigateSidebarWidth(500, 0)).toBe(500);
    expect(clampInvestigateSidebarWidth(2000, 0)).toBe(800);
  });
});

describe("readPersistedInvestigateSidebarWidth", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns DEFAULT when nothing is persisted", () => {
    expect(readPersistedInvestigateSidebarWidth(VIEWPORT_1080)).toBe(
      INVESTIGATE_SIDEBAR_DEFAULT_WIDTH,
    );
  });

  it("returns DEFAULT when the persisted value is non-numeric", () => {
    localStorage.setItem(INVESTIGATE_SIDEBAR_WIDTH_KEY, "garbage");
    expect(readPersistedInvestigateSidebarWidth(VIEWPORT_1080)).toBe(
      INVESTIGATE_SIDEBAR_DEFAULT_WIDTH,
    );
  });

  it("round-trips a clean numeric value within [MIN, MAX]", () => {
    persistInvestigateSidebarWidth(420);
    expect(readPersistedInvestigateSidebarWidth(VIEWPORT_1080)).toBe(420);
  });

  it("clamps a stale below-MIN persisted value up to MIN", () => {
    persistInvestigateSidebarWidth(40);
    expect(readPersistedInvestigateSidebarWidth(VIEWPORT_1080)).toBe(
      INVESTIGATE_SIDEBAR_MIN_WIDTH,
    );
  });

  it("clamps a stale above-MAX persisted value down to viewport cap", () => {
    persistInvestigateSidebarWidth(99_999);
    const expectedCap = Math.floor(
      VIEWPORT_1080 * INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION,
    );
    expect(readPersistedInvestigateSidebarWidth(VIEWPORT_1080)).toBe(expectedCap);
  });
});
