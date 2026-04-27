import { useState } from "react";
import type { AgentEvent } from "@/lib/types";
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

export function MCPEventDetails({ event }: MCPEventDetailsProps) {
  const [expanded, setExpanded] = useState(false);
  const p = event.payload;
  if (!p) return null;
  if (!isMCPEvent(event.event_type)) return null;

  // Failure path: surface the structured MCP taxonomy regardless of
  // capture state. Errors carry no sensitive content.
  const error = p.error;
  const isStructuredError = !!error && typeof error !== "string";

  // Capture-gated content for the three operations that have
  // request/response payloads to render. List events have no
  // capture-gated payload — they get a "no detail" notice when
  // expanded so the row stays self-explanatory.
  const hasCapturedPayload =
    (event.event_type === "mcp_tool_call" &&
      (p.arguments != null || p.result != null)) ||
    (event.event_type === "mcp_resource_read" && p.content != null) ||
    (event.event_type === "mcp_prompt_get" &&
      (p.arguments != null || (p.rendered && p.rendered.length > 0)));

  const isListEvent =
    event.event_type === "mcp_tool_list" ||
    event.event_type === "mcp_resource_list" ||
    event.event_type === "mcp_prompt_list";

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
            <ErrorBlock event={event} error={error as MCPErrorShape} />
          )}
          {!isStructuredError && hasCapturedPayload && (
            <CapturedPayloadBlock event={event} />
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
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

function CapturedPayloadBlock({ event }: { event: AgentEvent }) {
  const p = event.payload;
  if (!p) return null;
  return (
    <div className="space-y-2">
      {/* Tool call: arguments → result */}
      {event.event_type === "mcp_tool_call" && (
        <>
          {p.arguments != null && (
            <CodeBlock
              label="Arguments"
              value={p.arguments}
              testId={`mcp-event-detail-arguments-${event.id}`}
            />
          )}
          {p.result != null && (
            <CodeBlock
              label="Result"
              value={p.result}
              testId={`mcp-event-detail-result-${event.id}`}
            />
          )}
        </>
      )}
      {/* Resource read: full content body. The summary row already
          rendered ``content_bytes`` and ``mime_type`` so this block
          is just the body. */}
      {event.event_type === "mcp_resource_read" && p.content != null && (
        <CodeBlock
          label="Content"
          value={p.content}
          testId={`mcp-event-detail-content-${event.id}`}
        />
      )}
      {/* Prompt get: arguments → rendered messages */}
      {event.event_type === "mcp_prompt_get" && (
        <>
          {p.arguments != null && (
            <CodeBlock
              label="Arguments"
              value={p.arguments}
              testId={`mcp-event-detail-arguments-${event.id}`}
            />
          )}
          {p.rendered && p.rendered.length > 0 && (
            <CodeBlock
              label="Rendered"
              value={p.rendered}
              testId={`mcp-event-detail-rendered-${event.id}`}
            />
          )}
        </>
      )}
    </div>
  );
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
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
