import { describe, it, expect, afterEach, vi } from "vitest";
import {
  formatCost,
  formatLatencyMs,
  formatTokens,
  relativeTime,
} from "@/lib/agents-format";

describe("formatTokens", () => {
  it("renders the bare integer below 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("switches to k at the 1000 boundary", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
  });

  it("switches to M at the 1,000,000 boundary", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatLatencyMs", () => {
  it("renders an em-dash for zero", () => {
    expect(formatLatencyMs(0)).toBe("—");
  });

  it("renders rounded ms below 1000", () => {
    expect(formatLatencyMs(1)).toBe("1ms");
    expect(formatLatencyMs(999)).toBe("999ms");
    expect(formatLatencyMs(12.6)).toBe("13ms");
  });

  it("switches to seconds at the 1000ms boundary", () => {
    expect(formatLatencyMs(1000)).toBe("1.0s");
    expect(formatLatencyMs(2500)).toBe("2.5s");
  });
});

describe("formatCost", () => {
  it("renders an em-dash for zero", () => {
    expect(formatCost(0)).toBe("—");
  });

  it("renders 3 decimals below $1", () => {
    expect(formatCost(0.001)).toBe("$0.001");
    expect(formatCost(0.5)).toBe("$0.500");
  });

  it("renders 2 decimals from $1 to $99.99", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(99.99)).toBe("$99.99");
  });

  it("renders no decimals at or above $100", () => {
    expect(formatCost(100)).toBe("$100");
    expect(formatCost(1234.5)).toBe("$1235");
  });
});

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function at(now: string, iso: string): string {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    return relativeTime(iso);
  }

  it("renders seconds below one minute", () => {
    expect(at("2026-05-15T12:00:30Z", "2026-05-15T12:00:00Z")).toBe(
      "30s ago",
    );
  });

  it("renders minutes below one hour", () => {
    expect(at("2026-05-15T12:30:00Z", "2026-05-15T12:00:00Z")).toBe(
      "30m ago",
    );
  });

  it("renders hours below one day", () => {
    expect(at("2026-05-15T18:00:00Z", "2026-05-15T12:00:00Z")).toBe(
      "6h ago",
    );
  });

  it("renders days at or above 24 hours", () => {
    expect(at("2026-05-18T12:00:00Z", "2026-05-15T12:00:00Z")).toBe(
      "3d ago",
    );
  });
});
