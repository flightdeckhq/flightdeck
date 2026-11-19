import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { PromptsTab } from "@/components/session/SessionDrawer";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { EMBEDDING_TOKEN_IDS_PREVIEW_COUNT as TOKEN_IDS_PREVIEW_COUNT } from "@/lib/constants";
import type { AgentEvent, EventContent, OutputDimensions, Session } from "@/lib/types";

// An embeddings event's Prompts tab shows the input its request sent,
// under the provider's name for it (Input for OpenAI and litellm,
// Contents for google-genai), drawn by the expanded event row's input
// view, the stored input byte for byte in its JSON view, and the event's
// output_dimensions as the response, never the empty stored response.
// The contents in fixtures/embeddings-content.json are what the content
// API served for real calls; the rest are built in the shapes the
// sensor stores (the API's own input shapes, and a google-genai request's
// contents on Vertex AI). The capture-off guard passes on main as well;
// every other case fails there (main showed only the stored response,
// {}).

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
  fetchSession: vi.fn((id: string) =>
    Promise.resolve({ session: { session_id: id, flavor: "f", capture_enabled: true }, events: [], attachments: [] }),
  ),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

interface Stored {
  output_dimensions: OutputDimensions | null;
  content: EventContent;
}

const live = JSON.parse(readFileSync(resolve(__dirname, "fixtures/embeddings-content.json"), "utf8")) as Record<
  string,
  Stored
>;

/** A token-id input longer than the viewer's preview. */
const LONG_TOKEN_IDS = Array.from({ length: TOKEN_IDS_PREVIEW_COUNT + 9 }, (_, i) => 5000 + i);

function built(provider: string, model: string, input: unknown): Stored {
  return {
    output_dimensions: { count: 1, dimension: 1536 },
    content: {
      event_id: `e-built-${provider}`,
      session_id: "s",
      provider,
      model,
      system_prompt: null,
      messages: [],
      tools: null,
      response: {},
      ...(input === undefined ? {} : { input }),
      captured_at: "2026-11-18T00:00:00Z",
    } as EventContent,
  };
}

/** Every provider's stored input shapes, and the state the input view
 *  shows each in. */
const CASES: Array<{ name: string; stored: Stored; title: "Input" | "Contents"; state: string }> = [
  { name: "openai: a string", stored: live.openai_string!, title: "Input", state: "string" },
  { name: "openai: a long string", stored: live.openai_long_string!, title: "Input", state: "string" },
  { name: "openai: a list of strings", stored: live.openai_list!, title: "Input", state: "list" },
  { name: "openai: thirty strings", stored: live.openai_many_inputs!, title: "Input", state: "list" },
  { name: "openai: token ids", stored: live.openai_token_ids!, title: "Input", state: "tokens" },
  { name: "openai (LangChain): token-id lists", stored: live.openai_langchain_token_lists!, title: "Input", state: "list" },
  { name: "openai: another value", stored: built("openai", "text-embedding-3-small", { text: "hello" }), title: "Input", state: "json" },
  { name: "litellm: a string", stored: live.litellm_string!, title: "Input", state: "string" },
  { name: "litellm: a list of strings", stored: built("litellm", "voyage/voyage-3", ["alpha", "beta"]), title: "Input", state: "list" },
  { name: "litellm: token ids", stored: built("litellm", "text-embedding-3-small", LONG_TOKEN_IDS), title: "Input", state: "tokens" },
  { name: "litellm: token-id lists", stored: built("litellm", "text-embedding-3-small", [[1, 2], [3]]), title: "Input", state: "list" },
  { name: "google, Gemini API: the requests' Content objects", stored: live.google_contents!, title: "Contents", state: "json" },
  { name: "google, Vertex AI predict: the instances' texts", stored: built("google", "gemini-embedding-001", ["hello", "world"]), title: "Contents", state: "list" },
  {
    name: "google, Vertex AI embedContent: the request's Content",
    stored: built("google", "gemini-embedding-001", { parts: [{ text: "hello" }], role: "user" }),
    title: "Contents",
    state: "json",
  },
  { name: "openai: no input stored", stored: built("openai", "text-embedding-3-small", undefined), title: "Input", state: "empty" },
];

async function renderTab(stored: Stored, withDimensions = true) {
  mockContent = stored.content;
  const view = render(
    <PromptViewer
      eventId={stored.content.event_id}
      eventType="embeddings"
      outputDimensions={withDimensions ? stored.output_dimensions : undefined}
    />,
  );
  await screen.findByTestId("prompt-viewer-embeddings");
  return view;
}

/** The expanded event row's viewer markup for the same stored content. */
async function rowViewerMarkup(stored: Stored): Promise<string> {
  mockContent = stored.content;
  const { container, unmount } = render(<EmbeddingsContentViewer eventId={stored.content.event_id} hasContent />);
  await waitFor(() => expect(container.querySelector('[data-state="loading"]')).toBeNull());
  const html = container.innerHTML;
  unmount();
  return html;
}

function inputBox(): HTMLElement {
  return screen.getByTestId("prompt-box-embeddings-input");
}

describe("PromptViewer: an embeddings event shows its input", () => {
  for (const c of CASES) {
    it(`${c.name}: under ${c.title}, drawn as the expanded row draws it, stored as is in JSON`, async () => {
      const row = await rowViewerMarkup(c.stored);
      await renderTab(c.stored);
      expect(screen.getByRole("button", { name: c.title })).toHaveAttribute("aria-expanded", "true");
      const viewer = within(inputBox()).getByTestId("embeddings-content-viewer");
      expect(viewer).toHaveAttribute("data-state", c.state);
      // One component: the input reads the same as in the expanded row.
      expect(viewer.outerHTML).toBe(row);

      fireEvent.click(screen.getByTestId("prompt-box-embeddings-input-json"));
      const json = screen.getByTestId("prompt-box-embeddings-input-json-view");
      expect(json.textContent).toBe(JSON.stringify(c.stored.content.input ?? null, null, 2));
      expect(within(inputBox()).queryByTestId("embeddings-content-viewer")).toBeNull();
    });
  }

  it("a Gemini embeddings call is not shown as a generate call", async () => {
    await renderTab(live.google_contents!);
    expect(screen.queryByTestId("prompt-viewer-gemini")).toBeNull();
    expect(screen.queryByTestId("prompt-box-content-0")).toBeNull();
    expect(screen.getByTestId("prompt-viewer-model")).toHaveTextContent("gemini-embedding-001");
  });

  it("the event's output_dimensions show under Output, never as a response: not the stored {} nor a vector", async () => {
    await renderTab(live.openai_many_inputs!);
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
    const output = screen.getByTestId("prompt-box-embeddings-output");
    // Event metadata, not stored response content: its section is
    // Output, its toggle names the event's field, and nothing in the tab
    // is called a response.
    expect(screen.getByRole("button", { name: "Output" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "Response" })).toBeNull();
    expect(within(output).getByRole("group", { name: "View for the event's output_dimensions" })).toBeInTheDocument();
    expect(screen.getByTestId("prompt-viewer-embeddings").textContent).not.toMatch(/response/i);
    expect(within(output).getByText("output_dimensions")).toBeInTheDocument();
    const fields = within(output).getByTestId("embeddings-output-dimensions");
    expect(within(fields).getAllByTestId("kv-label").map((l) => l.textContent)).toEqual(["count:", "dimension:"]);
    expect(fields).toHaveTextContent(/count:\s*30(?!\d)/);
    expect(fields).toHaveTextContent(/dimension:\s*64(?!\d)/);
    fireEvent.click(screen.getByTestId("prompt-box-embeddings-output-json"));
    expect(screen.getByTestId("prompt-box-embeddings-output-json-view").textContent).toBe(
      JSON.stringify({ count: 30, dimension: 64 }, null, 2),
    );
    // Nothing in the tab is the empty stored response.
    expect(screen.queryByText("{}")).toBeNull();
  });

  it("without output_dimensions the tab has no Output section, and says nothing about a response", async () => {
    await renderTab(live.openai_string!, false);
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Response" })).toBeNull();
    expect(screen.queryByTestId("prompt-box-embeddings-output")).toBeNull();
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
    expect(screen.getByTestId("prompt-box-embeddings-input")).toBeInTheDocument();
  });

  it("a long text is cut behind Show full input, and shown whole on it", async () => {
    const text = live.openai_long_string!.content.input as string;
    await renderTab(live.openai_long_string!);
    const shown = within(inputBox()).getByTestId("embeddings-content-state-string");
    expect(shown.textContent!.length).toBeLessThan(text.length);
    fireEvent.click(within(inputBox()).getByTestId("embeddings-content-toggle"));
    expect(within(inputBox()).getByTestId("embeddings-content-state-string")).toHaveTextContent(text);
  });

  it("thirty inputs stay closed behind their count until opened", async () => {
    await renderTab(live.openai_many_inputs!);
    expect(within(inputBox()).getByTestId("embeddings-content-state-list")).toHaveTextContent("30 inputs");
    expect(within(inputBox()).queryByTestId("embeddings-content-expanded")).toBeNull();
    fireEvent.click(within(inputBox()).getByTestId("embeddings-content-toggle"));
    const items = within(inputBox()).getByTestId("embeddings-content-expanded");
    expect(items.querySelectorAll("li")).toHaveLength(30);
    expect(within(items).getByTestId("embeddings-content-list-item-29")).toHaveTextContent(
      "Short note number 30 about the weather in a coastal town.",
    );
  });

  it("token ids are cut to the preview count", async () => {
    await renderTab(CASES.find((c) => c.name === "litellm: token ids")!.stored);
    expect(within(inputBox()).getByTestId("embeddings-content-token-count")).toHaveTextContent(
      `${LONG_TOKEN_IDS.length} tokens`,
    );
    expect(within(inputBox()).getByTestId("embeddings-content-state-tokens")).toHaveTextContent(
      `${LONG_TOKEN_IDS.slice(0, TOKEN_IDS_PREVIEW_COUNT).join(", ")}, …`,
    );
  });

  it("stored markup is text, never markup", async () => {
    await renderTab(built("openai", "text-embedding-3-small", "<b>bold</b><img src=x onerror=alert(1)>"));
    expect(inputBox().querySelector("b, img")).toBeNull();
    expect(within(inputBox()).getByTestId("embeddings-content-state-string")).toHaveTextContent(
      "<b>bold</b><img src=x onerror=alert(1)>",
    );
  });

  it("guard: capture off keeps its message", async () => {
    mockContent = null;
    render(<PromptViewer eventId="e-off" eventType="embeddings" outputDimensions={{ count: 1, dimension: 8 }} />);
    expect(await screen.findByText("Prompt capture is not enabled for this deployment.")).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-viewer-embeddings")).toBeNull();
  });
});

const SESSION = { session_id: "s-embed", capture_prompts: true, capture_enabled: true, client_type: "flightdeck_sensor" } as unknown as Session;

function event(id: string, eventType: string, fields: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    session_id: "s-embed",
    flavor: "f",
    event_type: eventType,
    model: "text-embedding-3-small",
    tokens_input: 5,
    tokens_output: null,
    tokens_total: null,
    latency_ms: 300,
    tool_name: null,
    has_content: true,
    occurred_at: "2026-11-18T00:00:00Z",
    ...fields,
  } as AgentEvent;
}

describe("the run drawer's View Prompts → on an embeddings row", () => {
  it("opens the input in a run that stored no other content", async () => {
    const stored = live.openai_token_ids!;
    mockContent = stored.content;
    render(
      <PromptsTab
        session={SESSION}
        events={[event(stored.content.event_id, "embeddings", { payload: { output_dimensions: stored.output_dimensions! } })]}
        selectedEventId={stored.content.event_id}
        focusedEventId={stored.content.event_id}
        onSelectEvent={() => {}}
      />,
    );
    await screen.findByTestId("prompt-viewer-embeddings");
    expect(within(inputBox()).getByTestId("embeddings-content-state-tokens")).toHaveTextContent("9906, 1917, 13");
    expect(screen.getByTestId("embeddings-output-dimensions")).toHaveTextContent(/dimension:\s*1536(?!\d)/);
    expect(screen.queryByTestId("prompts-no-content-for-run")).toBeNull();
    expect(screen.queryByTestId("prompts-capture-disabled")).toBeNull();
  });

  it("opens a Gemini embeddings call as one, beside the run's listed calls", async () => {
    const stored = live.google_contents!;
    mockContent = stored.content;
    render(
      <PromptsTab
        session={SESSION}
        events={[
          event("e-post", "post_call", { model: "gemini-3.1-flash-lite" }),
          event(stored.content.event_id, "embeddings", { payload: { output_dimensions: stored.output_dimensions! } }),
        ]}
        selectedEventId={stored.content.event_id}
        focusedEventId={stored.content.event_id}
        onSelectEvent={() => {}}
      />,
    );
    await screen.findByTestId("prompt-viewer-embeddings");
    expect(screen.queryByTestId("prompt-viewer-gemini")).toBeNull();
    expect(screen.getByRole("button", { name: "Contents" })).toBeInTheDocument();
    expect(screen.getByTestId("embeddings-output-dimensions")).toHaveTextContent(/count:\s*2(?!\d)/);
  });

});

describe("the run drawer's Prompts list lists embeddings calls", () => {
  /** A list row's badge, time and model, as the row shows them. */
  function rowParts(id: string): { badge: string; time: string; model: string } {
    const spans = screen.getByTestId(`prompts-row-${id}`).querySelectorAll(":scope > span");
    return { badge: spans[0]!.textContent!, time: spans[1]!.textContent!, model: spans[2]!.textContent! };
  }

  it("an embeddings call is a row beside the run's other calls: its badge, its time, its model", () => {
    const at = "2026-11-18T09:30:15Z";
    render(
      <PromptsTab
        session={SESSION}
        events={[
          event("e-post", "post_call", { model: "gpt-4o-mini" }),
          event("e-embed", "embeddings", { occurred_at: at }),
          event("e-tool", "tool_call", { model: null, tool_name: "search_docs" }),
        ]}
        selectedEventId={null}
        focusedEventId={null}
        onSelectEvent={() => {}}
      />,
    );
    // In the order the run's events come in, the embeddings call among them.
    expect(Array.from(document.querySelectorAll('[data-testid^="prompts-row-"]')).map((r) => r.getAttribute("data-testid"))).toEqual([
      "prompts-row-e-post",
      "prompts-row-e-embed",
      "prompts-row-e-tool",
    ]);
    expect(rowParts("e-embed")).toEqual({
      badge: "EMBED",
      time: new Date(at).toLocaleTimeString(),
      model: "text-embedding-3-small",
    });
    expect(rowParts("e-post").badge).toBe("LLM CALL");
    expect(screen.queryByTestId("prompts-no-content-for-run")).toBeNull();
  });

  it("an embeddings-only run lists its calls instead of saying no content was recorded", () => {
    render(
      <PromptsTab
        session={SESSION}
        events={[event("e-embed-2", "embeddings"), event("e-embed-1", "embeddings", { model: "gemini-embedding-001" })]}
        selectedEventId={null}
        focusedEventId={null}
        onSelectEvent={() => {}}
      />,
    );
    expect(screen.getByTestId("prompts-row-e-embed-2")).toBeInTheDocument();
    expect(rowParts("e-embed-1")).toMatchObject({ badge: "EMBED", model: "gemini-embedding-001" });
    expect(screen.queryByTestId("prompts-no-content-for-run")).toBeNull();
    expect(screen.queryByText(/No content was recorded/)).toBeNull();
  });

  it("a row opens its call: the list selects that event", () => {
    const onSelect = vi.fn();
    render(
      <PromptsTab
        session={SESSION}
        events={[event("e-post", "post_call", { model: "gpt-4o-mini" }), event("e-embed", "embeddings")]}
        selectedEventId={null}
        focusedEventId={null}
        onSelectEvent={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("prompts-row-e-embed"));
    expect(onSelect).toHaveBeenCalledWith("e-embed");
  });

  it("the selected row opens the embeddings view, and Back returns to the list with it", async () => {
    const stored = live.openai_list!;
    mockContent = stored.content;
    const id = stored.content.event_id;
    const events = [event(id, "embeddings", { payload: { output_dimensions: stored.output_dimensions! } })];
    let selected: string | null = id;
    const view = render(
      <PromptsTab session={SESSION} events={events} selectedEventId={selected} focusedEventId={id} onSelectEvent={(next) => (selected = next)} />,
    );
    await screen.findByTestId("prompt-viewer-embeddings");
    expect(within(inputBox()).getByTestId("embeddings-content-viewer")).toHaveAttribute("data-state", "list");
    fireEvent.click(screen.getByRole("button", { name: "← Back to event list" }));
    expect(selected).toBeNull();
    // A focused row scrolls itself into view; jsdom has no layout to scroll.
    Element.prototype.scrollIntoView ??= vi.fn();
    view.rerender(
      <PromptsTab session={SESSION} events={events} selectedEventId={selected} focusedEventId={id} onSelectEvent={(next) => (selected = next)} />,
    );
    expect(screen.getByTestId(`prompts-row-${id}`)).toHaveAttribute("data-focused", "true");
    expect(screen.queryByTestId("prompts-no-content-for-run")).toBeNull();
  });

  it("guard: an embeddings event that stored no content is not listed, and a run with nothing listed keeps its message", () => {
    render(
      <PromptsTab
        session={SESSION}
        events={[event("e-embed-none", "embeddings", { has_content: false })]}
        selectedEventId={null}
        focusedEventId={null}
        onSelectEvent={() => {}}
      />,
    );
    expect(screen.queryByTestId("prompts-row-e-embed-none")).toBeNull();
    expect(screen.getByTestId("prompts-no-content-for-run")).toHaveTextContent("No content was recorded for this run.");
    cleanup();
  });

  it("guard: capture off with no content keeps the disabled message", () => {
    const off = { ...SESSION, capture_prompts: false, capture_enabled: false } as Session;
    render(
      <PromptsTab
        session={off}
        events={[event("e-embed-off", "embeddings", { has_content: false })]}
        selectedEventId={null}
        focusedEventId={null}
        onSelectEvent={() => {}}
      />,
    );
    expect(screen.getByText("Prompt capture is not enabled for this deployment.")).toBeInTheDocument();
    expect(screen.queryByTestId("prompts-row-e-embed-off")).toBeNull();
    cleanup();
  });
});

describe("the event drawer's Prompts tab on an embeddings event", () => {
  it("shows the input and the event's output_dimensions", async () => {
    const stored = live.litellm_string!;
    mockContent = stored.content;
    render(
      <EventDetailDrawer
        event={event(stored.content.event_id, "embeddings", {
          session_id: stored.content.session_id,
          payload: { output_dimensions: stored.output_dimensions! },
        })}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("detail-tab-prompts"));
    await screen.findByTestId("prompt-viewer-embeddings");
    expect(within(inputBox()).getByTestId("embeddings-content-state-string")).toHaveTextContent(
      "playground litellm embeddings capture",
    );
    expect(screen.getByTestId("embeddings-output-dimensions")).toHaveTextContent(/count:\s*1(?!\d)/);
  });
});
