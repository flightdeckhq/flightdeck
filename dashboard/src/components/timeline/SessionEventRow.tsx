import { useMemo, memo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import { SESSION_ROW_HEIGHT } from "@/lib/constants";
import { EventNode } from "./EventNode";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { isEventVisible, truncateSessionId } from "@/lib/events";
import { OSIcon } from "@/components/ui/OSIcon";
import {
  OrchestrationIcon,
  getOrchestrationLabel,
} from "@/components/ui/OrchestrationIcon";
import { Camera } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Threshold at which the token count is dropped from the row left
 * panel. Below this, the panel is too narrow to fit session number +
 * icons + hostname + state badge + token count without wrapping or
 * overflowing. The token count is the least critical field so it
 * hides first; drag the panel wider to bring it back.
 *
 * Raised from 260 to 300 after the default width grew to 320 so
 * typical 14-char hostnames ("mac-laptop-bob", "compose-build-2")
 * show in full at the default, and dragging down to ~290 starts
 * trimming the token count first rather than the hostname.
 */
const TOKEN_COUNT_MIN_WIDTH = 300;

const stateBadgeColors: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(34,197,94,0.15)", color: "var(--status-active)" },
  idle: { bg: "rgba(234,179,8,0.15)", color: "var(--status-idle)" },
  stale: { bg: "rgba(249,115,22,0.15)", color: "var(--status-stale)" },
  closed: { bg: "rgba(100,100,100,0.15)", color: "var(--text-muted)" },
  lost: { bg: "rgba(239,68,68,0.15)", color: "var(--status-lost)" },
};

interface SessionEventRowProps {
  session: Session;
  /**
   * Zero-based position of this session within the parent flavor's
   * session list. Rendered as a 1-based index prefix in the left
   * panel so platform engineers can refer to "session 3" without
   * memorising the UUID.
   */
  sessionIndex: number;
  scale: ScaleTime<number, number>;
  onClick: (eventId?: string, event?: AgentEvent) => void;
  /**
   * Width of the event-circles area in pixels. The right panel is
   * sized exactly to this value so xScale.range = [0, timelineWidth]
   * and circles cannot escape into adjacent layout space.
   */
  timelineWidth: number;
  /**
   * Current resizable width of the sticky left panel. Flows from
   * Timeline.tsx via SwimLane so every row resizes in lockstep when
   * the user drags the Flavors-header resize handle.
   */
  leftPanelWidth: number;
  activeFilter?: string | null;
  version?: number;
}

function SessionEventRowComponent({
  session,
  sessionIndex,
  scale,
  onClick,
  timelineWidth,
  leftPanelWidth,
  activeFilter,
  version = 0,
}: SessionEventRowProps) {
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

  const truncatedSid = truncateSessionId(session.session_id);
  const showTokens = leftPanelWidth >= TOKEN_COUNT_MIN_WIDTH;

  return (
    <div
      className="flex cursor-pointer items-center transition-colors hover:bg-surface-hover"
      style={{
        height: SESSION_ROW_HEIGHT,
        borderBottom: "1px solid var(--border-subtle)",
      }}
      onClick={() => onClick()}
    >
      {/* Left panel — resizable, sticky for horizontal scroll.
          Layout inside the panel:
            <index> <pulse> <os-icon> <orch-icon> <label-column>
            <state-badge> <tokens?>
          The label column is a 2-line stack: primary label (hostname
          or hash) on top, secondary hash muted below when hostname is
          available. The full session id is also reachable via the
          row's hover tooltip. Token count is hidden when the panel
          is narrower than TOKEN_COUNT_MIN_WIDTH to keep the row
          legible during narrow drags. */}
      <div
        className="flex h-full items-center gap-1.5"
        style={{
          width: leftPanelWidth,
          flexShrink: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          position: "sticky",
          left: 0,
          zIndex: 1,
          overflow: "hidden",
          padding: "0 8px 0 28px",
        }}
        // When the row's primary label is the hostname, the hostname
        // is the field most likely to be visually truncated, so put
        // it on the first line of the tooltip with the full uuid
        // below. Browser `title` attributes render "\n" as a line
        // break in native tooltips. When there's no hostname the
        // uuid IS the identity and there's nothing to stack above.
        title={
          ctxHostname
            ? `${ctxHostname}\n${session.session_id}`
            : session.session_id
        }
      >
        <span
          data-testid="session-row-index"
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            minWidth: 14,
            textAlign: "right",
          }}
        >
          {sessionIndex + 1}
        </span>
        {isActive && <div className="pulse-dot" />}
        {ctxOs && (
          <span title={platformTooltip || undefined}>
            <OSIcon os={ctxOs} size={12} />
          </span>
        )}
        {ctxOrch && (
          <span
            title={ctxOrch ? getOrchestrationLabel(ctxOrch) : undefined}
          >
            <OrchestrationIcon orchestration={ctxOrch} size={12} />
          </span>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            data-testid="session-row-label"
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}
          >
            {primaryLabel}
          </span>
          {/* Secondary session hash -- only shown when hostname
              occupies the primary slot. Without a hostname, the
              hash IS the identity and duplicating it would waste
              space. */}
          {ctxHostname && (
            <span
              data-testid="session-row-hash"
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {truncatedSid}
            </span>
          )}
        </div>
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
        {session.capture_enabled && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span style={{ display: "inline-flex", lineHeight: 0, flexShrink: 0 }} aria-label="Prompt capture enabled">
                  <Camera size={12} style={{ color: "var(--accent)" }} />
                </span>
              </TooltipTrigger>
              <TooltipContent>Prompt capture enabled</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {showTokens && (
          <span
            data-testid="session-row-tokens"
            className="font-mono text-[11px]"
            style={{ color: "var(--text-muted)", flexShrink: 0 }}
          >
            {session.tokens_used.toLocaleString()}
          </span>
        )}
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
        {!loading &&
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
  if (prev.sessionIndex !== next.sessionIndex) return false;
  if (prev.activeFilter !== next.activeFilter) return false;
  if (prev.version !== next.version) return false;
  if (prev.timelineWidth !== next.timelineWidth) return false;
  // The left panel width gates token-count visibility and drives
  // the sticky column's actual width, so a drag must invalidate
  // every row immediately.
  if (prev.leftPanelWidth !== next.leftPanelWidth) return false;
  // Only re-render for scale changes > 1 second
  const domainDelta = Math.abs(
    next.scale.domain()[1].getTime() - prev.scale.domain()[1].getTime()
  );
  if (domainDelta < 1000) return true;
  return false;
});
