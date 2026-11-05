import { test, expect } from "@playwright/test";
import {
  GENAI_FIXTURE,
  bringSwimlaneRowIntoView,
  genaiEvents,
  genaiSession,
  newestGenaiRun,
  waitForFleetReady,
} from "./_fixtures";

// T152 — the shapes of an OpenTelemetry GenAI run beyond one agent:
// an agent that runs a sub-agent that runs a sub-agent (depth 2) as
// three Fleet rows joined by sub-agent connectors and parent pills; a
// trace's calls that no named agent made, in a session marked
// unattributed; a hand-off as a signal on the agent handing off; a
// failed model call as an error row; and the OTel pill naming the
// framework on the agent's rows. The runs come through the OTLP
// receiver and its assembler (tests/e2e-fixtures/genai_seed.py).
// Assertions are structural and theme-agnostic (Rule 40c.3).

const PILL_TITLE_PYDANTIC = "Pydantic AI via OpenTelemetry: observe only, no directives reach it";

// Tall viewport so the three depth-2 rows mount together without
// virtualization evicting the parent (the T34 pattern).
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T152 — OpenTelemetry GenAI sub-agents, hand-offs and errors", () => {
  test("a depth-2 run is three Fleet rows joined by sub-agent connectors", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.depth2);
    const root = `${GENAI_FIXTURE.depth2}/coordinator`;
    const researcher = genaiSession(run, `${root}/researcher`);
    const checker = genaiSession(run, `${root}/fact_checker`);
    genaiSession(run, root);

    await page.goto("/");
    await waitForFleetReady(page);
    // The seed dates the run within the last minutes: the 1h range
    // holds every one of its events.
    await page.getByRole("button", { name: "1h", exact: true }).click();
    const leafRow = await bringSwimlaneRowIntoView(page, checker.agent_name);
    await expect(leafRow).toBeVisible();
    await expect(leafRow.getByTestId("swimlane-telemetry-source-pill")).toHaveText(/otel/i);

    // One connector into each sub-agent: coordinator -> researcher and
    // researcher -> fact_checker.
    for (const child of [researcher, checker]) {
      await expect
        .poll(
          () =>
            page
              .locator(
                `[data-testid^="sub-agent-connector-"][data-child-session-id="${child.session_id}"]`,
              )
              .count(),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1);
    }
  });

  test("the middle agent's drawer shows the agent that spawned it and the one it spawned", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.depth2);
    const root = `${GENAI_FIXTURE.depth2}/coordinator`;
    const researcher = genaiSession(run, `${root}/researcher`);
    await page.goto(`/events?run=${researcher.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    const badge = drawer.getByTestId("otel-session-badge");
    await expect(badge).toBeVisible();
    await expect(badge.getByTestId("drawer-headline-relationship-pill")).toBeVisible();
    await drawer.getByTestId("drawer-tab-sub-agents").click();
    await expect(drawer.getByTestId("sub-agents-spawned-from")).toBeVisible();
    await expect(drawer.getByTestId("sub-agents-children")).toContainText("fact_checker");
  });

  test("a trace's calls no named agent made are in a session marked unattributed", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.depth2, { unattributed: true });
    const loose = genaiSession(run, GENAI_FIXTURE.depth2);
    await page.goto(`/events?run=${loose.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer.getByTestId("otel-session-unattributed")).toHaveText(/unattributed/i);
    await expect(drawer.getByTestId("otel-session-framework")).toHaveText("Pydantic AI");
    // A named agent's session carries no such mark.
    const named = await newestGenaiRun(page, GENAI_FIXTURE.depth2);
    await page.goto(`/events?run=${genaiSession(named, `${GENAI_FIXTURE.depth2}/coordinator`).session_id}`);
    await expect(page.getByTestId("session-drawer").getByTestId("otel-session-badge")).toBeVisible();
    await expect(page.getByTestId("session-drawer").getByTestId("otel-session-unattributed")).toHaveCount(0);
  });

  test("a hand-off is a signal on the agent handing off, naming both agents", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.openaiHandoff);
    const triage = genaiSession(run, `${GENAI_FIXTURE.openaiHandoff}/triage_agent`);
    const target = genaiSession(run, `${GENAI_FIXTURE.openaiHandoff}/weather_agent`);
    // The two agents are sibling roots of one trace.
    expect(target.context.otel_trace_id).toBe(triage.context.otel_trace_id);
    const [signal] = (await genaiEvents(page, triage.session_id)).filter(
      (e) => e.event_type === "session_signal",
    );
    await page.goto(`/events?run=${triage.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    const row = drawer.locator(`[data-event-id="${signal!.id}"]`);
    await expect(row).toContainText("hand-off · triage_agent → weather_agent");
    await row.click();
    await expect(drawer).toContainText("From agent");
    await expect(drawer).toContainText("To agent");
  });

  test("a failed model call is an error row on its agent", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.modelError);
    const agent = genaiSession(run, `${GENAI_FIXTURE.modelError}/missing_model_agent`);
    const [error] = (await genaiEvents(page, agent.session_id)).filter((e) => e.event_type === "llm_error");
    await page.goto(`/events?run=${agent.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    const row = drawer.getByTestId(`error-event-row-${error!.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("event-type-pill")).toHaveText(/error/i);
  });

  test("the agent drawer's OTel pill names the framework", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.pydanticAi);
    const agent = genaiSession(run, `${GENAI_FIXTURE.pydanticAi}/weather_agent`);
    await page.goto(`/agents?agent_drawer=${agent.agent_id}`);
    await expect(page.getByTestId("agent-drawer-name")).toHaveText(agent.agent_name);
    await expect(page.getByTestId("agent-drawer-telemetry-source")).toHaveAttribute(
      "title",
      PILL_TITLE_PYDANTIC,
    );
  });
});
