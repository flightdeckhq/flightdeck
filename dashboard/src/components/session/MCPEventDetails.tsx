import { useCallback, useState } from "react";
import type { AgentEvent, EventContent } from "@/lib/types";
import { fetchEventContent } from "@/lib/api";
import { AccordionHeader } from "./AccordionHeader";

/**
 * Collapsible details block rendered inside the expanded view of any
 * Phase 5 MCP event (``mcp_tool_call`` / ``mcp_tool_list`` /
 * ``mcp_resource_read`` / ``mcp_resource_list`` / ``mcp_prompt_get`` /
 * ``mcp_prompt_list``). Sibling to ``ErrorEventDetails`` and
 * ``PolicyEventDetails`` — same accordion shape, same per-field testid
 * convention so the T25 E2E spec can target individual rows.
 *
 * The summary rows above this accordion already carry server /
 * transport / tool|resource|prompt name / count / size / mime / duration
 * (see ``getSummaryRows`` in ``lib/events.ts``). This component renders
 * the structured payload that fits the dashboard's render-inline
 * convention: arguments + result for tool calls, content body for
 * resource reads, rendered messages for prompt fetches. All gated by
 * ``capture_prompts`` on the sensor side — when capture is off the
 * fields are absent from the payload and we render an explicit
 * "capture disabled" notice rather than an empty accordion.
 *
 * B-6 — content-overflow handling. Fields above the sensor's 8 KiB
 * inline threshold are stripped from the inline payload and replaced
 * with a ``{"_truncated": true, "size": N}`` marker; the full content
 * lives in the event_content row, fetched on click via
 * ``GET /v1/events/:id/content``. The component lazily fetches once
 * the user requests any truncated field and reuses the cached
 * response across all per-field reveals on the same event. The hard-
 * cap case (``_capped: true``) renders a "content too large to
 * capture" notice with no fetch button — no full content was
 * preserved on the wire.
 *
 * Failure paths share rendering with ``ErrorEventDetails`` semantically
 * but the MCP error taxonomy (JSON-RPC codes, ``error_class``) differs
 * from the LLM error taxonomy, so a small inline error block lives
 * here rather than reusing that component.
 */

const TRUNCATE_LIMIT = 2000;

const MCP_EVENT_TYPES = new Set([
  "mcp_tool_call",
  "mcp_tool_list",
  "mcp_resource_read",
  "mcp_resource_list",
  "mcp_prompt_get",
  "mcp_prompt_list",
]);

export function isMCPEvent(eventType: string): boolean {
  return MCP_EVENT_TYPES.has(eventType);
}

interface MCPEventDetailsProps {
  event: AgentEvent;
}

interface TruncationMarker {
  _truncated: true;
  size?: number;
  _capped?: boolean;
}

function isTruncationMarker(value: unknown): value is TruncationMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _truncated?: unknown })._truncated === true
  );
}

function isCappedMarker(value: unknown): boolean {
  return (
    isTruncationMarker(value) && (value as TruncationMarker)._capped === true
  );
}

export function MCPEventDetails({ event }: MCPEventDetailsProps) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<EventContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFull = useCallback(async () => {
    if (loading || fullContent) return;
    setLoading(true);
    setError(null);
    try {
      const c = await fetchEventContent(event.id);
      if (c == null) {
        setError("Content unavailable for this event.");
      } else {
        setFullContent(c);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load content.");
    } finally {
      setLoading(false);
    }
  }, [event.id, fullContent, loading]);

  const p = event.payload;
  if (!p) return null;
  if (!isMCPEvent(event.event_type)) return null;

  // Failure path: surface the structured MCP taxonomy regardless of
  // capture state. Errors carry no sensitive content.
  const errPayload = p.error;
  const isStructuredError = !!errPayload && typeof errPayload !== "string";

  // Per-field state. Captured payload is present when the inline
  // field has a value OR when it carries a truncation marker. Lists
  // get their own notice branch.
  const isListEvent =
    event.event_type === "mcp_tool_list" ||
    event.event_type === "mcp_resource_list" ||
    event.event_type === "mcp_prompt_list";

  // For resource_read, the inline ``content`` field is absent when the
  // body overflowed (the wire ``content`` was repurposed for the
  // event_content payload, which the worker consumed). The presence
  // of has_content=true is the discriminant for a truncated body.
  const resourceContentTruncated =
    event.event_type === "mcp_resource_read" &&
    p.content == null &&
    event.has_content === true;

  const hasCapturedPayload =
    (event.event_type === "mcp_tool_call" &&
      (p.arguments != null || p.result != null)) ||
    (event.event_type === "mcp_resource_read" &&
      (p.content != null || resourceContentTruncated)) ||
    (event.event_type === "mcp_prompt_get" &&
      (p.arguments != null || (p.rendered && p.rendered.length > 0)));

  return (
    <div
      data-testid={`mcp-event-details-${event.id}`}
      className="mt-2"
      style={{
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 8,
      }}
    >
      <AccordionHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label="MCP details"
        testId={`mcp-event-details-toggle-${event.id}`}
      />
      {expanded && (
        <div className="mt-2 space-y-3">
          {isStructuredError && (
            <ErrorBlock event={event} error={errPayload as MCPErrorShape} />
          )}
          {!isStructuredError && hasCapturedPayload && (
            <CapturedPayloadBlock
              event={event}
              fullContent={fullContent}
              loading={loading}
              loadError={error}
              onLoadFull={loadFull}
            />
          )}
          {!isStructuredError && !hasCapturedPayload && !isListEvent && (
            <CaptureDisabledNotice eventId={event.id} />
          )}
          {!isStructuredError && isListEvent && (
            <ListNotice
              eventId={event.id}
              count={typeof p.count === "number" ? p.count : null}
            />
          )}
        </div>
      )}
    </div>
  );
}

// MCP error shape. Mirrors ``MCPErrorPayload`` in lib/types.ts but
// kept local because we don't want to widen the type-import surface
// every time we render — the only fields we read here are the four
// listed below.
interface MCPErrorShape {
  error_type: string;
  error_class?: string;
  message?: string;
  code?: number;
  // Provider-supplied error details — shape varies per error_type
  // (FastMCP / mcp-py / sensor synthesised). Typed as `unknown` so
  // consumers narrow before rendering; the ErrorBlock JSON.stringifies
  // it directly which works for any value type.
  data?: unknown;
}

function ErrorBlock({
  event,
  error,
}: {
  event: AgentEvent;
  error: MCPErrorShape;
}) {
  return (
    <div
      data-testid={`mcp-event-detail-error-${event.id}`}
      className="grid gap-x-3 gap-y-1"
      style={{
        gridTemplateColumns: "120px 1fr",
        background: "color-mix(in srgb, var(--event-error) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--event-error) 30%, transparent)",
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <DetailRow
        label="Error type"
        value={error.error_type}
        testId={`mcp-event-detail-error-type-${event.id}`}
      />
      {error.error_class && (
        <DetailRow
          label="Class"
          value={error.error_class}
          testId={`mcp-event-detail-error-class-${event.id}`}
        />
      )}
      {typeof error.code === "number" && (
        <DetailRow
          label="Code"
          value={String(error.code)}
          testId={`mcp-event-detail-error-code-${event.id}`}
        />
      )}
      {error.message && (
        <DetailRow
          label="Message"
          value={error.message}
          testId={`mcp-event-detail-error-message-${event.id}`}
        />
      )}
    </div>
  );
}

function CapturedPayloadBlock({
  event,
  fullContent,
  loading,
  loadError,
  onLoadFull,
}: {
  event: AgentEvent;
  fullContent: EventContent | null;
  loading: boolean;
  loadError: string | null;
  onLoadFull: () => void;
}) {
  const p = event.payload;
  if (!p) return null;

  // Per-event field map: which payload field maps to which
  // event_content slot when the field overflowed (B-6).
  //   mcp_tool_call:    arguments → input,    result   → response
  //   mcp_resource_read: content   → response  (no arguments)
  //   mcp_prompt_get:    arguments → input,    rendered → response
  return (
    <div className="space-y-2">
      {event.event_type === "mcp_tool_call" && (
        <>
          <CaptureField
            label="Arguments"
            inline={p.arguments}
            externalValue={fullContent?.input}
            testId={`mcp-event-detail-arguments-${event.id}`}
            loading={loading}
            loadError={loadError}
            onLoadFull={onLoadFull}
          />
          <CaptureField
            label="Result"
            inline={p.result}
            externalValue={fullContent?.response}
            testId={`mcp-event-detail-result-${event.id}`}
            loading={loading}
            loadError={loadError}
            onLoadFull={onLoadFull}
          />
        </>
      )}
      {event.event_type === "mcp_resource_read" && (
        <CaptureField
          label="Content"
          inline={p.content}
          // For resource_read, the body lives on event_content.response
          // when overflowed. The implicit-truncation flag (has_content
          // true with no inline content) propagates via the inline
          // value being null + the externalValue being available
          // after fetch.
          externalValue={fullContent?.response}
          forceTruncated={
            p.content == null && event.has_content === true
              ? { _truncated: true }
              : null
          }
          testId={`mcp-event-detail-content-${event.id}`}
          loading={loading}
          loadError={loadError}
          onLoadFull={onLoadFull}
        />
      )}
      {event.event_type === "mcp_prompt_get" && (
        <>
          <CaptureField
            label="Arguments"
            inline={p.arguments}
            externalValue={fullContent?.input}
            testId={`mcp-event-detail-arguments-${event.id}`}
            loading={loading}
            loadError={loadError}
            onLoadFull={onLoadFull}
          />
          <CaptureField
            label="Rendered"
            inline={p.rendered}
            externalValue={fullContent?.response}
            testId={`mcp-event-detail-rendered-${event.id}`}
            loading={loading}
            loadError={loadError}
            onLoadFull={onLoadFull}
          />
        </>
      )}
    </div>
  );
}

function CaptureField({
  label,
  inline,
  externalValue,
  forceTruncated,
  testId,
  loading,
  loadError,
  onLoadFull,
}: {
  label: string;
  // Polymorphic JSON value from the MCP wire payload — string,
  // number, dict, list, or null. Typed as `unknown` so consumers
  // narrow at the rendering branch (CodeBlock JSON-stringifies it
  // directly which works for any value type).
  inline: unknown;
  externalValue?: unknown;
  forceTruncated?: TruncationMarker | null;
  testId?: string;
  loading: boolean;
  loadError: string | null;
  onLoadFull: () => void;
}) {
  // When the field is null/empty AND no truncation is implied, render
  // nothing — keeps the per-event-type field set sparse (e.g.
  // mcp_tool_call with capture but no arguments emits result only).
  const truncationCandidate = forceTruncated ?? inline;
  const truncated = isTruncationMarker(truncationCandidate);
  if (!truncated && (inline == null || inline === "")) {
    return null;
  }
  if (truncated) {
    const marker = truncationCandidate as TruncationMarker;
    if (isCappedMarker(marker)) {
      return (
        <CappedNotice
          label={label}
          size={marker.size}
          testId={testId ? `${testId}-capped` : undefined}
        />
      );
    }
    if (externalValue != null) {
      return (
        <CodeBlock
          label={`${label} (loaded from event_content)`}
          value={externalValue}
          testId={testId}
        />
      );
    }
    return (
      <TruncatedFieldBlock
        label={label}
        size={marker.size}
        loading={loading}
        loadError={loadError}
        onLoadFull={onLoadFull}
        testId={testId ? `${testId}-truncated` : undefined}
      />
    );
  }
  return <CodeBlock label={label} value={inline} testId={testId} />;
}

function TruncatedFieldBlock({
  label,
  size,
  loading,
  loadError,
  onLoadFull,
  testId,
}: {
  label: string;
  size?: number;
  loading: boolean;
  loadError: string | null;
  onLoadFull: () => void;
  testId?: string;
}) {
  const sizeLabel = typeof size === "number" ? formatBytes(size) : "large";
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between"
      style={{
        background: "var(--bg-elevated)",
        border: "1px dashed var(--border)",
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <div className="text-xs">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <span className="ml-2" style={{ color: "var(--text-muted)" }}>
          ·
        </span>
        <span className="ml-2" style={{ color: "var(--text)" }}>
          {sizeLabel} captured to event_content
        </span>
        {loadError && (
          <div
            className="mt-1 text-[11px]"
            style={{ color: "var(--event-error)" }}
          >
            {loadError}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={loading}
        className="text-xs"
        style={{
          color: loading ? "var(--text-muted)" : "var(--accent)",
          cursor: loading ? "default" : "pointer",
        }}
        onClick={(e) => {
          e.stopPropagation();
          onLoadFull();
        }}
      >
        {loading ? "Loading..." : "Load full response"}
      </button>
    </div>
  );
}

function CappedNotice({
  label,
  size,
  testId,
}: {
  label: string;
  size?: number;
  testId?: string;
}) {
  const sizeLabel = typeof size === "number" ? formatBytes(size) : "very large";
  return (
    <div
      data-testid={testId}
      className="text-xs"
      style={{
        background: "color-mix(in srgb, var(--warning) 10%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
        borderRadius: 4,
        padding: "8px 10px",
        color: "var(--text)",
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="ml-2" style={{ color: "var(--text-muted)" }}>
        ·
      </span>
      <span className="ml-2">
        Content too large to capture ({sizeLabel}). Only metadata recorded.
      </span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function CaptureDisabledNotice({ eventId }: { eventId: string }) {
  return (
    <div
      data-testid={`mcp-event-detail-capture-disabled-${eventId}`}
      className="text-xs"
      style={{
        color: "var(--text-muted)",
        fontStyle: "italic",
        padding: "8px 10px",
        background: "var(--bg-elevated)",
        borderRadius: 4,
      }}
    >
      Prompt capture is not enabled for this deployment. Server, transport,
      and timing metadata are still recorded, but the request and response
      bodies are not.
    </div>
  );
}

function ListNotice({
  eventId,
  count,
}: {
  eventId: string;
  count: number | null;
}) {
  return (
    <div
      data-testid={`mcp-event-detail-list-notice-${eventId}`}
      className="text-xs"
      style={{
        color: "var(--text-muted)",
        padding: "8px 10px",
        background: "var(--bg-elevated)",
        borderRadius: 4,
      }}
    >
      {count == null
        ? "Discovery event — server returned a list. Individual items are not captured here; per-call MCP_TOOL_CALL / MCP_RESOURCE_READ / MCP_PROMPT_GET events carry the names that were used."
        : `Server reported ${count.toLocaleString()} item${count === 1 ? "" : "s"} available. Individual names appear on subsequent per-call events as the agent uses them.`}
    </div>
  );
}

function CodeBlock({
  label,
  value,
  testId,
}: {
  label: string;
  // Polymorphic JSON value rendered inside a <pre>{JSON.stringify(...)}.
  // `unknown` is the right type — JSON.stringify accepts any value.
  value: unknown;
  testId?: string;
}) {
  const [showFull, setShowFull] = useState(false);
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  const isTruncated = serialized.length > TRUNCATE_LIMIT;
  const display =
    showFull || !isTruncated
      ? serialized
      : `${serialized.slice(0, TRUNCATE_LIMIT)}…`;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span
          className="text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          {label}
        </span>
        {isTruncated && (
          <button
            type="button"
            data-testid={
              testId ? `${testId}-toggle` : undefined
            }
            className="text-[11px]"
            style={{ color: "var(--accent)" }}
            onClick={(e) => {
              e.stopPropagation();
              setShowFull((v) => !v);
            }}
          >
            {showFull ? "Show less" : "Show full"}
          </button>
        )}
      </div>
      <pre
        data-testid={testId}
        className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all"
        style={{
          color: "var(--text)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 4,
          padding: "8px 10px",
          margin: 0,
          maxHeight: showFull ? "none" : 360,
          overflowY: "auto",
        }}
      >
        {display}
      </pre>
    </div>
  );
}

function DetailRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <>
      <span
        className="text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <span
        data-testid={testId}
        className="text-xs"
        style={{ color: "var(--text)", wordBreak: "break-word" }}
      >
        {value}
      </span>
    </>
  );
}
