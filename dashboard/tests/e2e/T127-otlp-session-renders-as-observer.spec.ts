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
const OPEN_PALETTE = process.platform === "darwin" ? "Meta+k" : "Control+k";
// uuid5 of flightdeck-e2e/e2e-test-sensor-agent-prod/fresh-active (see
// seed.py _derive_session_id).
const SENSOR_FRESH_ACTIVE_SESSION_ID = "8db1adf1-7a9e-559c-92e5-52b21fc6a42c";
const OTEL_TITLE = "Claude Code via OpenTelemetry: observe only, no directives reach it";
// The run drawer's source label as a screen reader reads it: the
// visible "via OpenTelemetry" and its visually hidden qualifier.
const OTLP_SOURCE_TEXT = "via OpenTelemetry: observe only, no directives reach it";

async function sessionAgentId(page: Page, sessionId: string): Promise<string> {
  const resp = await page.request.get(`http://localhost:4000/api/v1/sessions/${sessionId}`, {
    headers: AUTH,
  });
  expect(resp.ok(), `session ${sessionId} must exist`).toBe(true);
  return ((await resp.json()) as { session: { agent_id: string } }).session.agent_id;
}

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
    // Stop All here; an all-observer one does not. A custom directive
    // is registered under the OTLP session's flavor (otlp_seed.py), so
    // the trigger's absence is the observer gate, not an empty list.
    await expect(page.getByTestId(`flavor-stop-all-button-${agentId}`)).toHaveCount(0);
    await expect(page.getByTestId(`flavor-directives-button-${agentId}`)).toHaveCount(0);
  });

  test("a sensor agent's Fleet row offers the directives registered under its sessions' flavor", async ({
    page,
  }) => {
    // Positive control for the observer gate above: the row is keyed
    // by agent_id, the directive by the sensor's flavor string, and
    // the trigger must still resolve one through the other.
    const sensorId = await sessionAgentId(page, SENSOR_FRESH_ACTIVE_SESSION_ID);
    await page.goto("/");
    await waitForFleetReady(page);
    const button = page.getByTestId(`flavor-directives-button-${sensorId}`);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole("dialog")).toContainText("e2e_sensor_rotate");
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
    // Control first: the sensor agent's fresh-active run (the seed and
    // its keep-alive pin it active; its flavor has a registered
    // directive) shows the Stop control and the Directives tab. The tab
    // proves the page has loaded the registered directives, so the OTLP
    // run's missing tab below is the observer gate, not a directive list
    // that has not arrived yet.
    await page.goto(`/events?run=${SENSOR_FRESH_ACTIVE_SESSION_ID}`);
    await expect(page.getByTestId("session-drawer-stop-agent")).toBeVisible();
    await expect(page.getByTestId("drawer-tab-directives")).toBeVisible();

    // Then the OTLP run, opened in the app from the search palette with
    // no reload, so the loaded directive list carries over. The seed
    // registers a custom directive under this run's flavor too. The open
    // drawer covers the nav's search button, so the palette opens from
    // its keyboard shortcut.
    await page.keyboard.press(OPEN_PALETTE);
    const palette = page.getByRole("dialog");
    await expect(palette.getByRole("textbox", { name: "Search" })).toBeFocused();
    await palette.getByRole("textbox", { name: "Search" }).fill(OTLP_AGENT.rootSessionId);
    const hit = palette
      .getByRole("option")
      .filter({ has: page.getByTestId("search-session-telemetry-source") });
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(page).toHaveURL(new RegExp(`[?&]run=${OTLP_AGENT.rootSessionId}`));

    // While the sensor run's drawer animates out, two drawers are
    // mounted: scope to the one showing the OTLP run (the sensor run has
    // no Claude Code badge). Its header and its tab bar render from the
    // same session data, so once the bar is up a Stop control or a
    // Directives tab would be too.
    const drawer = page
      .getByTestId("session-drawer")
      .filter({ has: page.getByTestId("claude-code-badge") });
    await expect(drawer.getByTestId("claude-code-badge")).toContainText(
      `v${OTLP_AGENT.claudeCodeVersion}`,
    );
    const source = drawer.getByTestId("session-source-label");
    await expect(source).toHaveText(OTLP_SOURCE_TEXT);
    await expect(source).toHaveAttribute("data-telemetry", "otlp");
    await expect(drawer.getByTestId("drawer-tab-timeline")).toBeVisible();
    await expect(drawer.getByTestId("session-drawer-stop-agent")).toHaveCount(0);
    await expect(drawer.getByTestId("drawer-tab-directives")).toHaveCount(0);
  });

  test("the search palette's agent hit carries the OTel pill", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search" }).fill("e2e-test-otlp@");
    // The root agent exactly, not its "/general-purpose" sub-agent.
    const hit = dialog
      .getByRole("option")
      .filter({ has: page.getByTestId("search-agent-telemetry-source") })
      .filter({ hasText: new RegExp(`${OTLP_AGENT.name}(?!/)`) });
    await expect(hit).toHaveCount(1);
    await expect(hit).toBeVisible();
    await expect(hit.getByTestId("search-agent-telemetry-source")).toHaveText(/otel/i);
  });
});
