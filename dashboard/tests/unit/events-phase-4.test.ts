import { describe, it, expect } from "vitest";

import {
  EVENT_FILTER_PILLS,
  EVENT_TYPE_GROUPS,
  eventBadgeConfig,
  isEventVisible,
} from "@/lib/events";
import type { AgentEvent, LLMErrorPayload, StreamingMetrics } from "@/lib/types";

// Phase 4 contract tests. These pin the wire-shape extensions
// (embeddings + llm_error event types, structured error sub-object,
// streaming sub-object) at the typecheck level so a future
// refactor cannot silently drop a field the dashboard relies on.

describe("events.ts Phase 4 badge config", () => {
  it("registers embeddings and llm_error in eventBadgeConfig", () => {
    expect(eventBadgeConfig.embeddings).toBeDefined();
    expect(eventBadgeConfig.embeddings.label).toBe("EMBED");
    expect(eventBadgeConfig.embeddings.cssVar).toContain(
      "--event-embeddings",
    );

    expect(eventBadgeConfig.llm_error).toBeDefined();
    expect(eventBadgeConfig.llm_error.label).toBe("ERROR");
    expect(eventBadgeConfig.llm_error.cssVar).toContain("--event-error");
  });

  it("EVENT_TYPE_GROUPS includes Embeddings and Errors groups", () => {
    expect(EVENT_TYPE_GROUPS.Embeddings).toEqual(["embeddings"]);
    expect(EVENT_TYPE_GROUPS.Errors).toEqual(["llm_error"]);
  });

  it("EVENT_FILTER_PILLS includes Embeddings and Errors pills", () => {
    const labels = EVENT_FILTER_PILLS.map((p) => p.label);
    expect(labels).toContain("Embeddings");
    expect(labels).toContain("Errors");
  });

  it("isEventVisible narrows Embeddings filter to embeddings events only", () => {
    expect(isEventVisible("embeddings", "Embeddings")).toBe(true);
    expect(isEventVisible("post_call", "Embeddings")).toBe(false);
    expect(isEventVisible("llm_error", "Embeddings")).toBe(false);
  });

  it("isEventVisible narrows Errors filter to llm_error events only", () => {
    expect(isEventVisible("llm_error", "Errors")).toBe(true);
    expect(isEventVisible("post_call", "Errors")).toBe(false);
    expect(isEventVisible("embeddings", "Errors")).toBe(false);
  });
});

describe("AgentEvent Phase 4 payload extensions", () => {
  it("accepts a structured LLMErrorPayload in payload.error", () => {
    // Compile-time check via type annotation; runtime check that the
    // narrowing pattern downstream components use works.
    const errorPayload: LLMErrorPayload = {
      error_type: "rate_limit",
      provider: "anthropic",
      http_status: 429,
      provider_error_code: "rate_limit_exceeded",
      error_message: "RateLimitError: slow down",
      request_id: "req_abc123",
      retry_after: 30,
      is_retryable: true,
    };
    const event: AgentEvent = {
      id: "e1",
      session_id: "s1",
      flavor: "test",
      event_type: "llm_error",
      model: "claude-sonnet-4-6",
      tokens_input: null,
      tokens_output: null,
      tokens_total: null,
      latency_ms: 120,
      tool_name: null,
      has_content: false,
      payload: { error: errorPayload },
      occurred_at: new Date().toISOString(),
    };
    // The dashboard narrows via ``typeof`` before accessing taxonomy
    // fields. Assert the branch so a type change surfaces here.
    const err = event.payload?.error;
    expect(typeof err === "string" ? err : err?.error_type).toBe("rate_limit");
  });

  it("accepts a StreamingMetrics sub-object in payload.streaming", () => {
    const streaming: StreamingMetrics = {
      ttft_ms: 320,
      chunk_count: 42,
      inter_chunk_ms: { p50: 25, p95: 80, max: 150 },
      final_outcome: "completed",
      abort_reason: null,
    };
    const event: AgentEvent = {
      id: "e2",
      session_id: "s1",
      flavor: "test",
      event_type: "post_call",
      model: "claude-sonnet-4-6",
      tokens_input: 100,
      tokens_output: 200,
      tokens_total: 300,
      latency_ms: 1500,
      tool_name: null,
      has_content: false,
      payload: { streaming },
      occurred_at: new Date().toISOString(),
    };
    expect(event.payload?.streaming?.ttft_ms).toBe(320);
    expect(event.payload?.streaming?.final_outcome).toBe("completed");
  });

  it("tolerates an llm_error event with no partial_* fields", () => {
    const err: LLMErrorPayload = {
      error_type: "authentication",
      provider: "openai",
      http_status: 401,
      provider_error_code: null,
      error_message: "AuthenticationError",
      request_id: null,
      retry_after: null,
      is_retryable: false,
    };
    expect(err.partial_chunks).toBeUndefined();
    expect(err.abort_reason).toBeUndefined();
  });
});
