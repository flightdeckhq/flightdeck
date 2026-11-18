import { test, expect } from "@playwright/test";
import { API_URL } from "./_stack";

// T123 — every box in the Prompts panel has its own Rendered / JSON
// toggle. The seed's prompt_content_post_call (on the sensor agent's
// mcp-active session) is an Anthropic call shaped like a Claude Code
// turn: a system prompt, a user message whose text is JSON, an
// assistant message with text and tool_use blocks, a tool_result whose
// content is a JSON string, a tool declaration and a response. Rendered
// shows the blocks and pretty-prints the JSON; JSON shows the stored
// value. The drawer is deep-linked by event id, read from the API.
// Theme-agnostic per Rule 40c.3: assertions read test ids and text.

// uuid5 of flightdeck-e2e/e2e-test-sensor-agent-prod/mcp-active (see
// seed.py).
const MCP_ACTIVE_SESSION_ID = "f53c6626-fcdb-5452-9cf6-8472ef15dfca";

test.describe("T123 — Prompts panel Rendered / JSON per box", () => {
  test("each box toggles on its own and Rendered pretty-prints JSON", async ({ page }) => {
    const resp = await page.request.get(
      `${API_URL}/v1/sessions/${MCP_ACTIVE_SESSION_ID}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as {
      events?: Array<{ id: string; event_type: string; payload?: { stop_reason?: string } | null }>;
    };
    const call = (body.events ?? []).find(
      (e) => e.event_type === "post_call" && e.payload?.stop_reason === "tool_use",
    );
    expect(call, "the seed's prompt_content_post_call must exist").toBeDefined();

    await page.goto(`/events?event=${call!.id}&event_session=${MCP_ACTIVE_SESSION_ID}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await drawer.getByTestId("detail-tab-prompts").click();

    const boxes = ["system", "message-0", "message-1", "message-2", "tool-0", "response"];
    for (const id of boxes) {
      const box = drawer.getByTestId(`prompt-box-${id}`);
      await expect(box).toHaveAttribute("data-view", "rendered");
      // The tabs are named for what they show.
      await expect(drawer.getByTestId(`prompt-box-${id}-rendered`)).toHaveText("Rendered");
      await expect(drawer.getByTestId(`prompt-box-${id}-json`)).toHaveText("JSON");
    }

    // A message whose text is JSON is indented in the Rendered view.
    const jsonMessage = drawer.getByTestId("prompt-box-message-0");
    await expect(jsonMessage.getByTestId("pretty-json")).toContainText('"task": "list the repo"');

    // Content blocks render as text, a tool card and the parsed result,
    // not as a JSON dump.
    const assistant = drawer.getByTestId("prompt-box-message-1");
    await expect(assistant).toContainText("Listing the repository.");
    await expect(assistant.getByTestId("content-block-tool-use")).toContainText("Bash");
    await expect(assistant).not.toContainText('"type"');
    await expect(drawer.getByTestId("prompt-box-message-2").getByTestId("tool-result-parsed")).toContainText(
      "README.md",
    );

    // The JSON view of one box shows the stored message and leaves the rest alone.
    await drawer.getByTestId("prompt-box-message-1-json").click();
    await expect(drawer.getByTestId("prompt-box-message-1")).toHaveAttribute("data-view", "json");
    await expect(drawer.getByTestId("prompt-box-message-1-json-view")).toContainText('"tool_use"');
    await expect(drawer.getByTestId("prompt-box-message-0")).toHaveAttribute("data-view", "rendered");
    await expect(drawer.getByTestId("prompt-box-response")).toHaveAttribute("data-view", "rendered");

    // The JSON view wraps at the box's width instead of scrolling sideways. The
    // tool_result's escaped JSON string (the seed makes it about twice
    // the box's width) is one long line: unwrapped it is wider than the
    // box, wrapped it fits.
    await drawer.getByTestId("prompt-box-message-2-json").click();
    const widths = await drawer.getByTestId("prompt-box-message-2-json-view").evaluate((el) => {
      const pre = el.querySelector("pre")!;
      const wrapped = { scroll: pre.scrollWidth, client: pre.clientWidth };
      const saved = pre.style.cssText;
      pre.style.whiteSpace = "pre";
      pre.style.overflowWrap = "normal";
      const unwrapped = { scroll: pre.scrollWidth, client: pre.clientWidth };
      pre.style.cssText = saved;
      return { wrapped, unwrapped };
    });
    expect(widths.unwrapped.scroll, "the JSON line is long enough to overflow unwrapped").toBeGreaterThan(
      widths.unwrapped.client,
    );
    expect(widths.wrapped.scroll, "the JSON view wraps instead of scrolling sideways").toBeLessThanOrEqual(
      widths.wrapped.client,
    );
    await drawer.getByTestId("prompt-box-message-2-rendered").click();

    await drawer.getByTestId("prompt-box-message-1-rendered").click();
    await expect(drawer.getByTestId("prompt-box-message-1")).toHaveAttribute("data-view", "rendered");
  });
});
