import { useState } from "react";
import type { LLMErrorPayload } from "@/lib/types";
import { AccordionHeader } from "./AccordionHeader";

/**
 * Collapsible details block rendered inside the expanded view of an
 * ``llm_error`` event. Surfaces the operational fields that don't
 * belong in the always-visible summary grid -- ``request_id`` (used
 * to file provider support tickets), ``retry_after`` (provider's
 * suggested back-off), and ``is_retryable`` as a boolean pill.
 *
 * Pulled out into its own file because the accordion has its own
 * expand/collapse state and SessionDrawer.tsx is already large; one
 * less thing to scroll past when reading the drawer's main flow.
 *
 * Props are deliberately the structured ``LLMErrorPayload`` rather
 * than the parent ``AgentEvent`` -- the caller is expected to have
 * already narrowed ``payload.error`` against the directive_result
 * string overload before passing it in.
 */
export function ErrorEventDetails({
  error,
  eventId,
}: {
  error: LLMErrorPayload;
  eventId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-testid={`error-event-details-${eventId}`}
      className="mt-2"
      style={{
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 8,
      }}
    >
      <AccordionHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label="Error details"
        testId={`error-event-details-toggle-${eventId}`}
      />
      {expanded && (
        <div
          className="mt-2 grid gap-x-3 gap-y-1"
          style={{ gridTemplateColumns: "120px 1fr" }}
        >
          <DetailRow
            label="Request ID"
            value={error.request_id ?? "—"}
            mono
            testId={`error-event-detail-request-id-${eventId}`}
          />
          <DetailRow
            label="Retry after"
            value={
              error.retry_after != null ? `${error.retry_after}s` : "—"
            }
            testId={`error-event-detail-retry-after-${eventId}`}
          />
          <span
            className="text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Retryable
          </span>
          <span data-testid={`error-event-detail-is-retryable-${eventId}`}>
            <RetryablePill value={error.is_retryable} />
          </span>
          {error.abort_reason && (
            <DetailRow
              label="Abort reason"
              value={error.abort_reason}
              testId={`error-event-detail-abort-reason-${eventId}`}
            />
          )}
          {error.partial_chunks != null && (
            <DetailRow
              label="Partial chunks"
              value={error.partial_chunks.toLocaleString()}
              testId={`error-event-detail-partial-chunks-${eventId}`}
            />
          )}
          {error.partial_tokens_input != null && (
            <DetailRow
              label="Partial tok in"
              value={error.partial_tokens_input.toLocaleString()}
            />
          )}
          {error.partial_tokens_output != null && (
            <DetailRow
              label="Partial tok out"
              value={error.partial_tokens_output.toLocaleString()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  testId,
}: {
  label: string;
  value: string;
  mono?: boolean;
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
        className={`text-xs ${mono ? "font-mono" : ""}`}
        style={{ color: "var(--text)", wordBreak: "break-all" }}
      >
        {value}
      </span>
    </>
  );
}

/**
 * Boolean pill rendering ``is_retryable``. Green ``RETRYABLE`` for
 * true, neutral grey ``NOT RETRYABLE`` for false. Reuses the same
 * status-active token used elsewhere for "good" affirmations so
 * the colour vocabulary stays consistent.
 */
function RetryablePill({ value }: { value: boolean }) {
  const colorVar = value ? "var(--status-active)" : "var(--text-muted)";
  return (
    <span
      className="inline-flex items-center rounded font-mono text-[10px] font-semibold uppercase"
      style={{
        padding: "1px 6px",
        background: `color-mix(in srgb, ${colorVar} 15%, transparent)`,
        color: colorVar,
        border: `1px solid color-mix(in srgb, ${colorVar} 30%, transparent)`,
        borderRadius: 3,
        letterSpacing: "0.04em",
      }}
    >
      {value ? "Retryable" : "Not retryable"}
    </span>
  );
}
