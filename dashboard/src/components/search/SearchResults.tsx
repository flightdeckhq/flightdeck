import { useEffect, useRef } from "react";
import { truncateSessionId } from "@/lib/events";
import { getProvider } from "@/lib/models";
import {
  ClientType,
  isAgentType,
  isClientType,
} from "@/lib/agent-identity";
import { Highlight } from "@/components/search/Highlight";
import { EventTypePill } from "@/components/facets/EventTypePill";
import { AgentTypeBadge } from "@/components/facets/AgentTypeBadge";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { ProviderLogo } from "@/components/ui/provider-logo";
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
  /** The current query string. Passed down so each row can bold
   *  the matched substring in its display text. */
  query: string;
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
  query,
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
    <div
      className="max-h-80 overflow-y-auto"
      role="listbox"
      aria-label="Search results"
    >
      {groups.map((group) => {
        const groupStartIndex = runningIndex;
        runningIndex += group.items.length;

        return (
          <div key={group.key}>
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              <span>{group.label}</span>
              <span
                className="rounded bg-surface-hover px-1.5 text-[10px] font-normal text-text-muted"
                data-testid={`search-group-count-${group.key}`}
              >
                {group.items.length}
              </span>
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
                  type="button"
                  role="option"
                  aria-selected={isFocused}
                  data-testid={isFocused ? "search-result-focused" : undefined}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors ${focusClass}`}
                  onClick={() => onSelect(group.type, item)}
                >
                  {group.type === "agent" && (
                    <AgentRow item={item as SearchResultAgent} query={query} />
                  )}
                  {group.type === "session" && (
                    <SessionRow item={item as SearchResultSession} query={query} />
                  )}
                  {group.type === "event" && (
                    <EventRow item={item as SearchResultEvent} query={query} />
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Compact state chip matching AgentTable's chip styling. Green
 *  background for active runs (consistent with the prior SessionRow
 *  chip pattern), neutral surface for everything else. Shared by
 *  AgentRow and SessionRow so a "stale" run and a "stale" agent
 *  read identically. */
function StateChip({ state }: { state: string }) {
  if (!state) return null;
  const isActive = state === "active";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
        isActive
          ? "bg-green-500/20 text-green-400"
          : "bg-surface-hover text-text-muted"
      }`}
    >
      {state}
    </span>
  );
}

function AgentRow({ item, query }: { item: SearchResultAgent; query: string }) {
  // Mirror AgentTableRow's identity cluster: ClaudeCodeLogo when
  // the agent is a Claude Code client, then the agent-type badge,
  // then the state chip, then the highlighted name, then time.
  // All primitives are the same components /agents renders so the
  // two surfaces read as one family.
  const showClaudeLogo =
    isClientType(item.client_type) && item.client_type === ClientType.ClaudeCode;
  return (
    <>
      {showClaudeLogo && <ClaudeCodeLogo size={12} title="" />}
      {isAgentType(item.agent_type) && (
        <AgentTypeBadge agentType={item.agent_type} />
      )}
      <StateChip state={item.state} />
      <Highlight
        text={item.agent_name}
        query={query}
        className="font-medium text-text"
      />
      <span className="ml-auto text-text-muted">{formatTime(item.last_seen)}</span>
    </>
  );
}

function SessionRow({
  item,
  query,
}: {
  item: SearchResultSession;
  query: string;
}) {
  return (
    <>
      <Highlight
        text={truncateSessionId(item.session_id)}
        query={query}
        className="font-mono font-medium text-text"
      />
      <Highlight text={item.flavor} query={query} className="text-text-muted" />
      <StateChip state={item.state} />
      {item.model && (
        <span className="flex items-center gap-1 text-text-muted">
          <ProviderLogo provider={getProvider(item.model)} size={12} title="" />
          <Highlight text={item.model} query={query} className="text-text-muted" />
        </span>
      )}
      <span className="ml-auto text-text-muted">{formatTime(item.started_at)}</span>
    </>
  );
}

function EventRow({ item, query }: { item: SearchResultEvent; query: string }) {
  // Canonical EventTypePill leads the row — the same component
  // /events, the run drawer, and the agent drawer render — so a
  // ``post_call`` (or any other type) reads byte-identically
  // across all four surfaces. After the pill: raw event_type in
  // mono muted so a literal query like ``post_call`` shows its
  // matched substring; then ProviderLogo + model; then a small
  // mono-muted event id; then the time on the right.
  return (
    <>
      <EventTypePill eventType={item.event_type} />
      <Highlight
        text={item.event_type}
        query={query}
        className="font-mono text-[11px] text-text-muted"
      />
      {item.model && (
        <span className="flex items-center gap-1 text-text-muted">
          <ProviderLogo provider={getProvider(item.model)} size={12} title="" />
          <Highlight text={item.model} query={query} className="text-text-muted" />
        </span>
      )}
      {item.tool_name && (
        <Highlight text={item.tool_name} query={query} className="text-primary" />
      )}
      <span className="font-mono text-[11px] text-text-muted">
        {item.event_id.slice(0, 8)}
      </span>
      <span className="ml-auto text-text-muted">{formatTime(item.occurred_at)}</span>
    </>
  );
}
