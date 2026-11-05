import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The PromptViewer's OpenTelemetry GenAI renderer (provider
// otel_genai). Every fixture is a content body the live pipeline
// served for a recorded framework run replayed with capture on
// (fixtures/otel-genai-content.json says how it was made), so each
// test renders what ingestion really stores for that framework: the
// GenAI conventions' {role, parts} messages (Pydantic AI, Strands
// under the latest conventions, OpenAI Agents, Google ADK), Strands'
// Bedrock-style content blocks under the older ones, and a tool call's
// arguments and result.

interface Scenario {
  scenario: string;
  calls: EventContent[];
  tools: EventContent[];
}

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/otel-genai-content.json"), "utf8"),
) as Record<string, Scenario>;

function fixture(name: string): Scenario {
  const s = FIXTURES[name];
  if (!s) throw new Error(`no fixture ${name}`);
  return s;
}

function at<T>(list: T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no entry ${i}`);
  return v;
}

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

async function renderContent(content: EventContent) {
  mockContent = content;
  render(<PromptViewer eventId={content.event_id} />);
  return screen.findByTestId("prompt-viewer-otel-genai");
}

function box(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

describe("PromptViewer: OpenTelemetry GenAI content", () => {
  it("Pydantic AI: system instructions, {role, parts} messages and a tool call in the response", async () => {
    const call = at(fixture("pydantic_ai").calls, 0);
    const viewer = await renderContent(call);

    expect(within(viewer).getByTestId("prompt-viewer-source")).toHaveTextContent("OpenTelemetry GenAI");
    expect(viewer).toHaveTextContent("claude-haiku-4-5");
    // The instructions are JSON in the text column: rendered as parts.
    expect(box("prompt-box-system")).toHaveTextContent("Answer weather questions with the get_weather tool.");
    expect(box("prompt-box-system")).not.toHaveTextContent('"type"');

    expect(screen.getByText("Messages").parentElement).toHaveTextContent("(2)");
    expect(within(box("prompt-box-message-0")).getByText("system")).toBeInTheDocument();
    expect(within(box("prompt-box-message-1")).getByText("user")).toBeInTheDocument();
    expect(box("prompt-box-message-1")).toHaveTextContent(
      "What is the weather in Paris? Use the tool, then answer in one short sentence.",
    );

    const response = box("prompt-box-response-0");
    expect(within(response).getByText("assistant")).toBeInTheDocument();
    expect(within(response).getByTestId("genai-finish-reason")).toHaveTextContent("tool_call");
    const toolCall = within(response).getByTestId("genai-part-tool-call");
    expect(toolCall).toHaveTextContent("get_weather");
    expect(toolCall).toHaveTextContent("toolu_01JbpQe61yegPmLeUEf2eaLt");
    expect(toolCall).toHaveTextContent(/city:\s*Paris/);

    // The tool definitions the call offered, folded under the call's
    // own content, with their parameters.
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    expect(box("prompt-box-tool-0")).toHaveTextContent("get_weather");
    expect(box("prompt-box-tool-0")).toHaveTextContent("The current weather in a city.");
    expect(box("prompt-box-tool-0")).toHaveTextContent(/city\s*·\s*string/);
  });

  it("Pydantic AI: a tool's result inside the next call's messages", async () => {
    await renderContent(at(fixture("pydantic_ai").calls, 1));
    const result = within(box("prompt-box-message-3")).getByTestId("genai-part-tool-response");
    expect(result).toHaveTextContent("tool result · get_weather");
    expect(result).toHaveTextContent("Paris: sunny, 21 C");
    expect(box("prompt-box-response-0")).toHaveTextContent(
      "It's currently sunny in Paris with a temperature of 21°C.",
    );
  });

  it("Pydantic AI: a tool call's arguments and result", async () => {
    await renderContent(at(fixture("pydantic_ai").tools, 0));
    expect(box("prompt-box-tool-input")).toHaveTextContent(/city:\s*Paris/);
    expect(box("prompt-box-tool-output")).toHaveTextContent("Paris: sunny, 21 C");
    // A tool call has no messages and its stored response is {}.
    expect(screen.queryByText("Messages")).toBeNull();
    expect(screen.queryByText("Response")).toBeNull();
    expect(screen.queryByTestId("prompt-viewer-otel-genai-generic")).toBeNull();
  });

  it("Strands (older conventions): Bedrock-style text, toolUse and toolResult blocks", async () => {
    await renderContent(at(fixture("strands_legacy").calls, 1));
    expect(box("prompt-box-system")).toHaveTextContent("Answer weather questions with the get_weather tool.");
    expect(box("prompt-box-message-0")).toHaveTextContent("What is the weather in Paris?");
    const use = within(box("prompt-box-message-1")).getByTestId("genai-part-tool-call");
    expect(use).toHaveTextContent("get_weather");
    expect(use).toHaveTextContent("call_v9oBNPn0O7Jc3bGumEdegIPt");
    expect(use).toHaveTextContent(/city:\s*Paris/);
    const result = within(box("prompt-box-message-2")).getByTestId("genai-part-tool-response");
    expect(result).toHaveTextContent("tool result · success");
    expect(result).toHaveTextContent("Paris: sunny, 21 C");
    expect(within(box("prompt-box-message-2")).getByText("tool")).toBeInTheDocument();
    // The older choice event keeps its blocks under "message".
    expect(box("prompt-box-response-0")).toHaveTextContent(
      "The weather in Paris is sunny with a temperature of 21°C.",
    );
    expect(within(box("prompt-box-response-0")).getByTestId("genai-finish-reason")).toHaveTextContent("end_turn");
  });

  it("Strands (older conventions): a tool's result list renders its text", async () => {
    await renderContent(at(fixture("strands_legacy").tools, 0));
    expect(box("prompt-box-tool-input")).toHaveTextContent(/city:\s*Paris/);
    expect(box("prompt-box-tool-output")).toHaveTextContent("Paris: sunny, 21 C");
    expect(box("prompt-box-tool-output")).not.toHaveTextContent('"text"');
  });

  it("Strands (latest conventions): a tool_call_response part whose response is a block list", async () => {
    await renderContent(at(fixture("strands_latest").calls, 1));
    const result = within(box("prompt-box-message-2")).getByTestId("genai-part-tool-response");
    expect(result).toHaveTextContent("call_tP5ZxkHy2Mw32lWCe8OJe0NJ");
    expect(result).toHaveTextContent("Paris: sunny, 21 C");
  });

  it("OpenAI Agents: text parts kept as sent, the SDK's repr included, and no system section", async () => {
    await renderContent(at(fixture("openai_agents").calls, 0));
    expect(screen.queryByTestId("prompt-box-system")).toBeNull();
    // OpenAI Agents puts the SDK object's repr in a text part: shown as
    // that text, never parsed into a tool call it is not.
    const response = box("prompt-box-response-0");
    expect(response).toHaveTextContent("ResponseFunctionToolCall(arguments='{\"city\":\"Paris\"}'");
    expect(within(response).queryByTestId("genai-part-tool-call")).toBeNull();
  });

  it("Google ADK: a tool_call_response part whose response is an object, and tool parameters", async () => {
    await renderContent(at(fixture("google_adk").calls, 1));
    expect(screen.getByTestId("prompt-viewer-otel-genai")).toHaveTextContent("openai/gpt-4o-mini");
    const result = within(box("prompt-box-message-2")).getByTestId("genai-part-tool-response");
    expect(result).toHaveTextContent(/result:\s*Paris: sunny, 21 C/);
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    expect(box("prompt-box-tool-0")).toHaveTextContent(/city\s*·\s*string/);
  });

  it("Raw shows a message exactly as stored", async () => {
    await renderContent(at(fixture("pydantic_ai").calls, 0));
    fireEvent.click(screen.getByTestId("prompt-box-message-1-raw"));
    const raw = screen.getByTestId("prompt-box-message-1-raw-json");
    expect(raw).toHaveTextContent('"parts"');
    expect(raw).toHaveTextContent('"role"');
    // The other boxes stay in Pretty.
    expect(box("prompt-box-response-0")).toHaveAttribute("data-view", "pretty");
  });

  it("never renders through the Anthropic or OpenAI branches", async () => {
    await renderContent(at(fixture("pydantic_ai").calls, 0));
    // The provider branches' tool-use card is a different component.
    expect(screen.queryByTestId("content-block-tool-use")).toBeNull();
    expect(screen.queryByText("otel_genai")).toBeNull();
  });

  it("content with no messages, response or tool input falls back to a generic view of what is stored", async () => {
    await renderContent({
      event_id: "00000000-0000-4000-8000-0000000000ff",
      session_id: "00000000-0000-4000-9000-000000000001",
      provider: "otel_genai",
      model: "",
      system_prompt: null,
      messages: [],
      tools: null,
      response: {},
      input: { note: "a field this renderer does not know" },
      captured_at: "2026-11-05T00:00:00Z",
    });
    const generic = screen.getByTestId("prompt-viewer-otel-genai-generic");
    expect(generic).toHaveTextContent("shown as stored");
    expect(generic).toHaveTextContent("a field this renderer does not know");
    expect(screen.queryByText("Messages")).toBeNull();
  });

  it("an unknown part type, a non-object message and a message without parts render as stored", async () => {
    await renderContent({
      event_id: "00000000-0000-4000-8000-0000000000fe",
      session_id: "00000000-0000-4000-9000-000000000001",
      provider: "otel_genai",
      model: "claude-haiku-4-5",
      system_prompt: "Plain instructions, not JSON.",
      messages: [
        { role: "user", parts: [{ type: "video_frame", frame: 7 }] },
        "a bare string message",
        { role: "user", note: "no parts here" },
        { role: "assistant", parts: [{ type: "reasoning", content: "thinking it over" }] },
      ],
      tools: null,
      response: [],
      captured_at: "2026-11-05T00:00:00Z",
    });
    expect(box("prompt-box-system")).toHaveTextContent("Plain instructions, not JSON.");
    expect(box("prompt-box-message-0")).toHaveTextContent("video_frame");
    expect(box("prompt-box-message-1")).toHaveTextContent("a bare string message");
    expect(box("prompt-box-message-2")).toHaveTextContent("no parts here");
    expect(within(box("prompt-box-message-3")).getByTestId("genai-part-reasoning")).toHaveTextContent(
      "thinking it over",
    );
    expect(screen.queryByText("Response")).toBeNull();
  });

  it("a capture-off 404 still shows the disabled state", async () => {
    mockContent = null;
    render(<PromptViewer eventId="e-404" />);
    await waitFor(() =>
      expect(screen.getByText("Prompt capture is not enabled for this deployment.")).toBeInTheDocument(),
    );
  });
});
