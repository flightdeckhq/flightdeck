import { describe, it, expect } from "vitest";
import {
  LIVE_THRESHOLD_MS,
  RECENT_THRESHOLD_MS,
  advanceBucketEntry,
  bucketFor,
  seedBucketEntries,
  sortByActivityBucket,
} from "@/lib/fleet-ordering";

// Helpers -------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests
const iso = (t: number): string => new Date(t).toISOString();

// ---- bucketFor -----------------------------------------------------------

describe("bucketFor", () => {
  it("classifies under-15s as LIVE", () => {
    expect(bucketFor(iso(NOW - 1), NOW)).toBe("live");
    expect(bucketFor(iso(NOW - LIVE_THRESHOLD_MS + 1), NOW)).toBe("live");
  });

  it("classifies 15s-5m as RECENT", () => {
    expect(bucketFor(iso(NOW - LIVE_THRESHOLD_MS), NOW)).toBe("recent");
    expect(bucketFor(iso(NOW - RECENT_THRESHOLD_MS + 1), NOW)).toBe("recent");
  });

  it("classifies over-5m as IDLE", () => {
    expect(bucketFor(iso(NOW - RECENT_THRESHOLD_MS), NOW)).toBe("idle");
    expect(bucketFor(iso(NOW - 60 * 60_000), NOW)).toBe("idle");
  });

  it("classifies empty / invalid timestamps as IDLE", () => {
    expect(bucketFor(undefined, NOW)).toBe("idle");
    expect(bucketFor("", NOW)).toBe("idle");
    expect(bucketFor("not-a-date", NOW)).toBe("idle");
  });
});

// ---- sortByActivityBucket -----------------------------------------------

describe("sortByActivityBucket", () => {
  interface Row {
    id: string;
    name: string;
    lastSeenAt: string;
  }
  const key = (r: Row) => ({
    id: r.id,
    lastSeenAt: r.lastSeenAt,
    displayName: r.name,
  });

  it("sorts LIVE > RECENT > IDLE", () => {
    const rows: Row[] = [
      { id: "r1", name: "Zed", lastSeenAt: iso(NOW - 60 * 60_000) }, // idle
      { id: "r2", name: "Alpha", lastSeenAt: iso(NOW - 60_000) }, // recent
      { id: "r3", name: "Omega", lastSeenAt: iso(NOW - 2_000) }, // live
    ];
    const sorted = sortByActivityBucket(rows, key, NOW, new Map());
    expect(sorted.map((r) => r.bucket)).toEqual(["live", "recent", "idle"]);
    expect(sorted.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });

  it("IDLE rows sort alphabetically by displayName", () => {
    const rows: Row[] = [
      { id: "r1", name: "Zed", lastSeenAt: iso(NOW - 60 * 60_000) },
      { id: "r2", name: "Alpha", lastSeenAt: iso(NOW - 60 * 60_000) },
      { id: "r3", name: "Middle", lastSeenAt: iso(NOW - 60 * 60_000) },
    ];
    const sorted = sortByActivityBucket(rows, key, NOW, new Map());
    expect(sorted.map((r) => r.item.name)).toEqual(["Alpha", "Middle", "Zed"]);
  });

  it("LIVE rows sort by enteredBucketAt DESC (newest arrival at top)", () => {
    const rows: Row[] = [
      { id: "r1", name: "A", lastSeenAt: iso(NOW - 1_000) },
      { id: "r2", name: "B", lastSeenAt: iso(NOW - 1_000) },
      { id: "r3", name: "C", lastSeenAt: iso(NOW - 1_000) },
    ];
    const entered = new Map<string, number>([
      ["r1", NOW - 10_000], // oldest arrival
      ["r2", NOW - 2_000], // newest arrival
      ["r3", NOW - 5_000], // middle
    ]);
    const sorted = sortByActivityBucket(rows, key, NOW, entered);
    expect(sorted.map((r) => r.item.id)).toEqual(["r2", "r3", "r1"]);
  });

  it("within-bucket stability: events on already-in-bucket rows don't reorder", () => {
    // Regression guard: the supervisor's invariant is that tool_call
    // / post_call events on agents that stay in the same bucket must
    // NOT cause the list to reshuffle. Same enteredBucketAt across
    // calls means the sort is stable.
    const rows: Row[] = [
      { id: "r1", name: "A", lastSeenAt: iso(NOW - 1_000) },
      { id: "r2", name: "B", lastSeenAt: iso(NOW - 2_000) },
    ];
    const entered = new Map<string, number>([
      ["r1", NOW - 10_000],
      ["r2", NOW - 5_000],
    ]);
    const before = sortByActivityBucket(rows, key, NOW, entered).map(
      (r) => r.item.id,
    );
    // Simulate a tool_call on r1 that bumps last_seen_at but leaves
    // enteredBucketAt alone (both rows still LIVE).
    rows[0].lastSeenAt = iso(NOW - 500);
    const after = sortByActivityBucket(rows, key, NOW, entered).map(
      (r) => r.item.id,
    );
    expect(after).toEqual(before);
  });
});

// ---- advanceBucketEntry -------------------------------------------------

describe("advanceBucketEntry", () => {
  it("leaves the entry timestamp alone on same-bucket updates", () => {
    const priorMap = new Map<string, number>([["agent-1", NOW - 8_000]]);
    const next = advanceBucketEntry(
      priorMap,
      "agent-1",
      iso(NOW - 5_000), // prior was LIVE
      iso(NOW - 1_000), // still LIVE after update
      NOW,
    );
    expect(next).toBe(priorMap); // same reference
    expect(next.get("agent-1")).toBe(NOW - 8_000); // unchanged
  });

  it("advances the entry timestamp when the row crosses a bucket boundary", () => {
    const priorMap = new Map<string, number>([["agent-1", NOW - 120_000]]);
    const next = advanceBucketEntry(
      priorMap,
      "agent-1",
      iso(NOW - 60_000), // prior was RECENT
      iso(NOW - 2_000), // now LIVE
      NOW,
    );
    expect(next).not.toBe(priorMap);
    expect(next.get("agent-1")).toBe(NOW);
  });

  it("seeds the entry timestamp when a row is seen for the first time", () => {
    const priorMap = new Map<string, number>();
    const next = advanceBucketEntry(
      priorMap,
      "agent-1",
      undefined,
      iso(NOW - 2_000),
      NOW,
    );
    expect(next.get("agent-1")).toBe(NOW);
  });
});

// ---- seedBucketEntries --------------------------------------------------

describe("seedBucketEntries", () => {
  it("maps each row's id to its last_seen_at", () => {
    const map = seedBucketEntries([
      { id: "a", lastSeenAt: iso(NOW - 1_000) },
      { id: "b", lastSeenAt: iso(NOW - 100_000) },
    ]);
    expect(map.get("a")).toBe(NOW - 1_000);
    expect(map.get("b")).toBe(NOW - 100_000);
  });

  it("uses 0 for rows with no last_seen_at", () => {
    const map = seedBucketEntries([{ id: "a", lastSeenAt: undefined }]);
    expect(map.get("a")).toBe(0);
  });
});
