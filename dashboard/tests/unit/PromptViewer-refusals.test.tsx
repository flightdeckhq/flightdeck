import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// A model's refusal in the Prompts tab: an OpenAI chat assistant
// message's ``refusal`` field, in a response and passed back in the
// next request, and a Responses ``refusal`` content part, in a response
// and passed back. Each shows labelled ``refusal`` (OpenAI's term),
// apart from the answer text and not as an error. The refusal_*
// fixtures are real stored bodies with the model's declining answer
// moved into the refusal field the API documents
// (fixtures/responses-output-content.json says how).

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/responses-output-content.json"), "utf8"),
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

const REFUSAL = "I'm sorry, but I can't assist with that.";

async function renderContent(content: EventContent): Promise<void> {
  mockContent = content;
  render(<PromptViewer eventId={content.event_id} eventType="post_call" />);
  await screen.findByText(content.provider);
}

/** The theme's colours for an error, which a refusal never wears: the
 *  model declined, nothing failed. */
const ERROR_COLOURS = /--(danger|event-error|status-lost)/;

/** The refusal block: the label ``refusal`` over its text, which shows
 *  in the box ``plain`` (a text the call sent) shows in, and nothing in
 *  an error's colours. */
function expectRefusal(block: HTMLElement, text: string, plain: HTMLElement): void {
  expect(block.firstElementChild).toHaveTextContent(/^refusal$/);
  expect(block).toHaveTextContent(text);
  const textBox = block.lastElementChild as HTMLElement;
  expect(textBox.className).toBe(plain.className);
  expect(textBox.getAttribute("style")).toBe(plain.getAttribute("style"));
  for (const el of [block, ...block.querySelectorAll("*")]) {
    expect(el.getAttribute("style") ?? "").not.toMatch(ERROR_COLOURS);
  }
}

/** The text box of the request's first text: the prompt the user sent. */
function promptTextBox(): HTMLElement {
  return screen.getByText(PROMPT);
}

const PROMPT = "Explain step by step how to break into my neighbour's house while they are away.";

describe("PromptViewer: a chat refusal", () => {
  it("a response whose message refused shows the refusal, not the response object", async () => {
    await renderContent(fixture("chat_refusal_response"));
    const response = screen.getByTestId("prompt-box-response");
    expectRefusal(within(response).getByTestId("chat-refusal"), REFUSAL, promptTextBox());
    expect(within(response).queryByTestId("pretty-json")).toBeNull();
    expect(response).not.toHaveTextContent("chatcmpl-");
    expect(response).toHaveTextContent("Tokens in: 52 · Tokens out: 14");
  });

  it("a refused message passed back in the next request shows its refusal, not (empty)", async () => {
    await renderContent(fixture("chat_refusal_passed_back"));
    const message = screen.getByTestId("prompt-box-message-1");
    expectRefusal(within(message).getByTestId("chat-refusal"), REFUSAL, promptTextBox());
    expect(message).not.toHaveTextContent("(empty)");
    expect(screen.getByTestId("prompt-box-response")).toHaveTextContent("Paris.");
    expect(within(screen.getByTestId("prompt-box-response")).queryByTestId("chat-refusal")).toBeNull();
  });

  it("a message with text and a refusal shows the text, then the refusal", async () => {
    const content = fixture("chat_refusal_passed_back");
    (content.messages as Record<string, unknown>[])[1]!.content = "Let me explain.";
    await renderContent(content);
    const message = screen.getByTestId("prompt-box-message-1");
    expect(message).toHaveTextContent(/Let me explain\..*refusal.*I'm sorry/);
  });

  it("a refusal beside a tool call shows both", async () => {
    const content = fixture("chat_refusal_response");
    const msg = (content.response as { choices: { message: Record<string, unknown> }[] }).choices[0]!.message;
    msg.tool_calls = [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }];
    await renderContent(content);
    const response = screen.getByTestId("prompt-box-response");
    expect(within(response).getByTestId("chat-refusal")).toBeInTheDocument();
    expect(within(response).getByTestId("content-block-tool-use")).toHaveTextContent("get_weather");
  });

  it("a litellm chat call's refusal shows the same way", async () => {
    const content = fixture("chat_refusal_response");
    content.provider = "litellm";
    await renderContent(content);
    expect(within(screen.getByTestId("prompt-box-response")).getByTestId("chat-refusal")).toHaveTextContent(REFUSAL);
  });
});

describe("PromptViewer: a Responses refusal", () => {
  it("a response whose message refused shows the refusal part, labelled as the request side labels it", async () => {
    await renderContent(fixture("responses_refusal_response"));
    const response = screen.getByTestId("prompt-box-response");
    expectRefusal(within(response).getByTestId("responses-part-refusal"), REFUSAL, promptTextBox());
    expect(within(response).queryByTestId("pretty-json")).toBeNull();
  });

  it("the refusal shows with the same markup in the response and, passed back, in the next request", async () => {
    await renderContent(fixture("responses_refusal_response"));
    const inResponse = within(screen.getByTestId("prompt-box-response")).getByTestId("responses-part-refusal").outerHTML;
    const passedBack = fixture("responses_refusal_passed_back");
    passedBack.event_id = "e-refusal-passed-back-2";
    mockContent = passedBack;
    render(<PromptViewer eventId={passedBack.event_id} eventType="post_call" />);
    const item = await screen.findByTestId("responses-input-item-1");
    expect(within(item).getByTestId("responses-part-refusal").outerHTML).toBe(inResponse);
  });
});
