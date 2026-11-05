/**
 * T163 — An MCP call's details show the arguments and result its run
 * captured.
 *
 * An MCP tool call or prompt fetch stores its captured arguments and
 * result in event_content's tool_input / tool_output, not inline on the
 * event. The event drawer's MCP details read them from
 * GET /v1/events/:id/content when opened. A call with nothing captured
 * says why: capture is off for its run (the capture-disabled notice), or
 * capture is on and the call recorded no body. Each test posts its own
 * run through ingestion in the sensor's wire shape (_tool-content-run.ts).
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Locator } from "@playwright/test";
import {
  MCP_ARGS,
  PROMPT_ARGS,
  bareMcpToolCall,
  mcpPromptGet,
  mcpToolCall,
  newRun,
  openEventDrawer,
  removeRun,
  seedRun,
  sessionStart,
  storedEvent,
  type Run,
} from "./_tool-content-run";

/** Open an event's MCP details accordion in the event drawer. */
async function openMcpDetails(drawer: Locator, eventId: string): Promise<void> {
  await drawer.getByTestId(`mcp-event-details-toggle-${eventId}`).click();
}

test.describe("T163 — an MCP call's details show its captured arguments and result", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t163", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("a capture-on MCP tool call and prompt fetch show what they stored", async ({ page, request }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      mcpToolCall(run),
      mcpPromptGet(run),
    ]);

    const call = storedEvent(events, "mcp_tool_call").id;
    let drawer = await openEventDrawer(page, run, call);
    await openMcpDetails(drawer, call);
    await expect(drawer.getByTestId(`mcp-event-detail-arguments-${call}`)).toContainText(MCP_ARGS.path);
    await expect(drawer.getByTestId(`mcp-event-detail-result-${call}`)).toContainText("127.0.0.1 localhost");
    await expect(drawer.getByTestId(`mcp-event-detail-capture-disabled-${call}`)).toHaveCount(0);

    const prompt = storedEvent(events, "mcp_prompt_get").id;
    drawer = await openEventDrawer(page, run, prompt);
    await openMcpDetails(drawer, prompt);
    await expect(drawer.getByTestId(`mcp-event-detail-arguments-${prompt}`)).toContainText(PROMPT_ARGS.name);
    await expect(drawer.getByTestId(`mcp-event-detail-rendered-${prompt}`)).toContainText("Greet Ada warmly");
  });

  test("a capture-on call with nothing captured says it recorded no body", async ({ page, request }) => {
    const events = await seedRun(request, run, [sessionStart(run, true), mcpToolCall(run), bareMcpToolCall(run)]);
    const bare = storedEvent(events, "mcp_tool_call", "list_dir").id;
    const drawer = await openEventDrawer(page, run, bare);
    await openMcpDetails(drawer, bare);
    await expect(drawer.getByTestId(`mcp-event-detail-no-content-${bare}`)).toContainText(
      "no request or response body was recorded",
    );
    await expect(drawer.getByTestId(`mcp-event-detail-capture-disabled-${bare}`)).toHaveCount(0);
    await expect(drawer.getByTestId(`mcp-event-detail-arguments-${bare}`)).toHaveCount(0);
  });

  test("a capture-off run's call shows the capture-disabled notice and no content", async ({ page, request }) => {
    const events = await seedRun(request, run, [sessionStart(run, false), bareMcpToolCall(run)]);
    const bare = storedEvent(events, "mcp_tool_call").id;
    const drawer = await openEventDrawer(page, run, bare);
    await openMcpDetails(drawer, bare);
    await expect(drawer.getByTestId(`mcp-event-detail-capture-disabled-${bare}`)).toContainText(
      "Prompt capture is not enabled for this deployment.",
    );
    await expect(drawer.getByTestId(`mcp-event-detail-no-content-${bare}`)).toHaveCount(0);
    await expect(drawer.getByTestId(`mcp-event-detail-arguments-${bare}`)).toHaveCount(0);
  });
});
