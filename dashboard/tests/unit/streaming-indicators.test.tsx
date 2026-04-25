import { describe, it, expect } from "vitest";
import { getEventDetail, getSummaryRows } from "@/lib/events";
import type { AgentEvent, StreamingMetrics } from "@/lib/types";

// Phase 4 polish S-UI-2: streaming indicators on post_call rows.
// Pins the detail-text TTFT prefix, the summary-grid additions, and
// the aborted variant so a regression in any one surface fails here.

function makeStreamingPostCall(
  streaming: StreamingMetrics | null,
): AgentEvent {
  return {
    id: "post-1",
    session_id: "s",
    flavor: "f",
    event_type: "post_call",
    model: "claude-haiku-4-5",
    tokens_input: 240,
    tokens_output: 80,
    tokens_total: 320,
    latency_ms: 4500,
    tool_name: null,
    has_content: false,
    payload: streaming ? { streaming } : {},
    occurred_at: new Date().toISOString(),
  };
}

const HAPPY: StreamingMetrics = {
  ttft_ms: 320,
  chunk_count: 42,
  inter_chunk_ms: { p50: 25, p95: 80, max: 150 },
  final_outcome: "completed",
  abort_reason: null,
};

const ABORTED: StreamingMetrics = {
  ttft_ms: 380,
  chunk_count: 7,
  inter_chunk_ms: { p50: 30, p95: 90, max: 220 },
  final_outcome: "aborted",
  abort_reason: "client_aborted",
};

describe("getEventDetail -- streaming TTFT prefix", () => {
  it("inserts ``TTFT <n>ms`` ahead of tokens + total latency on streaming post_call", () => {
    const detail = getEventDetail(makeStreamingPostCall(HAPPY));
    expect(detail).toContain("TTFT 320ms");
    // Order matters: model, then TTFT, then tokens, then latency.
    // Index check rather than regex so a future change to the
    // separator (currently " · ") doesn't make the test brittle.
    const parts = detail.split(" · ");
    expect(parts[0]).toBe("claude-haiku-4-5");
    expect(parts[1]).toBe("TTFT 320ms");
  });

  it("non-streaming post_call keeps the original three-part shape", () => {
    const detail = getEventDetail(makeStreamingPostCall(null));
    const parts = detail.split(" · ");
    expect(parts).toEqual(["claude-haiku-4-5", "320 tok", "4500ms"]);
  });

  it("aborted streams still surface TTFT (the abort flag is rendered separately as a badge)", () => {
    const detail = getEventDetail(makeStreamingPostCall(ABORTED));
    expect(detail).toContain("TTFT 380ms");
  });
});

describe("getSummaryRows -- streaming sub-object surfaces in expanded grid", () => {
  it("appends TTFT, Chunks, Inter-chunk, and Stream outcome rows for streaming calls", () => {
    const rows = getSummaryRows(makeStreamingPostCall(HAPPY));
    const keys = rows.map(([k]) => k);
    expect(keys).toContain("TTFT");
    expect(keys).toContain("Chunks");
    expect(keys).toContain("Inter-chunk");
    expect(keys).toContain("Stream outcome");
  });

  it("inter-chunk row formats as ``p50 X · p95 Y · max Z``", () => {
    const rows = getSummaryRows(makeStreamingPostCall(HAPPY));
    const ic = rows.find(([k]) => k === "Inter-chunk")?.[1] ?? "";
    expect(ic).toContain("p50 25ms");
    expect(ic).toContain("p95 80ms");
    expect(ic).toContain("max 150ms");
  });

  it("aborted row reads ``aborted · <reason>`` so the why is visible without expanding", () => {
    const rows = getSummaryRows(makeStreamingPostCall(ABORTED));
    const outcome = rows.find(([k]) => k === "Stream outcome")?.[1] ?? "";
    expect(outcome).toBe("aborted · client_aborted");
  });

  it("aborted with no abort_reason falls back to plain ``aborted``", () => {
    const rows = getSummaryRows(
      makeStreamingPostCall({ ...ABORTED, abort_reason: null }),
    );
    const outcome = rows.find(([k]) => k === "Stream outcome")?.[1] ?? "";
    expect(outcome).toBe("aborted");
  });

  it("non-streaming post_call keeps the original five-row layout (no streaming rows)", () => {
    const rows = getSummaryRows(makeStreamingPostCall(null));
    const keys = rows.map(([k]) => k);
    expect(keys).toEqual([
      "Model",
      "Tokens input",
      "Tokens output",
      "Total tokens",
      "Latency",
    ]);
  });
});
