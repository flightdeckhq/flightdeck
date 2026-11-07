/**
 * T164 — A failed Claude Code tool call counts as an error on every
 * surface.
 *
 * The Claude Code plugin stores a failed tool call as a tool_call
 * carrying an error block (error_type=other, error_class=
 * PluginToolError). Each test posts its own run through ingestion in
 * the plugin's wire shape (a successful Bash call, then a failed one)
 * and removes it afterwards:
 *
 * - the run drawer marks the failed row with the error indicator, its
 *   detail reads "<tool> · failed" and the expanded row names the
 *   error class; the successful row carries none of it;
 * - the Agents row's errors count and the agent drawer's Runs-tab
 *   errors column count the failure, and the session listing's
 *   error_types[] and error_type filter carry it.
 *
 * Theme-agnostic — structural locators and data attributes only; runs
 * under both the neon-dark and clean-light theme projects.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  API,
  AUTH,
  newRun,
  removeRun,
  seedRun,
  storedEvent,
  type Run,
} from "./_tool-content-run";
import { openAgentDrawerFromRow } from "./_fixtures";

const HOST = "e2e-t164-host";
/** How long the Agents row may take to show the run's agent. */
const AGENT_ROW_WAIT_MS = 15_000;

/** Each event a second after the last, so the run's order is fixed. */
function stamp(offsetSeconds: number): string {
  return new Date(Date.now() - 60_000 + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pluginEvent(
  run: Run,
  eventType: string,
  offsetSeconds: number,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: run.sessionId,
    flavor: run.flavor,
    event_type: eventType,
    host: HOST,
    framework: null,
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_used_session: 0,
    token_limit_session: null,
    latency_ms: null,
    tool_name: null,
    tool_input: null,
    tool_result: null,
    has_content: false,
    content: null,
    timestamp: stamp(offsetSeconds),
    agent_id: run.agentId,
    agent_type: "coding",
    agent_name: run.agentName,
    client_type: "claude_code",
    user: "e2e",
    hostname: HOST,
    ...fields,
  };
}

/** The run's events: start, a Bash call that worked, one that failed.
 *  Capture is off, so the failure's message is the redaction marker. */
const runEvents = (run: Run) => [
  pluginEvent(run, "session_start", 0, {
    capture_prompts: false,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  }),
  pluginEvent(run, "tool_call", 1, {
    tool_name: "Read",
    tool_use_id: `toolu_ok_${run.sessionId.slice(0, 8)}`,
    latency_ms: 4,
    duration_ms: 4,
  }),
  pluginEvent(run, "tool_call", 2, {
    tool_name: "Bash",
    tool_use_id: `toolu_fail_${run.sessionId.slice(0, 8)}`,
    latency_ms: 31,
    duration_ms: 31,
    error: {
      error_type: "other",
      error_class: "PluginToolError",
      message: "<redacted>",
      interrupted: false,
    },
  }),
];

interface SessionRow {
  session_id: string;
  error_types: string[];
}

async function listSessions(api: APIRequestContext, run: Run, extra = ""): Promise<SessionRow[]> {
  const from = new Date(Date.now() - 2 * 3600_000).toISOString();
  const resp = await api.get(
    `${API}/sessions?agent_id=${run.agentId}&from=${encodeURIComponent(from)}${extra}`,
    { headers: AUTH },
  );
  expect(resp.ok(), `GET /v1/sessions: ${resp.status()}`).toBe(true);
  return ((await resp.json()) as { sessions: SessionRow[] }).sessions;
}

test.describe("T164 — a failed tool call counts as an error", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun("t164", test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the run drawer marks the failed tool_call row", async ({ page, request }) => {
    const events = await seedRun(request, run, runEvents(run));
    const failed = storedEvent(events, "tool_call", "Bash");
    const ok = storedEvent(events, "tool_call", "Read");

    await page.goto(`/events?run=${run.sessionId}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer).toBeVisible();

    const failedRow = drawer.locator(`[data-event-id="${failed.id}"]`);
    const okRow = drawer.locator(`[data-event-id="${ok.id}"]`);
    await expect(failedRow).toBeVisible();
    await expect(okRow).toBeVisible();

    const indicator = failedRow.getByTestId(`tool-error-indicator-${failed.id}`);
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute("aria-label", "Tool call failed: <redacted>");
    await expect(failedRow).toContainText("Bash · failed");
    await expect(okRow.getByTestId(`tool-error-indicator-${ok.id}`)).toHaveCount(0);
    await expect(okRow).not.toContainText("failed");

    // The expanded row lists the error's type and class.
    await failedRow.click();
    await expect(drawer.getByText("PluginToolError")).toBeVisible();
    await expect(drawer.getByText("Error class")).toBeVisible();
  });

  test("the Agents row, the agent drawer and the session listing count the failure", async ({
    page,
    request,
  }) => {
    await seedRun(request, run, runEvents(run));

    // The API: the run's error_types carries the failure and the
    // error_type filter finds the run by it.
    const rows = await listSessions(request, run);
    expect(rows.map((r) => [r.session_id, r.error_types])).toEqual([[run.sessionId, ["other"]]]);
    const filtered = await listSessions(request, run, "&error_type=other");
    expect(filtered.map((r) => r.session_id)).toEqual([run.sessionId]);

    // The Agents row's errors count.
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    await page.getByTestId("agents-search-input").fill(run.agentName);
    const agentRow = page.getByTestId(`agent-row-${run.agentId}`);
    await expect(agentRow).toBeVisible({ timeout: AGENT_ROW_WAIT_MS });
    await expect(
      page.getByTestId(`agent-row-errors-${run.agentId}`).locator("span").first(),
    ).toHaveText("1");

    // The agent drawer's Runs tab errors column.
    await openAgentDrawerFromRow(agentRow);
    await expect(page.getByTestId("agent-drawer")).toBeVisible();
    await page.getByTestId("agent-drawer-tab-runs").click();
    const runRow = page.getByTestId(`agent-drawer-run-row-${run.sessionId}`);
    await expect(runRow).toBeVisible();
    await expect(runRow.getByTestId("agent-drawer-run-errors")).toHaveText("1");
  });
});
