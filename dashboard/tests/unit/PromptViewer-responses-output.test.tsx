import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Prompts tab's Rendered view of an OpenAI Responses call's response:
// its output items one by one, in the Responses API's terms, then its
// status and error and the token line. The live fixtures are bodies the
// pipeline served for real calls (fixtures/responses-output-content.json
// and fixtures/responses-content.json say which); the item kinds no live
// call produced are built from the API's documented shapes.

const FIXTURES = {
  ...JSON.parse(readFileSync(resolve(__dirname, "fixtures/responses-content.json"), "utf8")),
  ...JSON.parse(readFileSync(resolve(__dirname, "fixtures/responses-output-content.json"), "utf8")),
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

async function renderContent(content: EventContent): Promise<void> {
  mockContent = content;
  render(<PromptViewer eventId={content.event_id} eventType="post_call" />);
  await screen.findByText(content.provider);
}

function responseBox(): HTMLElement {
  return screen.getByTestId("prompt-box-response");
}

function outputItem(index: number): HTMLElement {
  return within(responseBox()).getByTestId(`responses-output-item-${index}`);
}

/** A Responses call whose response holds ``output`` (and any other
 *  response fields given), on a real stored response. */
function withOutput(output: unknown[], fields: Record<string, unknown> = {}): EventContent {
  const c = fixture("streamed_plain");
  c.response = { ...(c.response as Record<string, unknown>), output, ...fields };
  return c;
}

describe("PromptViewer: a Responses call's response shows its output items", () => {
  it("a function_call item shows as the input's function_call does: name, call_id and arguments, not the response object", async () => {
    await renderContent(fixture("responses_item_list"));
    const item = outputItem(0);
    expect(item).toHaveAttribute("data-item-type", "function_call");
    const call = within(item).getByTestId("responses-function-call");
    expect(call).toHaveTextContent("get_weather");
    expect(within(call).getByTestId("responses-call-id")).toHaveTextContent("call_9IQorB7WiLKDYNXtObQMBB75");
    expect(within(call).getByTestId("kv-label")).toHaveTextContent("city:");
    expect(call).toHaveTextContent("Paris");
    // The response object's settings stay in the JSON view.
    expect(responseBox()).not.toHaveTextContent("access_programs");
    expect(responseBox()).not.toHaveTextContent("billing");
    expect(within(responseBox()).queryByTestId("pretty-json")).toBeNull();
  });

  it("the same function_call shows the same markup in the response and, passed back, in the next request's input", async () => {
    await renderContent(fixture("reasoning_tool_round_1"));
    const inResponse = within(outputItem(1)).getByTestId("responses-function-call").outerHTML;
    cleanup();
    await renderContent(fixture("reasoning_tool_round_2"));
    const inInput = within(screen.getByTestId("responses-input-item-2")).getByTestId("responses-function-call").outerHTML;
    expect(inInput).toBe(inResponse);
  });

  it("a message item shows its output_text as text", async () => {
    await renderContent(fixture("responses_function_call_round_trip"));
    const item = outputItem(0);
    expect(item).toHaveAttribute("data-item-type", "message");
    expect(item).toHaveTextContent("The weather in Paris is clear with a temperature of 18°C.");
  });

  it("a reasoning item with no summary is labelled, says so, and marks its encrypted content without printing it", async () => {
    const content = fixture("reasoning_tool_round_1");
    const encrypted = ((content.response as { output: { encrypted_content: string }[] }).output[0]!).encrypted_content;
    await renderContent(content);
    const reasoning = within(outputItem(0)).getByTestId("responses-reasoning-item");
    expect(reasoning).toHaveTextContent("reasoning");
    expect(reasoning).toHaveTextContent("(no summary)");
    expect(within(reasoning).getByTestId("responses-encrypted-reasoning")).toHaveTextContent(
      "encrypted_content · encrypted reasoning, in JSON",
    );
    expect(responseBox()).not.toHaveTextContent(encrypted.slice(0, 24));
    fireEvent.click(screen.getByTestId("prompt-box-response-json"));
    expect(screen.getByTestId("prompt-box-response-json-view")).toHaveTextContent(encrypted.slice(0, 24));
  });

  it("a reasoning item shows its summary text, then the answer", async () => {
    await renderContent(fixture("reasoning_summary_encrypted"));
    const reasoning = within(outputItem(0)).getByTestId("responses-reasoning-item");
    expect(within(reasoning).getByTestId("responses-reasoning")).toHaveTextContent("Determining if 391 is prime");
    expect(within(reasoning).getByTestId("responses-encrypted-reasoning")).toBeInTheDocument();
    expect(outputItem(1)).toHaveAttribute("data-item-type", "message");
  });

  it("a reasoning item with reasoning text and no summary shows the text", async () => {
    await renderContent(
      withOutput([{ type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "Seventeen times twenty-three." }] }]),
    );
    expect(within(outputItem(0)).getByTestId("responses-reasoning")).toHaveTextContent("Seventeen times twenty-three.");
    expect(within(outputItem(0)).queryByTestId("responses-encrypted-reasoning")).toBeNull();
  });

  it("a streamed call shows the final response its stream carried, with the token line from its usage", async () => {
    await renderContent(fixture("streamed_reasoning"));
    expect(within(outputItem(0)).getByTestId("responses-reasoning")).toHaveTextContent("Answering distinguishing prime numbers");
    expect(outputItem(1)).toHaveTextContent("23");
    expect(responseBox()).toHaveTextContent("Tokens in: 17 · Tokens out: 59");
  });

  it("a response cut short shows its status and the reason", async () => {
    await renderContent(fixture("incomplete_max_output_tokens"));
    expect(within(responseBox()).getByTestId("responses-status")).toHaveTextContent("status · incomplete · max_output_tokens");
    expect(outputItem(0)).toHaveAttribute("data-item-type", "reasoning");
  });


  it("a failed response shows its status and its error's code and message", async () => {
    await renderContent(withOutput([], { status: "failed", error: { code: "server_error", message: "The model failed to respond." } }));
    expect(within(responseBox()).getByTestId("responses-no-output")).toHaveTextContent("(no output)");
    expect(within(responseBox()).getByTestId("responses-status")).toHaveTextContent("status · failed");
    expect(within(responseBox()).getByTestId("responses-error")).toHaveTextContent("error · server_error · The model failed to respond.");
  });

  it("a stream left before its first item shows the in-progress snapshot as it is", async () => {
    await renderContent(withOutput([], { status: "in_progress", usage: null }));
    expect(within(responseBox()).getByTestId("responses-no-output")).toBeInTheDocument();
    expect(within(responseBox()).getByTestId("responses-status")).toHaveTextContent("status · in_progress");
  });

  it("a hosted web search shows its type and what it searched, then the answer, its links as text", async () => {
    await renderContent(fixture("web_search"));
    const tool = within(outputItem(0)).getByTestId("responses-tool-item");
    expect(tool).toHaveTextContent("web_search_call");
    expect(tool).toHaveTextContent("type:search");
    // Its queries repeat its query, so they show once.
    expect(tool).not.toHaveTextContent("queries");
    expect(tool).toHaveTextContent("Search the web: in what year was the Eiffel Tower completed? One sentence.");
    expect(outputItem(1)).toHaveTextContent("The Eiffel Tower was completed on March 31, 1889.");
    expect(responseBox().querySelectorAll("a")).toHaveLength(0);
    expect(responseBox().querySelectorAll("img")).toHaveLength(0);
  });

  it("a function_call with no arguments says so and keeps its call_id", async () => {
    await renderContent(withOutput([{ type: "function_call", id: "fc_1", call_id: "call_empty", name: "get_time", arguments: "" }]));
    const call = within(outputItem(0)).getByTestId("responses-function-call");
    expect(call).toHaveTextContent("get_time");
    expect(call).toHaveTextContent("(no arguments)");
    expect(within(call).getByTestId("responses-call-id")).toHaveTextContent("call_empty");
  });

  it("each hosted tool's call shows its type and the fields that say what it did", async () => {
    await renderContent(
      withOutput([
        {
          type: "file_search_call",
          id: "fs_1",
          status: "completed",
          queries: ["refund policy"],
          results: [{ file_id: "file_1", filename: "policy.pdf", score: 0.9, text: "Refunds within 30 days." }],
        },
        { type: "code_interpreter_call", id: "ci_1", status: "completed", container_id: "cntr_1", code: "print(17 * 23)", outputs: [{ type: "logs", logs: "391" }] },
        {
          type: "computer_call",
          id: "cu_1",
          call_id: "call_cu",
          status: "completed",
          action: { type: "click", button: "left", x: 10, y: 20 },
          pending_safety_checks: [],
        },
        { type: "local_shell_call", id: "ls_1", call_id: "call_ls", status: "completed", action: { type: "exec", command: ["ls", "-la"] } },
        { type: "mcp_call", id: "mcp_1", server_label: "docs", name: "search", arguments: '{"q":"refunds"}', output: "Found 2 pages", error: null },
        {
          type: "mcp_list_tools",
          id: "ml_1",
          server_label: "docs",
          tools: [{ name: "search", input_schema: {} }, { name: "fetch", input_schema: {} }],
          error: null,
        },
        { type: "mcp_approval_request", id: "ma_1", server_label: "docs", name: "delete_page", arguments: '{"page":"x"}' },
        { type: "custom_tool_call", id: "ct_1", call_id: "call_ct", name: "run_sql", input: "SELECT 1" },
      ]),
    );
    const tools = within(responseBox()).getAllByTestId("responses-tool-item");
    expect(tools.map((t) => t.firstElementChild?.textContent)).toEqual([
      "file_search_call",
      "code_interpreter_call",
      "computer_call",
      "local_shell_call",
      "mcp_call",
      "mcp_list_tools",
      "mcp_approval_request",
      "custom_tool_call",
    ]);
    expect(tools[0]).toHaveTextContent("refund policy");
    expect(tools[0]).toHaveTextContent("Refunds within 30 days.");
    expect(tools[1]).toHaveTextContent("print(17 * 23)");
    expect(tools[1]).toHaveTextContent("391");
    expect(tools[2]).toHaveTextContent("call_cu");
    expect(tools[2]).toHaveTextContent("button:left");
    expect(tools[3]).toHaveTextContent('"-la"');
    expect(tools[4]).toHaveTextContent("server_label:docs");
    expect(tools[4]).toHaveTextContent('"q": "refunds"');
    expect(tools[4]).toHaveTextContent("Found 2 pages");
    expect(tools[5]).toHaveTextContent('"search"');
    expect(tools[5]).toHaveTextContent('"fetch"');
    expect(tools[6]).toHaveTextContent("delete_page");
    expect(tools[7]).toHaveTextContent("run_sql");
    expect(tools[7]).toHaveTextContent("SELECT 1");
  });

  it("a hosted tool's call that did not complete says so in its label", async () => {
    await renderContent(withOutput([{ type: "web_search_call", id: "ws_1", status: "failed", action: { type: "search", query: "x" } }]));
    expect(within(outputItem(0)).getByTestId("responses-tool-item")).toHaveTextContent("web_search_call · failed");
  });

  it("an image generation's result is a placeholder with its size, never the bytes", async () => {
    const bytes = "iVBORw0KGgo".padEnd(4000, "A");
    await renderContent(
      withOutput([{ type: "image_generation_call", id: "ig_1", status: "completed", output_format: "png", revised_prompt: "A lighthouse", result: bytes }]),
    );
    const tool = within(outputItem(0)).getByTestId("responses-tool-item");
    expect(tool).toHaveTextContent("A lighthouse");
    expect(within(tool).getByTestId("responses-image-result")).toHaveTextContent("[image/png · 2.9 KB]");
    expect(responseBox()).not.toHaveTextContent("iVBORw0KGgo");
  });

  it("an image generation's result the sensor cut says so, with the full size from the cut marker", async () => {
    // The sensor's marker (sensor/flightdeck_sensor/transport/body_limit.py)
    // after the kept bytes: 3,000,000 base64 characters stood for 2.1 MB.
    const cut = `${"iVBORw0KGgo".padEnd(2000, "A")}… [flightdeck: kept 2000 of 3000000 bytes to fit the event size limit]`;
    await renderContent(withOutput([{ type: "image_generation_call", id: "ig_2", status: "completed", output_format: "png", result: cut }]));
    expect(within(outputItem(0)).getByTestId("responses-image-result")).toHaveTextContent(
      "[image/png · 2.1 MB · cut to fit the event size limit]",
    );
    expect(responseBox()).not.toHaveTextContent("iVBORw0KGgo");
  });

  it("a code interpreter's image output names a data URL rather than printing it, and keeps an https URL", async () => {
    const dataUrl = `data:image/png;base64,${"iVBORw0KGgo".padEnd(400, "A")}`;
    await renderContent(
      withOutput([
        {
          type: "code_interpreter_call",
          id: "ci_2",
          status: "completed",
          container_id: "cntr_2",
          code: "plot()",
          outputs: [
            { type: "logs", logs: "plotted" },
            { type: "image", url: dataUrl },
            { type: "image", url: "https://files.example.com/plot.png" },
          ],
        },
      ]),
    );
    const tool = within(outputItem(0)).getByTestId("responses-tool-item");
    expect(tool).toHaveTextContent('"logs": "plotted"');
    expect(tool).toHaveTextContent('"url": "data URL"');
    expect(tool).toHaveTextContent('"url": "https://files.example.com/plot.png"');
    expect(responseBox()).not.toHaveTextContent("base64");
    expect(responseBox()).not.toHaveTextContent("iVBORw0KGgo");
    fireEvent.click(screen.getByTestId("prompt-box-response-json"));
    expect(screen.getByTestId("prompt-box-response-json-view")).toHaveTextContent("data:image/png;base64,iVBORw0KGgo");
  });

  it("an item type it does not special-case is labelled by its type and shown as its JSON, never dropped", async () => {
    await renderContent(withOutput([{ type: "shell_call", id: "sh_1", call_id: "call_sh", action: { commands: ["pwd"] } }, "a bare value"]));
    expect(outputItem(0)).toHaveAttribute("data-item-type", "shell_call");
    expect(outputItem(0)).toHaveTextContent("shell_call");
    expect(within(outputItem(0)).getByTestId("pretty-json")).toHaveTextContent('"pwd"');
    expect(outputItem(1)).toHaveAttribute("data-item-type", "value");
    expect(outputItem(1)).toHaveTextContent("a bare value");
  });

  it("model text shows as text: markup in it is not rendered", async () => {
    await renderContent(
      withOutput([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "<b>bold</b> [link](https://example.com)", annotations: [] }] },
      ]),
    );
    expect(outputItem(0)).toHaveTextContent("<b>bold</b> [link](https://example.com)");
    expect(responseBox().querySelectorAll("b, a")).toHaveLength(0);
  });

  it("a litellm Responses call's response shows the same way", async () => {
    const content = fixture("responses_function_call_round_trip");
    content.provider = "litellm";
    await renderContent(content);
    expect(outputItem(0)).toHaveTextContent("The weather in Paris is clear with a temperature of 18°C.");
  });


});

// A reasoning item passed back in a request's input: the same view, so
// its encrypted content is never in the Rendered view on either side.
describe("PromptViewer: a reasoning item passed back in a request", () => {
  function inputItem(index: number): HTMLElement {
    return screen.getByTestId(`responses-input-item-${index}`);
  }

  it("with no summary: (no summary) and the mark, the encrypted content only in the JSON view (a real tool loop's second request)", async () => {
    const content = fixture("reasoning_tool_round_2");
    const passedBack = (content.input as Record<string, unknown>[])[1]!;
    const encrypted = passedBack.encrypted_content as string;
    expect(passedBack.type).toBe("reasoning");
    expect(passedBack.summary).toEqual([]);
    await renderContent(content);
    const item = inputItem(1);
    expect(item).toHaveAttribute("data-item-type", "reasoning");
    const reasoning = within(item).getByTestId("responses-reasoning-item");
    expect(reasoning).toHaveTextContent("(no summary)");
    expect(within(reasoning).getByTestId("responses-encrypted-reasoning")).toHaveTextContent(
      "encrypted_content · encrypted reasoning, in JSON",
    );
    expect(within(item).queryByTestId("pretty-json")).toBeNull();
    expect(item).not.toHaveTextContent(encrypted.slice(0, 24));
    fireEvent.click(screen.getByTestId("prompt-box-input-1-json"));
    expect(screen.getByTestId("prompt-box-input-1-json-view")).toHaveTextContent(encrypted.slice(0, 24));
  });

  it("with a summary: the summary and the mark, the encrypted content only in the JSON view", async () => {
    const content = fixture("responses_item_list");
    content.input = [
      { role: "user", content: "Is 391 prime?" },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "391 is 17 times 23." }],
        encrypted_content: "gAAAAABpassedBackEncryptedReasoning",
      },
    ];
    await renderContent(content);
    const item = inputItem(1);
    const reasoning = within(item).getByTestId("responses-reasoning-item");
    expect(within(reasoning).getByTestId("responses-reasoning")).toHaveTextContent("391 is 17 times 23.");
    expect(within(reasoning).getByTestId("responses-encrypted-reasoning")).toBeInTheDocument();
    // The box's badge names the item; the view adds no label of its own.
    expect(within(reasoning).queryByText("reasoning")).toBeNull();
    expect(item).not.toHaveTextContent("gAAAAABpassedBack");
    fireEvent.click(screen.getByTestId("prompt-box-input-1-json"));
    expect(screen.getByTestId("prompt-box-input-1-json-view")).toHaveTextContent("gAAAAABpassedBackEncryptedReasoning");
  });

  it("without encrypted content: the summary and no mark", async () => {
    const content = fixture("responses_item_list");
    content.input = [{ type: "reasoning", id: "rs_3", summary: [{ type: "summary_text", text: "Thinking about it." }] }];
    await renderContent(content);
    const reasoning = within(inputItem(0)).getByTestId("responses-reasoning-item");
    expect(reasoning).toHaveTextContent("Thinking about it.");
    expect(within(reasoning).queryByTestId("responses-encrypted-reasoning")).toBeNull();
  });
});

// Guards: what the response box showed before and still shows. These
// pass on main too; every case above fails there.
describe("PromptViewer: a Responses call's response keeps what it had", () => {
  it("a completed response shows no status line", async () => {
    await renderContent(fixture("streamed_plain"));
    expect(within(responseBox()).queryByTestId("responses-status")).toBeNull();
    expect(within(responseBox()).queryByTestId("responses-error")).toBeNull();
  });

  it("the JSON view keeps the whole response as stored", async () => {
    await renderContent(fixture("responses_item_list"));
    fireEvent.click(screen.getByTestId("prompt-box-response-json"));
    const raw = screen.getByTestId("prompt-box-response-json-view");
    expect(raw).toHaveTextContent('"access_programs": null');
    expect(raw).toHaveTextContent('"type": "function_call"');
  });

  it("a response object whose output is not a list shows as its JSON, as before", async () => {
    await renderContent(withOutput([], { output: null }));
    expect(within(responseBox()).getByTestId("pretty-json")).toHaveTextContent('"object": "response"');
    expect(within(responseBox()).queryByTestId("responses-output")).toBeNull();
  });
});
