/**
 * T162 — The Prompts tab shows a tool call's captured arguments and
 * result.
 *
 * The sensor stores a tool call's arguments and result in
 * event_content's tool_input / tool_output columns and puts `{}` in the
 * response column. Each test posts a capture-on run through ingestion in
 * the sensor's own wire shape (see _tool-content-run.ts), then opens it:
 *
 * - a sensor tool_call's Prompts tab, in the run drawer and in the event
 *   drawer, shows its arguments as fields and no `{}` response;
 * - an mcp_tool_call's Prompts tab shows its arguments and its result;
 * - the run drawer's Prompts list carries the run's MCP tool call and
 *   prompt fetch, and opens them.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect } from "@playwright/test";
import {
  API,
  AUTH,
  MCP_ARGS,
  PROMPT_ARGS,
  TOOL_ARGS,
  bareMcpToolCall,
  mcpPromptGet,
  mcpToolCall,
  newRun,
  openEventDrawer,
  removeRun,
  seedRun,
  sessionStart,
  storedEvent,
  toolCall,
  type Run,
} from "./_tool-content-run";

test.describe("T162 — the Prompts tab shows a tool call's arguments and result", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t162", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the API serves the tool call's arguments in tool_input", async ({ request }) => {
    const events = await seedRun(request, run, [sessionStart(run, true), toolCall(run)]);
    const resp = await request.get(`${API}/events/${storedEvent(events, "tool_call").id}/content`, {
      headers: AUTH,
    });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { tool_input?: unknown; response?: unknown };
    expect(body.tool_input).toEqual(TOOL_ARGS);
    expect(body.response).toEqual({});
  });

  test("a sensor tool_call's Prompts tab shows its arguments, in the run drawer and the event drawer", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run, [sessionStart(run, true), toolCall(run)]);
    const toolCallId = storedEvent(events, "tool_call").id;

    // The run drawer lists the tool call and opens its content.
    await page.goto(`/events?run=${run.sessionId}`);
    const runDrawer = page.getByTestId("session-drawer");
    await expect(runDrawer).toBeVisible();
    await runDrawer.getByTestId("drawer-tab-prompts").click();
    await runDrawer.getByTestId(`prompts-row-${toolCallId}`).click();
    const runArgs = runDrawer.getByTestId("prompt-box-tool-input");
    await expect(runArgs).toBeVisible();
    await expect(runArgs.getByTestId("tool-value-fields")).toContainText(TOOL_ARGS.query);
    await expect(runDrawer.getByTestId("prompt-box-response")).toHaveCount(0);

    // The event drawer shows the same, under a header naming the model.
    const drawer = await openEventDrawer(page, run, toolCallId);
    await drawer.getByTestId("detail-tab-prompts").click();
    const args = drawer.getByTestId("prompt-box-tool-input");
    await expect(args).toBeVisible();
    await expect(drawer.getByTestId("prompt-viewer-model")).toHaveText("gpt-4o-mini");
    await expect(args.getByTestId("kv-label")).toHaveText(["query:", "type:"]);
    await expect(args).toContainText(TOOL_ARGS.query);
    await expect(args).toContainText(TOOL_ARGS.type);
    await expect(drawer.getByTestId("prompt-box-response")).toHaveCount(0);
    await expect(drawer.getByTestId("prompt-box-tool-output")).toHaveCount(0);
    await expect(drawer.getByText("Prompt capture is not enabled for this deployment.")).toHaveCount(0);

    // Raw shows the arguments as stored.
    await drawer.getByTestId("prompt-box-tool-input-raw").click();
    await expect(drawer.getByTestId("prompt-box-tool-input-raw-json")).toContainText(
      `"query": "${TOOL_ARGS.query}"`,
    );
  });

  test("an mcp_tool_call's Prompts tab shows its arguments and its result", async ({ page, request }) => {
    const events = await seedRun(request, run, [sessionStart(run, true), mcpToolCall(run)]);
    const drawer = await openEventDrawer(page, run, storedEvent(events, "mcp_tool_call").id);
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("prompt-box-tool-input")).toContainText(MCP_ARGS.path);
    const result = drawer.getByTestId("prompt-box-tool-output");
    await expect(result).toBeVisible();
    await expect(result).toContainText("127.0.0.1 localhost");
    await expect(drawer.getByTestId("prompt-box-response")).toHaveCount(0);
  });

  test("the run drawer's Prompts list carries the run's MCP tool call and prompt fetch", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run, [
      sessionStart(run, true),
      mcpToolCall(run),
      mcpPromptGet(run),
      bareMcpToolCall(run),
    ]);
    const mcpCall = storedEvent(events, "mcp_tool_call", "read_file");
    const promptGet = storedEvent(events, "mcp_prompt_get");
    const bare = storedEvent(events, "mcp_tool_call", "list_dir");

    await page.goto(`/events?run=${run.sessionId}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.getByTestId(`prompts-row-${mcpCall.id}`)).toContainText("read_file");
    await expect(drawer.getByTestId(`prompts-row-${promptGet.id}`)).toContainText("greet");
    // A call that stored nothing has nothing to open.
    await expect(drawer.getByTestId(`prompts-row-${bare.id}`)).toHaveCount(0);

    await drawer.getByTestId(`prompts-row-${promptGet.id}`).click();
    await expect(drawer.getByTestId("prompt-box-tool-input")).toContainText(PROMPT_ARGS.name);
    await expect(drawer.getByTestId("prompt-box-tool-output")).toContainText("Greet Ada warmly");
  });
});
