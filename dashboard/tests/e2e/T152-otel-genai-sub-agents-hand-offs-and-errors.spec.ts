import { test, expect } from "@playwright/test";
import { GENAI_FIXTURE, genaiEvents, genaiSession, newestGenaiRun } from "./_fixtures";

// T152 — the shapes of an OpenTelemetry GenAI run beyond one agent:
// an agent that runs a sub-agent that runs a sub-agent (depth 2) as
// swimlane rows joined by sub-agent connectors, and parent pills; a
// trace's calls that no named agent made, in a session marked
// unattributed; a hand-off as a signal on the agent handing off; a
// failed model call as an error row; and the OTel pill naming the
// framework on the agent's rows. The runs come through the OTLP
// receiver and its assembler (tests/e2e-fixtures/genai_seed.py).
// Assertions are structural and theme-agnostic (Rule 40c.3).

const PILL_TITLE_PYDANTIC = "Pydantic AI via OpenTelemetry: observe only, no directives reach it";

// The swimlane ranges, shortest first, and the share of a range a run's
// age may take so the run sits well inside the range's right edge.
const RANGES: ReadonlyArray<[string, number]> = [
  ["5m", 5 * 60_000],
  ["15m", 15 * 60_000],
  ["30m", 30 * 60_000],
  ["1h", 60 * 60_000],
];
const RANGE_FILL = 0.8;

/** The shortest swimlane range in which a run started at ``startedAt``
 *  sits no closer to the right edge than ``1 - RANGE_FILL``. */
function rangeFor(startedAt: string): string {
  const age = Date.now() - new Date(startedAt).getTime();
  for (const [name, ms] of RANGES) {
    if (age < ms * RANGE_FILL) return name;
  }
  return "1h";
}

// Tall viewport so a parent's and its sub-agent's swimlane rows mount
// together in the modal (the T34 pattern).
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T152 — OpenTelemetry GenAI sub-agents, hand-offs and errors", () => {
  // The per-agent swimlane modal draws the focused agent with its
  // direct sub-agents and the connectors between them, so the depth-2
  // chain is checked one level at a time: the coordinator's modal joins
  // it to the researcher, the researcher's joins it to the fact checker.
  // (The modal is reached through the agent drawer's deep link rather
  // than by scrolling Fleet's full roster, which on a large dev DB
  // takes longer than a test's budget.)
  for (const [parentRole, childRole] of [
    ["", "researcher"],
    ["researcher", "fact_checker"],
  ] as const) {
    test(`a depth-2 run: ${parentRole || "the coordinator"}'s swimlane joins it to ${childRole}`, async ({
      page,
    }) => {
      const run = await newestGenaiRun(page, GENAI_FIXTURE.depth2);
      const root = `${GENAI_FIXTURE.depth2}/coordinator`;
      const parent = genaiSession(run, parentRole ? `${root}/${parentRole}` : root);
      const child = genaiSession(run, `${root}/${childRole}`);

      await page.goto(`/agents?agent_drawer=${parent.agent_id}`);
      // The agent drawer reads the agent from the fleet roster, which
      // on a large dev DB takes several seconds to load.
      await expect(page.getByTestId("agent-drawer-name")).toHaveText(parent.agent_name, {
        timeout: 15_000,
      });
      await page.getByTestId("agent-drawer-open-swimlane").click();
      // A range that holds the run well inside its right edge: a run
      // drawn a few pixels from "now" can leave its connector's
      // endpoints at the clipped edge.
      await page.getByTestId(`per-agent-swimlane-modal-time-${rangeFor(child.started_at)}`).click();
      // The toggle defaults on only for a pure parent; the researcher is
      // both a child and a parent, so turn it on.
      await page.getByTestId("per-agent-swimlane-modal-show-sub-agents-input").check();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByTestId(`swimlane-agent-row-${child.agent_name}`),
      ).toBeVisible();
      await expect(
        dialog
          .getByTestId(`swimlane-agent-row-${child.agent_name}`)
          .getByTestId("swimlane-telemetry-source-pill"),
      ).toHaveText(/otel/i);
      // The modal holds only the parent's and the child's rows, so any
      // connector in it joins the two (an earlier seed's run may be the
      // one drawn).
      await expect
        .poll(() => dialog.locator('[data-testid^="sub-agent-connector-"][data-child-session-id]').count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(1);
    });
  }

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
    await expect(page.getByTestId("agent-drawer-name")).toHaveText(agent.agent_name, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("agent-drawer-telemetry-source")).toHaveAttribute(
      "title",
      PILL_TITLE_PYDANTIC,
    );
  });
});
