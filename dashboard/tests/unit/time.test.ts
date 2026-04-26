import { describe, it, expect } from "vitest";
import { formatRelativeLabel, formatRelativeTime } from "@/lib/time";

describe("formatRelativeTime", () => {
  // Coverage for the unit-suffixed relative formatter that the
  // Directives page still uses. The Investigate session table moved
  // to formatSessionTimestamp under S-TBL-1; these cases continue to
  // exercise the helper that callers outside that table depend on.
  it("renders seconds for sub-minute deltas", () => {
    const recent = new Date(Date.now() - 12_000).toISOString();
    expect(formatRelativeTime(recent)).toMatch(/^\d{1,2}s ago$/);
  });

  it("renders minutes for sub-hour deltas", () => {
    const m5 = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(m5)).toBe("5m ago");
  });

  it("renders hours for sub-day deltas", () => {
    const h2 = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(h2)).toBe("2h ago");
  });

  it("renders days for >= 24h deltas", () => {
    const d3 = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(d3)).toBe("3d ago");
  });
});

describe("formatRelativeLabel", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatRelativeLabel(30_000)).toBe("30s");
    expect(formatRelativeLabel(45_000)).toBe("45s");
    expect(formatRelativeLabel(0)).toBe("0s");
    expect(formatRelativeLabel(59_000)).toBe("59s");
  });

  it("formats sub-hour durations in minutes", () => {
    expect(formatRelativeLabel(60_000)).toBe("1m");
    expect(formatRelativeLabel(300_000)).toBe("5m");
    expect(formatRelativeLabel(720_000)).toBe("12m");
    expect(formatRelativeLabel(1_800_000)).toBe("30m");
  });

  it("formats hour-and-up durations in hours", () => {
    expect(formatRelativeLabel(3_600_000)).toBe("1h");
    expect(formatRelativeLabel(7_200_000)).toBe("2h");
    expect(formatRelativeLabel(21_600_000)).toBe("6h");
  });
});
