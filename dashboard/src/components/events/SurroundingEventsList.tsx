import { useEffect, useState } from "react";
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

/**
 * Lazy-fetches the ±N events from the same session and renders
 * them as a vertical list. Each entry is clickable and swaps the
 * drawer to that event. The anchor row (the currently-displayed
 * event) is visually distinguished but not disabled — clicking it
 * is a no-op via reference equality.
 *
 * Fetch strategy: pulls a slightly oversized window of events from
 * the session via fetchBulkEvents (session_id-scoped, no time
 * window — the server returns the most recent N), filters to the
 * anchor's vicinity, and clamps to ±N. Cached per session_id while
 * the drawer is mounted on the same session — switching to a
 * different event in the same session reuses the cached events.
 */
export function SurroundingEventsList({
  event,
  onSelect,
  window: windowSize = DEFAULT_WINDOW,
}: SurroundingEventsListProps) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    const limit = windowSize * 4 + 1;
    fetchBulkEvents({
      from: "1970-01-01T00:00:00Z",
      session_id: event.session_id,
      limit,
    })
      .then((resp) => {
        if (cancelled) return;
        const sorted = [...resp.events].sort(
          (a, b) =>
            new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
        );
        const idx = sorted.findIndex((e) => e.id === event.id);
        if (idx === -1) {
          // Anchor not in the returned page (rare — happens when the
          // session has many more events than our limit and the
          // anchor is mid-history). Show whatever we got centered
          // around the most recent N.
          setEvents(sorted.slice(-(windowSize * 2 + 1)));
          return;
        }
        const lo = Math.max(0, idx - windowSize);
        const hi = Math.min(sorted.length, idx + windowSize + 1);
        setEvents(sorted.slice(lo, hi));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "fetch failed");
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, event.session_id, windowSize]);

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
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-surface-hover"
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
          >
            <span
              className="font-mono text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              {time}
            </span>
            <span
              className="flex h-[14px] min-w-[64px] shrink-0 items-center justify-center whitespace-nowrap rounded px-1 font-mono text-[9px] font-semibold uppercase"
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
