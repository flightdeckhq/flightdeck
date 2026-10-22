import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNow } from "@/hooks/useNow";

afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("returns the current time and advances it every interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const { result } = renderHook(() => useNow(5_000));
    const start = result.current;
    expect(start).toBe(Date.parse("2026-10-22T12:00:00Z"));

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(start);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(start + 5_000);
  });

  it("stops ticking after unmount", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, "clearInterval");
    const { unmount } = renderHook(() => useNow(1_000));
    unmount();
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
