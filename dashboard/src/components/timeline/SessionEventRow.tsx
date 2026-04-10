import { useMemo, memo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import type { ViewMode } from "@/pages/Fleet";
import { LEFT_PANEL_WIDTH } from "@/lib/constants";
import { EventNode } from "./EventNode";
import { BarView } from "./BarView";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { isEventVisible, truncateSessionId } from "@/lib/events";
import { OSIcon } from "@/components/ui/OSIcon";
import {
  OrchestrationIcon,
  getOrchestrationLabel,
} from "@/components/ui/OrchestrationIcon";

const stateBadgeColors: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(34,197,94,0.15)", color: "var(--status-active)" },
  idle: { bg: "rgba(234,179,8,0.15)", color: "var(--status-idle)" },
  stale: { bg: "rgba(249,115,22,0.15)", color: "var(--status-stale)" },
  closed: { bg: "rgba(100,100,100,0.15)", color: "var(--text-muted)" },
  lost: { bg: "rgba(239,68,68,0.15)", color: "var(--status-lost)" },
};

interface SessionEventRowProps {
  session: Session;
  scale: ScaleTime<number, number>;
  onClick: (eventId?: string, event?: AgentEvent) => void;
  viewMode: ViewMode;
  start: Date;
  end: Date;
  /**
   * Width of the event-circles area in pixels. The right panel is
   * sized exactly to this value so xScale.range = [0, timelineWidth]
   * and circles cannot escape into adjacent layout space. Renamed
   * from `width` to make the contract explicit and prevent the
   * double-subtraction bug that broke wide-range layouts.
   */
  timelineWidth: number;
  activeFilter?: string | null;
  version?: number;
}

function SessionEventRowComponent({ session, scale, onClick, viewMode, start, end, timelineWidth, activeFilter, version = 0 }: SessionEventRowProps) {
  const isActive = session.state === "active";
  const { events, loading } = useSessionEvents(session.session_id, isActive, version);
  const badge = stateBadgeColors[session.state] ?? stateBadgeColors.closed;

  // Pull display fields off the optional runtime context. Hostname
  // (when available) replaces the truncated session id as the primary
  // identifier; OS / orchestration icons render before the label so
  // platform engineers can scan the swimlane by environment at a
  // glance.
  const ctx = session.context as Record<string, unknown> | undefined;
  const ctxOs =
    typeof ctx?.os === "string" && ctx.os.length > 0 ? ctx.os : null;
  const ctxArch =
    typeof ctx?.arch === "string" && ctx.arch.length > 0 ? ctx.arch : null;
  const ctxHostname =
    typeof ctx?.hostname === "string" && ctx.hostname.length > 0
      ? ctx.hostname
      : null;
  const ctxOrch =
    typeof ctx?.orchestration === "string" && ctx.orchestration.length > 0
      ? ctx.orchestration
      : null;
  const ctxPython =
    typeof ctx?.python_version === "string" && ctx.python_version.length > 0
      ? `Python ${ctx.python_version}`
      : null;

  const platformTooltip = [
    ctxOs,
    ctxArch,
    ctxOrch ? getOrchestrationLabel(ctxOrch) : null,
    ctxPython,
  ]
    .filter(Boolean)
    .join(" · ");

  const primaryLabel = ctxHostname ?? truncateSessionId(session.session_id);

  const eventNodes = useMemo(
    () =>
      events.map((event) => ({
        id: event.id,
        x: scale(new Date(event.occurred_at)),
        eventType: event.event_type,
        model: event.model,
        toolName: event.tool_name,
        tokensTotal: event.tokens_total,
        latencyMs: event.latency_ms,
        occurredAt: event.occurred_at,
        directiveName: event.payload?.directive_name,
        directiveStatus: event.payload?.directive_status,
      })),
    [events, scale]
  );

  return (
    <div
      className="flex h-10 cursor-pointer items-center transition-colors hover:bg-surface-hover"
      style={{ borderBottom: "1px solid var(--border-subtle)" }}
      onClick={() => onClick()}
    >
      {/* Left panel — 240px, indented, sticky for horizontal scroll.
          When the session has a runtime context, the hostname replaces
          the truncated session id as the primary identifier and OS /
          orchestration icons sit before it. The full session id is
          always reachable via the row's hover tooltip so platform
          engineers don't lose access to the canonical id. */}
      <div
        className="flex h-full items-center gap-1.5 pl-7 pr-3"
        style={{
          width: LEFT_PANEL_WIDTH,
          flexShrink: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          position: "sticky",
          left: 0,
          zIndex: 1,
          overflow: "hidden",
        }}
        title={session.session_id}
      >
        {isActive && <div className="pulse-dot" />}
        {ctxOs && (
          <span title={platformTooltip || undefined}>
            <OSIcon os={ctxOs} size={12} />
          </span>
        )}
        {ctxOrch && (
          <span
            title={
              ctxOrch ? getOrchestrationLabel(ctxOrch) : undefined
            }
          >
            <OrchestrationIcon orchestration={ctxOrch} size={12} />
          </span>
        )}
        <span
          className="font-mono text-xs"
          style={{
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flexShrink: 1,
          }}
          data-testid="session-row-label"
        >
          {primaryLabel}
        </span>
        <span
          className="rounded font-mono text-[10px] px-[5px] py-[1px]"
          style={{
            background: badge.bg,
            color: badge.color,
            border: `1px solid ${badge.color}30`,
            flexShrink: 0,
          }}
        >
          {session.state}
        </span>
        <span
          className="ml-auto font-mono text-[11px]"
          style={{ color: "var(--text-muted)", flexShrink: 0 }}
        >
          {session.tokens_used.toLocaleString()}
        </span>
      </div>

      {/* Right panel — events. Sized to exactly timelineWidth so
          xScale.range = [0, timelineWidth] and circles cannot escape
          into adjacent layout space. overflow: hidden clips any
          visual that would otherwise leak into the next row. */}
      <div
        className="relative h-full flex items-center px-1"
        style={{
          width: timelineWidth,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {loading && (
          <div className="flex items-center h-full gap-2 pl-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-border animate-pulse"
              />
            ))}
          </div>
        )}
        {!loading && viewMode === "swimlane" &&
          eventNodes.map((node) => (
            <EventNode
              key={node.id}
              x={node.x}
              eventType={node.eventType}
              sessionId={session.session_id}
              flavor={session.flavor}
              model={node.model}
              toolName={node.toolName}
              tokensTotal={node.tokensTotal}
              latencyMs={node.latencyMs}
              occurredAt={node.occurredAt}
              eventId={node.id}
              directiveName={node.directiveName}
              directiveStatus={node.directiveStatus}
              onClick={(eid) => {
                const fullEvent = events.find((e) => e.id === eid);
                onClick(eid, fullEvent);
              }}
              size={24}
              isVisible={isEventVisible(node.eventType, activeFilter)}
            />
          ))}
        {!loading && viewMode === "bars" && (
          <BarView events={events} start={start} end={end} width={Math.max(timelineWidth, 100)} activeFilter={activeFilter} />
        )}
      </div>
    </div>
  );
}

export const SessionEventRow = memo(SessionEventRowComponent, (prev, next) => {
  if (prev.session.state !== next.session.state) return false;
  if (prev.session.tokens_used !== next.session.tokens_used) return false;
  // Context is set once by the worker on session_start. The first
  // WebSocket session update that carries context replaces the
  // session reference; we re-render so the OS/orchestration icons
  // and hostname appear without waiting for an unrelated state /
  // token change to invalidate the row.
  if (prev.session.context !== next.session.context) return false;
  if (prev.viewMode !== next.viewMode) return false;
  if (prev.activeFilter !== next.activeFilter) return false;
  if (prev.version !== next.version) return false;
  if (prev.timelineWidth !== next.timelineWidth) return false;
  // Only re-render for scale changes > 1 second
  const domainDelta = Math.abs(
    next.scale.domain()[1].getTime() - prev.scale.domain()[1].getTime()
  );
  if (domainDelta < 1000) return true;
  return false;
});
