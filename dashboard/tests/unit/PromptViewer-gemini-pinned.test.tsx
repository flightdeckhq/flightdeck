import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// What renders for content that is not a Gemini call's stays as it was
// before the Gemini view existed, every byte of the Prompts tab's
// markup: the expected markup was captured by rendering these contents
// with the PromptViewer of the commit before the view
// (feat/sensor-gemini 3d1c4ab9, whose PromptViewer is main's ad1b8b97),
// into fixtures/prompts-pinned-before-gemini.json. Set
// CAPTURE_PINNED_MARKUP=1 to write that file again from the component in
// place (only ever from that commit's component).

const PINNED_FILE = resolve(__dirname, "fixtures/prompts-pinned-before-gemini.json");
const CAPTURE = process.env.CAPTURE_PINNED_MARKUP === "1";

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

const base = {
  session_id: "s",
  system_prompt: null,
  messages: [],
  tools: null,
  captured_at: "2026-11-17T00:00:00Z",
};

/** Contents of each kind another view renders, one per provider path. */
const PINNED: Record<string, EventContent> = {
  anthropic: {
    ...base,
    event_id: "e-pinned-anthropic",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    system_prompt: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Sunny" }] },
    ],
    tools: [{ name: "get_weather", description: "Weather", input_schema: { properties: { city: { type: "string" } } } }],
    response: { type: "message", content: [{ type: "text", text: "Sunny in Paris." }], usage: { input_tokens: 9, output_tokens: 4 } },
  },
  openai: {
    ...base,
    event_id: "e-pinned-openai",
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ],
    tools: [{ type: "function", function: { name: "f", description: "F", parameters: { properties: { a: { type: "string" } } } } }],
    response: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "Hello." } }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  },
  litellm_gemini_model: {
    ...base,
    event_id: "e-pinned-litellm",
    provider: "litellm",
    model: "gemini/gemini-3.1-flash-lite",
    messages: [{ role: "user", content: "Hi" }],
    response: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "Hello." } }] },
  },
  otel_genai_gemini_model: {
    ...base,
    event_id: "e-pinned-otel",
    provider: "otel_genai",
    model: "gemini-3.1-flash-lite",
    system_prompt: [{ type: "text", content: "Be brief." }],
    messages: [
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
      { role: "model", parts: [{ type: "tool_call", id: "c1", name: "lookup", arguments: { q: "x" } }] },
    ],
    response: [{ role: "model", parts: [{ type: "text", content: "Hello." }], finish_reason: "stop" }],
  },
  google_embeddings: {
    ...base,
    event_id: "e-pinned-google-embeddings",
    provider: "google",
    model: "gemini-embedding-001",
    response: {},
    input: [{ parts: [{ text: "hello" }], role: "user" }, { parts: [{ text: "world" }], role: "user" }],
  },
  openai_embeddings: {
    ...base,
    event_id: "e-pinned-openai-embeddings",
    provider: "openai",
    model: "text-embedding-3-small",
    response: {},
    input: ["hello", "world"],
  },
};

async function markup(content: EventContent): Promise<string> {
  mockContent = content;
  const { container, unmount } = render(<PromptViewer eventId={content.event_id} />);
  await screen.findAllByText(content.provider === "otel_genai" ? "OpenTelemetry GenAI" : content.provider);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("PromptViewer: content that is not a Gemini call renders as it did before", () => {
  if (CAPTURE) {
    it("captures the markup", async () => {
      const captured: Record<string, string> = {};
      for (const [name, content] of Object.entries(PINNED)) captured[name] = await markup(content);
      writeFileSync(PINNED_FILE, `${JSON.stringify(captured, null, 2)}\n`);
    });
    return;
  }
  const expected = JSON.parse(readFileSync(PINNED_FILE, "utf8")) as Record<string, string>;
  for (const name of Object.keys(PINNED)) {
    it(name, async () => {
      expect(await markup(PINNED[name]!)).toBe(expected[name]);
    });
  }
});
