import { describe, expect, it } from "vitest";
import { compareEventOrder, compareOccurredAt, oldestEvent, sortByEventOrder } from "@/lib/event-order";

// The API returns occurred_at to the microsecond, with trailing zeros
// trimmed, and ids as canonical lowercase UUIDs.
const T = "2026-11-02T10:00:00Z";
const T_PLUS_1US = "2026-11-02T10:00:00.000001Z";
const T_PLUS_500US = "2026-11-02T10:00:00.0005Z";
const T_PLUS_2MS = "2026-11-02T10:00:00.002Z";

const ID_LOW = "0a000000-0000-4000-8000-000000000000";
const ID_MID = "7f000000-0000-4000-8000-000000000000";
const ID_HIGH = "f0000000-0000-4000-8000-000000000000";

describe("compareOccurredAt", () => {
  it("orders by the microsecond, below Date's millisecond", () => {
    expect(compareOccurredAt(T, T_PLUS_1US)).toBeLessThan(0);
    expect(compareOccurredAt(T_PLUS_500US, T_PLUS_1US)).toBeGreaterThan(0);
    expect(compareOccurredAt(T_PLUS_2MS, T_PLUS_500US)).toBeGreaterThan(0);
  });

  it("treats the same instant written with and without fraction digits as equal", () => {
    expect(compareOccurredAt(T, "2026-11-02T10:00:00.000Z")).toBe(0);
    expect(compareOccurredAt("2026-11-02T12:00:00+02:00", T)).toBe(0);
  });
});

describe("compareEventOrder", () => {
  it("breaks a timestamp tie by id, the way the server does", () => {
    expect(compareEventOrder({ id: ID_LOW, occurred_at: T }, { id: ID_HIGH, occurred_at: T })).toBeLessThan(0);
    expect(compareEventOrder({ id: ID_HIGH, occurred_at: T }, { id: ID_LOW, occurred_at: T })).toBeGreaterThan(0);
  });

  it("lets time win over id", () => {
    expect(
      compareEventOrder({ id: ID_HIGH, occurred_at: T }, { id: ID_LOW, occurred_at: T_PLUS_1US }),
    ).toBeLessThan(0);
  });
});

describe("oldestEvent", () => {
  it("picks the first event in (occurred_at, id) order from an unsorted list", () => {
    const events = [
      { id: ID_MID, occurred_at: T, event_type: "tool_call" },
      { id: ID_HIGH, occurred_at: T_PLUS_2MS, event_type: "post_call" },
      { id: ID_LOW, occurred_at: T, event_type: "pre_call" },
      { id: ID_HIGH, occurred_at: T, event_type: "tool_call" },
    ];
    expect(oldestEvent(events)?.id).toBe(ID_LOW);
  });

  it("returns undefined for no events", () => {
    expect(oldestEvent([])).toBeUndefined();
  });
});

describe("sortByEventOrder", () => {
  const ev = (id: string, occurred_at: string) => ({ id, occurred_at });

  it("orders by time to the microsecond, then id, as compareEventOrder does", () => {
    const events = [ev(ID_MID, T_PLUS_1US), ev(ID_LOW, T_PLUS_2MS), ev(ID_LOW, T_PLUS_1US), ev(ID_MID, T)];
    expect(sortByEventOrder(events)).toEqual([...events].sort(compareEventOrder));
  });

  it("returns a new array, also when the list is already in order", () => {
    const events = [ev(ID_LOW, T), ev(ID_LOW, T_PLUS_500US)];
    const sorted = sortByEventOrder(events);
    expect(sorted).toEqual(events);
    expect(sorted).not.toBe(events);
  });
});
