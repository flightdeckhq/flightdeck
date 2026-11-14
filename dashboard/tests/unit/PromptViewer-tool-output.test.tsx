import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Pretty view of a Claude Code plugin tool_call's result: the
// tool_result block's content is the tool's response as stored, its
// JSON text within 2000 characters. The plugin cuts inside the
// structure and marks the cut (a cut string ends with "…", a cut list
// with a "…" element, the holding object names it in `truncated`);
// earlier plugin versions stored the JSON text cut mid-way. Raw always
// shows the stored value.

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

const MARK = "…";
const STDOUT = Array.from({ length: 80 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`).join("\n");

function pluginToolCall(result: string, input: Record<string, unknown> = { command: "go test ./..." }): EventContent {
  return {
    event_id: "e-tool-output",
    session_id: "s-tool-output",
    provider: "anthropic",
    model: "claude-opus-5-5",
    system_prompt: null,
    messages: [],
    tools: [{ type: "tool_use", name: "Bash", input }],
    response: [{ type: "tool_result", content: result }],
    captured_at: "2026-11-14T00:00:00Z",
  } as EventContent;
}

async function renderResult(result: string, input?: Record<string, unknown>): Promise<HTMLElement> {
  mockContent = pluginToolCall(result, input);
  render(<PromptViewer eventId="e-tool-output" />);
  return screen.findByTestId("prompt-box-response");
}

/** The JSON the plugin stores now for a Bash result whose stdout was cut. */
function cutBash(fields: Record<string, unknown>, truncated: string[]): string {
  return JSON.stringify({ ...fields, truncated });
}

describe("a structured tool result in Pretty", () => {
  it("shows stdout and stderr as terminal text with their line breaks, the flags compactly", async () => {
    const box = await renderResult(
      JSON.stringify({ stdout: "line one\nline two", stderr: "warning: slow", interrupted: false, isImage: false }),
    );
    const result = within(box).getByTestId("tool-result-parsed");
    const stdout = within(result).getByTestId("tool-result-stdout").querySelector("pre");
    expect(stdout?.textContent).toBe("line one\nline two");
    const stderr = within(result).getByTestId("tool-result-stderr");
    expect(stderr).toHaveTextContent("warning: slow");
    // stderr is set apart from stdout.
    expect(stderr.querySelector("pre")?.getAttribute("style")).toContain("var(--danger)");
    expect(stdout?.getAttribute("style")).not.toContain("var(--danger)");
    const scalars = within(result).getByTestId("tool-result-scalars");
    expect(within(scalars).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual([
      "interrupted:",
      "isImage:",
    ]);
    expect(within(result).queryByTestId("tool-result-truncated")).toBeNull();
  });

  it("names the cut fields and how much each kept, and does not show the list as a field", async () => {
    const stdout = STDOUT.slice(0, 1500) + MARK;
    const box = await renderResult(
      cutBash({ stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }, ["stdout"]),
    );
    const result = within(box).getByTestId("tool-result-parsed");
    const pre = within(result).getByTestId("tool-result-stdout").querySelector("pre");
    expect(pre?.textContent).toBe(stdout);
    expect(pre?.textContent?.split("\n").length).toBeGreaterThan(20);
    expect(within(result).getByTestId("tool-result-truncated")).toHaveTextContent(
      "… (truncated) stdout cut at 1,500 characters",
    );
    const labels = within(result).getAllByTestId("kv-label").map((el) => el.textContent);
    expect(labels).not.toContain("truncated:");
    expect(labels).toContain("stdout");
    // An empty stderr is a compact field, not a block.
    expect(within(result).queryByTestId("tool-result-stderr")).toBeNull();
    expect(within(result).getByTestId("tool-result-scalars")).toHaveTextContent("stderr:(empty)");
  });

  it("names every cut field, in the order listed", async () => {
    const box = await renderResult(
      cutBash({ stdout: `${"o".repeat(900)}${MARK}`, stderr: `${"e".repeat(900)}${MARK}`, interrupted: false }, [
        "stdout",
        "stderr",
      ]),
    );
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent(
      "stdout cut at 900 characters; stderr cut at 900 characters",
    );
  });

  it("shows a nested object as fields of its own, with its own cut note (Read)", async () => {
    const content = `1\timport x\n2\timport y\n3\t${MARK}`;
    const box = await renderResult(
      JSON.stringify({
        type: "text",
        file: { filePath: "/repo/app.ts", content, numLines: 400, truncated: ["content"] },
      }),
    );
    const nested = within(box).getByTestId("tool-result-nested");
    expect(nested).toHaveAttribute("data-field", "file");
    expect(within(nested).getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(content);
    expect(within(nested).getByTestId("tool-result-truncated")).toHaveTextContent("content cut at");
    expect(within(nested).getByTestId("tool-result-scalars")).toHaveTextContent("filePath:/repo/app.ts");
    // The top level lists nothing.
    expect(within(box).getAllByTestId("tool-result-truncated")).toHaveLength(1);
  });

  it("names a list cut after its leading entries, and keeps a tool's own truncated flag as a field (Glob)", async () => {
    const cutList = await renderResult(
      JSON.stringify({ filenames: ["/a.ts", "/b.ts", MARK], durationMs: 3, numFiles: 90, truncated: ["filenames"] }),
    );
    expect(within(cutList).getByTestId("tool-result-truncated")).toHaveTextContent("filenames cut after 2 entries");
    expect(within(cutList).getByTestId("pretty-json")).toHaveTextContent("/b.ts");
  });

  it("shows Glob's own truncated flag as a field when nothing was cut", async () => {
    const box = await renderResult(JSON.stringify({ filenames: [], numFiles: 0, truncated: true }));
    expect(within(box).getByTestId("tool-result-scalars")).toHaveTextContent("truncated:true");
    expect(within(box).queryByTestId("tool-result-truncated")).toBeNull();
  });

  it("shows a list of text blocks as their texts, each with its cut note (an Agent's report)", async () => {
    const report = `Found it.\nThe fixture moved.${MARK}`;
    const box = await renderResult(
      JSON.stringify({ status: "completed", content: [{ type: "text", text: report, truncated: ["text"] }] }),
    );
    const pres = Array.from(box.querySelectorAll("pre")).map((p) => p.textContent);
    expect(pres).toContain(report);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("text cut at");
    expect(within(box).queryByTestId("pretty-json")).toBeNull();
  });

  it("shows a response kept as the head of its JSON text as that text, with its note", async () => {
    const keys = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`key${i}`, i]));
    const head = `${JSON.stringify(keys).slice(0, 1900)}${MARK}`;
    const box = await renderResult(JSON.stringify({ text: head, truncated: ["text"] }));
    expect(within(box).getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(head);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("text cut at");
  });

  it("shows a top-level list of text blocks as text, and any other list as JSON", async () => {
    const box = await renderResult(JSON.stringify([{ type: "text", text: `hello\nworld${MARK}`, truncated: ["text"] }]));
    expect(Array.from(box.querySelectorAll("pre")).map((p) => p.textContent)).toContain(`hello\nworld${MARK}`);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("text cut at 11 characters");
  });

  it("shows any other list as JSON", async () => {
    const box = await renderResult(JSON.stringify([1, 2, 3]));
    expect(within(box).getByTestId("pretty-json")).toHaveTextContent("1");
  });
});

describe("a tool result an earlier plugin version stored cut mid-way", () => {
  /** What the old plugin stored: the JSON text's first 2000 characters, then the mark. */
  const oldCut = (response: unknown) => JSON.stringify(response).slice(0, 2000) + MARK;

  it("reads the fields up to the cut and says where the stored text ends", async () => {
    const box = await renderResult(oldCut({ stdout: STDOUT, stderr: "late", interrupted: false, isImage: false }));
    const result = within(box).getByTestId("tool-result-recovered");
    const pre = within(result).getByTestId("tool-result-stdout").querySelector("pre");
    expect(pre?.textContent?.startsWith("=== RUN   TestCase0\n--- PASS: TestCase0 (0.00s)\n")).toBe(true);
    expect(pre?.textContent?.endsWith(MARK)).toBe(true);
    expect(pre?.textContent).not.toContain("\\n");
    expect(within(result).queryByTestId("tool-result-stderr")).toBeNull();
    expect(within(result).getByTestId("tool-result-truncated")).toHaveTextContent(
      "… (truncated) the stored output ends at 2,000 characters, inside stdout; nothing after it was stored",
    );
    expect(within(box).queryByTestId("tool-result-raw")).toBeNull();
  });

  it("names a nested field the text ended in (a Read)", async () => {
    const box = await renderResult(
      oldCut({ type: "text", file: { filePath: "/repo/app.ts", content: "x\n".repeat(3000), numLines: 3000 } }),
    );
    expect(within(box).getByTestId("tool-result-recovered")).toBeInTheDocument();
    expect(within(box).getByTestId("tool-result-nested")).toHaveTextContent("/repo/app.ts");
    expect(within(box).getAllByTestId("tool-result-truncated").at(-1)).toHaveTextContent("inside file.content");
  });

  it("says when the text ended between fields", async () => {
    const box = await renderResult(`{"stdout":"done","interrupted":false${MARK}`);
    expect(within(box).getByTestId("tool-result-recovered")).toBeInTheDocument();
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent(
      "ends at 36 characters, after the last field shown",
    );
  });

  it("falls back to the stored text when it does not read as cut JSON", async () => {
    for (const stored of [`plain text output${MARK}`, `{not json at all${MARK}`, `{"stdout${MARK}`]) {
      mockContent = pluginToolCall(stored);
      const view = render(<PromptViewer eventId={`e-${stored.length}`} />);
      const box = await view.findByTestId("prompt-box-response");
      expect(within(box).getByTestId("tool-result-raw"), stored).toHaveTextContent(stored);
      expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("(truncated)");
      expect(within(box).queryByTestId("tool-result-recovered")).toBeNull();
      view.unmount();
    }
  });

  it("shows plain text under the bound as written, with no note", async () => {
    const box = await renderResult("total 0\ndrwxr-xr-x  2 u u 40 .");
    expect(within(box).getByTestId("tool-result-raw")).toHaveTextContent("total 0");
    expect(within(box).queryByTestId("tool-result-truncated")).toBeNull();
  });
});

describe("Raw of a tool result", () => {
  it("shows the stored block, its content as the stored string, for either form", async () => {
    const stored = cutBash({ stdout: `ok${MARK}`, stderr: "" }, ["stdout"]);
    const box = await renderResult(stored);
    fireEvent.click(screen.getByTestId("prompt-box-response-raw"));
    expect(box).toHaveAttribute("data-view", "raw");
    const raw = screen.getByTestId("prompt-box-response-raw-json");
    expect(raw.textContent).toContain('"type": "tool_result"');
    expect(raw.textContent).toContain(`"content": ${JSON.stringify(stored)}`);
    expect(within(box).queryByTestId("tool-result-parsed")).toBeNull();
  });
});

describe("a tool input the plugin cut", () => {
  it("shows how many characters a listed field kept, and not the list", async () => {
    const command = `${"git log --oneline | ".repeat(10)}`.slice(0, 200) + MARK;
    await renderResult("ok", { command, truncated: ["command"] });
    const tool = screen.getByTestId("prompt-box-tool-0");
    const input = within(tool).getByTestId("tool-use-input");
    expect(input).toHaveTextContent(command);
    expect(within(input).getByTestId("cut-note")).toHaveTextContent("cut at 200 characters");
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["command"]);
  });

  it("marks only the listed fields", async () => {
    await renderResult("ok", {
      file_path: "/repo/a.ts",
      pattern: `${"*".repeat(200)}${MARK}`,
      truncated: ["pattern"],
    });
    const input = within(screen.getByTestId("prompt-box-tool-0")).getByTestId("tool-use-input");
    expect(within(input).getAllByTestId("cut-note")).toHaveLength(1);
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["file_path:", "pattern"]);
  });

  it("renders an input with no list as before", async () => {
    await renderResult("ok", { command: "ls -la", truncated: true });
    const input = within(screen.getByTestId("prompt-box-tool-0")).getByTestId("tool-use-input");
    expect(within(input).queryByTestId("cut-note")).toBeNull();
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["command:", "truncated:"]);
  });
});
