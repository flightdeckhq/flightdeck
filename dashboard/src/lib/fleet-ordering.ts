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
