import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { SyntaxJson, TEXT_SAFE_SYNTAX_COLORS } from "@/components/ui/syntax-json";
import { NoEventContent, NoEventContentForEvent, NoRunContent } from "@/components/session/NoEventContent";
import { SignalPromptsPanel } from "@/components/session/SignalContentViewer";
import { PromptsTab } from "@/components/session/SessionDrawer";
import { TELEMETRY_OTLP } from "@/lib/agent-identity";
import type { AgentEvent, EventContent, OutputDimensions, Session } from "@/lib/types";
import {
  TEXT_SAFE_FLOOR,
  THEMES,
  contrastRatio,
  over,
  paintRatio,
  readThemeTokens,
  resolveColor,
  textPaints,
  type TextPaint,
  type Theme,
} from "./support/theme-contrast";

// Every text in the Prompts tab reads at 4.6:1 or better (WCAG AA's
// 4.5:1 with headroom; TEXT_SAFE_FLOOR) in both themes. The tab is
// rendered for every provider path (stored bodies from the fixtures, and
// built shapes for the rest), in its Rendered view and in every box's
// JSON view, and for everything else either drawer's Prompts tab shows:
// the no-content and capture-off states, a session_signal's panel, and
// the run drawer's list of the run's calls. Each text node's colour and
// the backgrounds behind it are read from the markup and resolved
// through themes.css as it is, so a token or a component change that
// puts a text under the floor fails here. The embeddings viewer's
// states are checked the same way, and an embeddings event's Prompts
// tab (real stored bodies) with its input opened as well.

const TOKENS = readThemeTokens();

let mockContent: EventContent | null = null;
let mockSession: Session | null = null;
let pending = false;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => (pending ? new Promise(() => {}) : Promise.resolve(mockContent))),
  fetchSession: vi.fn(() => Promise.resolve({ session: mockSession, events: [] })),
}));

beforeEach(() => {
  mockContent = null;
  mockSession = null;
  pending = false;
  vi.clearAllMocks();
});

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(__dirname, "fixtures", file), "utf8")) as Record<string, unknown>;
}

/** The stored contents in a fixture value: a content itself, or the
 *  contents nested in an object or a list of them. */
function contentsOf(value: unknown): EventContent[] {
  if (Array.isArray(value)) return value.flatMap(contentsOf);
  if (value === null || typeof value !== "object") return [];
  if ("provider" in value && "event_id" in value) return [value as EventContent];
  return Object.values(value).flatMap(contentsOf);
}

interface Case {
  name: string;
  content: EventContent | null;
  eventType?: string;
  clientType?: string;
  /** An embeddings event's output_dimensions, which its view shows. */
  outputDimensions?: OutputDimensions | null;
}

const base = { session_id: "s", system_prompt: null, messages: [], tools: null, response: null, captured_at: "2026-11-18T00:00:00Z" };
const bashResult = JSON.stringify({ stdout: "3 files\nok", stderr: "warning: deprecated flag", interrupted: false, note: null });

/** Shapes the stored fixtures do not hold: every Anthropic block type
 *  the tab draws, an OpenAI chat's edge calls and replies, litellm, a
 *  legacy completion, every Responses output item kind with the
 *  response's status and error lines (and reasoning passed back in the
 *  input), a stream's empty snapshot, and a chat refusal beside text and
 *  a call. */
const BUILT: Case[] = [
  {
    name: "anthropic: every block type, a cache mark, a structured tool result",
    content: {
      ...base,
      event_id: "c-anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      system_prompt: [
        { type: "text", text: "You run shell commands.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "citations_note", note: "an unknown block" },
      ],
      messages: [
        { role: "user", content: '{"task":"list","depth":2,"dry":true,"limit":null}' },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should run ls." },
            { type: "redacted_thinking" },
            { type: "text", text: "Listing." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", timeout: 30, flags: { all: true } } },
            { type: "tool_use", id: "t2", name: "Noop", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: bashResult },
            { type: "tool_result", tool_use_id: "t2", content: "plain text result" },
            { type: "image", source: { type: "base64" } },
          ],
        },
        null,
        { role: "user", content: null },
      ],
      tools: [{ name: "Bash", description: "Run a shell command", input_schema: { properties: { command: { type: "string" } } } }],
      response: { type: "message", content: [{ type: "text", text: "Three files." }], usage: { input_tokens: 50, output_tokens: 10 } },
    },
  },
  {
    name: "openai chat: custom, legacy and unknown calls, matched and unmatched replies",
    content: {
      ...base,
      event_id: "c-openai",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            { id: "call_2", type: "function", function: { name: "now", arguments: "{}" } },
            { id: "call_3", type: "custom", custom: { name: "run_sql" } },
            { id: "call_4", type: "mystery", mystery: { x: 1 } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
        { role: "tool", tool_call_id: "call_9IQorB7WiLKDYNXtObQMBB75", content: "unmatched" },
        { role: "function", name: "lookup", content: "found" },
        { role: "assistant", content: null, function_call: { name: "legacy", arguments: "not json" } },
      ],
      tools: [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { properties: { city: { type: "string" } } } } }],
      response: {
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "f", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      },
    },
  },
  {
    name: "litellm",
    content: {
      ...base,
      event_id: "c-litellm",
      provider: "litellm",
      model: "gemini/gemini-3.1-flash-lite",
      messages: [{ role: "user", content: "Hi" }],
      response: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "Hello." } }] },
    },
  },
  {
    name: "a legacy completion",
    content: {
      ...base,
      event_id: "c-completion",
      provider: "litellm",
      model: "gpt-3.5-turbo-instruct",
      input: ["first prompt", "second prompt"],
      response: { object: "text_completion", choices: [{ text: " Paris." }], usage: { prompt_tokens: 6, completion_tokens: 2 } },
    },
  },
  {
    name: "responses: every output item kind, a refusal part, a failed response, reasoning passed back",
    content: {
      ...base,
      event_id: "c-responses-output",
      provider: "openai",
      model: "gpt-5-mini",
      system_prompt: "Answer briefly.",
      input: [
        { role: "user", content: "Plot 17 * 23." },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Multiply, then plot." }], encrypted_content: "gAAAAB-in" },
        { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAAB-in-2" },
      ],
      response: {
        object: "response",
        status: "failed",
        error: { code: "server_error", message: "The model failed to respond." },
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "reasoning", id: "rs_3", summary: [], encrypted_content: "gAAAAB-out" },
          { type: "reasoning", id: "rs_4", summary: [{ type: "summary_text", text: "The product is 391." }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "391.", annotations: [] }, { type: "refusal", refusal: "I can't plot that." }] },
          { type: "function_call", call_id: "call_1", name: "plot", arguments: '{"values":[391]}' },
          { type: "function_call", call_id: "call_2", name: "noop", arguments: "" },
          { type: "web_search_call", id: "ws_1", status: "failed", action: { type: "search", query: "391", sources: [{ type: "url", url: "https://example.com" }] } },
          { type: "file_search_call", id: "fs_1", status: "completed", queries: ["policy"], results: [{ filename: "p.pdf", score: 0.9, text: "Refunds." }] },
          {
            type: "code_interpreter_call",
            id: "ci_1",
            status: "completed",
            container_id: "cntr_1",
            code: "print(17 * 23)\nplot()",
            outputs: [{ type: "logs", logs: "391" }, { type: "image", url: "data:image/png;base64,iVBORw0KGgo" }, { type: "image", url: "https://files.example.com/p.png" }],
          },
          { type: "computer_call", id: "cu_1", call_id: "call_cu", status: "completed", action: { type: "click", button: "left", x: 1, y: 2 }, pending_safety_checks: [] },
          { type: "local_shell_call", id: "ls_1", call_id: "call_ls", status: "completed", action: { type: "exec", command: ["ls"] } },
          { type: "image_generation_call", id: "ig_1", status: "completed", output_format: "png", revised_prompt: "A plot", result: "iVBORw0KGgo".padEnd(400, "A") },
          {
            type: "image_generation_call",
            id: "ig_2",
            status: "completed",
            output_format: "png",
            result: `${"iVBORw0KGgo".padEnd(40, "A")}… [flightdeck: kept 40 of 3000000 bytes to fit the event size limit]`,
          },
          { type: "image_generation_call", id: "ig_3", status: "in_progress" },
          { type: "mcp_call", id: "mc_1", server_label: "docs", name: "search", arguments: '{"q":"refunds"}', output: "Found 2 pages", error: "partial" },
          { type: "mcp_list_tools", id: "ml_1", server_label: "docs", tools: [{ name: "search", input_schema: {} }] },
          { type: "mcp_approval_request", id: "ma_1", server_label: "docs", name: "delete_page", arguments: '{"page":"x"}' },
          { type: "custom_tool_call", id: "ct_1", call_id: "call_ct", name: "run_sql", input: "SELECT 1" },
          { type: "shell_call", id: "sh_1", action: { commands: ["pwd"] } },
          "a bare value",
        ],
        usage: { input_tokens: 40, output_tokens: 90 },
      },
    },
  },
  {
    name: "responses: a stream left before its first item",
    content: {
      ...base,
      event_id: "c-responses-empty",
      provider: "litellm",
      model: "gpt-4o-mini",
      input: "Hi",
      response: { object: "response", status: "in_progress", output: [], usage: null },
    },
  },
  {
    name: "openai chat: a refusal with text and a call, in a request and a response",
    content: {
      ...base,
      event_id: "c-chat-refusal",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Explain how to get into a locked house." },
        { role: "assistant", content: "Let me explain.", refusal: "I'm sorry, but I can't assist with that." },
      ],
      response: {
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              refusal: "I'm sorry, but I can't assist with that.",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 52, completion_tokens: 14 },
      },
    },
  },
  { name: "capture off", content: null },
];

const gemini = fixture("gemini-content.json");

/** Real embeddings events' stored bodies, each with its event's
 *  output_dimensions, opened under the event's type. */
const EMBEDDINGS_CASES: Case[] = Object.entries(fixture("embeddings-content.json"))
  .filter(([key]) => !key.startsWith("_"))
  .map(([key, value]) => {
    const stored = value as { content: EventContent; output_dimensions: OutputDimensions | null };
    return { name: `embeddings ${key}`, content: stored.content, eventType: "embeddings", outputDimensions: stored.output_dimensions };
  });

const CASES: Case[] = [
  ...EMBEDDINGS_CASES,
  ...BUILT,
  ...Object.entries(gemini)
    .filter(([key]) => !key.startsWith("_"))
    .flatMap(([key, value]) =>
      contentsOf(value).map((content) => ({
        name: `gemini ${key}`,
        content,
        eventType: key === "embeddings" ? "embeddings" : "post_call",
      })),
    ),
  ...(
    ["otel-genai-content.json", "responses-content.json", "responses-output-content.json", "openai-tool-calls-content.json"] as const
  ).flatMap((file) =>
    contentsOf(fixture(file)).map((content) => ({ name: `${file} ${content.event_id}`, content })),
  ),
  ...contentsOf(fixture("tool-content.json")).map((content) => ({
    name: `tool-content ${content.event_id}`,
    content,
    clientType: content.provider === "anthropic" ? "claude_code" : undefined,
  })),
];

interface Failure {
  theme: Theme;
  where: string;
  text: string;
  color: string;
  backgrounds: string;
  ratio: number;
}

function failuresOf(where: string, paints: TextPaint[], baseBg = "var(--surface)"): Failure[] {
  const out: Failure[] = [];
  for (const theme of THEMES) {
    for (const paint of paints) {
      const ratio = paintRatio(TOKENS[theme], paint, baseBg);
      if (ratio < TEXT_SAFE_FLOOR) {
        out.push({
          theme,
          where,
          text: paint.text,
          color: paint.color,
          backgrounds: paint.backgrounds.join(" | ") || baseBg,
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
  }
  return out;
}

/** The tab's text in its Rendered view, then in every box's JSON view. */
async function promptsPaints(c: Case, i: number): Promise<TextPaint[]> {
  mockContent = c.content;
  const { container } = render(
    <PromptViewer
      eventId={`e-contrast-${i}`}
      eventType={c.eventType ?? "post_call"}
      clientType={c.clientType}
      outputDimensions={c.outputDimensions}
    />,
  );
  await waitFor(() => expect(container.querySelector(".animate-spin")).toBeNull());
  await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0));
  const paints = textPaints(container);
  const jsonButtons = Array.from(container.querySelectorAll('button[data-testid$="-json"]'));
  for (const button of jsonButtons) fireEvent.click(button);
  paints.push(...textPaints(container));
  cleanup();
  return paints;
}

describe("the Prompts tab's text reads at 4.6:1 or better in both themes", () => {
  it("every text node of every provider path, in the Rendered and the JSON views", async () => {
    const failures: Failure[] = [];
    let checked = 0;
    for (const [i, c] of CASES.entries()) {
      const paints = await promptsPaints(c, i);
      checked += paints.length;
      failures.push(...failuresOf(c.name, paints));
    }
    // A pass that read little would prove nothing.
    expect(checked).toBeGreaterThan(1500);
    expect(failures, JSON.stringify(failures.slice(0, 20), null, 1)).toEqual([]);
  });

  it("an embeddings event's view with its input opened: lists, whole texts, whole token ids", async () => {
    const failures: Failure[] = [];
    let checked = 0;
    for (const [i, c] of EMBEDDINGS_CASES.entries()) {
      mockContent = c.content;
      const { container } = render(
        <PromptViewer eventId={`e-contrast-embed-${i}`} eventType="embeddings" outputDimensions={c.outputDimensions} />,
      );
      await waitFor(() => expect(container.querySelector('[data-testid="prompt-viewer-embeddings"]')).not.toBeNull());
      // Each click can add a button ("Show full inputs" once a list opens).
      for (let k = 0; k < 3; k++) {
        const next = container.querySelectorAll('[data-testid="embeddings-content-viewer"] button')[k];
        if (!next) break;
        fireEvent.click(next);
      }
      const paints = textPaints(container);
      checked += paints.length;
      failures.push(...failuresOf(`${c.name}, opened`, paints));
      cleanup();
    }
    expect(checked).toBeGreaterThan(100);
    expect(failures, JSON.stringify(failures.slice(0, 20), null, 1)).toEqual([]);
  });

  it("the embeddings viewer's states, notes and toggle", async () => {
    const inputs: Array<[string, unknown]> = [
      ["string", "x".repeat(400)],
      ["tokens", Array.from({ length: 40 }, (_, k) => k + 100)],
      ["list", ["alpha", "beta", "gamma"]],
      ["token lists", [[1, 2, 3], [4, 5]]],
      ["json", { text: "hello", n: 2, ok: true, none: null }],
    ];
    const failures: Failure[] = [];
    let checked = 0;
    const check = (where: string, root: Element) => {
      const paints = textPaints(root);
      checked += paints.length;
      failures.push(...failuresOf(where, paints));
    };
    for (const [i, [kind, input]] of inputs.entries()) {
      mockContent = { ...base, event_id: `e-embed-${i}`, provider: "openai", model: "text-embedding-3-small", response: {}, input } as EventContent;
      const { container } = render(<EmbeddingsContentViewer eventId={`e-embed-${i}`} hasContent />);
      await waitFor(() => expect(container.querySelector('[data-state="loading"]')).toBeNull());
      check(`embeddings ${kind}`, container);
      for (const button of Array.from(container.querySelectorAll("button"))) fireEvent.click(button);
      check(`embeddings ${kind}, open`, container);
      cleanup();
    }
    const empty = render(<EmbeddingsContentViewer eventId="e-embed-empty" hasContent={false} />);
    check("embeddings, nothing captured", empty.container);
    cleanup();
    pending = true;
    const loading = render(<EmbeddingsContentViewer eventId="e-embed-loading" hasContent />);
    check("embeddings, loading", loading.container);
    cleanup();
    expect(checked).toBeGreaterThan(20);
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
  });
});

describe("the rest of the Prompts tab reads at 4.6:1 or better in both themes", () => {
  const session = (fields: Record<string, unknown> = {}): Session =>
    ({
      session_id: "s-other",
      capture_prompts: true,
      capture_enabled: true,
      client_type: "flightdeck_sensor",
      framework: null,
      context: {},
      ...fields,
    }) as unknown as Session;
  const captureOff = session({ capture_prompts: false, capture_enabled: false });
  const genaiRun = session({ client_type: "otlp", framework: "pydantic_ai", context: { telemetry: TELEMETRY_OTLP } });
  const event = (fields: Record<string, unknown> = {}): AgentEvent =>
    ({
      id: "ev-other",
      session_id: "s-other",
      event_type: "post_call",
      occurred_at: "2026-11-18T08:00:00Z",
      has_content: false,
      model: "gpt-4o-mini",
      tool_name: null,
      payload: null,
      ...fields,
    }) as unknown as AgentEvent;

  /** The text under ``root`` that the case is about, checked: the case
   *  must show ``shows`` (so it cannot pass on an empty render). */
  function failuresIn(where: string, root: Element, shows: RegExp, skip?: (p: TextPaint) => boolean): Failure[] {
    expect(root.textContent, where).toMatch(shows);
    const paints = textPaints(root).filter((p) => !skip?.(p));
    expect(paints.length, where).toBeGreaterThan(0);
    return failuresOf(where, paints);
  }

  it("an event or a run with no content: capture off, capture on, and a framework's reason", async () => {
    const failures: Failure[] = [];
    const cases: Array<[string, React.ReactElement, RegExp]> = [
      ["event, capture off", <NoEventContent event={event()} session={captureOff} />, /Prompt capture is not enabled for this deployment\./],
      ["event, capture on", <NoEventContent event={event()} session={session()} />, /No content was recorded for this event\./],
      ["event, a framework's reason", <NoEventContent event={event()} session={genaiRun} />, /The framework sent no messages/],
      ["run, capture off", <NoRunContent session={captureOff} />, /Prompt capture is not enabled for this deployment\./],
      ["run, capture on", <NoRunContent session={session()} />, /No content was recorded for this run\./],
      ["run, a framework's reason", <NoRunContent session={genaiRun} />, /the framework sent no content/],
    ];
    for (const [where, element, shows] of cases) {
      const { container } = render(element);
      failures.push(...failuresIn(where, container, shows));
      cleanup();
    }
    // The event drawer's form, which reads the run itself.
    mockSession = captureOff;
    const { container } = render(<NoEventContentForEvent event={event()} />);
    await waitFor(() => expect(container.textContent).toMatch(/Prompt capture is not enabled/));
    failures.push(...failuresIn("event drawer, capture off", container, /Prompt capture is not enabled for this deployment\./));
    cleanup();
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
  });

  it("a session_signal's panel: its texts, nothing captured, capture off, loading", async () => {
    const failures: Failure[] = [];
    const signal = (fields: Record<string, unknown>) =>
      event({ event_type: "session_signal", model: null, payload: { signal: "context_compacted" }, ...fields });
    // No content: capture off for a signal whose text is always sent, a
    // plain line for one that may carry none.
    const off = render(<SignalPromptsPanel event={signal({})} />);
    failures.push(...failuresIn("signal, capture off", off.container, /Prompt capture is not enabled for this deployment\./));
    cleanup();
    const none = render(<SignalPromptsPanel event={signal({ payload: { signal: "model_switch" } })} />);
    failures.push(...failuresIn("signal, no text", none.container, /This event carries no captured text\./));
    cleanup();
    // Content: its texts under their headings, and the empty state.
    mockContent = { ...base, event_id: "ev-signal", provider: "claude_code", model: "", response: { compact_summary: "Summary of the work so far.", custom_instructions: "Keep the plan." } } as EventContent;
    const texts = render(<SignalPromptsPanel event={signal({ id: "ev-signal", has_content: true })} />);
    await waitFor(() => expect(texts.container.textContent).toMatch(/Compaction summary/));
    failures.push(...failuresIn("signal, its texts", texts.container, /Summary of the work so far\./));
    cleanup();
    mockContent = { ...base, event_id: "ev-signal-empty", provider: "claude_code", model: "", response: {} } as EventContent;
    const empty = render(<SignalPromptsPanel event={signal({ id: "ev-signal-empty", has_content: true })} />);
    await waitFor(() => expect(empty.container.textContent).toMatch(/no text captured/));
    failures.push(...failuresIn("signal, empty", empty.container, /\(no text captured\)/));
    cleanup();
    pending = true;
    const loading = render(<SignalPromptsPanel event={signal({ id: "ev-signal-loading", has_content: true })} />);
    failures.push(...failuresIn("signal, loading", loading.container, /Loading…/));
    cleanup();
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
  });

  const listEvents = [
    event({ id: "ev-l1", event_type: "post_call", has_content: true, model: "gpt-4o-mini" }),
    event({ id: "ev-l2", event_type: "tool_call", has_content: true, model: null, tool_name: "get_weather" }),
    event({ id: "ev-l3", event_type: "mcp_tool_call", has_content: true, model: null, tool_name: "read_file" }),
    event({ id: "ev-l4", event_type: "mcp_prompt_get", has_content: true, model: null, tool_name: "greet" }),
  ];
  /** A list row's event-type badge: its type's hue as text on the hue's
   *  tint, the look every event-type badge in the app shares. */
  const BADGE_TEXT = new Set(["var(--event-llm)", "var(--event-tool)", "var(--event-mcp-tool)", "var(--event-mcp-prompt)"]);
  const isBadge = (p: TextPaint) => BADGE_TEXT.has(p.color);

  it("the run drawer's list of the run's calls: timestamps and names, focused or not, and an empty run", () => {
    // A focused row scrolls itself into view; jsdom has no layout to scroll.
    Element.prototype.scrollIntoView ??= vi.fn();
    const failures: Failure[] = [];
    for (const focused of [null, "ev-l2"]) {
      const { container } = render(
        <PromptsTab session={session()} events={listEvents} selectedEventId={null} focusedEventId={focused} onSelectEvent={() => {}} />,
      );
      failures.push(...failuresIn(`list, focused ${focused}`, container, /get_weather/, isBadge));
      cleanup();
    }
    const emptyRun = render(
      <PromptsTab session={genaiRun} events={[]} selectedEventId={null} focusedEventId={null} onSelectEvent={() => {}} />,
    );
    failures.push(...failuresIn("list, an empty run", emptyRun.container, /No content was recorded for this run\./));
    cleanup();
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
  });

  // A known gap: the list rows' event-type badges draw their type's hue as
  // text on the hue's own tint, as every event-type badge in the app does,
  // and that is under the floor (the LLM CALL badge in both themes, the
  // TOOL and MCP badges in the light one). Whether and how they change is
  // the maintainer's call. This case holds the gap as it is: it fails if a
  // badge stops rendering, and it fails once every badge reads at the
  // floor, when it becomes a check that they all pass.
  it("the list rows' event-type badges render, and some read under the floor (a known gap)", () => {
    const { container } = render(
      <PromptsTab session={session()} events={listEvents} selectedEventId={null} focusedEventId={null} onSelectEvent={() => {}} />,
    );
    const labels = ["LLM CALL", "TOOL", "MCP TOOL CALL", "MCP PROMPT FETCHED"];
    const badges = textPaints(container).filter((p) => labels.includes(p.text));
    expect(badges.map((b) => b.text)).toEqual(labels);
    expect(
      failuresOf("list badges", badges),
      "every event-type badge in the list reads at the floor now: make this case check that they all pass",
    ).not.toEqual([]);
  });
});

describe("the text-safe tokens on the surfaces they are used on", () => {
  const TEXT = ["--text", "--text-secondary", "--muted-text", "--accent-text", "--event-llm-text", "--event-tool-text", "--danger-text", "--success-text", "--warning-text"];
  const SURFACES = ["--surface", "--bg-elevated", "--bg"];
  /** A role badge: its text token on a 15% tint of its hue over --surface. */
  const BADGES: Array<[string, string]> = [
    ["--text-muted", "--muted-text"],
    ["--accent", "--accent-text"],
    ["--event-llm", "--event-llm-text"],
    ["--event-tool", "--event-tool-text"],
  ];
  const BADGE_TINT = 0.15;

  for (const theme of THEMES) {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        it(`${theme}: ${text} on ${surface}`, () => {
          const t = TOKENS[theme];
          expect(contrastRatio(resolveColor(t, `var(${text})`), resolveColor(t, `var(${surface})`))).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
        });
      }
    }
    for (const [hue, text] of BADGES) {
      it(`${theme}: ${text} on a ${hue} badge's tint, exact and as the 8-bit colour a browser composites`, () => {
        const t = TOKENS[theme];
        const tintColor = { ...resolveColor(t, `var(${hue})`), a: BADGE_TINT };
        const exact = over(tintColor, resolveColor(t, "var(--surface)"));
        const eightBit = { r: Math.round(exact.r), g: Math.round(exact.g), b: Math.round(exact.b), a: 1 };
        for (const bg of [exact, eightBit]) {
          expect(contrastRatio(resolveColor(t, `var(${text})`), bg)).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
        }
      });
    }
    // A hovered row of the run drawer's Prompts list (hover:bg-surface-hover)
    // under its timestamp; jsdom applies no :hover, so the render walk above
    // never sees this background.
    it(`${theme}: --muted-text on a hovered Prompts-list row (--surface-hover)`, () => {
      const t = TOKENS[theme];
      expect(contrastRatio(resolveColor(t, "var(--muted-text)"), resolveColor(t, "var(--surface-hover)"))).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
    });
  }

  it("both themes define the same text-safe tokens", () => {
    const names = (theme: Theme) => [...TOKENS[theme].keys()].filter((k) => k !== "--text" && k.endsWith("-text")).sort();
    expect(names("dark")).toEqual(names("light"));
    expect(names("dark")).toEqual(
      ["--accent-text", "--danger-text", "--event-llm-text", "--event-tool-text", "--muted-text", "--success-text", "--warning-text"],
    );
  });
});

describe("the Prompts tab's JSON highlighting", () => {
  /** Smallest distance in sRGB between two of the five colours that
   *  still reads as a different colour at a glance. */
  const MIN_DISTANCE = 60;

  it("keys, strings, numbers, literals and punctuation are apart from each other in both themes", () => {
    const parts: Record<string, string> = {
      key: TEXT_SAFE_SYNTAX_COLORS.key,
      string: TEXT_SAFE_SYNTAX_COLORS.string,
      number: TEXT_SAFE_SYNTAX_COLORS.number,
      literal: TEXT_SAFE_SYNTAX_COLORS.literal,
      punctuation: "var(--text-secondary)",
    };
    for (const theme of THEMES) {
      const resolved = Object.entries(parts).map(([name, v]) => [name, resolveColor(TOKENS[theme], v)] as const);
      for (const [name, c] of resolved) {
        expect(contrastRatio(c, resolveColor(TOKENS[theme], "var(--bg-elevated)")), `${theme} ${name}`).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
      }
      for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          const [a, ca] = resolved[i]!;
          const [b, cb] = resolved[j]!;
          const distance = Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b);
          expect(distance, `${theme}: ${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_DISTANCE);
        }
      }
    }
  });

  it("every other JSON view keeps its own colours", () => {
    const { container } = render(<SyntaxJson data={{ k: "v", n: 1, b: true }} />);
    const html = container.innerHTML;
    expect(html).toContain('<span style="color:var(--event-llm)">"k"</span>');
    expect(html).toContain('<span style="color:var(--status-active)">"v"</span>');
    expect(html).toContain('<span style="color:var(--event-warn)">1</span>');
    expect(html).toContain('<span style="color:var(--text-muted)">true</span>');
  });
});
