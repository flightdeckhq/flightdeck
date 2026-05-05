import { describe, it, expect } from "vitest";
import {
  LIVE_THRESHOLD_MS,
  RECENT_THRESHOLD_MS,
  advanceBucketEntry,
  bucketFor,
  groupChildrenUnderParents,
  seedBucketEntries,
  sortByActivityBucket,
  topologyFor,
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

// ---- groupChildrenUnderParents (D126 UX revision 2026-05-03) -----------

describe("groupChildrenUnderParents", () => {
  // Toy row shape — minimal surface area so the helper test stays
  // independent of FlavorSummary / SessionListItem evolution.
  type Row = {
    id: string;
    parentId: string | null | undefined;
    started: string;
  };
  const acc = {
    id: (r: Row) => r.id,
    parentId: (r: Row) => r.parentId,
    childOrder: (r: Row) => r.started,
  };

  it("preserves order when no parent-child relationships exist", () => {
    const rows: Row[] = [
      { id: "a", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "b", parentId: null, started: "2026-05-03T10:01:00Z" },
      { id: "c", parentId: null, started: "2026-05-03T10:02:00Z" },
    ];
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("places a child immediately after its parent", () => {
    const rows: Row[] = [
      { id: "p1", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "lone", parentId: null, started: "2026-05-03T10:01:00Z" },
      { id: "c1", parentId: "p1", started: "2026-05-03T10:00:30Z" },
    ];
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "p1",
      "c1",
      "lone",
    ]);
  });

  it("sorts multiple children of one parent by childOrder ASC", () => {
    const rows: Row[] = [
      { id: "p", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "c2", parentId: "p", started: "2026-05-03T10:01:00Z" },
      { id: "c1", parentId: "p", started: "2026-05-03T10:00:30Z" },
      { id: "c3", parentId: "p", started: "2026-05-03T10:02:00Z" },
    ];
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "p",
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("preserves parent order across the input list", () => {
    const rows: Row[] = [
      { id: "p2", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "p1", parentId: null, started: "2026-05-03T11:00:00Z" },
      { id: "c-of-p1", parentId: "p1", started: "2026-05-03T11:00:30Z" },
      { id: "c-of-p2", parentId: "p2", started: "2026-05-03T10:00:30Z" },
    ];
    // p2 appears first in the input → p2 group emits first.
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "p2",
      "c-of-p2",
      "p1",
      "c-of-p1",
    ]);
  });

  it("orphans (parent not visible in list) keep their natural position", () => {
    const rows: Row[] = [
      { id: "a", parentId: null, started: "2026-05-03T10:00:00Z" },
      // parent "missing" is NOT in the list → orphan rides as-is
      { id: "orphan", parentId: "missing", started: "2026-05-03T10:00:30Z" },
      { id: "b", parentId: null, started: "2026-05-03T10:02:00Z" },
    ];
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "a",
      "orphan",
      "b",
    ]);
  });

  it("handles depth-2 (parent-of-parent) without infinite recursion", () => {
    // Grandparent → parent → child. The β-grouping spec only
    // attaches direct children to their parent in one pass; the
    // grandchild's parent (mid) is itself attached after gp.
    // Result: gp, mid, gc — single contiguous chain.
    const rows: Row[] = [
      { id: "gp", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "mid", parentId: "gp", started: "2026-05-03T10:00:30Z" },
      { id: "gc", parentId: "mid", started: "2026-05-03T10:01:00Z" },
    ];
    expect(groupChildrenUnderParents(rows, acc).map((r) => r.id)).toEqual([
      "gp",
      "mid",
      "gc",
    ]);
  });

  it("returns a new array (does not mutate input)", () => {
    const rows: Row[] = [
      { id: "p", parentId: null, started: "2026-05-03T10:00:00Z" },
      { id: "c", parentId: "p", started: "2026-05-03T10:00:30Z" },
    ];
    const before = [...rows];
    groupChildrenUnderParents(rows, acc);
    expect(rows).toEqual(before);
  });

  it("survives an empty input cleanly", () => {
    expect(groupChildrenUnderParents([], acc)).toEqual([]);
  });
});

// ---- topologyFor -------------------------------------------------------

describe("topologyFor", () => {
  type Row = { id: string; parentId: string | null };
  const parentId = (r: Row) => r.parentId;

  it("returns 'root' for a row with no parentId", () => {
    expect(
      topologyFor({ id: "a", parentId: null }, new Set(["a"]), parentId),
    ).toBe("root");
  });

  it("returns 'child' when parentId is in the visible set", () => {
    expect(
      topologyFor(
        { id: "c", parentId: "p" },
        new Set(["p", "c"]),
        parentId,
      ),
    ).toBe("child");
  });

  it("falls back to 'root' when parentId is not visible (orphan)", () => {
    expect(
      topologyFor(
        { id: "orphan", parentId: "missing" },
        new Set(["orphan"]),
        parentId,
      ),
    ).toBe("root");
  });
});
