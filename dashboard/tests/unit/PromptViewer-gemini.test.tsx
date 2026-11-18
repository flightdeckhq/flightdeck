import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import {
  PromptViewer,
  geminiCallNames,
  geminiToolBoxes,
  inlineDataSize,
  isGeminiContent,
} from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Prompts tab's view of a Gemini (google-genai) call: the request
// body the SDK built (contents, systemInstruction's parts, tools) and the
// response body, in Gemini's own terms. The live fixtures are contents a
// dev stack served for real google-genai 2.34 calls on the Gemini API
// (fixtures/gemini-content.json says which); the other shapes are built
// from bodies other SDK releases and Vertex AI send. The last block pins
// what renders for other content as it did before this view existed.

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/gemini-content.json"), "utf8"),
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

async function renderContent(content: EventContent, eventType = "post_call"): Promise<void> {
  mockContent = content;
  render(<PromptViewer eventId={content.event_id} eventType={eventType} />);
  await screen.findByText(content.provider);
}

/** A Gemini call built from a request and a response body. */
function gemini(
  input: unknown[],
  response: Record<string, unknown>,
  overrides: Partial<EventContent> = {},
): EventContent {
  return {
    event_id: "e-gemini-shape",
    session_id: "s",
    provider: "google",
    model: "gemini-3.1-flash-lite",
    system_prompt: null,
    messages: [],
    tools: null,
    response,
    input,
    captured_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}

const answered = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0, ...extra }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  modelVersion: "gemini-3.1-flash-lite",
});

const userTurn = (parts: unknown[]) => ({ parts, role: "user" });

function content(index: number): HTMLElement {
  return screen.getByTestId(`prompt-box-content-${index}`);
}

function response(): HTMLElement {
  return screen.getByTestId("prompt-box-response");
}

describe("PromptViewer: a Gemini call, in Gemini's terms", () => {
  it("a plain call shows its system instruction, its contents and its response", async () => {
    await renderContent(fixture("plain_call"));
    expect(screen.getByTestId("prompt-viewer-gemini")).toBeInTheDocument();
    for (const title of ["System instruction", "Contents", "Response"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${title}`) })).toBeInTheDocument();
    }
    // The badge says it in words (CSS upper-cases it); Raw keeps the body.
    expect(within(screen.getByTestId("prompt-box-system")).getByText("system instruction")).toBeInTheDocument();
    // The response shows the token line every provider's does.
    expect(response()).toHaveTextContent("Tokens in: 12 · Tokens out: 3");
    expect(screen.getByTestId("prompt-box-system")).toHaveTextContent("Answer in at most five words.");
    expect(within(content(0)).getByText("user")).toBeInTheDocument();
    expect(content(0)).toHaveTextContent("Say hi.");
    expect(response()).toHaveTextContent("Hi there!");
    // It ended normally, so no finish reason is shown.
    expect(screen.queryByTestId("gemini-finish-reason")).toBeNull();
    // The view of every other provider is not used.
    expect(screen.queryByTestId("prompt-box-message-0")).toBeNull();
  });

  it("a thought signature is marked, never printed, and Raw has it", async () => {
    const c = fixture("plain_call");
    await renderContent(c);
    const signature = ((c.response as { candidates: { content: { parts: { thoughtSignature: string }[] } }[] })
      .candidates[0]!.content.parts[0]!).thoughtSignature;
    const mark = within(response()).getByTestId("gemini-thought-signature");
    expect(mark).toHaveTextContent("thoughtSignature · opaque bytes, in Raw");
    expect(document.body.textContent).not.toContain(signature.slice(0, 24));
    fireEvent.click(screen.getByTestId("prompt-box-response-raw"));
    expect(screen.getByTestId("prompt-box-response-raw-json")).toHaveTextContent(signature.slice(0, 24));
  });

  it("a chat's history shows each turn with its role, a model turn's signature marked", async () => {
    await renderContent(fixture("chat_second_turn"));
    expect(screen.getByRole("button", { name: /^Contents/ })).toHaveTextContent("(3)");
    expect(within(content(0)).getByText("user")).toBeInTheDocument();
    expect(within(content(1)).getByText("model")).toBeInTheDocument();
    expect(within(content(2)).getByText("user")).toBeInTheDocument();
    expect(content(1)).toHaveTextContent("Nice to meet you, Ada.");
    expect(within(content(1)).getByTestId("gemini-thought-signature")).toBeInTheDocument();
    expect(content(2)).toHaveTextContent("What is my name?");
  });

  it("the first round of a function call: the tool by its name, the call with its args", async () => {
    await renderContent(fixture("function_calling_round_1"));
    const tool = screen.getByTestId("prompt-box-tool-0");
    expect(tool).toHaveTextContent("get_weather");
    expect(tool).not.toHaveTextContent("tool_0");
    expect(tool).toHaveTextContent("Returns the current weather in a city.");
    expect(tool).toHaveTextContent("city");
    expect(tool).toHaveTextContent("string");
    const call = within(response()).getByTestId("content-block-tool-use");
    expect(call.firstElementChild).toHaveTextContent("get_weather");
    expect(within(call).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["city:"]);
    expect(call).toHaveTextContent("Paris");
    // Raw keeps the declaration as sent.
    fireEvent.click(screen.getByTestId("prompt-box-tool-0-raw"));
    expect(screen.getByTestId("prompt-box-tool-0-raw-json")).toHaveTextContent('"parameters_json_schema"');
  });

  it("the second round: the model's call and the function's response, named", async () => {
    await renderContent(fixture("function_calling_round_2"));
    expect(within(content(1)).getByTestId("content-block-tool-use")).toHaveTextContent("get_weather");
    const reply = within(content(2)).getByTestId("gemini-function-response");
    expect(reply.firstElementChild).toHaveTextContent("function response · get_weather");
    expect(within(reply).getByTestId("tool-reply-target")).toHaveAttribute("data-target", "name");
    expect(within(reply).getByTestId("tool-value-fields")).toHaveTextContent("result:");
    expect(reply).toHaveTextContent("sunny, 21 C in Paris");
    expect(response()).toHaveTextContent("The weather in Paris");
  });

  it("a thinking response shows its thought apart from its answer", async () => {
    await renderContent(fixture("thinking"));
    const parts = within(response());
    const thought = parts.getByTestId("gemini-part-thought");
    expect(thought.firstElementChild).toHaveTextContent("thought");
    expect(thought).toHaveTextContent("Calculating the Product");
    expect(response()).toHaveTextContent("391");
    expect(parts.getByTestId("gemini-thought-signature")).toBeInTheDocument();
  });

  it("inline data is a placeholder with its type and size, its bytes only in Raw", async () => {
    const c = fixture("inline_image");
    await renderContent(c);
    const data = ((c.input as { parts: { inlineData?: { data: string } }[] }[])[0]!.parts[1]!.inlineData!).data;
    const placeholder = within(content(0)).getByTestId("gemini-part-inline-data");
    expect(placeholder).toHaveTextContent(/^\[image\/png · \d+ B\]$/);
    expect(content(0)).toHaveTextContent("What colour is this image? One word.");
    expect(document.body.innerHTML).not.toContain(data.slice(0, 16));
    expect(document.querySelectorAll("img")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("prompt-box-content-0-raw"));
    expect(screen.getByTestId("prompt-box-content-0-raw-json")).toHaveTextContent(data.slice(0, 16));
  });

  it("code execution: the built-in tool by its name, the code and its result", async () => {
    await renderContent(fixture("code_execution"));
    const tool = screen.getByTestId("prompt-box-tool-0");
    expect(tool).toHaveTextContent("codeExecution");
    expect(tool).toHaveTextContent("(no settings)");
    const code = within(response()).getByTestId("gemini-part-executable-code");
    expect(code.firstElementChild).toHaveTextContent("executable code · PYTHON");
    expect(code).toHaveTextContent("def is_prime(n):");
    const result = within(response()).getByTestId("gemini-part-code-execution-result");
    expect(result.firstElementChild).toHaveTextContent("code execution result · OUTCOME_OK");
    expect(result).toHaveTextContent("The sum of the first 10 prime numbers is: 129");
    expect(response()).toHaveTextContent("129");
  });

  it("an embeddings event keeps the view every provider's embeddings have", async () => {
    await renderContent(fixture("embeddings"), "embeddings");
    expect(screen.queryByTestId("prompt-viewer-gemini")).toBeNull();
    expect(isGeminiContent(fixture("embeddings"), "embeddings")).toBe(false);
    expect(isGeminiContent(fixture("plain_call"), "post_call")).toBe(true);
  });

  it("a generate call whose response was stored as {} or not at all keeps the Gemini view", async () => {
    for (const stored of [{}, null]) {
      const c = fixture("plain_call");
      c.response = stored;
      await renderContent(c);
      expect(screen.getByTestId("prompt-viewer-gemini")).toBeInTheDocument();
      expect(content(0)).toHaveTextContent("Say hi.");
      expect(screen.queryByTestId("prompt-box-response")).toBeNull();
      expect(screen.queryByText(/tool_0/)).toBeNull();
      cleanup();
    }
  });

  it("google-genai 1.64 on the Gemini API: inlineData with mimeType, a parameters schema", async () => {
    await renderContent(fixture("sdk164_gemini_api_round_2"));
    expect(within(content(0)).getByTestId("gemini-part-inline-data")).toHaveTextContent(/^\[image\/png · \d+ B\]$/);
    expect(within(content(1)).getByTestId("content-block-tool-use")).toHaveTextContent("describe_image");
    expect(within(content(2)).getByTestId("gemini-function-response")).toHaveTextContent("a red square (colour)");
    const tool = screen.getByTestId("prompt-box-tool-0");
    expect(tool).toHaveTextContent("describe_image");
    expect(tool).toHaveTextContent("STRING");
  });

  it("google-genai 1.64 on Vertex AI: the parts in snake_case", async () => {
    await renderContent(fixture("sdk164_vertex_round_2"));
    expect(within(content(0)).getByTestId("gemini-part-inline-data")).toHaveTextContent(/^\[image\/png · \d+ B\]$/);
    expect(within(content(1)).getByTestId("content-block-tool-use")).toHaveTextContent("describe_image");
    expect(within(content(1)).getByTestId("gemini-thought-signature")).toHaveTextContent("thought_signature");
    expect(content(1)).not.toHaveTextContent("c2lnbmF0dXJl");
    expect(within(content(2)).getByTestId("gemini-function-response")).toHaveTextContent("describe_image");
  });
});

describe("PromptViewer: the shapes a Gemini body has across SDK releases and platforms", () => {
  it("snake_case fields (google-genai 1.64 on Vertex AI) render as their camelCase twins", async () => {
    await renderContent(
      gemini(
        [
          userTurn([{ text: "look" }, { inline_data: { data: "iVBORw==", mime_type: "image/png" } }]),
          { parts: [{ function_call: { name: "lookup", args: { word: "cat" } } }], role: "model" },
          userTurn([{ function_response: { name: "lookup", response: { meaning: "a small feline" } } }]),
        ],
        answered([{ text: "done", thought_signature: "c2ln" }], {
          finishReason: undefined,
          finish_reason: "MAX_TOKENS",
          finish_message: "The answer reached max_output_tokens.",
        }),
        {
          tools: [
            {
              functionDeclarations: [
                { name: "lookup", parameters: { type: "OBJECT", properties: { word: { type: "STRING" } } } },
              ],
            },
          ],
        },
      ),
    );
    expect(within(content(0)).getByTestId("gemini-part-inline-data")).toHaveTextContent("[image/png · 4 B]");
    expect(within(content(1)).getByTestId("content-block-tool-use")).toHaveTextContent("lookup");
    expect(within(content(2)).getByTestId("gemini-function-response")).toHaveTextContent("a small feline");
    expect(within(response()).getByTestId("gemini-thought-signature")).toHaveTextContent("thought_signature");
    expect(within(response()).getByTestId("gemini-finish-reason")).toHaveTextContent(
      "finishReason · MAX_TOKENS · The answer reached max_output_tokens.",
    );
    // The schema's own type names, as sent.
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveTextContent("STRING");
  });

  it("a file is its MIME type and URI", async () => {
    await renderContent(
      gemini(
        [userTurn([{ fileData: { mimeType: "application/pdf", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc" } }])],
        answered([{ text: "ok" }]),
      ),
    );
    expect(within(content(0)).getByTestId("gemini-part-file-data")).toHaveTextContent(
      "[file · application/pdf · https://generativelanguage.googleapis.com/v1beta/files/abc]",
    );
  });

  it("a prompt the filters blocked says so plainly, not (empty)", async () => {
    await renderContent(
      gemini([userTurn([{ text: "x" }])], {
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 3 },
      }),
    );
    const blocked = within(response()).getByTestId("gemini-prompt-blocked");
    expect(blocked).toHaveTextContent("The prompt was blocked (blockReason SAFETY): the model returned no candidates.");
    expect(response()).not.toHaveTextContent("(empty)");
  });

  it("a candidate stopped by the safety filters shows its finish reason", async () => {
    await renderContent(gemini([userTurn([{ text: "x" }])], answered([{ text: "" }], { finishReason: "SAFETY" })));
    expect(within(response()).getByTestId("gemini-finish-reason")).toHaveTextContent("finishReason · SAFETY");
  });

  it("several candidates are labelled by their index", async () => {
    await renderContent(
      gemini([userTurn([{ text: "x" }])], {
        candidates: [
          { content: { parts: [{ text: "one" }], role: "model" }, finishReason: "STOP", index: 0 },
          { content: { parts: [{ text: "two" }], role: "model" }, finishReason: "STOP", index: 1 },
        ],
      }),
    );
    const candidates = within(response()).getAllByTestId("gemini-candidate");
    expect(candidates).toHaveLength(2);
    expect(candidates[1]!.firstElementChild).toHaveTextContent("candidate 1");
    expect(candidates[1]).toHaveTextContent("two");
  });

  it("a function response that names only its call's id is labelled with the call's function", async () => {
    await renderContent(
      gemini(
        [
          userTurn([{ text: "weather?" }]),
          { parts: [{ functionCall: { id: "call-7", name: "get_weather", args: {} } }], role: "model" },
          userTurn([{ functionResponse: { id: "call-7", response: { result: "sunny" } } }]),
        ],
        answered([{ text: "Sunny." }]),
      ),
    );
    // A call with no args says so in Gemini's word for the field.
    expect(within(content(1)).getByTestId("content-block-tool-use")).toHaveTextContent("(no args)");
    const reply = within(content(2)).getByTestId("gemini-function-response");
    expect(reply.firstElementChild).toHaveTextContent("function response · get_weather");
  });

  it("a part of a kind the view does not know is shown as its JSON", async () => {
    await renderContent(gemini([userTurn([{ videoMetadata: { fps: 2 } }])], answered([{ text: "ok" }])));
    expect(within(content(0)).getByTestId("pretty-json")).toHaveTextContent('"videoMetadata"');
  });

  it("a part that only carries a signature shows the mark, never its value", async () => {
    for (const part of [{ text: "", thoughtSignature: "c2lnLW9ubHk=" }, { thought_signature: "c2lnLW9ubHk=" }]) {
      await renderContent(gemini([userTurn([{ text: "x" }])], answered([part])));
      expect(within(response()).getByTestId("gemini-thought-signature")).toHaveTextContent("opaque bytes, in Raw");
      expect(response()).not.toHaveTextContent("c2lnLW9ubHk=");
      expect(within(response()).queryByTestId("pretty-json")).toBeNull();
      cleanup();
    }
  });

  it("a turn whose parts carry signatures shows one mark", async () => {
    await renderContent(
      gemini(
        [
          {
            parts: [
              { text: "a", thoughtSignature: "c2lnMQ==" },
              { functionCall: { name: "f", args: {} }, thoughtSignature: "c2lnMg==" },
              { text: "", thoughtSignature: "c2lnMw==" },
            ],
            role: "model",
          },
        ],
        answered([{ text: "ok" }]),
      ),
    );
    expect(within(content(0)).getAllByTestId("gemini-thought-signature")).toHaveLength(1);
    expect(within(response()).queryByTestId("gemini-thought-signature")).toBeNull();
  });

  it("a candidate whose content has no parts says so", async () => {
    await renderContent(
      gemini([userTurn([{ text: "x" }])], { candidates: [{ content: { role: "model" }, finishReason: "MAX_TOKENS" }] }),
    );
    expect(response()).toHaveTextContent("(no parts)");
    expect(within(response()).queryByTestId("pretty-json")).toBeNull();
  });

  it("the token line counts the prompt with the tool-use prompt, the candidates with the thoughts", async () => {
    await renderContent(
      gemini([userTurn([{ text: "x" }])], {
        candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, toolUsePromptTokenCount: 24, candidatesTokenCount: 3, thoughtsTokenCount: 148 },
      }),
    );
    expect(response()).toHaveTextContent("Tokens in: 1,024 · Tokens out: 151");
  });

  it("a cut inline payload is sized from the marker's total and says it was cut", async () => {
    const kept = "A".repeat(786_000);
    const data = `${kept}… [flightdeck: kept 786000 of 4000000 bytes to fit the event size limit]`;
    await renderContent(gemini([userTurn([{ inlineData: { mimeType: "image/jpeg", data } }])], answered([{ text: "ok" }])));
    expect(within(content(0)).getByTestId("gemini-part-inline-data")).toHaveTextContent(
      "[image/jpeg · 2.9 MB · cut to fit the event size limit]",
    );
    expect(document.body.innerHTML).not.toContain("AAAAAAAAAAAAAAAA");
  });

  it("built-in tools are named as the body names them, each declaration by its name", async () => {
    await renderContent(
      gemini([userTurn([{ text: "x" }])], answered([{ text: "ok" }]), {
        tools: [
          { googleSearch: {} },
          { urlContext: {} },
          { functionDeclarations: [{ name: "a", description: "First." }, { name: "b" }] },
        ],
      }),
    );
    // Each box's label, the first child of its header row.
    const names = [0, 1, 2, 3].map(
      (i) => screen.getByTestId(`prompt-box-tool-${i}`).firstElementChild?.firstElementChild?.textContent,
    );
    expect(names).toEqual(["googleSearch", "urlContext", "a", "b"]);
    expect(screen.getByRole("button", { name: /^Tools/ })).toHaveTextContent("(4)");
    expect(screen.getByTestId("prompt-box-tool-3")).toHaveTextContent("(no parameters)");
    // Raw: a declaration as sent, a built-in tool as the tool entry.
    fireEvent.click(screen.getByTestId("prompt-box-tool-2-raw"));
    expect(screen.getByTestId("prompt-box-tool-2-raw-json")).toHaveTextContent('"description": "First."');
    expect(screen.getByTestId("prompt-box-tool-2-raw-json")).not.toHaveTextContent('"b"');
    fireEvent.click(screen.getByTestId("prompt-box-tool-0-raw"));
    expect(screen.getByTestId("prompt-box-tool-0-raw-json")).toHaveTextContent('"googleSearch": {}');
  });

  it("a system instruction stored as text, and contents that are not a list, still render", async () => {
    await renderContent(
      gemini([], answered([{ text: "ok" }]), { system_prompt: "Be brief.", input: { unexpected: true } as never }),
    );
    expect(screen.getByTestId("prompt-box-system")).toHaveTextContent("Be brief.");
    expect(within(screen.getByTestId("prompt-box-contents")).getByTestId("pretty-json")).toHaveTextContent(
      '"unexpected"',
    );
  });
});

describe("Gemini view helpers", () => {
  it("inlineDataSize reads a cut payload's size from the sensor's marker, only at its end", () => {
    expect(inlineDataSize("iVBORw==")).toEqual({ bytes: 4, cut: false });
    expect(
      inlineDataSize("AAAA… [flightdeck: kept 4 of 4000000 bytes to fit the event size limit]"),
    ).toEqual({ bytes: 3_000_000, cut: true });
    // The marker's shape in the middle of the data is data, not a cut.
    const middle = "AAAA… [flightdeck: kept 4 of 4000000 bytes to fit the event size limit]AAAA";
    expect(inlineDataSize(middle)).toEqual({ bytes: Math.floor((middle.length * 3) / 4), cut: false });
  });

  it("geminiCallNames maps each call's id to its function", () => {
    expect([
      ...geminiCallNames([
        { parts: [{ functionCall: { id: "a", name: "f" } }, { function_call: { id: "b", name: "g" } }] },
        { parts: [{ functionCall: { name: "no-id" } }, "text"] },
        "not a turn",
      ]).entries(),
    ]).toEqual([
      ["a", "f"],
      ["b", "g"],
    ]);
    expect(geminiCallNames("contents").size).toBe(0);
  });

  it("geminiToolBoxes flattens declarations and names built-in tools", () => {
    const boxes = geminiToolBoxes([
      { function_declarations: [{ name: "x" }, {}] },
      { codeExecution: {} },
      "odd",
    ]);
    expect(boxes.map((b) => b.name)).toEqual(["x", "function_declarations[1]", "codeExecution", "tool_2"]);
    expect(geminiToolBoxes(null)).toEqual([]);
  });
});
