import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRunLink, useRunLit, useRunLitEvent } from "@/lib/run-link";

// The per-agent modal's run link: the run (and feed event) the pointer
// is on, read by each lane and feed row, which re-render only when their
// own reading changes.

describe("createRunLink", () => {
  it("starts with nothing lit and tells its readers of a change only", () => {
    const link = createRunLink();
    expect(link.get()).toEqual({ run: null, eventId: null });
    const listener = vi.fn();
    const unsubscribe = link.subscribe(listener);

    link.set("run-a");
    expect(link.get()).toEqual({ run: "run-a", eventId: null });
    expect(listener).toHaveBeenCalledTimes(1);

    link.set("run-a");
    expect(listener).toHaveBeenCalledTimes(1);

    link.set("run-a", "ev-1");
    expect(link.get()).toEqual({ run: "run-a", eventId: "ev-1" });
    expect(listener).toHaveBeenCalledTimes(2);

    link.set(null, "ignored");
    expect(link.get()).toEqual({ run: null, eventId: null });
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    link.set("run-b");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("useRunLit / useRunLitEvent", () => {
  it("re-renders a reader only when its run lights or goes out", () => {
    const link = createRunLink();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRunLit(link, "run-a");
    });
    expect(result.current).toBe(false);
    const base = renders;

    act(() => link.set("run-b"));
    expect(result.current).toBe(false);
    expect(renders).toBe(base);

    act(() => link.set("run-a"));
    expect(result.current).toBe(true);
    expect(renders).toBe(base + 1);

    // Another event of the same run: still lit, no render.
    act(() => link.set("run-a", "ev-2"));
    expect(renders).toBe(base + 1);

    act(() => link.set(null));
    expect(result.current).toBe(false);
    expect(renders).toBe(base + 2);
  });

  it("gives the lit event on its run, and null on any other", () => {
    const link = createRunLink();
    const { result } = renderHook(() => ({
      a: useRunLitEvent(link, "run-a"),
      b: useRunLitEvent(link, "run-b"),
    }));
    act(() => link.set("run-a", "ev-1"));
    expect(result.current).toEqual({ a: "ev-1", b: null });
    act(() => link.set("run-a"));
    expect(result.current).toEqual({ a: null, b: null });
  });

  it("reads nothing lit without a link", () => {
    const { result } = renderHook(() => [useRunLit(undefined, "run-a"), useRunLitEvent(undefined, "run-a")]);
    expect(result.current).toEqual([false, null]);
  });
});
