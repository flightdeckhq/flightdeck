import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type { AgentEvent } from "@/lib/types";
import { getBadge, getEventDetail, flavorColor, isEventVisible } from "@/lib/events";
import {
  FEED_MAX_EVENTS,
  PAUSE_QUEUE_MAX_EVENTS,
  FEED_MIN_HEIGHT,
  FEED_MAX_HEIGHT,
  FEED_DEFAULT_HEIGHT,
  FEED_HEIGHT_STORAGE_KEY,
} from "@/lib/constants";

function getInitialHeight(): number {
  if (typeof window === "undefined") return FEED_DEFAULT_HEIGHT;
  const stored = localStorage.getItem(FEED_HEIGHT_STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= FEED_MIN_HEIGHT && n <= FEED_MAX_HEIGHT) return n;
  }
  return FEED_DEFAULT_HEIGHT;
}

interface LiveFeedProps {
  events: AgentEvent[];
  onEventClick: (event: AgentEvent) => void;
  activeFilter?: string | null;
  onFilterChange?: (filter: string | null) => void;
  isPaused?: boolean;
  queueLength?: number;
  catchingUp?: boolean;
}

export function LiveFeed({ events, onEventClick, activeFilter, onFilterChange, isPaused, queueLength = 0, catchingUp }: LiveFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [feedHeight, setFeedHeight] = useState(getInitialHeight);
  const capped = events.slice(-FEED_MAX_EVENTS);
  const visibleEvents = activeFilter
    ? capped.filter((e) => isEventVisible(e.event_type, activeFilter))
    : capped;

  // Newest first — reverse for display
  const displayEvents = useMemo(
    () => [...visibleEvents].reverse(),
    [visibleEvents]
  );

  useEffect(() => {
    localStorage.setItem(FEED_HEIGHT_STORAGE_KEY, String(feedHeight));
  }, [feedHeight]);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = feedHeight;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setFeedHeight(Math.min(FEED_MAX_HEIGHT, Math.max(FEED_MIN_HEIGHT, startHeight + delta)));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div className="shrink-0">
      {/* Resize handle */}
      <div
        className="h-1 w-full cursor-ns-resize transition-colors"
        style={{ background: "var(--border)" }}
        onMouseDown={handleResizeStart}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "var(--border)"; }}
        data-testid="feed-resize-handle"
      />

      {/* Feed header */}
      <div
        className="flex h-9 items-center gap-2 px-3"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {!isPaused && visibleEvents.length > 0 && <div className="pulse-dot" />}
        <span
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          Live Feed
        </span>
        {catchingUp ? (
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--status-idle)" }}
            data-testid="feed-catching-up"
          >
            Catching up...
          </span>
        ) : isPaused ? (
          <span
            className="font-mono text-[11px]"
            style={{ color: queueLength >= PAUSE_QUEUE_MAX_EVENTS ? "var(--status-stale)" : "var(--status-idle)" }}
            data-testid="feed-count"
          >
            {queueLength >= PAUSE_QUEUE_MAX_EVENTS
              ? `Paused · ${queueLength.toLocaleString()} events buffered (oldest dropped)`
              : `Paused · ${queueLength} events waiting`}
          </span>
        ) : (
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--text-secondary)" }}
            data-testid="feed-count"
          >
            {activeFilter
              ? `${visibleEvents.length} of ${capped.length} events`
              : `${visibleEvents.length} events`}
          </span>
        )}
        {activeFilter && (
          <button
            className="font-mono text-[11px]"
            style={{ color: "var(--accent)", background: "transparent", border: "none", cursor: "pointer" }}
            onClick={() => onFilterChange?.(null)}
            data-testid="feed-filter-label"
          >
            · {activeFilter}
          </button>
        )}
        {/* Pause controls are in the fleet header */}
      </div>

      {/* Feed body with sticky column headers */}
      <div
        className="relative"
        style={{ height: feedHeight, background: "var(--bg)" }}
      >
        {/* Column headers (sticky) */}
        <div
          className="absolute left-0 right-0 top-0 z-10 flex h-6 items-center gap-2 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}
          data-testid="feed-column-headers"
        >
          <span className="w-[100px] shrink-0">Flavor</span>
          <span className="w-[80px] shrink-0">Session</span>
          <span className="w-[88px] shrink-0">Type</span>
          <span className="flex-1">Detail</span>
          <span className="w-[72px] shrink-0 text-right">Time ↑</span>
        </div>

        {/* Scrollable rows (virtualized) */}
        <VirtualizedFeedBody
          scrollRef={scrollRef}
          visibleEvents={displayEvents}
          onEventClick={onEventClick}
        />
      </div>
    </div>
  );
}

const ROW_HEIGHT = 30;
const VISIBLE_BUFFER = 10;

function VirtualizedFeedBody({
  scrollRef,
  visibleEvents,
  onEventClick,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  visibleEvents: AgentEvent[];
  onEventClick: (event: AgentEvent) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      setScrollTop(scrollRef.current.scrollTop);
    }
  }, [scrollRef]);

  const totalHeight = visibleEvents.length * ROW_HEIGHT;
  const containerHeight = scrollRef.current?.clientHeight ?? 300;
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER);
  const endIndex = Math.min(visibleEvents.length, startIndex + visibleCount + VISIBLE_BUFFER * 2);
  const visibleSlice = visibleEvents.slice(startIndex, endIndex);

  return (
    <div
      ref={scrollRef}
      className="absolute left-0 right-0 overflow-y-auto"
      style={{ top: 24, bottom: 0 }}
      onScroll={handleScroll}
      data-testid="feed-body"
    >
      {visibleEvents.length === 0 && (
        <div
          className="flex items-center justify-center text-xs"
          style={{ color: "var(--text-muted)", padding: 16, height: "100%" }}
        >
          Waiting for events...
        </div>
      )}
      {visibleEvents.length > 0 && (
        <div style={{ height: totalHeight, position: "relative" }}>
          <div style={{ position: "absolute", top: startIndex * ROW_HEIGHT, width: "100%" }}>
            {visibleSlice.map((event, i) => (
              <FeedRow
                key={event.id ?? startIndex + i}
                event={event}
                onClick={() => onEventClick(event)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FeedRow({ event, onClick }: { event: AgentEvent; onClick: () => void }) {
  const badge = getBadge(event.event_type);
  const detail = getEventDetail(event);
  const color = flavorColor(event.flavor);

  return (
    <div
      className="flex h-[30px] cursor-pointer items-center gap-2 px-3 transition-colors hover:bg-surface-hover"
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        animation: "fadeIn 200ms ease",
      }}
      onClick={onClick}
      data-testid="feed-row"
    >
      {/* Flavor */}
      <span
        className="w-[100px] shrink-0 truncate font-mono text-xs"
        style={{ color }}
      >
        {event.flavor}
      </span>

      {/* Session ID */}
      <span
        className="w-[80px] shrink-0 truncate font-mono text-[11px]"
        style={{ color: "var(--text-muted)" }}
        data-testid="feed-session-id"
      >
        {event.session_id.slice(0, 8)}
      </span>

      {/* Badge */}
      <span
        className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
        style={{
          background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
          color: badge.cssVar,
          border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
          borderRadius: 3,
        }}
        data-testid="feed-badge"
      >
        {badge.label}
      </span>

      {/* Detail */}
      <span
        className="flex-1 truncate text-xs"
        style={{ color: "var(--text)" }}
      >
        {detail}
      </span>

      {/* Timestamp */}
      <span
        className="w-[72px] shrink-0 text-right font-mono text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        {new Date(event.occurred_at).toLocaleTimeString()}
      </span>
    </div>
  );
}
