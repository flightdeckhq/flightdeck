import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";
import { ErrorEventDetails } from "@/components/session/ErrorEventDetails";
import { getEventDetail, getSummaryRows, getBadge } from "@/lib/events";
import type { AgentEvent, LLMErrorPayload } from "@/lib/types";

// Phase 4 polish S-UI-3 part 1: llm_error rendering. Pins the timeline
// circle, the drawer row detail string, the summary grid, and the
// expandable accordion in one suite.

function makeErrorEvent(error?: Partial<LLMErrorPayload>): AgentEvent {
  const base: LLMErrorPayload = {
    error_type: "rate_limit",
    provider: "anthropic",
    http_status: 429,
    provider_error_code: "rate_limit_exceeded",
    error_message: "RateLimitError: slow down",
    request_id: "req_abc123",
    retry_after: 30,
    is_retryable: true,
  };
  return {
    id: "err-1",
    session_id: "sess-1",
    flavor: "test",
    event_type: "llm_error",
    model: "claude-haiku-4-5",
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: 120,
    tool_name: null,
    has_content: false,
    payload: { error: { ...base, ...error } },
    occurred_at: new Date().toISOString(),
  };
}

describe("llm_error -- timeline circle (EventNode)", () => {
  it("uses --event-error background", () => {
    const { container } = render(
      <EventNode
        x={0}
        eventType="llm_error"
        sessionId="s"
        flavor="f"
        occurredAt={new Date().toISOString()}
        onClick={vi.fn()}
      />,
    );
    const circle = container.querySelector("[style*='background']") as HTMLElement;
    expect(circle.style.backgroundColor).toBe("var(--event-error)");
  });

  it("renders the AlertCircle glyph (lucide aliases AlertCircle → CircleAlert internally)", () => {
    const { container } = render(
      <EventNode
        x={0}
        eventType="llm_error"
        sessionId="s"
        flavor="f"
        occurredAt={new Date().toISOString()}
        onClick={vi.fn()}
      />,
    );
    // lucide-react v0.379 renders ``AlertCircle`` with class
    // ``lucide-circle-alert`` (the underlying canonical name).
    // ``lucide-x-circle`` is policy_block's icon — pin we don't
    // accidentally collide.
    expect(container.querySelector("svg.lucide-circle-alert")).not.toBeNull();
    expect(container.querySelector("svg.lucide-x-circle")).toBeNull();
  });
});

describe("llm_error -- detail string (getEventDetail)", () => {
  it("formats as ``error_type · provider_error_code`` when both present", () => {
    const detail = getEventDetail(makeErrorEvent());
    expect(detail).toBe("rate_limit · rate_limit_exceeded");
  });

  it("falls back to ``error_type · provider`` when provider_error_code missing", () => {
    const detail = getEventDetail(
      makeErrorEvent({ provider_error_code: null }),
    );
    expect(detail).toBe("rate_limit · anthropic");
  });

  it("returns ``llm error`` when payload.error is missing entirely", () => {
    const detail = getEventDetail({
      ...makeErrorEvent(),
      payload: {},
    });
    expect(detail).toBe("llm error");
  });
});

describe("llm_error -- summary grid (getSummaryRows)", () => {
  it("emits Model + Error type + Provider + HTTP + Provider code + Message rows", () => {
    const rows = getSummaryRows(makeErrorEvent());
    const keys = rows.map(([k]) => k);
    expect(keys).toEqual([
      "Model",
      "Error type",
      "Provider",
      "HTTP status",
      "Provider code",
      "Message",
    ]);
  });

  it("omits HTTP status row when http_status is null (timeout class)", () => {
    const rows = getSummaryRows(
      makeErrorEvent({ error_type: "timeout", http_status: null }),
    );
    const keys = rows.map(([k]) => k);
    expect(keys).not.toContain("HTTP status");
  });
});

describe("llm_error -- badge config (getBadge)", () => {
  it("returns the ERROR badge with --event-error cssVar", () => {
    const badge = getBadge("llm_error");
    expect(badge.label).toBe("ERROR");
    expect(badge.cssVar).toContain("--event-error");
  });
});

describe("ErrorEventDetails accordion", () => {
  const error: LLMErrorPayload = {
    error_type: "authentication",
    provider: "openai",
    http_status: 401,
    provider_error_code: null,
    error_message: "AuthenticationError",
    request_id: "req_xyz",
    retry_after: null,
    is_retryable: false,
  };

  it("collapsed by default; toggle expands the grid", () => {
    const { getByTestId, queryByTestId } = render(
      <ErrorEventDetails error={error} eventId="evt-1" />,
    );
    expect(getByTestId("error-event-details-evt-1")).toBeDefined();
    // Collapsed state -- detail rows aren't in the DOM yet.
    expect(queryByTestId("error-event-detail-request-id-evt-1")).toBeNull();
    fireEvent.click(getByTestId("error-event-details-toggle-evt-1"));
    expect(getByTestId("error-event-detail-request-id-evt-1").textContent).toBe(
      "req_xyz",
    );
  });

  it("renders ``Not retryable`` pill when is_retryable=false", () => {
    const { getByTestId } = render(
      <ErrorEventDetails error={error} eventId="evt-1" />,
    );
    fireEvent.click(getByTestId("error-event-details-toggle-evt-1"));
    expect(
      getByTestId("error-event-detail-is-retryable-evt-1").textContent,
    ).toContain("Not retryable");
  });

  it("renders ``Retryable`` pill when is_retryable=true", () => {
    const { getByTestId } = render(
      <ErrorEventDetails
        error={{ ...error, is_retryable: true }}
        eventId="evt-2"
      />,
    );
    fireEvent.click(getByTestId("error-event-details-toggle-evt-2"));
    expect(
      getByTestId("error-event-detail-is-retryable-evt-2").textContent,
    ).toContain("Retryable");
  });

  it("renders retry_after as ``<n>s`` when present", () => {
    const { getByTestId } = render(
      <ErrorEventDetails
        error={{ ...error, retry_after: 30 }}
        eventId="evt-3"
      />,
    );
    fireEvent.click(getByTestId("error-event-details-toggle-evt-3"));
    expect(
      getByTestId("error-event-detail-retry-after-evt-3").textContent,
    ).toBe("30s");
  });

  it("surfaces partial_chunks + abort_reason on stream-error variants", () => {
    const { getByTestId } = render(
      <ErrorEventDetails
        error={{
          ...error,
          error_type: "stream_error",
          abort_reason: "connection_reset",
          partial_chunks: 5,
          partial_tokens_input: 100,
          partial_tokens_output: 18,
        }}
        eventId="evt-stream"
      />,
    );
    fireEvent.click(getByTestId("error-event-details-toggle-evt-stream"));
    expect(
      getByTestId("error-event-detail-abort-reason-evt-stream").textContent,
    ).toBe("connection_reset");
    expect(
      getByTestId("error-event-detail-partial-chunks-evt-stream").textContent,
    ).toBe("5");
  });
});
