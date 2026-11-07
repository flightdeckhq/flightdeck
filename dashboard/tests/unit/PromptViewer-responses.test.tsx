import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { PromptViewer, isResponsesContent, isTextCompletionContent } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Prompts tab's view of an OpenAI Responses call. The sensor stores
// its request as the API's own parameters: ``instructions`` in the
// system slot, ``input`` verbatim (a string or a list of input items),
// ``messages`` empty. The three fixtures are bodies the live pipeline
// served (fixtures/responses-content.json says which); the item types a
// live call did not produce are built from the Responses API's shapes.

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/responses-content.json"), "utf8"),
) as Record<string, EventContent>;

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

/** A Responses call whose input is the given item list. */
function withItems(items: unknown[]): EventContent {
  const c = fixture("responses_item_list");
  c.input = items;
  return c;
}

function item(index: number): HTMLElement {
  return screen.getByTestId(`responses-input-item-${index}`);
}

describe("PromptViewer: an OpenAI Responses call", () => {
  it("labels the instructions `instructions`, not System", async () => {
    await renderContent(fixture("responses_string_input"));
    expect(screen.getByRole("button", { name: /^Instructions/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^System/ })).toBeNull();
    const box = screen.getByTestId("prompt-box-instructions");
    expect(within(box).getByText("instructions")).toBeInTheDocument();
    expect(within(box).queryByText("system")).toBeNull();
    expect(box).toHaveTextContent("You are terse. Answer in five words or fewer.");
    expect(screen.queryByTestId("prompt-box-system")).toBeNull();
  });

  it("shows a string input as written", async () => {
    await renderContent(fixture("responses_string_input"));
    expect(screen.getByRole("button", { name: /^Input/ })).toBeInTheDocument();
    const box = screen.getByTestId("prompt-box-input");
    expect(box).toHaveTextContent("Name the capital of France.");
    // There is no chat history to show.
    expect(screen.queryByRole("button", { name: /^Messages/ })).toBeNull();
    // Raw shows the string as stored.
    fireEvent.click(screen.getByTestId("prompt-box-input-raw"));
    expect(screen.getByTestId("prompt-box-input-raw-json")).toHaveTextContent('"Name the capital of France."');
  });

  it("shows each input item in its own box with the item count", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    expect(screen.getByRole("button", { name: /^Input\s*\(4\)/ })).toBeInTheDocument();
    expect(
      [0, 1, 2, 3].map((i) => item(i).getAttribute("data-item-type")),
    ).toEqual(["message", "message", "function_call", "function_call_output"]);
  });

  it("a message item shows its role and its content (a string or input_text parts)", async () => {
    await renderContent(fixture("responses_item_list"));
    // {role, content} with no type is a message item.
    expect(within(item(0)).getByText("developer")).toBeInTheDocument();
    expect(item(0)).toHaveTextContent("Use the weather tool for weather questions.");
    expect(within(item(1)).getByText("user")).toBeInTheDocument();
    expect(item(1)).toHaveTextContent("What is the weather in Paris?");
    // Parts render as text, not as their JSON.
    expect(item(1)).not.toHaveTextContent("input_text");
  });

  it("a function_call item shows its name, call_id and arguments as fields", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    const call = within(item(2)).getByTestId("responses-function-call");
    expect(within(item(2)).getByText("function_call")).toBeInTheDocument();
    expect(call).toHaveTextContent("get_weather");
    expect(within(call).getByTestId("responses-call-id")).toHaveTextContent("call_9IQorB7WiLKDYNXtObQMBB75");
    expect(within(call).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["city:"]);
    expect(call).toHaveTextContent("Paris");
  });

  it("a function_call_output item shows its call_id and its output", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    expect(within(item(3)).getByText("function_call_output")).toBeInTheDocument();
    const output = within(item(3)).getByTestId("responses-function-call-output");
    expect(within(output).getByTestId("responses-call-id")).toHaveTextContent("call_9IQorB7WiLKDYNXtObQMBB75");
    // The output is a JSON string, pretty-printed.
    expect(within(output).getByTestId("pretty-json")).toHaveTextContent('"temp_c": 18');
  });

  it("a function_call_output whose output is a list of parts shows them", async () => {
    await renderContent(
      withItems([
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "forecast: rain" }],
        },
        { type: "function_call_output", call_id: "call_2" },
      ]),
    );
    expect(item(0)).toHaveTextContent("forecast: rain");
    expect(item(1)).toHaveTextContent("(no output)");
  });

  it("a function_call with no or unparseable arguments still shows", async () => {
    await renderContent(
      withItems([
        { type: "function_call", call_id: "c1", name: "list_files", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "echo", arguments: "not json" },
      ]),
    );
    expect(item(0)).toHaveTextContent("list_files");
    expect(item(0)).toHaveTextContent("(no arguments)");
    expect(item(1)).toHaveTextContent("echo");
    expect(item(1)).toHaveTextContent("not json");
  });

  it("an assistant message item shows output_text and a refusal part", async () => {
    await renderContent(
      withItems([
        {
          type: "message",
          role: "assistant",
          id: "msg_1",
          status: "completed",
          content: [
            { type: "output_text", text: "Earlier answer.", annotations: [] },
            { type: "refusal", refusal: "I can't help with that." },
          ],
        },
      ]),
    );
    expect(within(item(0)).getByText("assistant")).toBeInTheDocument();
    expect(item(0)).toHaveTextContent("Earlier answer.");
    const refusal = within(item(0)).getByTestId("responses-part-refusal");
    expect(refusal).toHaveTextContent("refusal");
    expect(refusal).toHaveTextContent("I can't help with that.");
  });

  it("image, file and audio parts are named by type, a data URL is not inlined", async () => {
    await renderContent(
      withItems([
        {
          role: "user",
          content: [
            { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
            { type: "input_image", detail: "low", file_id: "file-img" },
            { type: "input_file", filename: "report.pdf", file_id: "file-123" },
            { type: "input_audio", input_audio: { format: "wav", data: "UklGRg==" } },
          ],
        },
      ]),
    );
    const media = within(item(0)).getAllByTestId("responses-part-media").map((el) => el.textContent);
    expect(media).toEqual([
      "[input_image · auto · data URL]",
      "[input_image · low · file-img]",
      "[input_file · report.pdf · file-123]",
      "[input_audio · wav]",
    ]);
    expect(item(0)).not.toHaveTextContent("base64");
  });

  it("a long signed media URL wraps inside its box", async () => {
    const signed =
      "https://files.example-cdn.com/uploads/2026/11/07/report-final-v3.png?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAEXAMPLE%2F20261107%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=" +
      "a".repeat(256);
    await renderContent(
      withItems([
        {
          role: "user",
          content: [
            { type: "input_image", detail: "high", image_url: signed },
            { type: "input_file", file_url: signed },
          ],
        },
      ]),
    );
    const parts = within(item(0)).getAllByTestId("responses-part-media");
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      // The URL is shown whole, and the box may break it anywhere.
      expect(part).toHaveTextContent(signed);
      expect(part.style.overflowWrap).toBe("anywhere");
    }
  });

  it("a reasoning item shows its summary text", async () => {
    await renderContent(
      withItems([
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "The user wants the weather." }],
          encrypted_content: "gAAAA",
        },
      ]),
    );
    expect(item(0).getAttribute("data-item-type")).toBe("reasoning");
    expect(within(item(0)).getByTestId("responses-reasoning")).toHaveTextContent("The user wants the weather.");
  });

  it("an item type it does not know is labelled by its type and shown as JSON, never dropped", async () => {
    await renderContent(
      withItems([
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "eiffel" } },
        { type: "item_reference", id: "msg_previous" },
        { type: "reasoning", id: "rs_2", summary: [] },
        "a bare string",
        { content: "no role, no type" },
      ]),
    );
    expect(screen.getByRole("button", { name: /^Input\s*\(5\)/ })).toBeInTheDocument();
    expect([0, 1, 2, 3, 4].map((i) => item(i).getAttribute("data-item-type"))).toEqual([
      "web_search_call",
      "item_reference",
      "reasoning",
      "value",
      "item",
    ]);
    expect(within(item(0)).getByText("web_search_call")).toBeInTheDocument();
    expect(within(item(0)).getByTestId("pretty-json")).toHaveTextContent('"query": "eiffel"');
    expect(within(item(1)).getByText("item_reference")).toBeInTheDocument();
    expect(item(1)).toHaveTextContent("msg_previous");
    expect(within(item(2)).getByTestId("pretty-json")).toHaveTextContent('"rs_2"');
    expect(item(3)).toHaveTextContent("a bare string");
    expect(within(item(4)).getByTestId("pretty-json")).toHaveTextContent("no role, no type");
  });

  it("each item box keeps its own Pretty / Raw toggle", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    fireEvent.click(screen.getByTestId("prompt-box-input-2-raw"));
    expect(screen.getByTestId("prompt-box-input-2")).toHaveAttribute("data-view", "raw");
    expect(screen.getByTestId("prompt-box-input-2-raw-json")).toHaveTextContent('"type": "function_call"');
    expect(screen.getByTestId("prompt-box-input-3")).toHaveAttribute("data-view", "pretty");
  });

  it("an empty item list says so", async () => {
    await renderContent(withItems([]));
    expect(screen.getByRole("button", { name: /^Input\s*\(0\)/ })).toBeInTheDocument();
    expect(screen.queryByTestId("responses-input-item-0")).toBeNull();
  });

  it("a Responses function tool shows its parameters", async () => {
    await renderContent(fixture("responses_item_list"));
    const tool = screen.getByTestId("prompt-box-tool-0");
    expect(tool).toHaveTextContent("get_weather");
    expect(tool).toHaveTextContent("Current weather for a city");
    expect(tool).toHaveTextContent("Parameters");
    expect(tool).toHaveTextContent("city");
  });

  it("a hosted Responses tool is named by its type", async () => {
    const c = fixture("responses_string_input");
    c.tools = [{ type: "web_search_preview" }];
    await renderContent(c);
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveTextContent("web_search_preview");
  });

  it("a Responses call without instructions shows no Instructions section", async () => {
    const c = fixture("responses_string_input");
    c.system_prompt = null;
    await renderContent(c);
    expect(screen.queryByRole("button", { name: /^Instructions/ })).toBeNull();
    expect(screen.getByTestId("prompt-box-input")).toHaveTextContent("Name the capital of France.");
  });

  it("a litellm Responses call renders the same way", async () => {
    const c = fixture("responses_function_call_round_trip");
    c.provider = "litellm";
    await renderContent(c);
    expect(screen.getByTestId("prompt-box-instructions")).toHaveTextContent("You are a weather assistant.");
    expect(item(2).getAttribute("data-item-type")).toBe("function_call");
  });
});

/** A litellm ``text_completion`` call as the sensor stores it: the
 *  request's ``prompt`` verbatim in ``input``, no ``messages``. */
function textCompletion(prompt: unknown): EventContent {
  return {
    event_id: "e-text-completion",
    session_id: "s",
    provider: "litellm",
    model: "gpt-3.5-turbo-instruct",
    system_prompt: null,
    messages: [],
    tools: null,
    response: {
      id: "cmpl-1",
      object: "text_completion",
      choices: [{ text: " Paris.", index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    },
    input: prompt as EventContent["input"],
    captured_at: "2026-11-07T00:00:00Z",
  };
}

describe("PromptViewer: a legacy completion call", () => {
  it("shows a string prompt under Prompt", async () => {
    await renderContent(textCompletion("The capital of France is"));
    expect(screen.getByRole("button", { name: /^Prompt/ })).toBeInTheDocument();
    expect(screen.getByTestId("prompt-box-prompt")).toHaveTextContent("The capital of France is");
    expect(screen.queryByRole("button", { name: /^Input/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Instructions/ })).toBeNull();
  });

  it("shows a list of prompts one box each", async () => {
    await renderContent(textCompletion(["first prompt", "second prompt"]));
    expect(screen.getByRole("button", { name: /^Prompt\s*\(2\)/ })).toBeInTheDocument();
    expect(screen.getByTestId("prompt-box-prompt-0")).toHaveTextContent("first prompt");
    expect(screen.getByTestId("prompt-box-prompt-1")).toHaveTextContent("second prompt");
  });

  it("shows token-id prompts as their JSON", async () => {
    await renderContent(textCompletion([1212, 318, 257]));
    expect(within(screen.getByTestId("prompt-box-prompt")).getByTestId("pretty-json")).toHaveTextContent("1212");
  });

  it("is known by its text_completion response object", () => {
    expect(isTextCompletionContent(textCompletion("x"))).toBe(true);
    expect(isTextCompletionContent(fixture("responses_string_input"))).toBe(false);
  });
});

describe("PromptViewer: other calls keep their rendering", () => {
  it("knows a Responses call only by its response object", () => {
    expect(isResponsesContent(fixture("responses_string_input"))).toBe(true);
    const chat = fixture("responses_string_input");
    chat.response = { object: "chat.completion", choices: [] };
    expect(isResponsesContent(chat)).toBe(false);
    const embeddings = fixture("responses_string_input");
    embeddings.response = {};
    expect(isResponsesContent(embeddings)).toBe(false);
    const anthropic = fixture("responses_string_input");
    anthropic.response = { type: "message", content: [] };
    expect(isResponsesContent(anthropic)).toBe(false);
    const listResponse = fixture("responses_string_input");
    listResponse.response = [{ object: "response" }];
    expect(isResponsesContent(listResponse)).toBe(false);
  });

  it("an Anthropic call still shows its system prompt under System", async () => {
    await renderContent({
      event_id: "e-anthropic",
      session_id: "s",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      system_prompt: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      response: { type: "message", role: "assistant", content: [{ type: "text", text: "hello" }] },
      captured_at: "2026-11-07T00:00:00Z",
    });
    expect(screen.getByRole("button", { name: /^System/ })).toBeInTheDocument();
    expect(screen.getByTestId("prompt-box-system")).toHaveTextContent("You are helpful.");
    expect(screen.queryByTestId("prompt-box-instructions")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Input/ })).toBeNull();
  });

  it("an OpenAI chat call shows its messages and no Input", async () => {
    await renderContent({
      event_id: "e-chat",
      session_id: "s",
      provider: "openai",
      model: "gpt-4o-mini",
      system_prompt: null,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { properties: { a: { type: "string" } } } } }],
      response: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] },
      captured_at: "2026-11-07T00:00:00Z",
    });
    expect(screen.getByRole("button", { name: /^Messages\s*\(2\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Input/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Instructions/ })).toBeNull();
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveTextContent("f");
  });

  it("an embeddings call's input is not shown as a Responses input", async () => {
    await renderContent({
      event_id: "e-embed",
      session_id: "s",
      provider: "openai",
      model: "text-embedding-3-small",
      system_prompt: null,
      messages: [],
      tools: null,
      response: {},
      input: ["alpha", "beta"],
      captured_at: "2026-11-07T00:00:00Z",
    });
    expect(screen.queryByRole("button", { name: /^Input/ })).toBeNull();
    expect(screen.queryByTestId("responses-input-item-0")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Prompt/ })).toBeNull();
  });
});
