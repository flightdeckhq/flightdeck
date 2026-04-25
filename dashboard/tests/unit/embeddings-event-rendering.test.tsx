import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";
import { getEventDetail, getSummaryRows, getBadge } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

// Phase 4 polish S-UI-1: rich embeddings rendering. Pins three layers
// in one place so a future refactor can't silently regress one of
// them (timeline circle colour + glyph, drawer detail string, drawer
// summary-grid rows).

function makeEmbeddingsEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: "embed-1",
    session_id: "sess-1",
    flavor: "test",
    event_type: "embeddings",
    model: "text-embedding-3-small",
    tokens_input: 1024,
    tokens_output: null,
    tokens_total: null,
    latency_ms: 120,
    tool_name: null,
    has_content: false,
    payload: {},
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("embeddings -- timeline circle (EventNode)", () => {
  it("uses --event-embeddings background", () => {
    const { container } = render(
      <EventNode
        x={50}
        eventType="embeddings"
        sessionId="s"
        flavor="f"
        occurredAt={new Date().toISOString()}
        onClick={vi.fn()}
      />,
    );
    const circle = container.querySelector("[style*='background']") as HTMLElement;
    expect(circle).not.toBeNull();
    expect(circle.style.backgroundColor).toBe("var(--event-embeddings)");
  });

  it("renders the Database glyph (not the default Circle)", () => {
    const { container } = render(
      <EventNode
        x={0}
        eventType="embeddings"
        sessionId="s"
        flavor="f"
        occurredAt={new Date().toISOString()}
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector("svg.lucide-database")).not.toBeNull();
  });
});

describe("embeddings -- drawer row detail string (getEventDetail)", () => {
  it("formats as ``model · N tok in · Mms`` and explicitly carries ``tok in`` (not just ``tok``)", () => {
    const detail = getEventDetail(makeEmbeddingsEvent());
    expect(detail).toContain("text-embedding-3-small");
    expect(detail).toContain("1,024 tok in");
    expect(detail).toContain("120ms");
    // Order matters: model · tok in · latency. Pin the segment
    // sequence so a future refactor can't quietly reorder.
    expect(detail.split(" · ")).toEqual([
      "text-embedding-3-small",
      "1,024 tok in",
      "120ms",
    ]);
  });

  it("falls back gracefully when tokens_input is null", () => {
    const detail = getEventDetail(
      makeEmbeddingsEvent({ tokens_input: null }),
    );
    expect(detail).toContain("text-embedding-3-small");
    expect(detail).not.toContain("tok in");
  });
});

describe("embeddings -- drawer summary-grid rows (getSummaryRows)", () => {
  it("emits Model + Tokens input + Latency rows; no Tokens output / Total", () => {
    const rows = getSummaryRows(makeEmbeddingsEvent());
    const keys = rows.map(([k]) => k);
    expect(keys).toEqual(["Model", "Tokens input", "Latency"]);
    // Negative assertion -- the post_call layout would have these and
    // we explicitly want the embeddings layout to NOT mimic it.
    expect(keys).not.toContain("Tokens output");
    expect(keys).not.toContain("Total tokens");
  });
});

describe("embeddings -- badge config (getBadge)", () => {
  it("returns the EMBED badge with --event-embeddings cssVar", () => {
    const badge = getBadge("embeddings");
    expect(badge.label).toBe("EMBED");
    expect(badge.cssVar).toContain("--event-embeddings");
  });
});
