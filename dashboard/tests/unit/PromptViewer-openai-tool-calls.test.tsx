import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import {
  PromptViewer,
  chatToolReplies,
  responsesToolReplies,
} from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Prompts tab's view of an OpenAI call's tool activity: the calls an
// assistant message carries beside its content (``tool_calls``, the
// legacy ``function_call``), the replies that answer them (``tool`` and
// legacy ``function`` messages, Responses ``function_call_output``
// items), and the calls in a chat response. The live fixtures are bodies
// the pipeline served (fixtures/openai-tool-calls-content.json and
// fixtures/responses-content.json say which); the other shapes are built
// from the OpenAI API's own. The last block pins what renders as it did
// before tool calls were shown, markup included.

const FIXTURES = {
  ...JSON.parse(readFileSync(resolve(__dirname, "fixtures/openai-tool-calls-content.json"), "utf8")),
  ...JSON.parse(readFileSync(resolve(__dirname, "fixtures/responses-content.json"), "utf8")),
} as Record<string, EventContent>;

function fixture(name: string): EventContent {
  const c = FIXTURES[name];
  if (!c) throw new Error(`no fixture ${name}`);
  return structuredClone(c);
}

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

/** Render the content and wait for its provider header. */
async function renderContent(content: EventContent): Promise<void> {
  mockContent = content;
  render(<PromptViewer eventId={content.event_id} />);
  await screen.findByText(content.provider);
}

/** An OpenAI chat call whose request carries ``messages``. */
function chat(messages: unknown[], overrides: Partial<EventContent> = {}): EventContent {
  return {
    event_id: "e-chat-tools",
    session_id: "s",
    provider: "openai",
    model: "gpt-4o-mini",
    system_prompt: null,
    messages,
    tools: null,
    response: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "Done." } }] },
    captured_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}

/** An OpenAI chat call whose response message is ``message``. */
function chatResponse(message: Record<string, unknown>): EventContent {
  return chat([{ role: "user", content: "Weather?" }], {
    response: { object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls", message }] },
  });
}

const fnCall = (id: string, name: string, args: string) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

function message(index: number): HTMLElement {
  return screen.getByTestId(`prompt-box-message-${index}`);
}

/** The tool boxes in an element, as ``[name, text]`` pairs. */
function toolBoxes(el: HTMLElement): HTMLElement[] {
  return within(el).queryAllByTestId("content-block-tool-use");
}

function toolName(box: HTMLElement): string | null {
  return box.firstElementChild?.textContent ?? null;
}

/** A box's Pretty body: everything after its header row. */
function prettyBody(testId: string): string {
  const box = screen.getByTestId(testId);
  return Array.from(box.children)
    .slice(1)
    .map((c) => c.outerHTML)
    .join("\n");
}

describe("PromptViewer: an OpenAI chat tool-use loop, as stored", () => {
  it("the assistant message that called a tool shows the call, not (empty)", async () => {
    await renderContent(fixture("chat_tool_loop"));
    const assistant = message(1);
    expect(within(assistant).getByText("assistant")).toBeInTheDocument();
    const boxes = toolBoxes(assistant);
    expect(boxes).toHaveLength(1);
    expect(toolName(boxes[0]!)).toBe("get_weather");
    expect(within(boxes[0]!).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["city:"]);
    expect(boxes[0]).toHaveTextContent("Paris");
    expect(assistant).not.toHaveTextContent("(empty)");
    // The arguments render as fields, not as their JSON string.
    expect(assistant).not.toHaveTextContent('{"city":"Paris"}');
  });

  it("the tool reply says which call it answers, by the tool's name", async () => {
    await renderContent(fixture("chat_tool_loop"));
    const reply = within(message(2)).getByTestId("chat-tool-reply");
    expect(reply.firstElementChild).toHaveTextContent("tool result · get_weather");
    const target = within(reply).getByTestId("tool-reply-target");
    expect(target).toHaveTextContent("get_weather");
    expect(target).toHaveAttribute("data-target", "name");
    // The name is text, written as stored, not only a colour.
    expect(target).toHaveClass("normal-case");
    expect(reply).toHaveTextContent("Sunny, 21 C");
  });

  it("Raw shows each message exactly as stored", async () => {
    await renderContent(fixture("chat_tool_loop"));
    fireEvent.click(screen.getByTestId("prompt-box-message-1-raw"));
    const raw = screen.getByTestId("prompt-box-message-1-raw-json");
    expect(raw).toHaveTextContent('"content": null');
    expect(raw).toHaveTextContent('"arguments": "{\\"city\\":\\"Paris\\"}"');
    expect(raw).toHaveTextContent('"id": "call_WQ8qSG2k17m77npWHcxO2enm"');
    expect(raw).toHaveTextContent('"refusal": null');
    expect(raw).toHaveTextContent('"annotations": []');
    expect(within(message(1)).queryAllByTestId("content-block-tool-use")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("prompt-box-message-2-raw"));
    expect(screen.getByTestId("prompt-box-message-2-raw-json")).toHaveTextContent(
      '"tool_call_id": "call_WQ8qSG2k17m77npWHcxO2enm"',
    );
    expect(within(message(2)).queryByTestId("chat-tool-reply")).toBeNull();
  });

  it("the first call's response shows the call it asked for", async () => {
    await renderContent(fixture("chat_tool_call_response"));
    const boxes = toolBoxes(screen.getByTestId("prompt-box-response"));
    expect(boxes.map(toolName)).toEqual(["get_weather"]);
    expect(boxes[0]).toHaveTextContent("city:Paris");
  });

  it("the follow-up's response, with null tool_calls and function_call, shows its text alone", async () => {
    await renderContent(fixture("chat_tool_loop"));
    const response = screen.getByTestId("prompt-box-response");
    expect(response).toHaveTextContent("The weather in Paris is sunny with a temperature of 21°C.");
    expect(toolBoxes(response)).toHaveLength(0);
    expect(response).toHaveTextContent("Tokens in: 91");
  });
});

describe("PromptViewer: OpenAI chat tool-call shapes", () => {
  it("a message with text and a call shows the text, then the call", async () => {
    await renderContent(
      chat([
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Let me check.", tool_calls: [fnCall("call_1", "get_weather", '{"city":"Paris"}')] },
      ]),
    );
    const assistant = message(1);
    const text = within(assistant).getByText("Let me check.");
    const box = toolBoxes(assistant)[0]!;
    expect(toolName(box)).toBe("get_weather");
    expect(text.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("parallel calls show one box each, in order", async () => {
    await renderContent(
      chat([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            fnCall("call_a", "get_weather", '{"city":"Paris"}'),
            fnCall("call_b", "get_weather", '{"city":"Oslo"}'),
            fnCall("call_c", "get_time", '{"tz":"UTC"}'),
          ],
        },
      ]),
    );
    const boxes = toolBoxes(message(0));
    expect(boxes.map(toolName)).toEqual(["get_weather", "get_weather", "get_time"]);
    expect(boxes[0]).toHaveTextContent("Paris");
    expect(boxes[1]).toHaveTextContent("Oslo");
    expect(boxes[2]).toHaveTextContent("UTC");
    expect(message(0)).not.toHaveTextContent("(empty)");
  });

  it("content given as a list of parts shows its text, then the calls", async () => {
    await renderContent(
      chat([
        {
          role: "assistant",
          content: [{ type: "text", text: "Checking two cities." }],
          tool_calls: [fnCall("call_1", "get_weather", '{"city":"Paris"}')],
        },
      ]),
    );
    expect(message(0)).toHaveTextContent("Checking two cities.");
    expect(toolBoxes(message(0)).map(toolName)).toEqual(["get_weather"]);
  });

  it("arguments that are not valid JSON show as written, never dropped", async () => {
    const cut = '{"city": "Par';
    await renderContent(
      chat([{ role: "assistant", content: null, tool_calls: [fnCall("call_1", "get_weather", cut)] }]),
    );
    const box = toolBoxes(message(0))[0]!;
    expect(toolName(box)).toBe("get_weather");
    expect(within(box).getByText(cut)).toBeInTheDocument();
    expect(within(box).queryAllByTestId("kv-label")).toHaveLength(0);
  });

  it("empty, missing, blank and list arguments show in OpenAI's terms", async () => {
    await renderContent(
      chat([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            fnCall("call_1", "list_files", "{}"),
            { id: "call_2", type: "function", function: { name: "now" } },
            { id: "call_3", type: "function", function: { name: "today", arguments: null } },
            fnCall("call_4", "ping", ""),
            fnCall("call_5", "sum", "[1, 2, 3]"),
            { id: "call_6", type: "custom", custom: { name: "run_sql" } },
          ],
        },
      ]),
    );
    const [empty, missing, nulled, blank, list, custom] = toolBoxes(message(0));
    // A function call's field is arguments; a custom tool's is input.
    for (const box of [empty, missing, nulled]) {
      expect(box).toHaveTextContent("(no arguments)");
      expect(box).not.toHaveTextContent("(no input)");
    }
    expect(blank).toHaveTextContent("(empty)");
    expect(within(list!).getByTestId("pretty-json")).toHaveTextContent("1");
    expect(custom).toHaveTextContent("(no input)");
  });

  it("a custom tool's call shows its name and its input text", async () => {
    await renderContent(
      chat([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "custom", custom: { name: "run_sql", input: "SELECT 1;" } }],
        },
      ]),
    );
    const box = toolBoxes(message(0))[0]!;
    expect(toolName(box)).toBe("run_sql");
    expect(within(box).getByText("SELECT 1;")).toBeInTheDocument();
  });

  it("a legacy function_call shows as a call, and its function reply names it", async () => {
    await renderContent(
      chat([
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: null,
          function_call: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
        { role: "function", name: "get_weather", content: "Sunny" },
      ]),
    );
    const box = toolBoxes(message(1))[0]!;
    expect(toolName(box)).toBe("get_weather");
    expect(box).toHaveTextContent("city:Paris");
    const reply = within(message(2)).getByTestId("chat-tool-reply");
    expect(reply.firstElementChild).toHaveTextContent("tool result · get_weather");
    expect(reply).toHaveTextContent("Sunny");
  });

  it("a call of a type the viewer does not know shows as its JSON", async () => {
    await renderContent(
      chat([{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "mystery", mystery: { x: 1 } }] }]),
    );
    expect(toolBoxes(message(0))).toHaveLength(0);
    expect(within(message(0)).getByTestId("pretty-json")).toHaveTextContent('"mystery"');
  });

  it("a message with neither text nor a call still shows (empty)", async () => {
    await renderContent(
      chat([
        { role: "assistant", content: null, tool_calls: [], function_call: null },
        { role: "assistant", content: "", tool_calls: null },
      ]),
    );
    expect(message(0)).toHaveTextContent("(empty)");
    expect(toolBoxes(message(0))).toHaveLength(0);
    expect(toolBoxes(message(1))).toHaveLength(0);
  });

  it("a litellm call's OpenAI-format messages render the same way", async () => {
    const c = fixture("chat_tool_loop");
    c.provider = "litellm";
    await renderContent(c);
    expect(toolBoxes(message(1)).map(toolName)).toEqual(["get_weather"]);
    expect(within(message(2)).getByTestId("tool-reply-target")).toHaveTextContent("get_weather");
  });
});

describe("PromptViewer: which call an OpenAI tool reply answers", () => {
  it("a reply whose call is not in the list shows the call's id, shortened; Raw keeps it whole", async () => {
    const id = "call_9IQorB7WiLKDYNXtObQMBB75";
    await renderContent(chat([{ role: "tool", tool_call_id: id, content: "Sunny" }]));
    const target = within(message(0)).getByTestId("tool-reply-target");
    expect(target).toHaveAttribute("data-target", "call-id");
    expect(target.textContent).toBe("call_9IQorB7WiLK…");
    fireEvent.click(screen.getByTestId("prompt-box-message-0-raw"));
    expect(screen.getByTestId("prompt-box-message-0-raw-json")).toHaveTextContent(`"tool_call_id": "${id}"`);
  });

  it("a reply whose call is not in the list but which names its tool shows that name", async () => {
    await renderContent(
      chat([{ role: "tool", tool_call_id: "call_9IQorB7WiLKDYNXtObQMBB75", name: "get_weather", content: "Sunny" }]),
    );
    const target = within(message(0)).getByTestId("tool-reply-target");
    expect(target).toHaveAttribute("data-target", "name");
    expect(target.textContent).toBe("get_weather");
  });

  it("the name in the label wraps rather than overflowing the box", async () => {
    await renderContent(fixture("chat_tool_loop"));
    expect(within(message(2)).getByTestId("tool-reply-target").style.overflowWrap).toBe("anywhere");
  });

  it("a short id shows whole", async () => {
    await renderContent(chat([{ role: "tool", tool_call_id: "call_0", content: "Sunny" }]));
    expect(within(message(0)).getByTestId("tool-reply-target").textContent).toBe("call_0");
  });

  it("an id used again answers the nearest call before the reply", async () => {
    await renderContent(
      chat([
        { role: "assistant", content: null, tool_calls: [fnCall("call_0", "get_weather", "{}")] },
        { role: "tool", tool_call_id: "call_0", content: "Sunny" },
        { role: "assistant", content: null, tool_calls: [fnCall("call_0", "get_time", "{}")] },
        { role: "tool", tool_call_id: "call_0", content: "12:00" },
      ]),
    );
    expect(within(message(1)).getByTestId("tool-reply-target")).toHaveTextContent("get_weather");
    expect(within(message(3)).getByTestId("tool-reply-target")).toHaveTextContent("get_time");
  });

  it("a call made after the reply is not the one it answers", async () => {
    await renderContent(
      chat([
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
        { role: "assistant", content: null, tool_calls: [fnCall("call_1", "get_weather", "{}")] },
      ]),
    );
    const target = within(message(0)).getByTestId("tool-reply-target");
    expect(target).toHaveAttribute("data-target", "call-id");
    expect(target).toHaveTextContent("call_1");
  });

  it("a reply that names no call is labelled tool result alone", async () => {
    await renderContent(chat([{ role: "tool", content: "Sunny" }]));
    const reply = within(message(0)).getByTestId("chat-tool-reply");
    expect(reply.firstElementChild?.textContent).toBe("tool result");
    expect(within(reply).queryByTestId("tool-reply-target")).toBeNull();
  });

  it("chatToolReplies looks each reply up once, by its index", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [fnCall("c1", "get_weather", "{}"), fnCall("c2", "get_time", "{}")] },
      { role: "tool", tool_call_id: "c2", content: "12:00" },
      { role: "tool", tool_call_id: "c1", content: "Sunny" },
      { role: "tool", tool_call_id: "c9", content: "?" },
      { role: "function", name: "lookup", content: "x" },
      null,
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: {} }] },
      { role: "tool", tool_call_id: "c1", content: "again" },
      { role: "tool", tool_call_id: "c8", name: "search", content: "found" },
      { role: "tool", tool_call_id: "c2", name: "stale_name", content: "12:01" },
    ];
    const replies = chatToolReplies(messages);
    expect([...replies.keys()]).toEqual([2, 3, 4, 5, 8, 9, 10]);
    expect(replies.get(2)).toEqual({ name: "get_time", callId: "c2" });
    expect(replies.get(3)).toEqual({ name: "get_weather", callId: "c1" });
    expect(replies.get(4)).toEqual({ name: null, callId: "c9" });
    expect(replies.get(5)).toEqual({ name: "lookup", callId: null });
    // A later call that reuses the id and names no tool hides the earlier name.
    expect(replies.get(8)).toEqual({ name: null, callId: "c1" });
    // The call not in view: the reply's own name.
    expect(replies.get(9)).toEqual({ name: "search", callId: "c8" });
    // The call in view names the tool before the reply's own name does.
    expect(replies.get(10)).toEqual({ name: "get_time", callId: "c2" });
    expect(chatToolReplies(undefined).size).toBe(0);
    expect(chatToolReplies("not a list").size).toBe(0);
  });
});

describe("PromptViewer: OpenAI chat response calls", () => {
  it("a legacy function_call in the response shows as a call", async () => {
    await renderContent(
      chatResponse({ role: "assistant", content: null, tool_calls: null, function_call: { name: "get_weather", arguments: '{"city":"Paris"}' } }),
    );
    const boxes = toolBoxes(screen.getByTestId("prompt-box-response"));
    expect(boxes.map(toolName)).toEqual(["get_weather"]);
    expect(boxes[0]).toHaveTextContent("city:Paris");
  });

  it("a response call with no arguments says so, in OpenAI's word", async () => {
    await renderContent(chatResponse({ role: "assistant", content: null, tool_calls: [fnCall("c1", "list_files", "{}")] }));
    const box = toolBoxes(screen.getByTestId("prompt-box-response"))[0]!;
    expect(box).toHaveTextContent("(no arguments)");
    expect(box).not.toHaveTextContent("(no input)");
  });

  it("response shapes the OpenAI API does not return still show, never dropped", async () => {
    await renderContent(
      chatResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } },
          { id: "c2", type: "function", function: { name: "now" } },
          { id: "c3", type: "function", function: { name: "", arguments: '{"q":"x"}' } },
          { id: "c4", type: "mystery", mystery: { x: 1 } },
          "not an object",
        ],
      }),
    );
    const response = screen.getByTestId("prompt-box-response");
    const [objectArgs, missingArgs, unnamed] = toolBoxes(response);
    expect(toolBoxes(response)).toHaveLength(3);
    // Arguments stored as an object show as fields.
    expect(objectArgs).toHaveTextContent("city:Paris");
    expect(missingArgs).toHaveTextContent("(no arguments)");
    expect(toolName(unnamed!)).toBe("tool");
    // An unknown call type and a non-object entry show as their JSON.
    const json = within(response).getAllByTestId("pretty-json").map((el) => el.textContent);
    expect(json).toHaveLength(2);
    expect(json[0]).toContain('"mystery"');
    expect(json[1]).toContain('"not an object"');
  });

  it("a custom tool's call in the response shows its name and input", async () => {
    await renderContent(
      chatResponse({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "custom", custom: { name: "run_sql", input: "SELECT 1;" } }],
      }),
    );
    const box = toolBoxes(screen.getByTestId("prompt-box-response"))[0]!;
    expect(toolName(box)).toBe("run_sql");
    expect(box).toHaveTextContent("SELECT 1;");
  });

  it("text and a call in the response show the text, then the call", async () => {
    await renderContent(
      chatResponse({ role: "assistant", content: "On it.", tool_calls: [fnCall("c1", "get_weather", '{"city":"Paris"}')] }),
    );
    const response = screen.getByTestId("prompt-box-response");
    const text = within(response).getByText("On it.");
    const box = toolBoxes(response)[0]!;
    expect(text.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("PromptViewer: which call a Responses function_call_output answers", () => {
  function item(index: number): HTMLElement {
    return screen.getByTestId(`responses-input-item-${index}`);
  }

  it("an output after its function_call is labelled with the function's name, its call_id kept", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    const output = within(item(3)).getByTestId("responses-function-call-output");
    expect(output.firstElementChild).toHaveTextContent("tool result · get_weather");
    expect(within(output).getByTestId("tool-reply-target")).toHaveAttribute("data-target", "name");
    expect(within(output).getByTestId("responses-call-id")).toHaveTextContent("call_9IQorB7WiLKDYNXtObQMBB75");
    // The function_call item itself shows as it did.
    const call = within(item(2)).getByTestId("responses-function-call");
    expect(call).toHaveTextContent("get_weather");
    expect(within(call).getByTestId("responses-call-id")).toHaveTextContent("call_9IQorB7WiLKDYNXtObQMBB75");
  });

  it("an output whose call is not in the input is labelled tool result, its call_id shown whole", async () => {
    const c = fixture("responses_item_list");
    c.input = [{ type: "function_call_output", call_id: "call_elsewhere_0123456789", output: "Sunny" }];
    await renderContent(c);
    const output = within(item(0)).getByTestId("responses-function-call-output");
    expect(output.firstElementChild?.textContent).toBe("tool result");
    expect(within(output).queryByTestId("tool-reply-target")).toBeNull();
    expect(within(output).getByTestId("responses-call-id")).toHaveTextContent("call_elsewhere_0123456789");
  });

  it("a call_id used again answers the nearest function_call before the output", async () => {
    const c = fixture("responses_item_list");
    c.input = [
      { type: "function_call", call_id: "c0", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "c0", output: "Sunny" },
      { type: "function_call", call_id: "c0", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "c0", output: "12:00" },
    ];
    await renderContent(c);
    expect(within(item(1)).getByTestId("tool-reply-target")).toHaveTextContent("get_weather");
    expect(within(item(3)).getByTestId("tool-reply-target")).toHaveTextContent("get_time");
  });

  it("responsesToolReplies looks each output up once, by its index", () => {
    const replies = responsesToolReplies([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "Sunny" },
      { type: "function_call_output", call_id: "c2", output: "?" },
      "a bare string",
    ]);
    expect([...replies.entries()]).toEqual([[2, { name: "get_weather", callId: "c1" }]]);
    expect(responsesToolReplies("a string input").size).toBe(0);
  });
});

describe("PromptViewer: what renders as it did before tool calls were shown", () => {
  // Markup main renders for these boxes, captured from it: the change
  // must leave every byte of it alone.
  const TEXT_BOX = (text: string) =>
    `<div class="rounded-md p-2.5" style="background: var(--bg-elevated); font-size: 13px; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word;">${text}</div>`;
  const EMPTY = '<div class="text-xs" style="color: var(--text-muted);">(empty)</div>';
  const TOOL_USE = (name: string, key: string, value: string) =>
    `<div data-testid="content-block-tool-use" class="rounded-md p-2.5" style="background: var(--bg-elevated); border: 1px solid var(--border);"><div class="font-mono text-[13px] font-semibold" style="color: var(--event-tool);">${name}</div><div class="mt-2"><div class="space-y-1.5"><div class="flex items-baseline gap-2 font-mono text-[12px]"><span data-testid="kv-label" class="font-medium" style="color: var(--text-muted);">${key}:</span><span style="color: var(--text);">${value}</span></div></div></div></div>`;
  const NO_INPUT_TOOL_USE = (name: string) =>
    `<div data-testid="content-block-tool-use" class="rounded-md p-2.5" style="background: var(--bg-elevated); border: 1px solid var(--border);"><div class="font-mono text-[13px] font-semibold" style="color: var(--event-tool);">${name}</div><div class="mt-1 text-xs" style="color: var(--text-muted);">(no input)</div></div>`;

  it("OpenAI messages without tool activity, and a text response", async () => {
    await renderContent(
      chat(
        [
          { role: "user", content: "Hello" },
          { role: "assistant", content: null },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Part one." },
              { type: "image_url", image_url: { url: "https://x/y.png" } },
            ],
          },
        ],
        {
          response: {
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "Done.", tool_calls: null, function_call: null } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          },
        },
      ),
    );
    expect(prettyBody("prompt-box-message-0")).toBe(TEXT_BOX("Hello"));
    expect(prettyBody("prompt-box-message-1")).toBe(EMPTY);
    const parts = message(2);
    expect(parts).toHaveTextContent("Part one.");
    expect(within(parts).getByTestId("pretty-json")).toHaveTextContent('"image_url"');
    expect(within(parts).queryByTestId("chat-tool-reply")).toBeNull();
    expect(toolBoxes(parts)).toHaveLength(0);
    expect(prettyBody("prompt-box-response")).toBe(
      `<div><div class="space-y-2">${TEXT_BOX("Done.")}</div><div class="mt-2 font-mono text-[11px]" style="color: var(--text-muted);"><span>Tokens in: 3</span><span> · </span><span>Tokens out: 2</span></div></div>`,
    );
  });

  it("an Anthropic tool_use, tool_result and response tool_use", async () => {
    await renderContent({
      event_id: "e-anthropic-pinned",
      session_id: "s",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      system_prompt: "S",
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            { type: "tool_use", id: "toolu_2", name: "noop", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny, 21 C" }] },
      ],
      tools: null,
      response: { type: "message", content: [{ type: "tool_use", id: "toolu_3", name: "get_time", input: { tz: "UTC" } }] },
      captured_at: "2026-11-17T00:00:00Z",
    });
    expect(prettyBody("prompt-box-message-1")).toBe(
      `<div class="space-y-2">${TEXT_BOX("Checking.")}${TOOL_USE("get_weather", "city", "Paris")}${NO_INPUT_TOOL_USE("noop")}</div>`,
    );
    expect(prettyBody("prompt-box-message-2")).toBe(
      '<div class="space-y-2"><div><div class="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]" style="color: var(--text-muted);">tool result</div><div data-testid="tool-result-raw"><pre class="rounded-md p-2.5 font-mono text-[12px]" style="background: var(--bg-elevated); color: var(--text); white-space: pre-wrap; word-break: break-word; margin: 0px;">Sunny, 21 C</pre></div></div></div>',
    );
    expect(prettyBody("prompt-box-response")).toBe(
      `<div><div class="space-y-2">${TOOL_USE("get_time", "tz", "UTC")}</div></div>`,
    );
  });

  it("OpenTelemetry GenAI tool messages keep their own renderer", async () => {
    mockContent = {
      event_id: "e-genai-tools",
      session_id: "s",
      provider: "otel_genai",
      model: "gpt-4o-mini",
      system_prompt: null,
      messages: [
        { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "get_weather", arguments: { city: "Paris" } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "Sunny" }] },
      ],
      tools: null,
      response: [],
      captured_at: "2026-11-17T00:00:00Z",
    };
    render(<PromptViewer eventId="e-genai-tools" />);
    // The GenAI header names its source, not the provider.
    await screen.findByTestId("prompt-viewer-otel-genai");
    expect(within(screen.getByTestId("prompt-box-message-0")).getByTestId("genai-part-tool-call")).toHaveTextContent(
      "get_weather",
    );
    expect(within(screen.getByTestId("prompt-box-message-1")).getByTestId("genai-part-tool-response")).toHaveTextContent(
      "Sunny",
    );
    expect(screen.queryByTestId("chat-tool-reply")).toBeNull();
    expect(screen.queryByTestId("content-block-tool-use")).toBeNull();
  });
});
