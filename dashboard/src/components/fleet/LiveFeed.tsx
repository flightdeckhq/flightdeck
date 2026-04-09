import { useRef, useEffect, useState, useCallback } from "react";
import type { AgentEvent } from "@/lib/types";
import { getBadge, getEventDetail, flavorColor, isEventVisible } from "@/lib/events";

const STORAGE_KEY = "flightdeck-feed-height";
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 240;

function getInitialHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT) return n;
  }
  return DEFAULT_HEIGHT;
}

interface LiveFeedProps {
  events: AgentEvent[];
  onEventClick: (event: AgentEvent) => void;
  activeFilter?: string | null;
}

export function LiveFeed({ events, onEventClick, activeFilter }: LiveFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [feedHeight, setFeedHeight] = useState(getInitialHeight);
  const capped = events.slice(-500);
  const visibleEvents = activeFilter
    ? capped.filter((e) => isEventVisible(e.event_type, activeFilter))
    : capped;

  // Persist height
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(feedHeight));
  }, [feedHeight]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [capped.length, paused]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (!atBottom && !paused) setPaused(true);
    if (atBottom && paused) setPaused(false);
  }, [paused]);

  function handleResume() {
    setPaused(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = feedHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setFeedHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta)));
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

      {/* Feed header — 36px */}
      <div
        className="flex h-9 items-center gap-2 px-3"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {!paused && visibleEvents.length > 0 && <div className="pulse-dot" />}
        <span
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          Live Feed
        </span>
        <span
          className="font-mono text-[11px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {visibleEvents.length} events
        </span>
        <button
          className="ml-auto text-[11px]"
          style={{
            color: paused ? "var(--accent)" : "var(--text-muted)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "2px 6px",
          }}
          onClick={paused ? handleResume : () => setPaused(true)}
          data-testid="feed-pause-btn"
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </div>

      {/* Feed body */}
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ height: feedHeight, background: "var(--bg)" }}
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
        {visibleEvents.map((event, i) => (
          <FeedRow
            key={event.id ?? i}
            event={event}
            onClick={() => onEventClick(event)}
          />
        ))}
      </div>
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
      <span
        className="w-[100px] shrink-0 truncate font-mono text-xs"
        style={{ color }}
      >
        {event.flavor}
      </span>

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

      <span
        className="flex-1 truncate text-xs"
        style={{ color: "var(--text)" }}
      >
        {detail}
      </span>

      <span
        className="w-[72px] shrink-0 text-right font-mono text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        {new Date(event.occurred_at).toLocaleTimeString()}
      </span>
    </div>
  );
}
