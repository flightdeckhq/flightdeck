import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  persistAllRowCollapsed,
  readAllRowCollapsed,
  useAllRowCollapsed,
} from "@/lib/allRowCollapsed";
import { ALL_ROW_COLLAPSED_KEY } from "@/lib/constants";

// ALL-row collapse state-hook contract. Pairs with E2E T93,
// which exercises the same persist + reload path through
// Playwright. Default is collapsed (true) so a fresh operator
// sees the swimlane reduced to per-agent rows + AGENTS header,
// matching the user-facing decision logged in
// constants.ts::ALL_ROW_COLLAPSED_KEY.

describe("readAllRowCollapsed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to collapsed (true) when storage is empty", () => {
    expect(readAllRowCollapsed()).toBe(true);
  });

  it("returns true for the canonical '1' stored value", () => {
    localStorage.setItem(ALL_ROW_COLLAPSED_KEY, "1");
    expect(readAllRowCollapsed()).toBe(true);
  });

  it("returns false for the canonical '0' stored value", () => {
    localStorage.setItem(ALL_ROW_COLLAPSED_KEY, "0");
    expect(readAllRowCollapsed()).toBe(false);
  });

  it("falls back to default (true) on invalid stored values", () => {
    for (const garbage of ["true", "false", "yes", "on", "[1]", "  1  "]) {
      localStorage.setItem(ALL_ROW_COLLAPSED_KEY, garbage);
      expect(readAllRowCollapsed()).toBe(true);
    }
  });

  it("falls back to default (true) when localStorage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage disabled");
    };
    try {
      expect(readAllRowCollapsed()).toBe(true);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("persistAllRowCollapsed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes '1' for true", () => {
    persistAllRowCollapsed(true);
    expect(localStorage.getItem(ALL_ROW_COLLAPSED_KEY)).toBe("1");
  });

  it("writes '0' for false", () => {
    persistAllRowCollapsed(false);
    expect(localStorage.getItem(ALL_ROW_COLLAPSED_KEY)).toBe("0");
  });

  it("dispatches the same-tab CustomEvent with the boolean detail", () => {
    const listener = vi.fn();
    window.addEventListener("flightdeck:all-row-collapsed", listener);
    try {
      persistAllRowCollapsed(false);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<boolean>;
      expect(event.detail).toBe(false);
    } finally {
      window.removeEventListener("flightdeck:all-row-collapsed", listener);
    }
  });

  it("dispatches the CustomEvent even when localStorage.setItem throws", () => {
    // Quota-exceeded / disabled-storage path. Subscribers must
    // still see the new value so a fleeting storage error
    // doesn't desync the in-memory state.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
    const listener = vi.fn();
    window.addEventListener("flightdeck:all-row-collapsed", listener);
    try {
      persistAllRowCollapsed(false);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<boolean>;
      expect(event.detail).toBe(false);
    } finally {
      Storage.prototype.setItem = original;
      window.removeEventListener("flightdeck:all-row-collapsed", listener);
    }
  });
});

describe("useAllRowCollapsed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initialises from the default (collapsed=true)", () => {
    const { result } = renderHook(() => useAllRowCollapsed());
    expect(result.current).toBe(true);
  });

  it("initialises from a previously-persisted expanded state", () => {
    localStorage.setItem(ALL_ROW_COLLAPSED_KEY, "0");
    const { result } = renderHook(() => useAllRowCollapsed());
    expect(result.current).toBe(false);
  });

  it("multiple subscribers stay in sync via the same-tab CustomEvent", () => {
    // Default state for both.
    const { result: a } = renderHook(() => useAllRowCollapsed());
    const { result: b } = renderHook(() => useAllRowCollapsed());
    expect(a.current).toBe(true);
    expect(b.current).toBe(true);
    // Toggle from anywhere; both subscribers see the new value.
    act(() => {
      persistAllRowCollapsed(false);
    });
    expect(a.current).toBe(false);
    expect(b.current).toBe(false);
  });

  it("ignores a CustomEvent whose detail is not boolean", () => {
    const { result } = renderHook(() => useAllRowCollapsed());
    act(() => {
      window.dispatchEvent(
        new CustomEvent("flightdeck:all-row-collapsed", { detail: "garbage" }),
      );
    });
    expect(result.current).toBe(true);
  });
});
