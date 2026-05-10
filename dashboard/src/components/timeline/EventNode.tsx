import { useState, memo, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EventType } from "@/lib/types";
import { truncateSessionId } from "@/lib/events";
import { cn } from "@/lib/utils";
import {
  Zap, Wrench, AlertTriangle, XCircle, ArrowDown,
  Play, Square, Check, Circle, X, Database, AlertCircle,
  ListChecks, FileText, Folder, MessageSquare, List,
  type LucideProps,
} from "lucide-react";

const eventTypeConfig: Record<
  string,
  { cssVar: string; label: string; Icon: React.ComponentType<LucideProps> }
> = {
  pre_call: { cssVar: "var(--event-llm)", Icon: Zap, label: "LLM Call" },
  post_call: { cssVar: "var(--event-llm)", Icon: Zap, label: "LLM Response" },
  tool_call: { cssVar: "var(--event-tool)", Icon: Wrench, label: "Tool Call" },
  policy_warn: { cssVar: "var(--event-warn)", Icon: AlertTriangle, label: "Policy Warn" },
  policy_block: { cssVar: "var(--event-block)", Icon: XCircle, label: "Policy Block" },
  policy_degrade: { cssVar: "var(--event-degrade)", Icon: ArrowDown, label: "Policy Degrade" },
  session_start: { cssVar: "var(--event-lifecycle)", Icon: Play, label: "Session Start" },
  session_end: { cssVar: "var(--event-lifecycle)", Icon: Square, label: "Session End" },
  directive_result: { cssVar: "var(--event-directive)", Icon: Check, label: "Directive Result" },
  heartbeat: { cssVar: "var(--event-lifecycle)", Icon: Circle, label: "Heartbeat" },
  // Phase 4 event-type additions. ``embeddings`` reuses the cyan
  // RAG/semantic-search visual family; ``llm_error`` is the
  // danger-red ``--event-error`` token. Distinct glyphs (Database
  // / AlertCircle) keep the 24px circle readable at a glance so a
  // row of mixed events doesn't read as "all the same shape but
  // coloured differently". ``llm_error`` deliberately uses a
  // different glyph from policy_block (XCircle) — they're both
  // alarming but they mean different things, so the iconography
  // separates them.
  embeddings: { cssVar: "var(--event-embeddings)", Icon: Database, label: "Embeddings" },
  llm_error: { cssVar: "var(--event-error)", Icon: AlertCircle, label: "LLM Error" },
  // Phase 5 — MCP. Three colour families × two glyph variants per
  // family. Solid (call/read/get) gets the more pictographic glyph;
  // outline (list) gets the list-style glyph. Wrench shares with the
  // LLM tool_call type but the cyan-2 chroma + label disambiguate at
  // any size. ListChecks is the discovery shape; FileText reads as a
  // document for resource reads; Folder reads as the resource bucket;
  // MessageSquare for prompt fetches; List for prompt enumeration.
  // Phase 5 MCP — Title-Case "MCP " prefix matches the badge labels
  // in lib/events.ts (D123 restores the prefix). A hover tooltip on
  // the swimlane circle now reads identically to the badge of the
  // corresponding drawer row, including the category prefix.
  mcp_tool_call: { cssVar: "var(--event-mcp-tool)", Icon: Wrench, label: "MCP Tool Call" },
  mcp_tool_list: { cssVar: "var(--event-mcp-tool)", Icon: ListChecks, label: "MCP Tools Discovered" },
  mcp_resource_read: { cssVar: "var(--event-mcp-resource)", Icon: FileText, label: "MCP Resource Read" },
  mcp_resource_list: { cssVar: "var(--event-mcp-resource)", Icon: Folder, label: "MCP Resources Discovered" },
  mcp_prompt_get: { cssVar: "var(--event-mcp-prompt)", Icon: MessageSquare, label: "MCP Prompt Fetched" },
  mcp_prompt_list: { cssVar: "var(--event-mcp-prompt)", Icon: List, label: "MCP Prompts Discovered" },
};

// Failed directive_result events (error/timeout) render with the
// plain X glyph instead of the Check icon. X is bolder and more
// readable than XCircle at the 20-24px circle sizes.
const FAILED_DIRECTIVE_STATUSES = new Set(["error", "timeout"]);

const defaultConfig = { cssVar: "var(--event-lifecycle)", Icon: Circle, label: "Event" };

// Override colors for directive_result events based on directive_status.
// success/acknowledged → green (status-active)
// error/timeout → red (status-lost / event-block)
// anything else → fall back to the base directive color
function directiveResultOverride(
  status: string | undefined,
): { cssVar: string } | null {
  if (!status) return null;
  if (status === "success" || status === "acknowledged") {
    return { cssVar: "var(--status-active)" };
  }
  if (status === "error" || status === "timeout") {
    return { cssVar: "var(--event-block)" };
  }
  return null;
}

export interface EventNodeProps {
  x: number;
  eventType: EventType | string;
  sessionId: string;
  flavor: string;
  model?: string | null;
  toolName?: string | null;
  tokensTotal?: number | null;
  latencyMs?: number | null;
  occurredAt: string;
  eventId?: string;
  onClick: (eventId?: string) => void;
  size?: number;
  isVisible?: boolean;
  directiveName?: string;
  directiveStatus?: string;
  /**
   * When true, override the session_start lifecycle colour with
   * var(--warning) (the project amber) and flip the tooltip label
   * to "Session attached". Caller is responsible for passing this
   * only when the event_type is session_start AND it matched the
   * session's attachments array -- see
   * lib/events.ts::isAttachmentStartEvent. Follows the
   * directive_result override pattern already in this file so
   * there's one consistent way to colour-swap a circle.
   */
  isAttachment?: boolean;
}

function EventNodeComponent({
  x, eventType, sessionId, flavor, model, toolName,
  tokensTotal, latencyMs, occurredAt, eventId, onClick,
  size = 24, isVisible = true, directiveName, directiveStatus,
  isAttachment = false,
}: EventNodeProps) {
  const config = eventTypeConfig[eventType] ?? defaultConfig;
  const override = eventType === "directive_result"
    ? directiveResultOverride(directiveStatus)
    : null;
  // Attachment recolour: applies only to session_start circles. Sits
  // below directive_result in priority because the two event types
  // are disjoint -- a session_start is never a directive_result.
  const attachColor =
    isAttachment && eventType === "session_start" ? "var(--warning)" : null;
  const color = attachColor ?? override?.cssVar ?? config.cssVar;
  // Phase 5 (B-5b) — MCP family is rendered as HEXAGONS, not circles.
  // The shape itself is the family identifier so an operator scanning
  // the swimlane can tell at a glance which events are MCP vs LLM /
  // tool / embeddings / policy. The pre-B-5b 3px mauve box-shadow
  // ring around a still-circular shape was insufficient (Supervisor
  // verified live in Chrome at 1280×800: ring is too subtle at
  // swimlane density on dark backgrounds, every event still reads as
  // a circle). The hexagon is shaped via CSS clip-path applied to
  // the same container element — Tailwind's ``rounded-full`` class
  // is overridden by ``borderRadius: 0`` and the white border is
  // dropped on MCP events because clip-path would otherwise reveal
  // jagged border fragments at the hex apexes. Per-type fill colour
  // and glyph remain unchanged so within-family differentiation
  // (tool / resource / prompt families and call vs discover within)
  // is still legible. Hover scale-up scales the clip-path with the
  // element so the hex stays hex at 1.25×.
  const isMCP = eventType.startsWith("mcp_");
  // Pointy-top regular hexagon. 50% 0% is the top apex; 7%/93% on the
  // left/right edges follow from the regular-hexagon geometry
  // (``cos(30°) ≈ 0.866`` → 50% ± 43.3%, but pulled in slightly to
  // 7%/93% so the bounding-box leaves a 1px breathing margin against
  // adjacent circles in the swimlane). The 25%/75% Y-coords are the
  // hexagon's flat-side endpoints. Pointy-top reads as "node in a
  // network/protocol mesh," matching MCP's "protocol between agent
  // and external tooling" semantic.
  const HEXAGON_CLIP_PATH =
    "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)";
  // Failed directive_result events use the plain X glyph in place of
  // the success Check. The tooltip label switches to "RESULT · status"
  // for any directive_result event so the status is visible without
  // opening the drawer.
  const isFailedDirective =
    eventType === "directive_result" &&
    !!directiveStatus &&
    FAILED_DIRECTIVE_STATUSES.has(directiveStatus);
  const tooltipLabel =
    isAttachment && eventType === "session_start"
      ? "Session attached"
      : eventType === "directive_result" && directiveStatus
      ? `RESULT · ${directiveStatus}`
      : config.label;
  const [hovered, setHovered] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const iconSize = size <= 20 ? 11 : 13;

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    setTooltipPos(null);
  }, []);

  const IconComponent = isFailedDirective ? X : config.Icon;

  return (
    <>
      <div
        data-testid={`session-circle-${sessionId}`}
        className={cn(
          "absolute top-1/2 -translate-y-1/2 cursor-pointer flex items-center justify-center flex-shrink-0",
          // Non-MCP events keep the rounded-full circle shape via
          // Tailwind. MCP events are clip-path hexagons (see B-5b)
          // and override border-radius inline — applying
          // ``rounded-full`` AND a hexagon clip-path together would
          // round the visible hexagon's apexes which is not what we
          // want.
          !isMCP && "rounded-full",
          // Transform transition is scoped to the hover state only.
          // Keeping it on all 900+ circles as a permanent inline
          // style meant React diffed the `transition` declaration
          // on every rAF tick even though nothing was animating.
          // The hover-in scale-up transitions smoothly; the
          // hover-out snaps back instantly, which is acceptable at
          // 150ms and keeps the render path cheap. Opacity
          // transition (previously 300ms) removed entirely along
          // with the rAF mount-fade -- circles now appear
          // immediately when they render.
          hovered && "transition-transform duration-150 ease-out",
        )}
        // Phase 5 (B-5b) — ``data-mcp-family`` is the structural
        // marker E2E + unit tests use to identify the hexagon
        // primitive without depending on inline-style introspection.
        // Always emitted on MCP events; never on non-MCP.
        data-mcp-family={isMCP ? "true" : undefined}
        data-event-shape={isMCP ? "hexagon" : "circle"}
        style={{
          left: x, width: size, height: size,
          backgroundColor: color, color: "white",
          // MCP hexagon: drop the white border because clip-path
          // would clip it into jagged fragments at the apexes; the
          // hexagon edges are sharp by design. Non-MCP circles keep
          // the existing 1.5px translucent-white inner border for
          // chrome separation against adjacent circles.
          border: isMCP ? "none" : "1.5px solid rgba(255,255,255,0.1)",
          clipPath: isMCP ? HEXAGON_CLIP_PATH : undefined,
          transform: hovered ? "translateY(-50%) scale(1.25)" : "translateY(-50%) scale(1)",
          // zIndex 2 (was 1) so circles paint above the timeline
          // grid line overlay which now sits at zIndex 1.
          zIndex: hovered ? 10 : 2,
          opacity: isVisible ? 1 : 0,
          pointerEvents: isVisible ? "auto" : "none",
        }}
        onClick={(e) => { e.stopPropagation(); onClick(eventId); }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <IconComponent size={iconSize} />
      </div>

      {/* Tooltip rendered in a portal to escape overflow:hidden */}
      {hovered && tooltipPos && createPortal(
        <div
          style={{
            position: "fixed",
            top: tooltipPos.top,
            left: tooltipPos.left,
            transform: "translate(-50%, -100%)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 11,
            pointerEvents: "none",
            zIndex: 9999,
            whiteSpace: "nowrap",
          }}
        >
          <div style={{ color: "var(--text-secondary)" }}>{tooltipLabel}</div>
          <div className="font-mono" style={{ color: "var(--text-muted)" }}>
            {flavor} / {truncateSessionId(sessionId)}
          </div>
          {directiveName && (
            <div style={{ color: "var(--text)" }}>
              {directiveName}{directiveStatus ? ` · ${directiveStatus}` : ""}
            </div>
          )}
          {model && <div style={{ color: "var(--text)" }}>{model}</div>}
          {toolName && <div style={{ color: "var(--text)" }}>Tool: {toolName}</div>}
          {tokensTotal != null && (
            <div style={{ color: "var(--text)" }}>{tokensTotal.toLocaleString()} tokens</div>
          )}
          {latencyMs != null && (
            <div style={{ color: "var(--text-muted)" }}>{latencyMs}ms</div>
          )}
          <div className="font-mono" style={{ color: "var(--text-muted)" }}>
            {new Date(occurredAt).toLocaleTimeString()}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export const EventNode = memo(EventNodeComponent, (prev, next) => {
  if (prev.x !== next.x) return false;
  if (prev.isVisible !== next.isVisible) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.size !== next.size) return false;
  if (prev.directiveStatus !== next.directiveStatus) return false;
  if (prev.directiveName !== next.directiveName) return false;
  if (prev.isAttachment !== next.isAttachment) return false;
  return true;
});
