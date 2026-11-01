import { test, expect, type Page } from "@playwright/test";
import {
  OTLP_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T127 — a Claude Code session reported over OpenTelemetry renders as
// an observer: no Stop control anywhere, and an OTel source pill that
// tells it apart from a plugin-reported Claude Code session on every
// surface that names the client (Fleet swimlane row and sidebar row,
// the /agents row, the agent drawer, the run drawer header and the
// search palette). The fixture is one OTLP log export the seed sends
// to POST /v1/logs (tests/e2e-fixtures/otlp_seed.py), so these rows
// are what ingestion stores for a real export. Assertions are
// structural, theme-agnostic (Rule 40c.3).

const AUTH = { Authorization: "Bearer tok_dev" };
// uuid5 of flightdeck-e2e/e2e-test-sensor-agent-prod/fresh-active (see
// seed.py _derive_session_id).
const SENSOR_FRESH_ACTIVE_SESSION_ID = "8db1adf1-7a9e-559c-92e5-52b21fc6a42c";
const OTEL_TITLE = "Claude Code via OpenTelemetry: observe only, no directives reach it";

async function otlpAgentId(page: Page): Promise<string> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions/${OTLP_AGENT.rootSessionId}`,
    { headers: AUTH },
  );
  expect(resp.ok(), "the seeded OTLP root session must exist").toBe(true);
  const body = (await resp.json()) as {
    session: { agent_id: string; state: string; context?: Record<string, unknown> };
  };
  expect(body.session.context?.telemetry).toBe("otlp");
  expect(body.session.state, "the seed pins the OTLP root active").toBe("active");
  return body.session.agent_id;
}

test.describe("T127 — OTLP session renders as an observer", () => {
  test("Fleet rows carry the OTel pill beside the client pill and offer no Stop All", async ({
    page,
  }) => {
    const agentId = await otlpAgentId(page);
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, OTLP_AGENT.name);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("swimlane-client-type-pill")).toHaveText(/claude code/i);
    const pill = row.getByTestId("swimlane-telemetry-source-pill");
    await expect(pill).toHaveText(/otel/i);
    await expect(pill).toHaveAttribute("title", OTEL_TITLE);

    const sidebarRow = page.getByTestId(`fleet-sidebar-agent-${OTLP_AGENT.name}`);
    await expect(sidebarRow).toBeVisible();
    await expect(sidebarRow.getByTestId("flavor-telemetry-source-pill")).toHaveText(/otel/i);
    // The root is active, so a directive-capable agent would offer
    // Stop All here; an all-observer one does not.
    await expect(page.getByTestId(`flavor-stop-all-button-${agentId}`)).toHaveCount(0);
  });

  test("a plugin-reported Claude Code agent carries no OTel pill", async ({ page }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    const row = await bringSwimlaneRowIntoView(page, "e2e-test-coding-agent");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("swimlane-client-type-pill")).toHaveText(/claude code/i);
    await expect(row.getByTestId("swimlane-telemetry-source-pill")).toHaveCount(0);
  });

  test("the /agents row and the agent drawer carry the OTel pill", async ({ page }) => {
    const agentId = await otlpAgentId(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    await page.getByTestId("agents-search-input").fill(OTLP_AGENT.name);
    const pill = page.getByTestId(`agent-row-telemetry-source-${agentId}`);
    await expect(pill).toHaveText(/otel/i);
    await expect(pill).toHaveAttribute("title", OTEL_TITLE);

    await page.goto(`/agents?agent_drawer=${agentId}`);
    await expect(page.getByTestId("agent-drawer-name")).toHaveText(OTLP_AGENT.name);
    await expect(page.getByTestId("agent-drawer-telemetry-source")).toHaveText(/otel/i);
  });

  test("the run drawer names the source and shows no Stop Agent; a sensor run still does", async ({
    page,
  }) => {
    await page.goto(`/events?run=${OTLP_AGENT.rootSessionId}`);
    const badge = page.getByTestId("claude-code-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(`v${OTLP_AGENT.claudeCodeVersion}`);
    const source = page.getByTestId("session-source-label");
    await expect(source).toHaveText("via OpenTelemetry");
    await expect(source).toHaveAttribute("data-telemetry", "otlp");
    // The drawer has rendered its body (the badge above), so a Stop
    // control, if any, would be mounted by now.
    await expect(page.getByTestId("session-drawer-stop-agent")).toHaveCount(0);
    await expect(page.getByTestId("drawer-tab-directives")).toHaveCount(0);

    // Control: the sensor agent's fresh-active run (the seed and its
    // keep-alive pin it active) renders the Stop control the OTLP run
    // lacks, so the absence above is not a missing selector.
    await page.goto(`/events?run=${SENSOR_FRESH_ACTIVE_SESSION_ID}`);
    await expect(page.getByTestId("session-drawer-stop-agent")).toBeVisible();
  });

  test("the search palette's agent hit carries the OTel pill", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search" }).fill("e2e-test-otlp@");
    const hit = dialog
      .getByRole("option")
      .filter({ hasText: OTLP_AGENT.name })
      .filter({ has: page.getByTestId("search-agent-telemetry-source") })
      .first();
    await expect(hit).toBeVisible();
    await expect(hit.getByTestId("search-agent-telemetry-source")).toHaveText(/otel/i);
  });
});
