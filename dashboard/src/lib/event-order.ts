import type { AgentEvent } from "./types";

/**
 * The order the API returns events in: `occurred_at` to the
 * microsecond, then `id`. `GET /v1/events` and `GET /v1/sessions/:id`
 * both sort this way, and the run drawer's "Show older" keyset cursor
 * (`before` + `before_id`) follows it, so the dashboard picks cursors
 * and merges pages with the same comparison.
 */

/** The fraction of a second in an API timestamp, as nine digits. */
function nanosOf(timestamp: string): string {
  return (timestamp.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
}

/**
 * Orders two API timestamps the way the server does. Date keeps
 * milliseconds only, and the API returns microseconds, so equal
 * milliseconds fall back to the fraction digits.
 */
export function compareOccurredAt(a: string, b: string): number {
  const ms = new Date(a).getTime() - new Date(b).getTime();
  if (ms !== 0) return ms;
  const na = nanosOf(a);
  const nb = nanosOf(b);
  return na < nb ? -1 : na > nb ? 1 : 0;
}

type Ordered = Pick<AgentEvent, "id" | "occurred_at">;

/**
 * Orders two events the way the server does: `occurred_at`, then `id`.
 * The API returns ids as canonical lowercase UUIDs, which compare
 * character by character the way Postgres compares uuids.
 */
export function compareEventOrder(a: Ordered, b: Ordered): number {
  const byTime = compareOccurredAt(a.occurred_at, b.occurred_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * ``events`` in the server's order, as a new array. Each timestamp is
 * parsed once rather than on every comparison, and a list that is
 * already in order (what the API returns) is copied without sorting:
 * a run's full history can hold thousands of events.
 */
export function sortByEventOrder<T extends Ordered>(events: readonly T[]): T[] {
  const keyed = events.map((e) => ({
    e,
    ms: new Date(e.occurred_at).getTime(),
    nanos: nanosOf(e.occurred_at),
  }));
  const cmp = (a: (typeof keyed)[number], b: (typeof keyed)[number]): number => {
    const ms = a.ms - b.ms;
    if (ms !== 0) return ms;
    if (a.nanos !== b.nanos) return a.nanos < b.nanos ? -1 : 1;
    return a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0;
  };
  let sorted = true;
  for (let i = 1; i < keyed.length; i++) {
    if (cmp(keyed[i - 1]!, keyed[i]!) > 0) {
      sorted = false;
      break;
    }
  }
  if (!sorted) keyed.sort(cmp);
  return keyed.map((k) => k.e);
}

/** The first event in the server's order, or undefined when there are
 *  none. The list need not be sorted. */
export function oldestEvent<T extends Ordered>(events: readonly T[]): T | undefined {
  let oldest: T | undefined;
  for (const e of events) {
    if (oldest === undefined || compareEventOrder(e, oldest) < 0) oldest = e;
  }
  return oldest;
}
