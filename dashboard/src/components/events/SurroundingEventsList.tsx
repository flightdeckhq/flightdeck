import { useMemo } from "react";
import { useKeyedFetch } from "@/hooks/useKeyedFetch";
import { fetchBulkEvents } from "@/lib/api";
import { getBadge, getEventDetail } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

interface SurroundingEventsListProps {
  /** The currently-displayed event. Used to anchor the ±N window
   * and to highlight the row in the rendered list. */
  event: AgentEvent;
  /** Click-swap callback — drawer host re-renders with the chosen
   * sibling event. */
  onSelect: (event: AgentEvent) => void;
  /** How many events on each side of the anchor to show. */
  window?: number;
}

const DEFAULT_WINDOW = 5;

// Events sharing the anchor's timestamp sort in no fixed order on the
// server, so each side fetches this many extra to keep the anchor and
// its true neighbours in the result when several share a time.
const TIE_MARGIN = 5;

const EPOCH = "1970-01-01T00:00:00Z";

/** ``events`` deduplicated by id, in occurred_at order (id breaks ties). */
function mergeInTimeOrder(events: AgentEvent[]): AgentEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  return [...byId.values()].sort(
    (a, b) =>
      new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Lazy-fetches the ±N events from the same session and renders
 * them as a vertical list. Each entry is clickable and swaps the
 * drawer to that event. The anchor row (the currently-displayed
 * event) is visually distinguished but not disabled — clicking it
 * is a no-op via reference equality.
 *
 * Fetch strategy: two session-scoped fetchBulkEvents calls bracket the
 * anchor's occurred_at, the events up to it newest first and the
 * events from it oldest first, so the window is the anchor's own
 * however long the session is. Both bounds are inclusive, so both
 * pages carry the anchor; the merge deduplicates by id. Cached per
 * anchor while the drawer is mounted.
 */
export function SurroundingEventsList({
  event,
  onSelect,
  window: windowSize = DEFAULT_WINDOW,
}: SurroundingEventsListProps) {
  const requestKey = `${event.session_id}|${event.id}|${windowSize}`;
  const fetched = useKeyedFetch(requestKey, () => {
    const limit = windowSize + 1 + TIE_MARGIN;
    return Promise.all([
      fetchBulkEvents({
        from: EPOCH,
        to: event.occurred_at,
        session_id: event.session_id,
        order: "desc",
        limit,
      }),
      fetchBulkEvents({
        from: event.occurred_at,
        session_id: event.session_id,
        order: "asc",
        limit,
      }),
    ]).then(([before, after]) => mergeInTimeOrder([...before.events, ...after.events]));
  });
  const error =
    fetched.error === null
      ? null
      : fetched.error instanceof Error
        ? fetched.error.message
        : "fetch failed";
  // Only this session's list is shown; another session's never stands
  // in while the new one loads.
  const sorted =
    !fetched.loading && error === null && fetched.dataKey === requestKey ? fetched.data : undefined;
  const events = useMemo<AgentEvent[] | null>(() => {
    if (!sorted) return null;
    const idx = sorted.findIndex((e) => e.id === event.id);
    if (idx === -1) {
      // Anchor not returned (more events share its timestamp than the
      // tie margin covers, or it was deleted). Show the events nearest
      // its time instead.
      const at = new Date(event.occurred_at).getTime();
      const nearest = sorted.findIndex((e) => new Date(e.occurred_at).getTime() >= at);
      const centre = nearest === -1 ? sorted.length - 1 : nearest;
      return sorted.slice(Math.max(0, centre - windowSize), centre + windowSize + 1);
    }
    const lo = Math.max(0, idx - windowSize);
    const hi = Math.min(sorted.length, idx + windowSize + 1);
    return sorted.slice(lo, hi);
  }, [sorted, event.id, event.occurred_at, windowSize]);

  if (error) {
    return (
      <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Failed to load surrounding events: {error}
      </div>
    );
  }

  if (!events) {
    return (
      <div
        className="px-2 py-1 font-mono text-[11px]"
        style={{ color: "var(--text-muted)" }}
        data-testid="surrounding-loading"
      >
        Loading…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
        No surrounding events.
      </div>
    );
  }

  return (
    <div className="space-y-0.5" data-testid="surrounding-events-list">
      {events.map((e) => {
        const isAnchor = e.id === event.id;
        const badge = getBadge(e.event_type);
        const detail = getEventDetail(e);
        const time = new Date(e.occurred_at).toLocaleTimeString();
        return (
          <button
            key={e.id}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-surface-hover"
            style={{
              background: isAnchor
                ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                : undefined,
              border: isAnchor
                ? "1px solid color-mix(in srgb, var(--accent) 30%, transparent)"
                : "1px solid transparent",
            }}
            onClick={() => {
              if (!isAnchor) onSelect(e);
            }}
            data-testid={isAnchor ? "surrounding-anchor" : "surrounding-row"}
            data-event-id={e.id}
          >
            <span
              className="font-mono text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              {time}
            </span>
            <span
              className="flex h-[14px] min-w-[64px] shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-1 font-mono text-[9px] font-semibold uppercase"
              style={{
                background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
                color: badge.cssVar,
                border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
                borderRadius: 2,
              }}
            >
              {badge.label}
            </span>
            <span
              className="truncate font-mono text-[11px]"
              style={{ color: "var(--text)" }}
            >
              {detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}
