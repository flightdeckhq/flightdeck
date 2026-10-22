import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket } from "@/hooks/useWebSocket";

// Minimal WebSocket double: records instances so a test can drive
// open / message / close on the socket the hook created.
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useWebSocket", () => {
  it("delivers messages to the latest handler without reconnecting", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => useWebSocket("ws://x/fleet", h), {
      initialProps: { h: first },
    });
    expect(FakeSocket.instances).toHaveLength(1);
    rerender({ h: second });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => {
      FakeSocket.instances[0]!.onmessage?.({ data: "hello" } as MessageEvent);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("hello");
  });

  it("reconnects with doubling backoff and resets it after a successful open", () => {
    renderHook(() => useWebSocket("ws://x/fleet", () => {}));
    act(() => FakeSocket.instances[0]!.close());
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeSocket.instances).toHaveLength(2);

    // Second failure waits twice as long.
    act(() => FakeSocket.instances[1]!.close());
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeSocket.instances).toHaveLength(3);

    // A successful open resets the delay to the first step.
    act(() => FakeSocket.instances[2]!.onopen?.());
    act(() => FakeSocket.instances[2]!.close());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("does not reconnect after unmount and cancels a pending reconnect", () => {
    const { unmount } = renderHook(() => useWebSocket("ws://x/fleet", () => {}));
    act(() => FakeSocket.instances[0]!.close());
    // A reconnect is now pending; unmounting must cancel it.
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("closes the socket on unmount without scheduling a reconnect", () => {
    const { unmount } = renderHook(() => useWebSocket("ws://x/fleet", () => {}));
    unmount();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("opens nothing for a null url", () => {
    renderHook(() => useWebSocket(null, () => {}));
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
