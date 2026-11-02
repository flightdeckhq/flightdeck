import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EventsCacheMap, useEventsCacheEpoch } from "@/lib/events-cache-epoch";

// The events cache counts its writes so a view that derives something
// from several runs' cached events re-renders when any of them change,
// including a run's own history fetch that lands outside the view.

describe("EventsCacheMap", () => {
  it("re-renders a subscriber once per batch of writes", async () => {
    const cache = new EventsCacheMap<string, number[]>();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEventsCacheEpoch();
    });
    const before = result.current;
    const rendersBefore = renders;
    await act(async () => {
      cache.set("a", [1]);
      cache.set("b", [2]);
      cache.set("c", [3]);
      await Promise.resolve();
    });
    expect(result.current).toBe(before + 3);
    expect(renders).toBe(rendersBefore + 1);
  });

  it("counts a delete of a present key and a clear of a non-empty map, and nothing else", async () => {
    const cache = new EventsCacheMap<string, number[]>();
    const { result } = renderHook(() => useEventsCacheEpoch());
    const start = result.current;
    await act(async () => {
      cache.delete("missing");
      cache.clear();
      await Promise.resolve();
    });
    expect(result.current).toBe(start);
    await act(async () => {
      cache.set("a", [1]);
      cache.delete("a");
      cache.set("b", [2]);
      cache.clear();
      await Promise.resolve();
    });
    expect(result.current).toBe(start + 4);
    expect(cache.size).toBe(0);
  });

  it("is still a Map", () => {
    const cache = new EventsCacheMap<string, number[]>();
    cache.set("a", [1]);
    expect(cache).toBeInstanceOf(Map);
    expect(cache.get("a")).toEqual([1]);
    expect([...cache.keys()]).toEqual(["a"]);
  });
});
