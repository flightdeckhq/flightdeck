import { useEffect, useRef } from "react";
import { truncateSessionId } from "@/lib/events";
import type {
  SearchResults as SearchResultsType,
  SearchResultAgent,
  SearchResultSession,
  SearchResultEvent,
} from "@/lib/types";

type ResultItem = SearchResultAgent | SearchResultSession | SearchResultEvent;

interface SearchResultsProps {
  results: SearchResultsType;
  onSelect: (type: "agent" | "session" | "event", item: ResultItem) => void;
  focusedIndex: number;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SearchResultsList({
  results,
  onSelect,
  focusedIndex,
}: SearchResultsProps) {
  let runningIndex = 0;
  const focusedRef = useRef<HTMLButtonElement | null>(null);

  // Keep the focused row visible as the index moves past the
  // listbox viewport on ArrowUp / ArrowDown. ``nearest`` is the
  // gentler scroll mode — only scroll when the row is actually
  // clipped, no jump when it is already in view.
  useEffect(() => {
    // ``scrollIntoView`` is missing on jsdom's HTMLElement (test
    // env); the optional call lets the component render cleanly in
    // unit tests that don't stub it. In a real browser the method
    // always exists.
    focusedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusedIndex]);

  const groups: {
    key: string;
    label: string;
    type: "agent" | "session" | "event";
    items: ResultItem[];
  }[] = [];

  if (results.agents.length > 0) {
    groups.push({
      key: "agents",
      label: "Agents",
      type: "agent",
      items: results.agents,
    });
  }
  if (results.sessions.length > 0) {
    groups.push({
      key: "sessions",
      label: "Runs",
      type: "session",
      items: results.sessions,
    });
  }
  if (results.events.length > 0) {
    groups.push({
      key: "events",
      label: "Events",
      type: "event",
      items: results.events,
    });
  }

  return (
    <div className="max-h-80 overflow-y-auto" role="listbox">
      {groups.map((group) => {
        const groupStartIndex = runningIndex;
        runningIndex += group.items.length;

        return (
          <div key={group.key}>
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {group.label}
            </div>
            {group.items.map((item, i) => {
              const globalIndex = groupStartIndex + i;
              const isFocused = globalIndex === focusedIndex;
              // Solid focus tokens: bg-primary/<N> compiles to no
              // background in this theme system because --primary
              // is a hex var; surface-hover + a left accent bar
              // gives a visible, theme-aware highlight in both
              // neon-dark and clean-light.
              const focusClass = isFocused
                ? "bg-surface-hover border-l-2 border-primary text-text"
                : "border-l-2 border-transparent text-text-muted hover:bg-surface-hover";
              return (
                <button
                  key={`${group.key}-${i}`}
                  ref={isFocused ? focusedRef : undefined}
                  role="option"
                  aria-selected={isFocused}
                  data-testid={isFocused ? "search-result-focused" : undefined}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors ${focusClass}`}
                  onClick={() => onSelect(group.type, item)}
                >
                  {group.type === "agent" && <AgentRow item={item as SearchResultAgent} />}
                  {group.type === "session" && <SessionRow item={item as SearchResultSession} />}
                  {group.type === "event" && <EventRow item={item as SearchResultEvent} />}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AgentRow({ item }: { item: SearchResultAgent }) {
  return (
    <>
      <span className="font-medium text-text">{item.agent_name}</span>
      <span className="text-text-muted">{item.agent_type}</span>
      <span className="ml-auto text-text-muted">{formatTime(item.last_seen)}</span>
    </>
  );
}

function SessionRow({ item }: { item: SearchResultSession }) {
  return (
    <>
      <span className="font-mono font-medium text-text">
        {truncateSessionId(item.session_id)}
      </span>
      <span className="text-text-muted">{item.flavor}</span>
      <span
        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
          item.state === "active"
            ? "bg-green-500/20 text-green-400"
            : "bg-surface-hover text-text-muted"
        }`}
      >
        {item.state}
      </span>
      <span className="ml-auto text-text-muted">{formatTime(item.started_at)}</span>
    </>
  );
}

function EventRow({ item }: { item: SearchResultEvent }) {
  return (
    <>
      <span className="font-mono font-medium text-text">
        {item.event_id.slice(0, 8)}
      </span>
      <span className="text-text-muted">{item.event_type}</span>
      {item.model && <span className="text-text-muted">{item.model}</span>}
      {item.tool_name && <span className="text-primary">{item.tool_name}</span>}
      <span className="ml-auto text-text-muted">{formatTime(item.occurred_at)}</span>
    </>
  );
}
