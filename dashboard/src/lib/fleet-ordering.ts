/**
 * Three-tier bucket ordering for Fleet row displays.
 *
 * Supervisor brief: agents should group into three visually separated
 * buckets driven by how recently each agent emitted an event. Within
 * a bucket, row order is stable when events land on an already-in-
 * bucket agent, so the user's eye does not have to chase the list as
 * new events flow in.
 *
 *   LIVE    (<15s since last_seen_at)
 *     top, ordered by enteredBucketAt DESC (newest arrival at top)
 *   RECENT  (15s – 5min)
 *     middle, same enteredBucketAt DESC ordering
 *   IDLE    (>5min or never emitted)
 *     bottom, alphabetical by agent_name (stable, never reorders)
 *
 * Thresholds are exported as constants so tuning is a one-line change.
 * Consumers pass an ``enteredBucketAt`` Map keyed by a row identity
 * (agent_id for agents / flavors) → epoch-ms timestamp. The Fleet
 * store maintains this map across renders: it seeds from last_seen_at
 * on initial load and is updated only when an agent crosses a bucket
 * boundary, not on every live-event tick. This is what gives LIVE /
 * RECENT their within-bucket stability.
 */

export const LIVE_THRESHOLD_MS = 15_000;
export const RECENT_THRESHOLD_MS = 300_000;

export type Bucket = "live" | "recent" | "idle";

/**
 * Which bucket a row belongs to given its last_seen_at timestamp.
 * Invalid / empty timestamps land in IDLE.
 */
export function bucketFor(lastSeenAt: string | undefined, now: number): Bucket {
  if (!lastSeenAt) return "idle";
  const t = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(t)) return "idle";
  const age = now - t;
  if (age < LIVE_THRESHOLD_MS) return "live";
  if (age < RECENT_THRESHOLD_MS) return "recent";
  return "idle";
}

const BUCKET_ORDER: Record<Bucket, number> = {
  live: 0,
  recent: 1,
  idle: 2,
};

/**
 * Generic bucket sort. Consumers pass a minimal row shape (id +
 * last_seen_at + display name) alongside the ``enteredBucketAt`` map
 * so the helper has no dependency on full FlavorSummary / AgentSummary
 * types. Returns rows sorted by (bucket, within-bucket rule). The
 * bucket assignment itself is also returned for visual-separator
 * rendering.
 */
export interface BucketRow<T> {
  id: string;
  item: T;
  bucket: Bucket;
}

interface RowKey {
  id: string;
  lastSeenAt: string | undefined;
  /** Used for IDLE alphabetical tie-break; falls back to ``id``. */
  displayName: string;
}

export function sortByActivityBucket<T>(
  rows: T[],
  key: (row: T) => RowKey,
  now: number,
  enteredBucketAt: Map<string, number>,
): BucketRow<T>[] {
  const bucketed: BucketRow<T>[] = rows.map((row) => {
    const k = key(row);
    return {
      id: k.id,
      item: row,
      bucket: bucketFor(k.lastSeenAt, now),
    };
  });
  return bucketed.sort((a, b) => {
    const orderDiff = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (orderDiff !== 0) return orderDiff;
    if (a.bucket === "idle") {
      const aName = key(a.item).displayName.toLowerCase();
      const bName = key(b.item).displayName.toLowerCase();
      return aName.localeCompare(bName);
    }
    // LIVE / RECENT: enteredBucketAt DESC (newest arrival at top).
    // Rows missing from the map fall back to their last_seen_at, then
    // to 0. Stable on re-evaluation: if two rows share the same
    // enteredBucketAt, tie-break deterministically by id so the sort
    // is never order-dependent across renders.
    const aEntered = enteredBucketAt.get(a.id) ?? asTime(key(a.item).lastSeenAt);
    const bEntered = enteredBucketAt.get(b.id) ?? asTime(key(b.item).lastSeenAt);
    if (aEntered !== bEntered) return bEntered - aEntered;
    return a.id.localeCompare(b.id);
  });
}

function asTime(iso: string | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Advance the ``enteredBucketAt`` map on a fleet update. Call once
 * per row whose last_seen_at changed; pass the row's PRIOR
 * last_seen_at (so the helper can tell whether the bucket changed)
 * along with the new value. Returns a new Map so consumers can set
 * store state by reference equality.
 */
export function advanceBucketEntry(
  current: Map<string, number>,
  id: string,
  priorLastSeenAt: string | undefined,
  nextLastSeenAt: string | undefined,
  now: number,
): Map<string, number> {
  const priorBucket = bucketFor(priorLastSeenAt, now);
  const nextBucket = bucketFor(nextLastSeenAt, now);
  if (priorBucket === nextBucket && current.has(id)) {
    // Same-bucket update: leave the entry timestamp alone so the row
    // does not leapfrog its bucket-mates on a cosmetic last_seen_at
    // bump.
    return current;
  }
  const next = new Map(current);
  next.set(id, now);
  return next;
}

/**
 * Seed the ``enteredBucketAt`` map from an initial list of rows. Used
 * on fleet load / first render when no prior bucket history exists;
 * every row is assumed to have "just entered" its current bucket at
 * its last_seen_at, which is the most faithful approximation the UI
 * can make without server-side bucket-crossing telemetry.
 */
export function seedBucketEntries(
  rows: Array<{ id: string; lastSeenAt: string | undefined }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.id, asTime(row.lastSeenAt));
  }
  return map;
}

/**
 * D126 UX revision 2026-05-03 — group children under their parent
 * in a sorted row list.
 *
 * Takes a list of rows already sorted by some primary criterion
 * (typically the activity-bucket sort above) and reorders so that
 * every row whose ``parentId`` references another visible row in
 * the list is moved to immediately after its parent. Within a
 * parent group, children appear in ``childOrder`` ASC order
 * (typically a started_at timestamp string, since lexicographic
 * compare on ISO 8601 matches chronological order). Pure children
 * whose parent is not visible in the list keep their natural
 * position; lone rows (parentId is undefined / null) keep theirs
 * too. Mutates nothing; returns a fresh array.
 *
 * The β-grouping spec is purely visual — the swimlane's activity
 * bucket sort still drives the parent layer; this helper just
 * re-stitches children adjacent to their parent so the operator
 * reads the relationship without scanning a flat list.
 */
export function groupChildrenUnderParents<T>(
  rows: T[],
  accessors: {
    id: (row: T) => string;
    parentId: (row: T) => string | null | undefined;
    childOrder: (row: T) => string;
  },
): T[] {
  // Index rows by id so the reorder pass can look up parents in
  // O(1). Use a plain Map rather than an object so non-stringy ids
  // (none expected, but defensive) survive the round-trip.
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(accessors.id(row), row);

  // Bucket children under their (visible) parent. Order within each
  // bucket is the input order at first; sorted by childOrder
  // afterwards so parents whose own children are out of natural
  // order in the input still emit deterministic children sequences.
  const children = new Map<string, T[]>();
  const orphansAndParents: T[] = [];
  for (const row of rows) {
    const pid = accessors.parentId(row);
    if (pid && byId.has(pid)) {
      const list = children.get(pid) ?? [];
      list.push(row);
      children.set(pid, list);
    } else {
      // Pure children whose parent isn't in this list keep their
      // position (no group to attach to). Lone rows ride here too.
      orphansAndParents.push(row);
    }
  }

  // Sort each child bucket by childOrder ASC (ISO 8601 string
  // compare matches chronological order). Preserves spawn-time
  // sequence regardless of how the upstream sort handed children
  // back.
  for (const [pid, list] of children) {
    list.sort((a, b) =>
      accessors.childOrder(a).localeCompare(accessors.childOrder(b)),
    );
    children.set(pid, list);
  }

  // Walk the parent-and-orphan list, splicing each parent's
  // children — and any grandchildren — immediately after it via a
  // depth-first descent. Iterative stack to avoid recursion depth
  // limits on pathological hierarchies, and a visited set to keep
  // a self-referential row (parentId pointing back at itself) from
  // looping forever.
  const result: T[] = [];
  const visited = new Set<string>();
  const emit = (row: T) => {
    const id = accessors.id(row);
    if (visited.has(id)) return;
    visited.add(id);
    result.push(row);
    const kids = children.get(id);
    if (kids) {
      for (const kid of kids) emit(kid);
    }
  };
  for (const row of orphansAndParents) {
    emit(row);
  }
  return result;
}

/**
 * Topology classification used by SwimLane / Investigate row
 * styling (D126 UX revision). ``root`` covers both lone agents
 * and parents-with-children; ``child`` covers any row whose
 * ``parentId`` references another visible row. Callers stamp
 * ``data-topology={topology}`` on the row container so a single
 * CSS rule in globals.css handles both surfaces.
 */
export type RowTopology = "root" | "child";

export function topologyFor<T>(
  row: T,
  visibleIds: Set<string>,
  parentId: (row: T) => string | null | undefined,
): RowTopology {
  const pid = parentId(row);
  return pid && visibleIds.has(pid) ? "child" : "root";
}
