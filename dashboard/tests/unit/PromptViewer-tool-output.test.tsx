import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent } from "@/lib/types";

// The Pretty view of a Claude Code plugin tool_call's result: the
// tool_result block's content is the tool's response as stored, its
// JSON text within 2000 characters. The plugin cuts inside the
// structure, ends a cut string with "…", and names each cut value
// beside the content, in the block's `truncated`, as a JSON Pointer
// (nothing is added inside the response). Earlier plugin versions
// stored the JSON text cut mid-way, with no list. Raw always shows the
// stored block.

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

interface Cuts {
  /** The tool_result block's list of cut values. */
  output?: string[];
  /** The tool_use block's list of cut input fields. */
  input?: string[];
}

function pluginToolCall(
  result: string,
  input: Record<string, unknown> = { command: "go test ./..." },
  cuts: Cuts = {},
): EventContent {
  return {
    event_id: "e-tool-output",
    session_id: "s-tool-output",
    provider: "anthropic",
    model: "claude-opus-5-5",
    system_prompt: null,
    messages: [],
    tools: [{ type: "tool_use", name: "Bash", input, ...(cuts.input ? { truncated: cuts.input } : {}) }],
    response: [{ type: "tool_result", content: result, ...(cuts.output ? { truncated: cuts.output } : {}) }],
    captured_at: "2026-11-14T00:00:00Z",
  } as EventContent;
}

/** The client a plugin row carries (the event's ``client_type``). */
const PLUGIN_CLIENT = "claude_code";

async function renderResult(
  result: string,
  input?: Record<string, unknown>,
  cuts?: Cuts,
  clientType: string | null = PLUGIN_CLIENT,
): Promise<HTMLElement> {
  mockContent = pluginToolCall(result, input, cuts);
  render(<PromptViewer eventId="e-tool-output" clientType={clientType} />);
  return screen.findByTestId("prompt-box-response");
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

  it("names the cut fields the block lists and how much each kept", async () => {
    const stdout = STDOUT.slice(0, 1500) + MARK;
    const box = await renderResult(
      JSON.stringify({ stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }),
      undefined,
      { output: ["/stdout"] },
    );
    const result = within(box).getByTestId("tool-result-parsed");
    const pre = within(result).getByTestId("tool-result-stdout").querySelector("pre");
    expect(pre?.textContent).toBe(stdout);
    expect(pre?.textContent?.split("\n").length).toBeGreaterThan(20);
    expect(within(result).getByTestId("tool-result-truncated")).toHaveTextContent(
      "… (truncated) stdout cut at 1,500 characters",
    );
    const labels = within(result).getAllByTestId("kv-label").map((el) => el.textContent);
    expect(labels).toEqual(["stdout", "stderr:", "interrupted:", "isImage:", "noOutputExpected:"]);
    // An empty stderr is a compact field, not a block.
    expect(within(result).queryByTestId("tool-result-stderr")).toBeNull();
    expect(within(result).getByTestId("tool-result-scalars")).toHaveTextContent("stderr:(empty)");
  });

  it("names every cut field, in the order listed", async () => {
    const box = await renderResult(
      JSON.stringify({ stdout: `${"o".repeat(900)}${MARK}`, stderr: `${"e".repeat(900)}${MARK}`, interrupted: false }),
      undefined,
      { output: ["/stdout", "/stderr"] },
    );
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent(
      "stdout cut at 900 characters; stderr cut at 900 characters",
    );
  });

  it("shows a nested object as fields of its own, and names a cut inside it by its path (Read)", async () => {
    const content = `1\timport x\n2\timport y\n3\t${MARK}`;
    const box = await renderResult(
      JSON.stringify({ type: "text", file: { filePath: "/repo/app.ts", content, numLines: 400 } }),
      undefined,
      { output: ["/file/content"] },
    );
    const nested = within(box).getByTestId("tool-result-nested");
    expect(nested).toHaveAttribute("data-field", "file");
    expect(within(nested).getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(content);
    expect(within(nested).getByTestId("tool-result-scalars")).toHaveTextContent("filePath:/repo/app.ts");
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("file.content cut at 24 characters");
  });

  it("names a list cut after its leading entries, and shows Glob's own truncated flag untouched (Glob)", async () => {
    const box = await renderResult(
      JSON.stringify({ filenames: ["/a.ts", "/b.ts"], durationMs: 3, numFiles: 90, truncated: false }),
      undefined,
      { output: ["/filenames"] },
    );
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("filenames cut after 2 entries");
    expect(within(box).getByTestId("pretty-json")).toHaveTextContent("/b.ts");
    expect(within(box).getByTestId("tool-result-scalars")).toHaveTextContent("truncated:false");
  });

  it("shows Glob's own truncated flag as a field when nothing was cut", async () => {
    const box = await renderResult(JSON.stringify({ filenames: [], numFiles: 0, truncated: true }));
    expect(within(box).getByTestId("tool-result-scalars")).toHaveTextContent("truncated:true");
    expect(within(box).queryByTestId("tool-result-truncated")).toBeNull();
  });

  it("shows a list of text blocks as their texts (an Agent's report)", async () => {
    const report = `Found it.\nThe fixture moved.${MARK}`;
    const box = await renderResult(
      JSON.stringify({ status: "completed", content: [{ type: "text", text: report }] }),
      undefined,
      { output: ["/content/0/text"] },
    );
    const pres = Array.from(box.querySelectorAll("pre")).map((p) => p.textContent);
    expect(pres).toContain(report);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("content[0].text cut at 28 characters");
    expect(within(box).queryByTestId("pretty-json")).toBeNull();
  });

  it("reads a response kept as the head of its JSON text (named whole) up to the cut", async () => {
    const keys = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`key${i}`, i]));
    const head = `${JSON.stringify(keys).slice(0, 1999)}${MARK}`;
    const box = await renderResult(head, undefined, { output: [""] });
    const result = within(box).getByTestId("tool-result-recovered");
    expect(within(result).getByTestId("tool-result-scalars")).toHaveTextContent("key0:0");
    expect(within(result).getByTestId("tool-result-truncated")).toHaveTextContent(
      "the stored output ends at 1,999 characters",
    );
  });

  it("shows a plain-text output cut at the bound as written, with how much it kept", async () => {
    const text = `${"line of output\n".repeat(140)}`.slice(0, 1999) + MARK;
    const box = await renderResult(text, undefined, { output: [""] });
    expect(within(box).getByTestId("tool-result-raw").querySelector("pre")?.textContent).toBe(text);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("… (truncated) cut at 1,999 characters");
  });

  it("shows a top-level list of text blocks as text, and any other list as JSON", async () => {
    const box = await renderResult(JSON.stringify([{ type: "text", text: `hello\nworld${MARK}` }]), undefined, {
      output: ["/0/text"],
    });
    expect(Array.from(box.querySelectorAll("pre")).map((p) => p.textContent)).toContain(`hello\nworld${MARK}`);
    expect(within(box).getByTestId("tool-result-truncated")).toHaveTextContent("[0].text cut at 11 characters");
  });

  it("shows any other list as JSON", async () => {
    const box = await renderResult(JSON.stringify([1, 2, 3]));
    expect(within(box).getByTestId("pretty-json")).toHaveTextContent("1");
  });
});

describe("text fields of a structured result", () => {
  it("pretty-prints a field whose text holds JSON, and keeps stdout holding JSON as terminal text", async () => {
    const json = '{"name":"flightdeck","version":"0.8.0","scripts":{"test":"vitest"}}';
    const box = await renderResult(
      JSON.stringify({ type: "text", file: { filePath: "/repo/package.json", content: json }, stdout: json }),
    );
    const field = within(box).getByTestId("tool-result-json-text");
    expect(field).toHaveAttribute("data-field", "content");
    const pretty = within(field).getByTestId("pretty-json");
    expect(pretty).toHaveTextContent('"version": "0.8.0"');
    // Indented over several lines, syntax-coloured, as the viewer shows JSON text.
    expect(pretty.querySelector("pre")?.textContent?.split("\n").length).toBeGreaterThan(3);
    expect(pretty.querySelector("pre span")).not.toBeNull();
    expect(within(box).getByTestId("tool-result-stdout").querySelector("pre")?.textContent).toBe(json);
  });

  it("shows multi-line plain text as terminal text", async () => {
    const box = await renderResult(JSON.stringify({ result: "First line of the page.\nSecond line.", code: 200 }));
    expect(within(box).getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(
      "First line of the page.\nSecond line.",
    );
    expect(within(box).queryByTestId("tool-result-json-text")).toBeNull();
  });

  it("caps a terminal block's height; one whose text fits stays out of the tab order", async () => {
    // jsdom lays nothing out: every block measures as fitting.
    const box = await renderResult(JSON.stringify({ stdout: "a\nb", stderr: "e" }));
    for (const name of ["stdout", "stderr"]) {
      const pre = within(box).getByTestId(`tool-result-${name}`).querySelector("pre")!;
      expect(pre.style.overflowY).toBe("auto");
      expect(pre.style.maxHeight).toBe("360px");
      expect(pre).not.toHaveAttribute("tabindex");
      expect(pre).not.toHaveAttribute("role");
      expect(pre).not.toHaveAttribute("aria-label");
    }
    expect(within(box).queryByRole("region")).toBeNull();
  });

  describe("with text taller than its block", () => {
    const saved = {
      scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
      clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    };
    beforeEach(() => {
      // A <pre> measures 800 px of text in a 360 px box; nothing else overflows.
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === "PRE" ? 800 : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === "PRE" ? 360 : 0;
        },
      });
    });
    afterEach(() => {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    });

    it("makes a block that scrolls a focusable region named for its field", async () => {
      const box = await renderResult(JSON.stringify({ stdout: "many\nlines", stderr: "e" }));
      const stdout = await within(box).findByRole("region", { name: "stdout" });
      expect(stdout).toHaveAttribute("tabindex", "0");
      expect(stdout).toHaveAttribute("data-scrolls", "true");
      expect(within(box).getByRole("region", { name: "stderr" })).toHaveAttribute("tabindex", "0");
    });

    it("names a text block after the field that holds it, numbered when there are several", async () => {
      const one = await renderResult(
        JSON.stringify({ status: "completed", content: [{ type: "text", text: "The fixture moved." }] }),
      );
      expect(await within(one).findByRole("region", { name: "content" })).toHaveTextContent("The fixture moved.");
      cleanup();
      const two = await renderResult(
        JSON.stringify({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }),
      );
      expect(await within(two).findByRole("region", { name: "content 1" })).toHaveTextContent("first");
      expect(within(two).getByRole("region", { name: "content 2" })).toHaveTextContent("second");
      cleanup();
      const root = await renderResult(JSON.stringify([{ type: "text", text: "a list at the root" }]));
      expect(await within(root).findByRole("region", { name: "text block 1" })).toHaveTextContent("a list at the root");
    });
  });

  describe("when a block stops scrolling", () => {
    // The drawer widens: the same text now fits its box. The measurement
    // is stubbed, and a fake ResizeObserver lets the test say when the
    // box resized.
    let overflowing = true;
    const observers: Array<{ callback: ResizeObserverCallback }> = [];
    const saved = {
      scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
      clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    };
    beforeEach(() => {
      overflowing = true;
      observers.length = 0;
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === "PRE" ? (overflowing ? 800 : 200) : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === "PRE" ? (overflowing ? 360 : 200) : 0;
        },
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(public callback: ResizeObserverCallback) {
            observers.push(this);
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    });

    /** The text now fits: every observed box reports its resize. */
    function widen(): void {
      overflowing = false;
      act(() => {
        for (const o of observers) o.callback([], o as unknown as ResizeObserver);
      });
    }

    it("keeps the focus on a block that holds it, and leaves the tab order once it loses it", async () => {
      const box = await renderResult(JSON.stringify({ stdout: "many\nlines", stderr: "" }));
      const stdout = await within(box).findByRole("region", { name: "stdout" });
      act(() => stdout.focus());
      expect(document.activeElement).toBe(stdout);

      widen();
      // Still the focused element, still a named region: the focus did
      // not fall to the page.
      expect(document.activeElement).toBe(stdout);
      expect(stdout).toHaveAttribute("tabindex", "0");
      expect(stdout).toHaveAttribute("role", "region");
      expect(stdout).not.toHaveAttribute("data-scrolls");

      act(() => stdout.blur());
      expect(stdout).not.toHaveAttribute("tabindex");
      expect(stdout).not.toHaveAttribute("role");
      expect(within(box).queryByRole("region")).toBeNull();
    });

    it("leaves the tab order at once when the block does not hold the focus", async () => {
      const box = await renderResult(JSON.stringify({ stdout: "many\nlines", stderr: "" }));
      const stdout = await within(box).findByRole("region", { name: "stdout" });
      widen();
      expect(stdout).not.toHaveAttribute("tabindex");
      expect(within(box).queryByRole("region")).toBeNull();
    });
  });

  it("writes the cut notes and the field labels in the secondary text colour", async () => {
    const box = await renderResult(
      JSON.stringify({ stdout: `${"o".repeat(50)}${MARK}`, interrupted: false }),
      undefined,
      { output: ["/stdout"] },
    );
    expect(within(box).getByTestId("tool-result-truncated").getAttribute("style")).toContain("var(--text-secondary)");
    for (const label of within(box).getAllByTestId("kv-label")) {
      expect(label.getAttribute("style")).toContain("var(--text-secondary)");
    }
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
      const view = render(<PromptViewer eventId={`e-${stored.length}`} clientType={PLUGIN_CLIENT} />);
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

describe("the earlier cut form is the plugin's only", () => {
  const oldCut = JSON.stringify({ stdout: STDOUT, stderr: "", interrupted: false }).slice(0, 2000) + MARK;

  it("shows a text ending with … as stored on a row another client reported", async () => {
    for (const clientType of [null, "flightdeck_sensor"]) {
      mockContent = pluginToolCall(oldCut);
      const view = render(<PromptViewer eventId={`e-${String(clientType)}`} clientType={clientType} />);
      const box = await view.findByTestId("prompt-box-response");
      expect(within(box).getByTestId("tool-result-raw")).toHaveTextContent('{"stdout":"=== RUN');
      expect(within(box).queryByTestId("tool-result-recovered")).toBeNull();
      expect(within(box).queryByText(/the stored output ends at/)).toBeNull();
      view.unmount();
    }
  });

  it("shows a provider's tool_result in a message as stored, even on a plugin row", async () => {
    mockContent = {
      ...pluginToolCall("ok"),
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: oldCut }] }],
    } as EventContent;
    render(<PromptViewer eventId="e-message" clientType={PLUGIN_CLIENT} />);
    const message = await screen.findByTestId("prompt-box-message-0");
    expect(within(message).getByTestId("tool-result-raw")).toHaveTextContent('{"stdout":"=== RUN');
    expect(within(message).queryByTestId("tool-result-recovered")).toBeNull();
  });

  it("reads the same text up to the cut on the plugin's own row", async () => {
    const box = await renderResult(oldCut);
    expect(within(box).getByTestId("tool-result-recovered")).toBeInTheDocument();
  });
});

describe("Raw of a tool result", () => {
  it("shows the stored block, its content as the stored string and its list beside it", async () => {
    const stored = JSON.stringify({ stdout: `ok${MARK}`, stderr: "" });
    const box = await renderResult(stored, undefined, { output: ["/stdout"] });
    fireEvent.click(screen.getByTestId("prompt-box-response-raw"));
    expect(box).toHaveAttribute("data-view", "raw");
    const raw = screen.getByTestId("prompt-box-response-raw-json");
    expect(raw.textContent).toContain('"type": "tool_result"');
    expect(raw.textContent).toContain(`"content": ${JSON.stringify(stored)}`);
    expect(raw.textContent?.replace(/\s+/g, "")).toContain('"truncated":["/stdout"]');
    expect(within(box).queryByTestId("tool-result-parsed")).toBeNull();
  });
});

describe("a tool input the plugin cut", () => {
  it("shows how many characters a field the block lists kept", async () => {
    const command = `${"git log --oneline | ".repeat(10)}`.slice(0, 200) + MARK;
    await renderResult("ok", { command }, { input: ["/command"] });
    const tool = screen.getByTestId("prompt-box-tool-0");
    const input = within(tool).getByTestId("tool-use-input");
    expect(input).toHaveTextContent(command);
    expect(within(input).getByTestId("cut-note")).toHaveTextContent("cut at 200 characters");
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["command"]);
  });

  it("marks only the listed fields", async () => {
    await renderResult(
      "ok",
      { file_path: "/repo/a.ts", pattern: `${"*".repeat(200)}${MARK}` },
      { input: ["/pattern"] },
    );
    const input = within(screen.getByTestId("prompt-box-tool-0")).getByTestId("tool-use-input");
    expect(within(input).getAllByTestId("cut-note")).toHaveLength(1);
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["file_path:", "pattern"]);
  });

  it("renders an input whose block lists nothing as before, a truncated field of its own included", async () => {
    await renderResult("ok", { command: "ls -la", truncated: true });
    const input = within(screen.getByTestId("prompt-box-tool-0")).getByTestId("tool-use-input");
    expect(within(input).queryByTestId("cut-note")).toBeNull();
    expect(within(input).getAllByTestId("kv-label").map((el) => el.textContent)).toEqual(["command:", "truncated:"]);
  });
});
