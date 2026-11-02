/**
 * T149 — Fleet follows the worker's state changes for a run without a
 * reload.
 *
 * The worker's reconciler marks a silent run stale after 2 minutes and
 * lost after 30, and notifies flightdeck_fleet for every session it
 * moves; the API hub broadcasts the re-read session as a
 * session_update carrying no event. Each test creates its own agent and
 * run through ingestion, opens the page with the live stream on, and
 * then backdates only its own run's last_seen_at so the next reconciler
 * tick (5 s on the dev and E2E stacks) moves it. The status badge must
 * follow:
 *
 * - the Fleet swimlane row's badge goes from active to stale;
 * - a run silent past both thresholds shows lost;
 * - the Agents table row's state, which the fleet store re-derives
 *   from the agent's runs, drops from active to stale.
 *
 * A window marker set before the change and still present after it
 * shows the page did not reload.
 *
 * The E2E projects switch the live stream off for every spec (the
 * keep-alive flag in playwright.config.ts). This spec removes the flag
 * before the app loads, since the stream is what it tests.
 *
 * Theme-agnostic — structural locators and data attributes only; runs
 * under both the neon-dark and clean-light theme projects.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { DISABLE_KEEPALIVE_WS_STORAGE_KEY } from "../../src/lib/constants";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

const AUTH = { Authorization: "Bearer tok_dev" };
const INGEST = "http://localhost:4000/ingest/v1";
const API = "http://localhost:4000/api/v1";
const HOST = "e2e-t149-host";

/** How long the setup waits for the worker to store a run. */
const WORKER_WAIT_MS = 15_000;
/** How long a badge may take to follow a backdated run: up to one
 *  reconciler interval (5 s) to the next tick, a tick that had already
 *  read the row before the backdate can push it one more, then the
 *  notification, the hub's re-read and a render. */
const TRANSITION_WAIT_MS = 15_000;
/** Past the worker's 2-minute stale threshold, short of 30-minute lost. */
const STALE_AGO = "3 minutes";
/** Past the worker's 30-minute lost threshold. */
const LOST_AGO = "31 minutes";
/** Set on the window before the change; a reload would clear it. */
const NO_RELOAD_MARKER = "__t149NoReload";

interface Run {
  sessionId: string;
  agentId: string;
  agentName: string;
  flavor: string;
}

function newRun(project: string): Run {
  const suffix = randomUUID().slice(0, 8);
  return {
    sessionId: randomUUID(),
    agentId: randomUUID(),
    agentName: `e2e-t149-${project}-${suffix}`,
    flavor: `e2e-t149-${project}-${suffix}`,
  };
}

function sessionStart(run: Run): Record<string, unknown> {
  return {
    session_id: run.sessionId,
    flavor: run.flavor,
    event_type: "session_start",
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
    capture_prompts: true,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent_id: run.agentId,
    agent_type: "production",
    agent_name: run.agentName,
    client_type: "flightdeck_sensor",
    user: "e2e",
    hostname: HOST,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  };
}

/** Start the run and wait until the worker has stored it as active. */
async function startRun(api: APIRequestContext, run: Run): Promise<void> {
  const resp = await api.post(`${INGEST}/events`, { headers: AUTH, data: sessionStart(run) });
  expect(resp.ok(), `POST session_start: ${resp.status()} ${await resp.text()}`).toBe(true);
  await expect
    .poll(
      async () => {
        const resp = await api.get(`${API}/sessions/${run.sessionId}`, { headers: AUTH });
        if (!resp.ok()) return null;
        return ((await resp.json()) as { session: { state: string } }).session.state;
      },
      { timeout: WORKER_WAIT_MS, message: `run ${run.sessionId} was not stored` },
    )
    .toBe("active");
}

/** Run SQL against the stack's Postgres, values bound as psql
 *  variables, and return psql's trimmed output. */
function psql(sql: string, vars: Record<string, string>): string {
  const args = [
    "exec",
    "-i",
    "docker-postgres-1",
    "psql",
    "-U",
    "flightdeck",
    "-d",
    "flightdeck",
    "-tA",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  const result = spawnSync("docker", args, { input: sql, encoding: "utf8" });
  if (result.error) throw new Error(`psql: failed to run docker: ${result.error.message}`);
  expect(result.status, `psql: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

/** Move this run's own last signal into the past, so the next
 *  reconciler tick acts on it. Touches no other row. */
function backdate(run: Run, ago: string): void {
  const out = psql(
    "UPDATE sessions SET last_seen_at = NOW() - CAST(:'ago' AS interval) " +
      "WHERE session_id = :'sid'::uuid",
    { sid: run.sessionId, ago },
  );
  expect(out).toBe("UPDATE 1");
}

/** Remove what this test's run wrote. The flavor is the run's own, so
 *  nothing removed belongs to another test; without this every run
 *  would leave a new agent on a shared stack. */
function removeRun(run: Run): void {
  psql(
    `BEGIN;
     DELETE FROM event_content WHERE session_id IN
       (SELECT session_id FROM sessions WHERE flavor = :'flavor');
     DELETE FROM events WHERE session_id IN
       (SELECT session_id FROM sessions WHERE flavor = :'flavor');
     DELETE FROM directives WHERE session_id IN
       (SELECT session_id FROM sessions WHERE flavor = :'flavor');
     WITH gone AS (DELETE FROM sessions WHERE flavor = :'flavor' RETURNING agent_id)
     DELETE FROM agents a USING (SELECT DISTINCT agent_id FROM gone) g
     WHERE a.agent_id = g.agent_id
       AND NOT EXISTS (SELECT 1 FROM sessions o
                       WHERE o.agent_id = a.agent_id AND o.flavor <> :'flavor');
     COMMIT;`,
    { flavor: run.flavor },
  );
}

async function markNoReload(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, boolean>)[key] = true;
  }, NO_RELOAD_MARKER);
}

async function stillTheSamePage(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, boolean>)[key] === true,
    NO_RELOAD_MARKER,
  );
}

test.describe("T149 — Fleet follows the worker's state changes without a reload", () => {
  let run: Run;

  test.beforeEach(async ({ page }, testInfo) => {
    run = newRun(testInfo.project.name);
    // The stream is what this spec tests: drop the keep-alive flag the
    // project's storage state sets, before the app reads it at import.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, DISABLE_KEEPALIVE_WS_STORAGE_KEY);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the swimlane badge goes from active to stale when the run goes silent", async ({
    page,
    request,
  }) => {
    await startRun(request, run);
    await page.goto("/");
    await waitForFleetReady(page);
    const row = await bringSwimlaneRowIntoView(page, run.agentName);
    const badge = row.locator('[data-testid="swimlane-agent-status-badge"]');
    await expect(badge).toHaveAttribute("data-state", "active");
    await markNoReload(page);

    backdate(run, STALE_AGO);

    await expect(badge).toHaveAttribute("data-state", "stale", { timeout: TRANSITION_WAIT_MS });
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("a run silent past both thresholds shows lost", async ({ page, request }) => {
    await startRun(request, run);
    await page.goto("/");
    await waitForFleetReady(page);
    const row = await bringSwimlaneRowIntoView(page, run.agentName);
    const badge = row.locator('[data-testid="swimlane-agent-status-badge"]');
    await expect(badge).toHaveAttribute("data-state", "active");
    await markNoReload(page);

    backdate(run, LOST_AGO);

    await expect(badge).toHaveAttribute("data-state", "lost", { timeout: TRANSITION_WAIT_MS });
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("the Agents table row's state drops from active to stale", async ({ page, request }) => {
    await startRun(request, run);
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();
    // Narrow the roster to this agent; the search filters the live
    // store's rows, so the row keeps following its updates.
    await page.locator('[data-testid="agents-search-input"]').fill(run.agentName);
    const agentRow = page.locator(`[data-testid="agent-row-${run.agentId}"]`);
    await expect(agentRow).toHaveAttribute("data-agent-state", "active", {
      timeout: WORKER_WAIT_MS,
    });
    await markNoReload(page);

    backdate(run, STALE_AGO);

    await expect(agentRow).toHaveAttribute("data-agent-state", "stale", {
      timeout: TRANSITION_WAIT_MS,
    });
    expect(await stillTheSamePage(page)).toBe(true);
  });
});
