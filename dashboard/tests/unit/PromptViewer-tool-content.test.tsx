import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Prompts tab's view of a tool call's captured content: the
// arguments and result that event_content keeps in its tool_input /
// tool_output columns. Every fixture is a body the live pipeline served
// (fixtures/tool-content.json says which), so each test renders what is
// really stored for that source: the sensor's tool_call, an
// mcp_tool_call, Claude Code's tool_call over OpenTelemetry, and the
// Claude Code plugin's hook tool_call, whose tool_use / tool_result
// blocks render as before.

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/tool-content.json"), "utf8"),
) as Record<string, EventContent>;

function fixture(name: string): EventContent {
  const c = FIXTURES[name];
  if (!c) throw new Error(`no fixture ${name}`);
  return c;
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

describe("PromptViewer — a tool call's arguments and result", () => {
  it("the sensor's tool_call shows its arguments as fields, and no {} response", async () => {
    await renderContent(fixture("sensor_tool_call"));
    expect(screen.getByRole("button", { name: /Arguments/ })).toBeInTheDocument();
    const args = screen.getByTestId("prompt-box-tool-input");
    expect(within(args).getByTestId("tool-value-fields")).toBeInTheDocument();
    const labels = within(args).getAllByTestId("kv-label").map((el) => el.textContent);
    expect(labels).toEqual(["query:", "type:"]);
    expect(args).toHaveTextContent("eiffel tower completion year");
    expect(args).toHaveTextContent("search");
    // The response column's {} placeholder is not a response, and the
    // sensor stores no result for an LLM tool call.
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Response/ })).toBeNull();
    expect(screen.queryByTestId("prompt-box-tool-output")).toBeNull();
    // The header keeps the stored provider and model.
    expect(screen.getByText("llm")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
  });

  it("an mcp_tool_call shows its arguments and its result", async () => {
    await renderContent(fixture("mcp_tool_call"));
    const args = screen.getByTestId("prompt-box-tool-input");
    expect(args).toHaveTextContent("/etc/hosts");
    expect(screen.getByRole("button", { name: /Result/ })).toBeInTheDocument();
    const result = screen.getByTestId("prompt-box-tool-output");
    expect(within(result).getByTestId("tool-value-fields")).toBeInTheDocument();
    expect(result).toHaveTextContent("127.0.0.1 localhost");
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
    // The header names the MCP server the content came from.
    expect(screen.getByText("filesystem")).toBeInTheDocument();
  });

  it("a call made with no arguments says so instead of showing {}", async () => {
    await renderContent(fixture("mcp_tool_call_no_arguments"));
    const args = screen.getByTestId("prompt-box-tool-input");
    expect(args).toHaveTextContent("(empty)");
    expect(args).not.toHaveTextContent("{}");
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
  });

  it("Claude Code's tool_call over OpenTelemetry shows its input", async () => {
    await renderContent(fixture("claude_code_otlp_tool_call"));
    const args = screen.getByTestId("prompt-box-tool-input");
    expect(args).toHaveTextContent("echo recorded");
    expect(args).toHaveTextContent("Echo the word recorded");
    expect(screen.queryByTestId("prompt-box-response")).toBeNull();
    expect(screen.queryByTestId("prompt-box-tool-output")).toBeNull();
  });

  it("Raw shows the arguments and the result exactly as stored", async () => {
    const content = fixture("mcp_tool_call");
    await renderContent(content);
    fireEvent.click(screen.getByTestId("prompt-box-tool-output-raw"));
    expect(screen.getByTestId("prompt-box-tool-output")).toHaveAttribute("data-view", "raw");
    const raw = screen.getByTestId("prompt-box-tool-output-raw-json");
    expect(raw).toHaveTextContent('"type": "text"');
    expect(raw).toHaveTextContent('"text": "127.0.0.1 localhost"');
    // The arguments box keeps its own Pretty view.
    expect(screen.getByTestId("prompt-box-tool-input")).toHaveAttribute("data-view", "pretty");
  });

  it("arguments that are text show as written", async () => {
    await renderContent({ ...fixture("claude_code_otlp_tool_call"), tool_input: "ls -la" });
    const args = screen.getByTestId("prompt-box-tool-input");
    expect(args).toHaveTextContent("ls -la");
    expect(within(args).queryByTestId("pretty-json")).toBeNull();
  });

  it("arguments that are text holding JSON are pretty-printed", async () => {
    await renderContent({ ...fixture("claude_code_otlp_tool_call"), tool_input: '{"command":"ls"}' });
    const pretty = within(screen.getByTestId("prompt-box-tool-input")).getByTestId("pretty-json");
    expect(pretty).toHaveTextContent('"command": "ls"');
  });

  it("a result that is a list shows as JSON", async () => {
    await renderContent({
      ...fixture("mcp_tool_call"),
      tool_output: [{ role: "user", content: { type: "text", text: "Review the diff" } }],
    });
    const result = screen.getByTestId("prompt-box-tool-output");
    expect(within(result).getByTestId("pretty-json")).toHaveTextContent("Review the diff");
  });

  it("the plugin's hook tool_call keeps its tool_use and tool_result view", async () => {
    await renderContent(fixture("claude_code_hook_tool_call"));
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveTextContent("ToolSearch");
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveTextContent("select:Monitor");
    expect(within(screen.getByTestId("prompt-box-response")).getByTestId("tool-result-parsed")).toHaveTextContent(
      "Monitor",
    );
    expect(screen.queryByTestId("prompt-box-tool-input")).toBeNull();
    expect(screen.queryByTestId("prompt-box-tool-output")).toBeNull();
  });

  it("an empty response on content without tool columns still shows (only the tool placeholder hides)", async () => {
    const { tool_input: _input, ...rest } = fixture("sensor_tool_call");
    void _input;
    await renderContent(rest as EventContent);
    expect(screen.getByTestId("prompt-box-response")).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-box-tool-input")).toBeNull();
  });

  it("capture off keeps the disabled state and shows no tool content", async () => {
    mockContent = null;
    render(<PromptViewer eventId="00000000-0000-4000-8000-000000000001" />);
    await waitFor(() =>
      expect(screen.getByText("Prompt capture is not enabled for this deployment.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("prompt-box-tool-input")).toBeNull();
    expect(screen.queryByTestId("prompt-box-tool-output")).toBeNull();
  });
});
