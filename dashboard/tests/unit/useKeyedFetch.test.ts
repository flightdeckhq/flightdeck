import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useKeyedFetch } from "@/hooks/useKeyedFetch";

// A fetcher whose calls resolve or reject on demand, so tests control
// the order in which requests settle.
function controllable<T>() {
  const calls: {
    signal: AbortSignal;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fetcher = vi.fn(
    (signal: AbortSignal) =>
      new Promise<T>((resolve, reject) => calls.push({ signal, resolve, reject })),
  );
  return { fetcher, calls };
}

describe("useKeyedFetch", () => {
  it("does nothing for a null key", () => {
    const { fetcher } = controllable<string>();
    const { result } = renderHook(() => useKeyedFetch(null, fetcher));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("loads, then exposes the data", async () => {
    const { fetcher, calls } = controllable<string>();
    const { result } = renderHook(() => useKeyedFetch("a", fetcher));
    expect(result.current.loading).toBe(true);
    await act(async () => calls[0]!.resolve("A"));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe("A");
  });

  it("keeps the previous data while a new key loads, and aborts the superseded request", async () => {
    const { fetcher, calls } = controllable<string>();
    const { result, rerender } = renderHook(({ k }) => useKeyedFetch(k, fetcher), {
      initialProps: { k: "a" },
    });
    await act(async () => calls[0]!.resolve("A"));
    rerender({ k: "b" });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe("A");
    rerender({ k: "c" });
    expect(calls[1]!.signal.aborted).toBe(true);
    // The superseded request settling late must not show up.
    await act(async () => calls[1]!.resolve("B"));
    expect(result.current.data).toBe("A");
    await act(async () => calls[2]!.resolve("C"));
    expect(result.current.data).toBe("C");
    expect(result.current.dataKey).toBe("c");
    expect(result.current.loading).toBe(false);
  });

  it("reports an error only for the current key, keeping earlier data", async () => {
    const { fetcher, calls } = controllable<string>();
    const { result, rerender } = renderHook(({ k }) => useKeyedFetch(k, fetcher), {
      initialProps: { k: "a" },
    });
    await act(async () => calls[0]!.resolve("A"));
    rerender({ k: "b" });
    await act(async () => calls[1]!.reject(new Error("boom")));
    expect(result.current.loading).toBe(false);
    expect((result.current.error as Error).message).toBe("boom");
    expect(result.current.data).toBe("A");
    expect(result.current.dataKey).toBe("a");
    rerender({ k: "c" });
    expect(result.current.error).toBeNull();
  });

  it("refetch re-runs the current key", async () => {
    const { fetcher, calls } = controllable<string>();
    const { result } = renderHook(() => useKeyedFetch("a", fetcher));
    await act(async () => calls[0]!.resolve("A1"));
    act(() => result.current.refetch());
    expect(result.current.loading).toBe(true);
    await act(async () => calls[1]!.resolve("A2"));
    await waitFor(() => expect(result.current.data).toBe("A2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the fetcher from the render that changed the key", async () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ k }) => useKeyedFetch(k, async () => (seen.push(k), k)),
      { initialProps: { k: "a" } },
    );
    rerender({ k: "b" });
    await waitFor(() => expect(seen).toEqual(["a", "b"]));
  });
});
