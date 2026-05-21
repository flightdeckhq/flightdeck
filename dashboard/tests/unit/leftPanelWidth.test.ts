import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  persistLeftPanelWidth,
  readPersistedLeftPanelWidth,
  useLeftPanelWidth,
} from "@/lib/leftPanelWidth";
import {
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_WIDTH_KEY,
} from "@/lib/constants";

// Resize-width state-hook contract. Pairs with E2E T91, which
// exercises the same persist + reload path through Playwright.
// Unit coverage here locks down the clamp + default-fallback +
// same-tab CustomEvent sync semantics so a future refactor of
// the lib can't drop them silently.

describe("readPersistedLeftPanelWidth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the default width when storage is empty", () => {
    expect(readPersistedLeftPanelWidth()).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it("returns the default width when the stored value is not a number", () => {
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, "not-a-number");
    expect(readPersistedLeftPanelWidth()).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it("clamps an under-min stored value back to the min", () => {
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, "50");
    expect(readPersistedLeftPanelWidth()).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it("clamps an over-max stored value back to the new 640 max", () => {
    // Pre-bump, max was 500. Lock the new 640 cap so a future
    // edit to constants.ts that lowers max can't slip past a
    // test that just round-trips the default.
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, "9999");
    expect(readPersistedLeftPanelWidth()).toBe(LEFT_PANEL_MAX_WIDTH);
    expect(LEFT_PANEL_MAX_WIDTH).toBe(640);
  });

  it("preserves an in-range stored value", () => {
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, "420");
    expect(readPersistedLeftPanelWidth()).toBe(420);
  });

  it("default is the new 460 baseline", () => {
    // Locked alongside max so a future bump to either constant
    // visibly fails this test, forcing the docblock + tests to
    // update together. Pre-Fix-1+Fix-3 the default was 380.
    expect(LEFT_PANEL_DEFAULT_WIDTH).toBe(460);
  });

  it("falls back to default when localStorage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage disabled");
    };
    try {
      expect(readPersistedLeftPanelWidth()).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("persistLeftPanelWidth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes the post-clamp width to localStorage", () => {
    persistLeftPanelWidth(420);
    expect(localStorage.getItem(LEFT_PANEL_WIDTH_KEY)).toBe("420");
  });

  it("clamps a too-large width to the new 640 max before persisting", () => {
    persistLeftPanelWidth(1000);
    expect(localStorage.getItem(LEFT_PANEL_WIDTH_KEY)).toBe(
      String(LEFT_PANEL_MAX_WIDTH),
    );
  });

  it("clamps a too-small width to the min before persisting", () => {
    persistLeftPanelWidth(40);
    expect(localStorage.getItem(LEFT_PANEL_WIDTH_KEY)).toBe(
      String(LEFT_PANEL_MIN_WIDTH),
    );
  });

  it("dispatches the same-tab CustomEvent with the clamped width", () => {
    const listener = vi.fn();
    window.addEventListener("flightdeck:left-panel-width", listener);
    try {
      persistLeftPanelWidth(999);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<number>;
      expect(event.detail).toBe(LEFT_PANEL_MAX_WIDTH);
    } finally {
      window.removeEventListener("flightdeck:left-panel-width", listener);
    }
  });

  it("dispatches the CustomEvent even when localStorage.setItem throws", () => {
    // Quota-exceeded / disabled-storage path. Subscribers must
    // still see the new width so a fleeting storage error
    // doesn't strand the column at a stale value.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
    const listener = vi.fn();
    window.addEventListener("flightdeck:left-panel-width", listener);
    try {
      persistLeftPanelWidth(420);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<number>;
      expect(event.detail).toBe(420);
    } finally {
      Storage.prototype.setItem = original;
      window.removeEventListener("flightdeck:left-panel-width", listener);
    }
  });
});

describe("useLeftPanelWidth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initialises from localStorage", () => {
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, "555");
    const { result } = renderHook(() => useLeftPanelWidth());
    expect(result.current).toBe(555);
  });

  it("updates when persistLeftPanelWidth dispatches in the same tab", () => {
    const { result } = renderHook(() => useLeftPanelWidth());
    expect(result.current).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    act(() => {
      persistLeftPanelWidth(600);
    });
    expect(result.current).toBe(600);
  });

  it("ignores a CustomEvent without a numeric detail", () => {
    const { result } = renderHook(() => useLeftPanelWidth());
    const initial = result.current;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("flightdeck:left-panel-width", { detail: "garbage" }),
      );
    });
    expect(result.current).toBe(initial);
  });
});
