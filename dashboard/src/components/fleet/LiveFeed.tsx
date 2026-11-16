import { useEffect, useState, useMemo, type ReactNode } from "react";
import type { AgentEvent, FeedEvent } from "@/lib/types";
import { getBadge, getEventDetail, flavorColor, isDiscoveryEvent, isEventVisible, truncateSessionId } from "@/lib/events";
import { useShowDiscoveryEvents } from "@/lib/discoveryEventsPref";
import { getProvider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { useRunLit, type RunLink } from "@/lib/run-link";
import {
  FEED_MAX_EVENTS,
  PAUSE_QUEUE_MAX_EVENTS,
  FEED_MIN_HEIGHT,
  FEED_MAX_HEIGHT,
  FEED_DEFAULT_HEIGHT,
  FEED_HEIGHT_STORAGE_KEY,
  FEED_COL_WIDTHS_KEY,
  FEED_COL_DEFAULTS,
} from "@/lib/constants";

type SortCol = "flavor" | "session" | "type" | "detail" | "time";
type SortDir = "asc" | "desc";

type ColWidths = typeof FEED_COL_DEFAULTS;

const COL_MIN: Record<keyof ColWidths, number> = {
  flavor: 80, session: 60, type: 80, detail: 120, time: 60,
};

const TYPE_ORDER: Record<string, number> = {
  session_start: 0, pre_call: 1, post_call: 2, tool_call: 3,
  policy_warn: 4, policy_degrade: 5, policy_block: 6,
  directive: 7, directive_result: 8, session_end: 9,
};

function getInitialHeight(): number {
  if (typeof window === "undefined") return FEED_DEFAULT_HEIGHT;
  const stored = localStorage.getItem(FEED_HEIGHT_STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= FEED_MIN_HEIGHT && n <= FEED_MAX_HEIGHT) return n;
  }
  return FEED_DEFAULT_HEIGHT;
}

function getInitialColWidths(): ColWidths {
  if (typeof window === "undefined") return { ...FEED_COL_DEFAULTS };
  try {
    const stored = localStorage.getItem(FEED_COL_WIDTHS_KEY);
    if (stored) return { ...FEED_COL_DEFAULTS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...FEED_COL_DEFAULTS };
}

function getSortValue(fe: FeedEvent, col: SortCol): string | number {
  switch (col) {
    // Sort by the server-assigned occurred_at (not the WebSocket arrival
    // timestamp): workers drain events concurrently so NOTIFY order can
    // diverge from true chronological order under kill-switch / rapid
    // teardown load. Falling back to arrivedAt only if the event lacks
    // occurred_at (shouldn't happen, but keeps the sort total).
    case "time": return fe.event.occurred_at
      ? new Date(fe.event.occurred_at).getTime()
      : fe.arrivedAt;
    case "flavor": return fe.event.flavor ?? "";
    case "session": return fe.event.session_id ?? "";
    case "type": return TYPE_ORDER[fe.event.event_type] ?? 99;
    case "detail": return getEventDetail(fe.event);
  }
}

interface LiveFeedProps {
  events: FeedEvent[];
  onEventClick: (event: AgentEvent) => void;
  activeFilter?: string | null;
  onFilterChange?: (filter: string | null) => void;
  isPaused?: boolean;
  queueLength?: number;
  catchingUp?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  /**
   * The most height the feed body may take, below the height the
   * operator chose: the per-agent modal gives the feed's height up to
   * its run lanes when they do not fit. Ignored once the operator drags
   * this feed's resize handle.
   */
  maxBodyHeight?: number;
  /** The feed body's element, for a host that measures it (the
   *  per-agent modal's height cap). */
  bodyRef?: React.Ref<HTMLDivElement>;
  /** The per-agent modal's run link: hovering a row lights its run's
   *  lane and the event's circle, and a row of the lit run lights up.
   *  Absent on the Fleet page. */
  runLink?: RunLink;
  /** Drawn in the header after the counts: the modal's run-filter chip. */
  headerExtra?: ReactNode;
  /** What the feed says with no rows to show; "Waiting for events..."
   *  when not given. The modal's run filter names its run. */
  emptyText?: string;
}

/** A row of the lit run: the accent tint and left bar the modal's lit
 *  lane draws, so the two read as one. */
const LINKED_ROW_TINT = "color-mix(in srgb, var(--accent) 12%, transparent)";
const LINKED_ROW_BAR = "inset 2px 0 0 var(--accent)";

/** The row under the pointer lights its run: one handler on the rows'
 *  container, so moving from one row of a run to the next sets the
 *  link once and the run's rows stay lit. */
function lightRowUnderPointer(runLink: RunLink, target: EventTarget) {
  const row = (target as HTMLElement).closest?.<HTMLElement>("[data-feed-event-id]") ?? null;
  if (!row) {
    runLink.set(null);
    return;
  }
  runLink.set(row.dataset.runId ?? null, row.dataset.feedEventId ?? null);
}

export function LiveFeed({ events, onEventClick, activeFilter, onFilterChange, isPaused, queueLength = 0, catchingUp, onPause, onResume, maxBodyHeight, bodyRef, runLink, headerExtra, emptyText }: LiveFeedProps) {
  const [feedHeight, setFeedHeight] = useState(getInitialHeight);
  // Set once the operator drags the resize handle: their height then
  // holds, whatever ``maxBodyHeight`` asks.
  const [userSized, setUserSized] = useState(false);
  const bodyHeight =
    userSized || maxBodyHeight === undefined ? feedHeight : Math.min(feedHeight, maxBodyHeight);
  const [colWidths, setColWidths] = useState<ColWidths>(getInitialColWidths);
  const [sortCol, setSortCol] = useState<SortCol>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Hide MCP discovery events (mcp_*_list) by default. The
  // discovery filter is applied BEFORE the FEED_MAX_EVENTS cap so
  // the cap reflects "last N visible events", not "last N raw
  // events of which some are hidden". An MCP-heavy session that
  // bursts list events at startup would otherwise push all the
  // useful tool/resource/prompt rows out of the cap window before
  // the operator could read them.
  // Memoised on the inputs, so a host's render with the same events
  // keeps the same lists and the sort below does not run again.
  const [showDiscovery] = useShowDiscoveryEvents();
  const capped = useMemo(() => {
    const visibleAfterDiscovery = showDiscovery
      ? events
      : events.filter((fe) => !isDiscoveryEvent(fe.event.event_type));
    return visibleAfterDiscovery.slice(-FEED_MAX_EVENTS);
  }, [events, showDiscovery]);
  const filtered = useMemo(
    () =>
      activeFilter
        ? capped.filter((fe) => isEventVisible(fe.event.event_type, activeFilter))
        : capped,
    [capped, activeFilter],
  );

  const displayEvents = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      const av = getSortValue(a, sortCol);
      const bv = getSortValue(b, sortCol);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filtered, sortCol, sortDir]);

  useEffect(() => {
    localStorage.setItem(FEED_HEIGHT_STORAGE_KEY, String(feedHeight));
  }, [feedHeight]);

  function handleSortClick(col: SortCol) {
    if (col === sortCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "time" ? "desc" : "asc");
    }
    if (col !== "time" && !isPaused && onPause) onPause();
  }

  function handleReturnToLive() {
    setSortCol("time");
    setSortDir("desc");
    if (onResume) onResume();
  }

  function handleHeightResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    setUserSized(true);
    const startY = e.clientY;
    const startHeight = bodyHeight;
    const onMove = (ev: MouseEvent) => {
      setFeedHeight(Math.min(FEED_MAX_HEIGHT, Math.max(FEED_MIN_HEIGHT, startHeight + (startY - ev.clientY))));
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function handleColResizeStart(e: React.MouseEvent, col: keyof ColWidths) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[col];
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(COL_MIN[col], startWidth + ev.clientX - startX);
      setColWidths((prev) => {
        const next = { ...prev, [col]: newWidth };
        localStorage.setItem(FEED_COL_WIDTHS_KEY, JSON.stringify(next));
        return next;
      });
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const sortIndicator = (col: SortCol) =>
    sortCol === col ? (
      <span className="ml-1 text-[10px]" style={{ color: "var(--accent)" }}>
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    ) : null;

  const headerCols: { key: SortCol; label: string; width: number; align?: string }[] = [
    { key: "flavor", label: "Agent", width: colWidths.flavor },
    { key: "session", label: "Run", width: colWidths.session },
    { key: "type", label: "Type", width: colWidths.type },
    { key: "detail", label: "Detail", width: colWidths.detail },
    { key: "time", label: "Time", width: colWidths.time, align: "right" },
  ];

  return (
    <div className="shrink-0">
      {/* Height resize handle */}
      <div
        className="h-1 w-full cursor-ns-resize transition-colors"
        style={{ background: "var(--border)" }}
        onMouseDown={handleHeightResizeStart}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "var(--border)"; }}
        data-testid="feed-resize-handle"
      />

      {/* Feed header */}
      <div className="flex h-9 items-center gap-2 px-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--border-subtle)" }}>
        {!isPaused && filtered.length > 0 && <div className="pulse-dot" />}
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>Live Feed</span>
        {catchingUp ? (
          <span className="font-mono text-[11px]" style={{ color: "var(--status-idle)" }} data-testid="feed-catching-up">Catching up...</span>
        ) : isPaused ? (
          <span className="font-mono text-[11px]" style={{ color: queueLength >= PAUSE_QUEUE_MAX_EVENTS ? "var(--status-stale)" : "var(--status-idle)" }} data-testid="feed-count">
            {queueLength >= PAUSE_QUEUE_MAX_EVENTS
              ? `Paused · ${queueLength.toLocaleString()} events buffered (oldest dropped)`
              : `Paused · ${queueLength} events waiting`}
          </span>
        ) : (
          <span className="font-mono text-[11px]" style={{ color: "var(--text-secondary)" }} data-testid="feed-count">
            {activeFilter ? `${filtered.length} of ${capped.length} events` : `${filtered.length} events`}
          </span>
        )}
        {activeFilter && (
          <button className="font-mono text-[11px]" style={{ color: "var(--accent)", background: "transparent", border: "none", cursor: "pointer" }} onClick={() => onFilterChange?.(null)} data-testid="feed-filter-label">
            · {activeFilter}
          </button>
        )}
        {headerExtra}
      </div>

      {/* Feed body */}
      <div ref={bodyRef} className="relative" style={{ height: bodyHeight, background: "var(--bg)" }} data-testid="feed-body-frame">
        {/* Column headers */}
        <div
          className="absolute left-0 right-0 top-0 z-10 flex h-6 items-center px-3 font-mono text-[11px] font-bold uppercase tracking-[0.06em]"
          style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}
          data-testid="feed-column-headers"
        >
          {headerCols.map((col, i) => (
            <div
              key={col.key}
              className="relative shrink-0 cursor-pointer select-none"
              style={{ width: col.width, textAlign: (col.align as "right") ?? "left" }}
              onClick={() => handleSortClick(col.key)}
              data-testid={`feed-col-${col.key}`}
            >
              {col.label}{sortIndicator(col.key)}
              {i < headerCols.length - 1 && (
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent"
                  style={{ background: "transparent" }}
                  onMouseDown={(e) => handleColResizeStart(e, col.key)}
                  data-testid={`resize-${col.key}`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Sort pause banner */}
        {sortCol !== "time" && (
          <div
            className="absolute left-0 right-0 z-10 font-mono text-[11px] px-3 py-1"
            style={{ top: 24, background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}
            data-testid="sort-pause-banner"
          >
            Feed paused while sorted by {sortCol}.{" "}
            <span style={{ color: "var(--accent)", cursor: "pointer" }} onClick={handleReturnToLive}>Return to live</span>
          </div>
        )}

        {/* Scrollable rows */}
        <div
          className="absolute left-0 right-0 overflow-y-auto"
          style={{ top: sortCol !== "time" ? 48 : 24, bottom: 0 }}
          data-testid="feed-body"
          onMouseOver={runLink ? (e) => lightRowUnderPointer(runLink, e.target) : undefined}
          onMouseLeave={runLink ? () => runLink.set(null) : undefined}
          // The modal moves the focus here when its run filter clears and
          // the run's lane is gone: reachable by script, not by Tab.
          tabIndex={runLink ? -1 : undefined}
        >
          {displayEvents.length === 0 && (
            <div className="flex items-center justify-center text-xs" style={{ color: "var(--text-muted)", padding: 16, height: "100%" }} data-testid="feed-empty">
              {emptyText ?? "Waiting for events..."}
            </div>
          )}
          {displayEvents.map((fe) =>
            runLink ? (
              <LinkedFeedRow key={`${fe.arrivedAt}-${fe.event.id}`} fe={fe} colWidths={colWidths} onClick={() => onEventClick(fe.event)} runLink={runLink} />
            ) : (
              <FeedRow key={`${fe.arrivedAt}-${fe.event.id}`} fe={fe} colWidths={colWidths} onClick={() => onEventClick(fe.event)} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** A row of the per-agent modal's feed: lit while its run is hovered in
 *  the lanes (or another of its rows is), re-rendering only when that
 *  flips, and naming its run and event for the hover handler. */
function LinkedFeedRow(props: { fe: FeedEvent; colWidths: ColWidths; onClick: () => void; runLink: RunLink }) {
  const linked = useRunLit(props.runLink, props.fe.event.session_id);
  return <FeedRow fe={props.fe} colWidths={props.colWidths} onClick={props.onClick} link={{ linked }} />;
}

function FeedRow({
  fe,
  colWidths,
  onClick,
  link,
}: {
  fe: FeedEvent;
  colWidths: ColWidths;
  onClick: () => void;
  /** Given in the per-agent modal's feed only. */
  link?: { linked: boolean };
}) {
  const { event } = fe;
  const badge = getBadge(event.event_type);
  const detail = getEventDetail(event);
  const color = flavorColor(event.flavor);
  const linked = link?.linked ?? false;

  return (
    <div
      className="flex h-[30px] cursor-pointer items-center px-3 transition-colors hover:bg-surface-hover"
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        overflow: "hidden",
        background: linked ? LINKED_ROW_TINT : undefined,
        boxShadow: linked ? LINKED_ROW_BAR : undefined,
      }}
      onClick={onClick}
      data-testid="feed-row"
      data-run-id={link ? event.session_id : undefined}
      data-feed-event-id={link ? event.id : undefined}
      data-linked={linked ? "true" : undefined}
    >
      <span
        className="shrink-0 font-mono text-xs"
        style={{ width: colWidths.flavor, color, display: "inline-flex", alignItems: "center", gap: 4, overflow: "hidden" }}
      >
        {event.flavor === "claude-code" && (
          <ClaudeCodeLogo size={12} className="shrink-0" />
        )}
        <TruncatedText text={event.flavor} />
      </span>
      <span
        className="shrink-0 font-mono text-xs"
        style={{ width: colWidths.session, color: "var(--text-muted)", overflow: "hidden" }}
        data-testid="feed-session-id"
      >
        <TruncatedText text={truncateSessionId(event.session_id)} />
      </span>
      <span
        className="flex shrink-0 h-[18px] items-center justify-center rounded-sm font-mono text-[10px] font-semibold uppercase"
        style={{
          width: colWidths.type,
          background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
          color: badge.cssVar,
          border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
          borderRadius: 3,
          // The pill is a fixed-height box in a resizable column; a
          // long label stays on one line and ends in an ellipsis
          // (full text on hover) instead of wrapping out of the pill.
          padding: "0 4px",
          minWidth: 0,
        }}
        data-testid="feed-badge"
      >
        <TruncatedText text={badge.label} />
      </span>
      <span
        // Mixed content (provider logo + detail text). Native
        // ``title`` surfaces the text value on hover; the primitive
        // is not used here because the logo is a non-text child.
        className="shrink-0 truncate text-xs pl-2 flex items-center gap-1"
        style={{ width: colWidths.detail, color: "var(--text)" }}
        title={detail}
      >
        {(event.event_type === "post_call" || event.event_type === "pre_call") && event.model && (
          <ProviderLogo provider={getProvider(event.model)} size={12} />
        )}
        {detail}
      </span>
      <span className="shrink-0 text-right font-mono text-[11px]" style={{ width: colWidths.time, color: "var(--text-muted)" }} data-testid="feed-timestamp">
        {new Date(fe.arrivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </div>
  );
}
