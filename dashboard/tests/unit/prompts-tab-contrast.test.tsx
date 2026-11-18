import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { SyntaxJson, TEXT_SAFE_SYNTAX_COLORS } from "@/components/ui/syntax-json";
import type { EventContent } from "@/lib/types";
import {
  AA_NORMAL_TEXT,
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

// Every text in the Prompts tab reads at WCAG AA (4.5:1) in both themes.
// The tab is rendered for every provider path (stored bodies from the
// fixtures, and built shapes for the rest), in its Rendered view and in
// every box's JSON view; each text node's colour and the backgrounds
// behind it are read from the markup and resolved through themes.css as
// it is, so a token or a component change that puts a text under 4.5:1
// fails here. The embeddings viewer's states are checked the same way.

const TOKENS = readThemeTokens();

let mockContent: EventContent | null = null;
let pending = false;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => (pending ? new Promise(() => {}) : Promise.resolve(mockContent))),
}));

beforeEach(() => {
  mockContent = null;
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
}

const base = { session_id: "s", system_prompt: null, messages: [], tools: null, response: null, captured_at: "2026-11-18T00:00:00Z" };
const bashResult = JSON.stringify({ stdout: "3 files\nok", stderr: "warning: deprecated flag", interrupted: false, note: null });

/** Shapes the stored fixtures do not hold: every Anthropic block type
 *  the tab draws, an OpenAI chat's edge calls and replies, litellm, a
 *  legacy completion. */
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
  { name: "capture off", content: null },
];

const gemini = fixture("gemini-content.json");
const CASES: Case[] = [
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
  ...(["otel-genai-content.json", "responses-content.json", "openai-tool-calls-content.json"] as const).flatMap((file) =>
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
      if (ratio < AA_NORMAL_TEXT) {
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
    <PromptViewer eventId={`e-contrast-${i}`} eventType={c.eventType ?? "post_call"} clientType={c.clientType} />,
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

describe("the Prompts tab's text reads at 4.5:1 or better in both themes", () => {
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
          expect(contrastRatio(resolveColor(t, `var(${text})`), resolveColor(t, `var(${surface})`))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }
    for (const [hue, text] of BADGES) {
      it(`${theme}: ${text} on a ${hue} badge's tint`, () => {
        const t = TOKENS[theme];
        const tintColor = { ...resolveColor(t, `var(${hue})`), a: BADGE_TINT };
        const bg = over(tintColor, resolveColor(t, "var(--surface)"));
        expect(contrastRatio(resolveColor(t, `var(${text})`), bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
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
        expect(contrastRatio(c, resolveColor(TOKENS[theme], "var(--bg-elevated)")), `${theme} ${name}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
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
