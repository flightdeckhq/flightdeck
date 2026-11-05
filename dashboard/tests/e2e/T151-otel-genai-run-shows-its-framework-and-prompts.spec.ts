import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  GENAI_FIXTURE,
  genaiEvents,
  genaiSession,
  newestGenaiRun,
  type GenaiEvent,
} from "./_fixtures";

// T151 — an agent framework's run reported over OpenTelemetry GenAI
// opens in the run drawer under its framework's name, observes only,
// and its Prompts tab shows each call's and tool's content as the
// framework sent it. The runs are recorded framework exports the E2E
// seed replays with capture on through the OTLP receiver
// (tests/e2e-fixtures/genai_seed.py), so the drawer renders what
// ingestion's assembler stores. Assertions are structural and
// theme-agnostic (Rule 40c.3).

async function openRun(page: Page, sessionId: string): Promise<Locator> {
  await page.goto(`/events?run=${sessionId}`);
  const drawer = page.getByTestId("session-drawer");
  await expect(drawer.getByTestId("otel-session-badge")).toBeVisible();
  return drawer;
}

function only(events: GenaiEvent[], type: string): GenaiEvent[] {
  return events.filter((e) => e.event_type === type);
}

async function openPromptsRow(drawer: Locator, eventId: string): Promise<Locator> {
  await drawer.getByTestId("drawer-tab-prompts").click();
  await drawer.getByTestId(`prompts-row-${eventId}`).click();
  const viewer = drawer.getByTestId("prompt-viewer-otel-genai");
  await expect(viewer).toBeVisible();
  return viewer;
}

test.describe("T151 — an OpenTelemetry GenAI run shows its framework and its prompts", () => {
  test("Pydantic AI: the header names the framework and the trace, with no Stop control", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.pydanticAi);
    const agent = genaiSession(run, `${GENAI_FIXTURE.pydanticAi}/weather_agent`);
    const drawer = await openRun(page, agent.session_id);

    await expect(drawer.getByTestId("otel-session-framework")).toHaveText("Pydantic AI");
    await expect(drawer.getByTestId("otel-session-badge")).toContainText("v2.64.0");
    const source = drawer.getByTestId("session-source-label");
    await expect(source).toHaveText("via OpenTelemetry: observe only, no directives reach it");
    await expect(source).toHaveAttribute(
      "title",
      "Reported by Pydantic AI's OpenTelemetry instrumentation: observe only, no directives reach it",
    );
    const traceId = String(agent.context.otel_trace_id);
    await expect(drawer.getByTestId("otel-session-trace-id")).toHaveAttribute(
      "title",
      `OpenTelemetry trace ${traceId}`,
    );
    await expect(drawer.getByTestId("claude-code-badge")).toHaveCount(0);
    await expect(drawer.getByTestId("drawer-tab-timeline")).toBeVisible();
    await expect(drawer.getByTestId("session-drawer-stop-agent")).toHaveCount(0);
  });

  test("Pydantic AI: a call's messages and a tool call's arguments and result, as sent", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.pydanticAi);
    const agent = genaiSession(run, `${GENAI_FIXTURE.pydanticAi}/weather_agent`);
    const events = await genaiEvents(page, agent.session_id);
    const [firstCall] = only(events, "post_call");
    const [tool] = only(events, "tool_call");
    expect(firstCall?.has_content && tool?.has_content).toBe(true);
    const drawer = await openRun(page, agent.session_id);

    // Every call and tool with content is listed.
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.locator('[data-testid^="prompts-row-"]')).toHaveCount(3);

    let viewer = await openPromptsRow(drawer, firstCall!.id);
    await expect(viewer.getByTestId("prompt-viewer-source")).toHaveText("OpenTelemetry GenAI");
    await expect(viewer.getByTestId("prompt-box-system")).toContainText(
      "Answer weather questions with the get_weather tool.",
    );
    await expect(viewer.getByTestId("prompt-box-message-1")).toContainText(
      "What is the weather in Paris?",
    );
    const call = viewer.getByTestId("prompt-box-response-0").getByTestId("genai-part-tool-call");
    await expect(call).toContainText("get_weather");
    await expect(call).toContainText("Paris");
    // Raw shows the message as stored: GenAI parts, not a provider shape.
    await viewer.getByTestId("prompt-box-message-1-raw").click();
    await expect(viewer.getByTestId("prompt-box-message-1-raw-json")).toContainText('"parts"');

    await drawer.getByRole("button", { name: "← Back to event list" }).click();
    viewer = await openPromptsRow(drawer, tool!.id);
    await expect(viewer.getByTestId("prompt-box-tool-input")).toContainText("city");
    await expect(viewer.getByTestId("prompt-box-tool-input")).toContainText("Paris");
    await expect(viewer.getByTestId("prompt-box-tool-output")).toContainText("Paris: sunny, 21 C");
  });

  test("Strands (older conventions): content blocks render as the tool call and its result", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.strands);
    const agent = genaiSession(run, `${GENAI_FIXTURE.strands}/weather_agent`);
    const calls = only(await genaiEvents(page, agent.session_id), "post_call");
    const second = calls[1];
    expect(second?.has_content).toBe(true);
    const drawer = await openRun(page, agent.session_id);
    await expect(drawer.getByTestId("otel-session-framework")).toHaveText("Strands Agents");

    const viewer = await openPromptsRow(drawer, second!.id);
    await expect(viewer.getByTestId("prompt-box-message-1").getByTestId("genai-part-tool-call")).toContainText(
      "get_weather",
    );
    const result = viewer.getByTestId("prompt-box-message-2").getByTestId("genai-part-tool-response");
    await expect(result).toContainText("success");
    await expect(result).toContainText("Paris: sunny, 21 C");
  });

  test("Google ADK: a call's content from its log record; its tool call says where its content is", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.googleAdk);
    const agent = genaiSession(run, `${GENAI_FIXTURE.googleAdk}/weather_agent`);
    const events = await genaiEvents(page, agent.session_id);
    const calls = only(events, "post_call");
    const [tool] = only(events, "tool_call");
    expect(calls.every((c) => c.has_content)).toBe(true);
    expect(tool?.has_content).toBe(false);
    const drawer = await openRun(page, agent.session_id);
    await expect(drawer.getByTestId("otel-session-framework")).toHaveText("Google ADK");

    const viewer = await openPromptsRow(drawer, calls[1]!.id);
    await expect(
      viewer.getByTestId("prompt-box-message-2").getByTestId("genai-part-tool-response"),
    ).toContainText("Paris: sunny, 21 C");

    // The tool call stored no content though capture is on: its
    // Prompts tab says so, and where to look, not that capture is off.
    await drawer.getByTestId("drawer-tab-timeline").click();
    const row = drawer.locator(`[data-event-id="${tool!.id}"]`);
    await row.click();
    await drawer.getByTestId("open-full-detail").click();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("prompts-no-content-for-event")).toContainText(
      "No content was recorded for this event.",
    );
    await expect(drawer.getByTestId("prompts-no-content-reason")).toContainText(
      "Google ADK records a tool's arguments and result only inside the next model call's messages",
    );
    await expect(drawer.getByText("Prompt capture is not enabled for this deployment.")).toHaveCount(0);
  });

  test("Google ADK: the event drawer of the tool call says the same", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.googleAdk);
    const agent = genaiSession(run, `${GENAI_FIXTURE.googleAdk}/weather_agent`);
    const [tool] = only(await genaiEvents(page, agent.session_id), "tool_call");
    await page.goto(`/events?event=${tool!.id}&event_session=${agent.session_id}`);
    const eventDrawer = page.getByTestId("event-detail-drawer");
    await expect(eventDrawer).toBeVisible();
    await eventDrawer.getByTestId("detail-tab-prompts").click();
    await expect(eventDrawer.getByTestId("prompts-no-content-reason")).toContainText(
      "Google ADK records a tool's arguments and result",
    );
  });

  test("OpenAI Agents: a call's text parts show as sent, the SDK's repr included", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.openaiHandoff);
    const triage = genaiSession(run, `${GENAI_FIXTURE.openaiHandoff}/triage_agent`);
    const [call] = only(await genaiEvents(page, triage.session_id), "post_call");
    const drawer = await openRun(page, triage.session_id);
    await expect(drawer.getByTestId("otel-session-framework")).toHaveText("OpenAI Agents");
    const viewer = await openPromptsRow(drawer, call!.id);
    await expect(viewer.getByTestId("prompt-box-response-0")).toContainText(
      "ResponseFunctionToolCall(arguments='{}'",
    );
    await expect(viewer.getByTestId("prompt-box-system")).toHaveCount(0);
  });
});
