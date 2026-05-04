import { AlertCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  attachBadge,
  getBadge,
  getEventDetail,
  getSummaryRows,
  isAttachmentStartEvent,
} from "@/lib/events";
import { getProvider } from "@/lib/models";
import { SyntaxJson } from "@/components/ui/syntax-json";
import type { AgentEvent } from "@/lib/types";
import { ErrorEventDetails } from "./ErrorEventDetails";
import { PolicyEventDetails } from "./PolicyEventDetails";
import { EmbeddingsContentViewer } from "./EmbeddingsContentViewer";
import { MCPEventDetails, isMCPEvent } from "./MCPEventDetails";

/**
 * Per-event row used by both the SessionDrawer's Timeline tab AND
 * the Sub-agents tab's inline expansion. Lifted from SessionDrawer
 * so the two surfaces render with byte-identical fidelity — same
 * type-coloured badge, same MCP-error indicator, same streaming
 * pill, same provider-logo + detail string, same expand-into-
 * ExpandedEvent on click.
 *
 * The Sub-agents tab's UX revision (DECISIONS.md "UX revision
 * 2026-05-04") locked the contract that the inline mini-timeline
 * must match Timeline-tab fidelity exactly — pre-extraction the
 * mini-timeline used a simpler ``EventDetail`` primitive that
 * dropped the colour pills, streaming badges, and provider logos,
 * which read as a degraded second-class rendering. Sharing the
 * exact same row component closes that gap and means future row-
 * shape changes (Phase 4 polish, new event types, etc.) land in
 * both places without manual sync.
 */
export interface EventRowProps {
  event: AgentEvent;
  attachments: string[];
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onViewPrompts?: (eventId: string) => void;
  onOpenDetail?: (event: AgentEvent) => void;
}

export function EventRow({
  event,
  attachments,
  isExpanded,
  onToggleExpand,
  onViewPrompts,
  onOpenDetail,
}: EventRowProps) {
  const isAttachment = isAttachmentStartEvent(event, attachments);
  const badge = isAttachment ? attachBadge : getBadge(event.event_type);
  const detail = getEventDetail(event);
  return (
    <div>
      <div
        className="flex h-8 cursor-pointer items-center gap-2 px-3 transition-colors hover:bg-surface-hover"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
        onClick={() => onToggleExpand(event.id)}
        // Generic ``event-row`` testid stays for the existing E2E
        // suite. New per-type testids (Phase 4 polish) pin a
        // specific shape so T14/T15/T16 can locate exactly the
        // row they assert against — e.g. ``embeddings-event-row-
        // <id>``. Type-specific id sits alongside the generic via
        // data-event-type so both selectors keep working.
        data-testid={
          event.event_type === "embeddings"
            ? `embeddings-event-row-${event.id}`
            : event.event_type === "llm_error"
              ? `error-event-row-${event.id}`
              : event.event_type === "policy_warn" ||
                  event.event_type === "policy_degrade" ||
                  event.event_type === "policy_block"
                ? `policy-event-row-${event.id}`
                : isMCPEvent(event.event_type)
                  ? `mcp-event-row-${event.id}`
                  : "event-row"
        }
        data-event-type={event.event_type}
        data-event-id={event.id}
      >
        {isAttachment ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
                  style={{
                    background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
                    color: badge.cssVar,
                    border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
                    borderRadius: 3,
                  }}
                  data-testid="event-badge"
                >
                  {badge.label}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Agent re-attached with the same session ID
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span
            className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
            style={{
              background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
              color: badge.cssVar,
              border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
              borderRadius: 3,
            }}
            data-testid="event-badge"
          >
            {badge.label}
          </span>
        )}
        <MCPErrorIndicator event={event} />
        <span
          className="flex-1 truncate text-[13px] flex items-center gap-1"
          style={{ color: "var(--text)" }}
          title={detail}
        >
          {(event.event_type === "post_call" ||
            event.event_type === "pre_call") &&
            event.model && (
              <ProviderLogo provider={getProvider(event.model)} size={12} />
            )}
          {detail}
          <StreamingPill event={event} />
        </span>
        <span
          className="w-[72px] shrink-0 text-right font-mono text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          {new Date(event.occurred_at).toLocaleTimeString()}
        </span>
      </div>
      {isExpanded && (
        <ExpandedEvent
          event={event}
          onViewPrompts={
            event.has_content && onViewPrompts
              ? () => onViewPrompts(event.id)
              : undefined
          }
          onOpenDetail={onOpenDetail ? () => onOpenDetail(event) : undefined}
        />
      )}
    </div>
  );
}

/**
 * Phase 5 — small inline error indicator rendered between the badge
 * and the detail text on MCP event rows whose ``payload.error`` is
 * populated. Without this, an operator scanning the event feed cannot
 * distinguish a successful ``mcp_tool_call`` from a failed one
 * without expanding the row.
 *
 * Renders nothing when the event isn't MCP, when there's no error
 * field, or when ``payload`` is missing.
 */
export function MCPErrorIndicator({ event }: { event: AgentEvent }) {
  if (!isMCPEvent(event.event_type)) return null;
  const err = event.payload?.error;
  if (err == null) return null;
  const message =
    typeof err === "string"
      ? err
      : err && typeof err === "object"
        ? (err as { message?: string }).message ||
          (err as { error_class?: string }).error_class ||
          (err as { error_type?: string }).error_type ||
          "MCP call failed"
        : "MCP call failed";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`mcp-error-indicator-${event.id}`}
            aria-label={`MCP call failed: ${message}`}
            className="inline-flex shrink-0 items-center justify-center"
            style={{ color: "var(--event-error)" }}
          >
            <AlertCircle size={12} strokeWidth={2.5} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{`Failed: ${message}`}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Phase 4 — inline ``STREAM`` / ``ABORTED`` pill rendered alongside
 * the row's detail text for any post_call event whose payload
 * carries the streaming sub-object. ``STREAM`` for completed
 * streams; ``ABORTED`` (red) when ``final_outcome === "aborted"``.
 * Title attribute carries chunks/p50/p95/max_gap (and
 * abort_reason on aborted) so a hover reveals the per-chunk
 * latency summary.
 *
 * Renders nothing when ``payload.streaming`` is absent.
 */
export function StreamingPill({ event }: { event: AgentEvent }) {
  const stream = event.payload?.streaming;
  if (!stream) return null;
  const aborted = stream.final_outcome === "aborted";
  const ic = stream.inter_chunk_ms;
  const titleParts: string[] = [`chunks=${stream.chunk_count}`];
  if (ic) {
    titleParts.push(`p50=${ic.p50}ms`);
    titleParts.push(`p95=${ic.p95}ms`);
    titleParts.push(`max_gap=${ic.max}ms`);
  }
  if (aborted && stream.abort_reason) {
    titleParts.push(`abort_reason=${stream.abort_reason}`);
  }
  const title = titleParts.join(" · ");
  const colorVar = aborted ? "var(--event-error)" : "var(--event-llm)";
  const label = aborted ? "ABORTED" : "STREAM";
  return (
    <span
      data-testid={
        aborted ? `stream-aborted-${event.id}` : `stream-badge-${event.id}`
      }
      title={title}
      className="ml-1 inline-flex h-[16px] shrink-0 items-center rounded font-mono text-[9px] font-semibold uppercase"
      style={{
        padding: "0 5px",
        background: `color-mix(in srgb, ${colorVar} 15%, transparent)`,
        color: colorVar,
        border: `1px solid color-mix(in srgb, ${colorVar} 30%, transparent)`,
        borderRadius: 3,
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Expanded event body shown below an EventRow when the user clicks
 * the row. Renders the standard summary rows + type-specific
 * details (errors, policy events, embeddings content, MCP details)
 * + the raw payload JSON. Same component the SessionDrawer's
 * Timeline tab has used since Phase 4.
 */
export function ExpandedEvent({
  event,
  onViewPrompts,
  onOpenDetail,
}: {
  event: AgentEvent;
  onViewPrompts?: () => void;
  onOpenDetail?: () => void;
}) {
  const summaryRows = getSummaryRows(event);
  const payload = {
    id: event.id,
    event_type: event.event_type,
    model: event.model,
    tokens_input: event.tokens_input,
    tokens_output: event.tokens_output,
    tokens_total: event.tokens_total,
    latency_ms: event.latency_ms,
    tool_name: event.tool_name,
    has_content: event.has_content,
    occurred_at: event.occurred_at,
  };
  const errorPayload =
    event.event_type === "llm_error" &&
    event.payload?.error &&
    typeof event.payload.error !== "string"
      ? event.payload.error
      : null;
  return (
    <div
      className="px-3 py-2.5"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {summaryRows.map(([key, val]) => (
          <div key={key} className="contents">
            <span
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {key}
            </span>
            <span
              className="font-mono text-xs"
              style={{ color: "var(--text)" }}
            >
              {val}
            </span>
          </div>
        ))}
      </div>
      {errorPayload && (
        <ErrorEventDetails error={errorPayload} eventId={event.id} />
      )}
      {(event.event_type === "policy_warn" ||
        event.event_type === "policy_degrade" ||
        event.event_type === "policy_block") && (
        <PolicyEventDetails event={event} />
      )}
      {event.event_type === "embeddings" && (
        <EmbeddingsContentViewer
          eventId={event.id}
          hasContent={event.has_content}
        />
      )}
      {isMCPEvent(event.event_type) && <MCPEventDetails event={event} />}
      <div
        className="my-2"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      />
      <SyntaxJson data={payload} />
      <div className="mt-2 flex items-center gap-3">
        {onViewPrompts && (
          <button
            className="text-xs"
            style={{ color: "var(--accent)" }}
            onClick={(e) => {
              e.stopPropagation();
              onViewPrompts();
            }}
          >
            View Prompts →
          </button>
        )}
        {onOpenDetail && (
          <button
            className="text-[11px]"
            style={{ color: "var(--accent)" }}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetail();
            }}
            data-testid="open-full-detail"
          >
            Open full detail →
          </button>
        )}
      </div>
    </div>
  );
}
