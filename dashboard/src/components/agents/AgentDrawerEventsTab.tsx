import { useState } from "react";
import type { AgentEvent } from "@/lib/types";
import { getEventDetail, truncateSessionId } from "@/lib/events";
import { EventTypePill } from "@/components/facets/EventTypePill";
import { relativeTime } from "@/lib/agents-format";
import { useAgentEvents } from "@/hooks/useAgentEvents";

const PAGE_SIZE = 50;

interface AgentDrawerEventsTabProps {
  agentId: string;
  /** Row click — opens the event detail drawer. */
  onEventClick: (event: AgentEvent) => void;
  /** Run-badge click — opens the run drawer for the event's run. */
  onRunClick: (sessionId: string) => void;
}

/**
 * Agent drawer Events tab — a paginated, newest-first list of every
 * event across the agent's runs. Backed by `useAgentEvents`
 * (`GET /v1/events?agent_id=`).
 */
export function AgentDrawerEventsTab({
  agentId,
  onEventClick,
  onRunClick,
}: AgentDrawerEventsTabProps) {
  const [page, setPage] = useState(0);
  const { events, total, loading, error } = useAgentEvents(
    agentId,
    page,
    PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div
      data-testid="agent-drawer-events-tab"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div style={{ flex: 1, overflow: "auto" }}>
        {error && (
          <div
            data-testid="agent-drawer-events-error"
            style={{ padding: 16, fontSize: 12, color: "var(--danger)" }}
          >
            Could not load events for this agent.
          </div>
        )}
        {!error && loading && events.length === 0 && (
          <div
            data-testid="agent-drawer-events-loading"
            style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}
          >
            Loading events…
          </div>
        )}
        {!error && !loading && events.length === 0 && (
          <div
            data-testid="agent-drawer-events-empty"
            style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}
          >
            No events recorded for this agent.
          </div>
        )}
        {events.map((event) => {
          return (
            <div
              key={event.id}
              data-testid="agent-drawer-event-row"
              role="button"
              tabIndex={0}
              onClick={() => onEventClick(event)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onEventClick(event);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-subtle)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <EventTypePill eventType={event.event_type} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text)",
                }}
                title={getEventDetail(event)}
              >
                {getEventDetail(event)}
              </span>
              {(event.model || event.payload?.from_model) && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "var(--text-muted)",
                  }}
                >
                  {event.model ?? ""}
                </span>
              )}
              <button
                type="button"
                data-testid="agent-drawer-event-run-badge"
                onClick={(e) => {
                  e.stopPropagation();
                  onRunClick(event.session_id);
                }}
                title={`Open run ${event.session_id}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {truncateSessionId(event.session_id)}
              </button>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-muted)",
                  minWidth: 56,
                  textAlign: "right",
                }}
                title={new Date(event.occurred_at).toLocaleString()}
              >
                {relativeTime(event.occurred_at)}
              </span>
            </div>
          );
        })}
      </div>
      {total > PAGE_SIZE && (
        <div
          data-testid="agent-drawer-events-pagination"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderTop: "1px solid var(--border-subtle)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          <span data-testid="agent-drawer-events-pagination-counts">
            {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
            {total}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="agent-drawer-events-prev"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              style={paginationButtonStyle(page === 0)}
            >
              ← Prev
            </button>
            <button
              type="button"
              data-testid="agent-drawer-events-next"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              style={paginationButtonStyle(page >= pageCount - 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function paginationButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 3,
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-muted)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
