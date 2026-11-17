import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { EMBEDDING_TOKEN_IDS_PREVIEW_COUNT as TOKEN_IDS_PREVIEW } from "@/lib/constants";
import { getEventDetail, getSummaryRows, getBadge } from "@/lib/events";
import type { AgentEvent, EventContent } from "@/lib/types";
import * as api from "@/lib/api";

// Rich embeddings rendering. Pins three layers
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
// EmbeddingsContentViewer.
// Three render branches × the captured-vs-not-captured switch. Tests
// pin the contract the embeddings E2E coverage drives too.
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

  it("renders the empty placeholder when the content request comes back empty", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(null);
    render(<EmbeddingsContentViewer eventId="evt-null" hasContent={true} />);
    expect(screen.getByTestId("embeddings-content-state-loading")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-state-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("embeddings-content-state-loading")).toBeNull();
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
    // Text inputs are not labelled as token ids.
    expect(queryByTestId("embeddings-content-list-kind")).toBeNull();
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

// -------------------------------------------------------------------
// Token-id inputs and inputs of no known shape. The embeddings API
// also takes one input as a list of token ids, and several inputs as a
// list of token-id lists; the stored value is shown as what it is.
// -------------------------------------------------------------------

/** Render the viewer for a stored ``input`` and wait until it settled. */
async function renderInput(input: unknown) {
  vi.spyOn(api, "fetchEventContent").mockResolvedValue(
    makeContent(input as EventContent["input"]),
  );
  const view = render(<EmbeddingsContentViewer eventId="evt-tok" hasContent={true} />);
  await waitFor(() =>
    expect(screen.getByTestId("embeddings-content-viewer").getAttribute("data-state")).not.toBe(
      "loading",
    ),
  );
  return view;
}

describe("EmbeddingsContentViewer -- token ids and other inputs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a list of token ids as one input, labelled as token ids with their count", async () => {
    await renderInput([101, 202, 303]);
    const viewer = screen.getByTestId("embeddings-content-viewer");
    expect(viewer.getAttribute("data-state")).toBe("tokens");
    expect(viewer.textContent).toContain("Embedding input");
    expect(viewer.textContent).toContain("Token ids");
    expect(screen.getByTestId("embeddings-content-token-count").textContent).toBe("3 tokens");
    expect(screen.getByTestId("embeddings-content-state-tokens").textContent).toBe(
      "101, 202, 303",
    );
    // Not three inputs of one number each.
    expect(screen.queryByTestId("embeddings-content-state-list")).toBeNull();
    expect(screen.queryByTestId("embeddings-content-toggle")).toBeNull();
  });

  it("counts a single token id as ``1 token``", async () => {
    await renderInput([7]);
    expect(screen.getByTestId("embeddings-content-token-count").textContent).toBe("1 token");
    expect(screen.getByTestId("embeddings-content-state-tokens").textContent).toBe("7");
  });

  it("truncates a long token-id input with the same expander as a long text", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    await renderInput(ids);
    expect(screen.getByTestId("embeddings-content-token-count").textContent).toBe("1000 tokens");
    // The first ids, then ", …": the last shown id reads whole.
    expect(screen.getByTestId("embeddings-content-state-tokens").textContent).toBe(
      `${ids.slice(0, TOKEN_IDS_PREVIEW).join(", ")}, …`,
    );
    const toggle = screen.getByTestId("embeddings-content-toggle");
    expect(toggle.textContent).toBe("Show full input");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-state-tokens").textContent).toBe(
        ids.join(", "),
      ),
    );
    expect(screen.getByTestId("embeddings-content-toggle").textContent).toBe("Show less");
    expect(screen.getByTestId("embeddings-content-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("shows a list of token-id lists as one input per list, each with its own count", async () => {
    await renderInput([[1, 2, 3], [4, 5, 6, 7]]);
    expect(screen.getByTestId("embeddings-content-viewer").getAttribute("data-state")).toBe("list");
    expect(screen.getByTestId("embeddings-content-state-list").textContent).toBe("2 inputs");
    expect(screen.getByTestId("embeddings-content-list-kind").textContent).toBe("Token ids");
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-expanded")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("embeddings-content-list-item-0-count").textContent).toBe(
      "Token ids (3 tokens)",
    );
    expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe("1, 2, 3");
    expect(screen.getByTestId("embeddings-content-list-item-1-count").textContent).toBe(
      "Token ids (4 tokens)",
    );
    expect(screen.getByTestId("embeddings-content-list-item-1-ids").textContent).toBe(
      "4, 5, 6, 7",
    );
    // Every item fits its preview: nothing to show in full.
    expect(screen.queryByTestId("embeddings-content-full-toggle")).toBeNull();
  });

  it("cuts each long item of a token-id list, and shows them whole on ``Show full inputs``", async () => {
    const long = Array.from({ length: 40 }, (_, i) => 1000 + i);
    await renderInput([long, [1, 2, 3]]);
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-expanded")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("embeddings-content-list-item-0-count").textContent).toBe(
      "Token ids (40 tokens)",
    );
    expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe(
      `${long.slice(0, TOKEN_IDS_PREVIEW).join(", ")}, …`,
    );
    expect(screen.getByTestId("embeddings-content-list-item-1-ids").textContent).toBe("1, 2, 3");
    const full = screen.getByTestId("embeddings-content-full-toggle");
    expect(full.textContent).toBe("Show full inputs");
    expect(full.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(full);
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe(
        long.join(", "),
      ),
    );
    expect(screen.getByTestId("embeddings-content-full-toggle").textContent).toBe("Show less");
    expect(
      screen.getByTestId("embeddings-content-full-toggle").getAttribute("aria-expanded"),
    ).toBe("true");
    // Show less cuts the item again.
    fireEvent.click(screen.getByTestId("embeddings-content-full-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe(
        `${long.slice(0, TOKEN_IDS_PREVIEW).join(", ")}, …`,
      ),
    );
  });

  it("builds no items while a token-id list is closed, re-renders included", async () => {
    // Each item counts the reads that building its row makes (the
    // preview's ``slice``, the ids' ``join``); classifying the input
    // reads neither.
    let rowBuilds = 0;
    const counted = (ids: number[]) =>
      new Proxy(ids, {
        get(target, prop, receiver) {
          if (prop === "join" || prop === "slice") rowBuilds += 1;
          return Reflect.get(target, prop, receiver);
        },
      });
    const long = Array.from({ length: 40 }, (_, i) => 1000 + i);
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      makeContent([counted(long), counted([1, 2, 3])] as unknown as EventContent["input"]),
    );
    const view = render(<EmbeddingsContentViewer eventId="evt-closed" hasContent={true} />);
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-state-list").textContent).toBe("2 inputs"),
    );
    view.rerender(<EmbeddingsContentViewer eventId="evt-closed" hasContent={true} />);
    view.rerender(<EmbeddingsContentViewer eventId="evt-closed" hasContent={true} />);
    expect(screen.queryByTestId("embeddings-content-expanded")).toBeNull();
    expect(rowBuilds).toBe(0);
    // Opening builds them.
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-1-ids").textContent).toBe("1, 2, 3"),
    );
    expect(rowBuilds).toBeGreaterThan(0);
  });

  it("reopens a token-id list on the cut items after ``Show full inputs`` and a close", async () => {
    const long = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const cut = `${long.slice(0, TOKEN_IDS_PREVIEW).join(", ")}, …`;
    await renderInput([long, [1, 2, 3]]);
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    fireEvent.click(await screen.findByTestId("embeddings-content-full-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe(
        long.join(", "),
      ),
    );
    // Close the list, then open it again.
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() => expect(screen.queryByTestId("embeddings-content-expanded")).toBeNull());
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe(cut),
    );
    expect(screen.getByTestId("embeddings-content-full-toggle").textContent).toBe(
      "Show full inputs",
    );
    expect(
      screen.getByTestId("embeddings-content-full-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("singular ``1 input`` for a list holding one token-id list", async () => {
    await renderInput([[9, 8]]);
    expect(screen.getByTestId("embeddings-content-state-list").textContent).toBe("1 input");
    fireEvent.click(screen.getByTestId("embeddings-content-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("embeddings-content-list-item-0-ids").textContent).toBe("9, 8"),
    );
  });

  it.each([
    ["an empty list", [], "[]"],
    ["a list mixing text and token ids", ["alpha", 101], '"alpha"'],
    ["a list mixing token ids and token-id lists", [1, [2, 3]], "1"],
    ["an object", { text: "alpha", extra: true }, '"extra"'],
    ["numbers that are not token ids", [0.25, 0.5], "0.25"],
  ])("shows %s as its JSON", async (_name, input, expected) => {
    await renderInput(input);
    expect(screen.getByTestId("embeddings-content-viewer").getAttribute("data-state")).toBe("json");
    const json = screen.getByTestId("embeddings-content-state-json");
    expect(json.textContent).toContain(expected);
    expect(JSON.parse(json.textContent ?? "")).toEqual(input);
    expect(screen.queryByTestId("embeddings-content-state-list")).toBeNull();
  });
});
