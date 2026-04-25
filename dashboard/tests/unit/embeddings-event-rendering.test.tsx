import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { getEventDetail, getSummaryRows, getBadge } from "@/lib/events";
import type { AgentEvent, EventContent } from "@/lib/types";
import * as api from "@/lib/api";

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

// -------------------------------------------------------------------
// Phase 4 polish S-EMBED-5: EmbeddingsContentViewer.
// Three render branches × the captured-vs-not-captured switch. Tests
// pin the contract that drives the dashboard side of S-EMBED-7
// E2E coverage too.
// -------------------------------------------------------------------

function makeContent(input: EventContent["input"]): EventContent {
  return {
    event_id: "embed-1",
    session_id: "sess-1",
    provider: "openai",
    model: "text-embedding-3-small",
    system_prompt: null,
    messages: [],
    tools: null,
    response: {},
    input,
    captured_at: new Date().toISOString(),
  };
}

describe("EmbeddingsContentViewer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty placeholder when has_content is false (no API call)", () => {
    const fetchSpy = vi
      .spyOn(api, "fetchEventContent")
      .mockResolvedValue(null);
    const { getByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-1" hasContent={false} />,
    );
    expect(getByTestId("embeddings-content-state-empty")).toBeDefined();
    // Critical: no fetch fired when caller already knows nothing was
    // captured. Avoids a 404 round-trip on every embeddings row in
    // a session with capture disabled.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders truncated text + expand-to-show-more for a single-string input", async () => {
    const longText = "x".repeat(500);
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(makeContent(longText));
    const { getByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-2" hasContent={true} />,
    );
    await waitFor(() =>
      expect(getByTestId("embeddings-content-state-string")).toBeDefined(),
    );
    const span = getByTestId("embeddings-content-state-string");
    // Truncated: ends with the ellipsis, not the full 500 chars.
    expect(span.textContent?.endsWith("…")).toBe(true);
    expect((span.textContent ?? "").length).toBeLessThan(500);
    // Toggle reveals the full text.
    fireEvent.click(getByTestId("embeddings-content-toggle"));
    await waitFor(() => {
      const spanAfter = getByTestId("embeddings-content-state-string");
      expect(spanAfter.textContent).toBe(longText);
    });
  });

  it("does not show the expand button for short single-string inputs", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      makeContent("short input"),
    );
    const { getByTestId, queryByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-3" hasContent={true} />,
    );
    await waitFor(() =>
      expect(getByTestId("embeddings-content-state-string")).toBeDefined(),
    );
    expect(queryByTestId("embeddings-content-toggle")).toBeNull();
  });

  it("renders ``<N> inputs`` count for a list input + expand reveals each item", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      makeContent(["alpha", "beta", "gamma"]),
    );
    const { getByTestId, queryByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-4" hasContent={true} />,
    );
    await waitFor(() =>
      expect(getByTestId("embeddings-content-state-list")).toBeDefined(),
    );
    expect(getByTestId("embeddings-content-state-list").textContent).toBe(
      "3 inputs",
    );
    // Items hidden until expand clicked.
    expect(queryByTestId("embeddings-content-expanded")).toBeNull();
    fireEvent.click(getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(getByTestId("embeddings-content-expanded")).toBeDefined(),
    );
    expect(getByTestId("embeddings-content-list-item-0").textContent).toBe(
      "alpha",
    );
    expect(getByTestId("embeddings-content-list-item-2").textContent).toBe(
      "gamma",
    );
  });

  it("singular ``1 input`` for a single-element list", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      makeContent(["only one"]),
    );
    const { getByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-5" hasContent={true} />,
    );
    await waitFor(() =>
      expect(getByTestId("embeddings-content-state-list").textContent).toBe(
        "1 input",
      ),
    );
  });

  it("falls back to empty placeholder when has_content is true but input is missing (defensive)", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(makeContent(null));
    const { getByTestId } = render(
      <EmbeddingsContentViewer eventId="evt-6" hasContent={true} />,
    );
    await waitFor(() =>
      expect(getByTestId("embeddings-content-state-empty")).toBeDefined(),
    );
  });
});
