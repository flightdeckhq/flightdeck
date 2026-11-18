import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// What renders for content without a refusal stays as it was before the
// Responses output view and the refusal block existed, every byte of
// the Prompts tab's markup: the expected markup was captured by
// rendering these contents with main's PromptViewer at e2541499 (the
// Prompts tab's text-safe colours; first captured at 3f1a7618, then at
// 9343288b for the Rendered | JSON toggle) into
// fixtures/prompts-pinned-before-responses-refusals.json. Two entries
// were captured again from this branch's viewer, on purpose:
// openai_responses_request and litellm_responses_request, whose input
// passes back two reasoning items. A reasoning item in a request now has
// the view a response's has (its summary, else "(no summary)", and a
// mark in place of its encrypted content), so rs_1 gains that view's
// wrapper and rs_2 shows "(no summary)" and the mark instead of its
// JSON; every other byte of those two, and the other ten, are main's. A Responses
// call's response box is the one thing that changes for it, so its
// request side is pinned with that box taken out. Set
// CAPTURE_PINNED_MARKUP=1 to write the file again from the component in
// place (only ever from that commit's component, or a later main whose
// shared styles changed).

const PINNED_FILE = resolve(__dirname, "fixtures/prompts-pinned-before-responses-refusals.json");
const CAPTURE = process.env.CAPTURE_PINNED_MARKUP === "1";

const RESPONSES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/responses-content.json"), "utf8"),
) as Record<string, EventContent>;
const GEMINI = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/gemini-content.json"), "utf8"),
) as Record<string, EventContent>;

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
  captured_at: "2026-11-18T00:00:00Z",
};

/** A chat assistant message as the OpenAI SDK dumps it: every field
 *  present, ``refusal`` null. */
function sdkAssistant(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    annotations: [],
    audio: null,
    function_call: null,
    tool_calls: null,
    ...fields,
  };
}

/** The request side of a Responses call: every input kind the request
 *  view already renders, a refusal part among them. */
function responsesRequest(): EventContent {
  const content = structuredClone(RESPONSES.responses_function_call_round_trip!);
  content.event_id = "e-pinned-responses-request";
  content.input = [
    { role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Checking.", annotations: [] },
        { type: "refusal", refusal: "I can't share that." },
      ],
    },
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "The user wants the weather." }] },
    { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAAB-pinned" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
    { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Paris" } },
  ];
  content.tools = [...(content.tools as unknown[]), { type: "web_search_preview" }];
  return content;
}

/** Contents whose rendering must not change. */
const PINNED: Record<string, EventContent> = {
  openai_chat_tool_loop: {
    ...base,
    event_id: "e-pinned-chat-tool-loop",
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Paris?" },
      sdkAssistant({
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      }),
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
    ],
    tools: [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { properties: { city: { type: "string" } } } } }],
    response: {
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "tool_calls", message: sdkAssistant({ tool_calls: [{ id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } }] }) }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    },
  },
  openai_chat_text_response: {
    ...base,
    event_id: "e-pinned-chat-text",
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [
      { role: "user", content: "Hi" },
      sdkAssistant({ content: "Hello." }),
      sdkAssistant({}),
      { role: "user", content: "Again" },
    ],
    response: {
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: sdkAssistant({ content: "Hello again." }) }],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    },
  },
  openai_chat_empty_response: {
    ...base,
    event_id: "e-pinned-chat-empty",
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hi" }],
    response: {
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "length", message: sdkAssistant({}) }],
      usage: { prompt_tokens: 2, completion_tokens: 0 },
    },
  },
  litellm_chat: {
    ...base,
    event_id: "e-pinned-litellm-chat",
    provider: "litellm",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hi" }],
    response: {
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello.", tool_calls: null, function_call: null } }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    },
  },
  openai_responses_request: responsesRequest(),
  litellm_responses_request: {
    ...responsesRequest(),
    event_id: "e-pinned-litellm-responses-request",
    provider: "litellm",
  },
  text_completion: {
    ...base,
    event_id: "e-pinned-text-completion",
    provider: "litellm",
    model: "gpt-3.5-turbo-instruct",
    input: "Say hi",
    response: { object: "text_completion", choices: [{ text: " Hi.", index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } },
  },
  anthropic_thinking_tool_use: {
    ...base,
    event_id: "e-pinned-anthropic-thinking",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "Weather?" }],
    response: {
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "The user wants the weather.", signature: "sig" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
      ],
      usage: { input_tokens: 20, output_tokens: 15 },
    },
  },
  tool_call_row: {
    ...base,
    event_id: "e-pinned-tool-row",
    provider: "openai",
    model: "",
    response: {},
    tool_input: { city: "Paris" },
    tool_output: "Sunny",
  },
  gemini_plain_call: GEMINI.plain_call!,
  gemini_function_calling_round_2: GEMINI.function_calling_round_2!,
  gemini_thinking: GEMINI.thinking!,
};

/** The pinned markup of a content: the Prompts tab's, with a Responses
 *  call's response box taken out. */
async function markup(content: EventContent): Promise<string> {
  mockContent = content;
  const { container, unmount } = render(<PromptViewer eventId={content.event_id} eventType="post_call" />);
  await screen.findAllByText(content.provider);
  const isResponses = typeof content.response === "object" && content.response !== null && (content.response as { object?: unknown }).object === "response";
  if (isResponses) container.querySelector('[data-testid="prompt-box-response"]')?.remove();
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("PromptViewer: content without a refusal renders as it did before the Responses output view", () => {
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
