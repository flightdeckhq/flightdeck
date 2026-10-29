import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";

const mockContent = {
  event_id: "e1",
  session_id: "s1",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  system_prompt: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ],
  tools: [{ name: "web_search" }, { name: "calculator" }],
  response: { id: "resp-1", content: [{ type: "text", text: "Hi there!" }] },
  captured_at: "2026-04-07T10:01:00Z",
};

let mockFetchResult: typeof mockContent | null = mockContent;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockFetchResult)),
}));

beforeEach(() => {
  mockFetchResult = mockContent;
  vi.clearAllMocks();
});

describe("PromptViewer", () => {
  it("a failed content request ends the spinner instead of spinning forever", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchEventContent).mockImplementationOnce(() =>
      Promise.reject(new Error("network down")),
    );
    const { container } = render(<PromptViewer eventId="e-fail" />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeNull());
    // Failure is not reported as "capture not enabled".
    expect(screen.queryByText(/Prompt capture is not enabled/)).toBeNull();
  });

  it("renders nothing when eventId is null", () => {
    const { container } = render(<PromptViewer eventId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows disabled message when content fetch returns null (404)", async () => {
    mockFetchResult = null;
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Prompt capture is not enabled for this deployment."
        )
      ).toBeInTheDocument();
    });
  });

  it("shows provider and model from content", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("anthropic")).toBeInTheDocument();
      expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
    });
  });

  it("renders system prompt section when system_prompt is present", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("System")).toBeInTheDocument();
    });
  });

  it("renders messages section with correct count", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // Count "(2)" appears for both Messages and Tools — just verify Messages header exists
    const counts = screen.getAllByText("(2)");
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  it("renders tool names in tools section", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Tools")).toBeInTheDocument();
    });
    // Tools are expanded by default — tool names visible
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("calculator")).toBeInTheDocument();
  });

  it("renders response section", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Response")).toBeInTheDocument();
    });
  });

  it("does not render system section when system_prompt is null", async () => {
    mockFetchResult = { ...mockContent, system_prompt: null };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // System section should not be present — only check for the section header button
    const buttons = screen.getAllByRole("button");
    const systemButton = buttons.find((b) => b.textContent?.includes("System"));
    expect(systemButton).toBeUndefined();
  });

  it("does not render tools section when tools is null", async () => {
    mockFetchResult = { ...mockContent, tools: null };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    const buttons = screen.getAllByRole("button");
    const toolsButton = buttons.find((b) => b.textContent?.includes("Tools"));
    expect(toolsButton).toBeUndefined();
  });

  it("messages are visible by default", async () => {
    render(<PromptViewer eventId="e1" />);
    await waitFor(() => {
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });
    // All messages expanded by default — content visible without clicking
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  // This test must be last -- it overrides the mock with a never-resolving promise
  it("shows a spinner while loading", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchEventContent).mockReturnValue(new Promise(() => {}));
    const { container } = render(<PromptViewer eventId="e1" />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });
});

describe("PromptViewer tool_call content", () => {
  beforeEach(async () => {
    mockFetchResult = mockContent;
    vi.clearAllMocks();
    // Re-install the default fetch mock -- the final test in the first
    // describe block overrides it with a never-resolving promise and
    // vi.clearAllMocks() does not restore the original implementation.
    const api = await import("@/lib/api");
    vi.mocked(api.fetchEventContent).mockImplementation(() =>
      Promise.resolve(mockFetchResult),
    );
  });

  it("parses and renders structured fields for tool_result with JSON content", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }],
      response: [
        {
          type: "tool_result",
          content: JSON.stringify({
            stdout: "hello\nworld",
            stderr: "",
            interrupted: false,
            isImage: false,
          }),
        },
      ],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Response")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tool-result-parsed")).toBeInTheDocument();
    // Multi-line stdout renders in a pre block (contains "hello\nworld")
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    // Empty stderr renders as "(empty)" rather than being hidden
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    // Booleans render as plain text; both interrupted and isImage -> "false"
    expect(screen.getAllByText("false").length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to raw string when tool_result content is plain text", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }],
      response: [{ type: "tool_result", content: "this is just text" }],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Response")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tool-result-raw")).toBeInTheDocument();
    expect(screen.getByText("this is just text")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-result-parsed")).not.toBeInTheDocument();
  });

  it("does not crash when tool_result content is malformed JSON", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Bash", input: {} }],
      response: [{ type: "tool_result", content: '{"stdout":"broken' }],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Response")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tool-result-raw")).toBeInTheDocument();
    expect(screen.getByText('{"stdout":"broken')).toBeInTheDocument();
  });

  it("shows truncated indicator when tool_result content ends with ellipsis", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Bash", input: {} }],
      response: [
        { type: "tool_result", content: '{"stdout":"some output\u2026' },
      ],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Response")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tool-result-truncated")).toBeInTheDocument();
  });

  it("renders tool_use input as key/value list in Tools section", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [
        { type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } },
      ],
      response: [],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Tools")).toBeInTheDocument(),
    );
    expect(screen.getByText("Glob")).toBeInTheDocument();
    expect(screen.getByTestId("tool-use-input")).toBeInTheDocument();
    expect(screen.getByText("**/*.ts")).toBeInTheDocument();
    expect(screen.getByText("pattern:")).toBeInTheDocument();
  });

  it("renders only the name pill when tool_use has no input", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Glob" }],
      response: [],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Tools")).toBeInTheDocument(),
    );
    expect(screen.getByText("Glob")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-use-input")).not.toBeInTheDocument();
  });

  it("Pretty and Raw tabs render different DOM for tool_result response", async () => {
    mockFetchResult = {
      ...mockContent,
      tools: [{ type: "tool_use", name: "Bash", input: {} }],
      response: [
        {
          type: "tool_result",
          content: JSON.stringify({
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
          }),
        },
      ],
    };
    render(<PromptViewer eventId="e1" />);
    await waitFor(() =>
      expect(screen.getByText("Response")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tool-result-parsed")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prompt-box-response-raw"));
    expect(screen.queryByTestId("tool-result-parsed")).not.toBeInTheDocument();
    expect(screen.getByTestId("prompt-box-response-raw-json")).toBeInTheDocument();
  });
});

describe("PromptViewer Pretty / Raw per box", () => {
  const toolResultJson = JSON.stringify({ stdout: "3 files", exitCode: 0 });
  const claudeCodeContent = {
    ...mockContent,
    system_prompt: "You are Claude Code.",
    messages: [
      { role: "user", content: '{"task":"list files","depth":2}' },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Listing the files." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls", description: "List" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: toolResultJson }],
      },
    ],
    tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    response: { id: "r1", content: [{ type: "text", text: "Done." }] },
  };

  it("every box has its own Pretty / Raw toggle, defaulting to Pretty", async () => {
    mockFetchResult = claudeCodeContent;
    render(<PromptViewer eventId="e-boxes" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-response")).toBeInTheDocument());
    for (const id of ["system", "message-0", "message-1", "message-2", "tool-0", "response"]) {
      const box = screen.getByTestId(`prompt-box-${id}`);
      expect(box).toHaveAttribute("data-view", "pretty");
      expect(screen.getByTestId(`prompt-box-${id}-pretty`)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId(`prompt-box-${id}-raw`)).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("Pretty renders content blocks instead of a JSON dump", async () => {
    mockFetchResult = claudeCodeContent;
    render(<PromptViewer eventId="e-blocks" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-message-1")).toBeInTheDocument());
    const assistant = screen.getByTestId("prompt-box-message-1");
    expect(assistant).toHaveTextContent("Listing the files.");
    expect(assistant.querySelector('[data-testid="content-block-tool-use"]')).not.toBeNull();
    expect(assistant).toHaveTextContent("command:");
    expect(assistant).not.toHaveTextContent('"type"');
    const toolResult = screen.getByTestId("prompt-box-message-2");
    expect(toolResult.querySelector('[data-testid="tool-result-parsed"]')).not.toBeNull();
    expect(toolResult).toHaveTextContent("3 files");
  });

  it("a string that holds JSON is pretty-printed in Pretty and kept as stored in Raw", async () => {
    mockFetchResult = claudeCodeContent;
    render(<PromptViewer eventId="e-json-string" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-message-0")).toBeInTheDocument());
    const box = screen.getByTestId("prompt-box-message-0");
    const pretty = box.querySelector('[data-testid="pretty-json"] pre');
    expect(pretty).not.toBeNull();
    expect(pretty?.textContent).toContain('"task": "list files"');
    // Indented over several lines, not the one-line stored string.
    expect(pretty?.textContent?.split("\n").length).toBeGreaterThan(3);
    fireEvent.click(screen.getByTestId("prompt-box-message-0-raw"));
    const raw = screen.getByTestId("prompt-box-message-0-raw-json");
    // Raw shows the stored message: content is still the JSON string.
    expect(raw.textContent).toContain('"content": "{\\"task\\":\\"list files\\",\\"depth\\":2}"');
    expect(raw.textContent).toContain('"role": "user"');
  });

  it("toggling one box leaves the others in Pretty", async () => {
    mockFetchResult = claudeCodeContent;
    render(<PromptViewer eventId="e-independent" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-tool-0")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("prompt-box-tool-0-raw"));
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveAttribute("data-view", "raw");
    expect(screen.getByTestId("prompt-box-tool-0-raw-json").textContent).toContain('"input_schema"');
    expect(screen.getByTestId("prompt-box-system")).toHaveAttribute("data-view", "pretty");
    expect(screen.getByTestId("prompt-box-response")).toHaveAttribute("data-view", "pretty");
    fireEvent.click(screen.getByTestId("prompt-box-tool-0-pretty"));
    expect(screen.getByTestId("prompt-box-tool-0")).toHaveAttribute("data-view", "pretty");
  });

  it("an OpenAI tool call's JSON arguments render as fields", async () => {
    mockFetchResult = {
      ...mockContent,
      provider: "openai",
      model: "gpt-5.5",
      system_prompt: null,
      messages: [{ role: "user", content: "Weather?" }],
      tools: null,
      response: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris","unit":"c"}' } }],
            },
          },
        ],
      },
    } as unknown as typeof mockContent;
    render(<PromptViewer eventId="e-openai" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-response")).toBeInTheDocument());
    const response = screen.getByTestId("prompt-box-response");
    expect(response).toHaveTextContent("get_weather");
    expect(response).toHaveTextContent("city:");
    expect(response).toHaveTextContent("Paris");
  });

  it("a new event starts every box in Pretty again", async () => {
    mockFetchResult = claudeCodeContent;
    const { rerender } = render(<PromptViewer eventId="e-first" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-system")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("prompt-box-system-raw"));
    expect(screen.getByTestId("prompt-box-system")).toHaveAttribute("data-view", "raw");
    rerender(<PromptViewer eventId="e-second" />);
    await waitFor(() => expect(screen.getByTestId("prompt-box-system")).toHaveAttribute("data-view", "pretty"));
  });
});

describe("parseJsonContainer", () => {
  it("parses objects and arrays only", async () => {
    const { parseJsonContainer } = await import("@/components/session/PromptViewer");
    expect(parseJsonContainer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContainer("  [1, 2]\n")).toEqual([1, 2]);
    expect(parseJsonContainer("42")).toBeUndefined();
    expect(parseJsonContainer('"text"')).toBeUndefined();
    expect(parseJsonContainer("{not json")).toBeUndefined();
    expect(parseJsonContainer("plain text")).toBeUndefined();
    expect(parseJsonContainer("null")).toBeUndefined();
  });
});
