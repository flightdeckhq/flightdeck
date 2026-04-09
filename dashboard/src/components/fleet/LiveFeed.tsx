import { useRef, useEffect, useState, useCallback } from "react";
import type { AgentEvent } from "@/lib/types";
import { getBadge, getEventDetail, flavorColor } from "@/lib/events";

interface LiveFeedProps {
  events: AgentEvent[];
  onEventClick: (event: AgentEvent) => void;
}

export function LiveFeed({ events, onEventClick }: LiveFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const capped = events.slice(-500);

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

  return (
    <div>
      {/* Feed header — 36px */}
      <div
        className="flex h-9 items-center gap-2 px-3"
        style={{
          background: "var(--surface)",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {!paused && <div className="pulse-dot" />}
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
          {capped.length} events
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

      {/* Feed body — 240px fixed */}
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ height: 240, background: "var(--bg)" }}
        onScroll={handleScroll}
        data-testid="feed-body"
      >
        {capped.map((event, i) => (
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
      {/* Flavor */}
      <span
        className="w-[100px] shrink-0 truncate font-mono text-xs"
        style={{ color }}
      >
        {event.flavor}
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
