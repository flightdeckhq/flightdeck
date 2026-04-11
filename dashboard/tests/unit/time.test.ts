import { describe, it, expect } from "vitest";
import { formatRelativeLabel } from "@/lib/time";

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
