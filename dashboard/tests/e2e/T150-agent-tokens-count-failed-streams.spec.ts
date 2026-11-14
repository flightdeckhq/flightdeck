/**
 * T150 — An agent's token total counts the tokens a failed stream was
 * billed for, and the Agents row adds them live.
 *
 * A stream that fails after the provider delivered usage reports the
 * billed tokens on its llm_error (error.partial_tokens_*); the worker
 * stores them as the event's token counts, and every token total counts
 * them like a call's, embeddings calls included. Each test creates its
 * own agent and run through ingestion:
 *
 * - after a load, the Agents row's token total is the call's, the
 *   embeddings call's and the failed stream's tokens together;
 * - with the live stream on, a failed stream posted while the page is
 *   open is added to the row without a reload (the live patch finds the
 *   agent from the session the broadcast carries).
 *
 * Theme-agnostic — structural locators and data attributes only; runs
 * under both the neon-dark and clean-light theme projects.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { DISABLE_KEEPALIVE_WS_STORAGE_KEY } from "../../src/lib/constants";
import { API_URL, INGEST_URL, POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";

const AUTH = { Authorization: "Bearer tok_dev" };
const INGEST = `${INGEST_URL}/v1`;
const API = `${API_URL}/v1`;
const HOST = "e2e-t150-host";

/** How long the setup waits for the worker to store a run's events. */
const WORKER_WAIT_MS = 15_000;
/** How long the Agents row may take to show a live event: the worker
 *  stores it, the hub broadcasts it, the hook patches the summary. */
const LIVE_WAIT_MS = 15_000;
/** Set on the window before the live event; a reload would clear it. */
const NO_RELOAD_MARKER = "__t150NoReload";

/** Billed tokens of each event the tests post. Below 1,000 in total, so
 *  the row prints them as a bare integer. */
const CALL = { in: 300, out: 100 };
const EMBEDDINGS = 50;
const FAILED_STREAM = { in: 450, out: 50 };

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
    agentName: `e2e-t150-${project}-${suffix}`,
    flavor: `e2e-t150-${project}-${suffix}`,
  };
}

function event(run: Run, eventType: string, fields: Record<string, unknown>): Record<string, unknown> {
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
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent_id: run.agentId,
    agent_type: "production",
    agent_name: run.agentName,
    client_type: "flightdeck_sensor",
    user: "e2e",
    hostname: HOST,
    ...fields,
  };
}

const sessionStart = (run: Run) =>
  event(run, "session_start", {
    capture_prompts: false,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  });

const call = (run: Run) =>
  event(run, "post_call", {
    model: "claude-sonnet-4-5",
    tokens_input: CALL.in,
    tokens_output: CALL.out,
    tokens_total: CALL.in + CALL.out,
    latency_ms: 900,
  });

const embeddings = (run: Run) =>
  event(run, "embeddings", {
    model: "text-embedding-3-small",
    tokens_input: EMBEDDINGS,
    tokens_output: 0,
    tokens_total: EMBEDDINGS,
    latency_ms: 120,
  });

const failedStream = (run: Run) =>
  event(run, "llm_error", {
    model: "claude-sonnet-4-5",
    latency_ms: 700,
    retry_attempt: 1,
    terminal: false,
    error: {
      error_type: "stream_error",
      provider: "anthropic",
      http_status: null,
      provider_error_code: null,
      error_message: "APIError",
      request_id: null,
      retry_after: null,
      is_retryable: true,
      abort_reason: "error_mid_stream",
      partial_chunks: 7,
      partial_tokens_input: FAILED_STREAM.in,
      partial_tokens_output: FAILED_STREAM.out,
    },
  });

async function post(api: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const resp = await api.post(`${INGEST}/events`, { headers: AUTH, data: body });
  expect(resp.ok(), `POST ${String(body.event_type)}: ${resp.status()} ${await resp.text()}`).toBe(
    true,
  );
}

/** Wait until the worker has added the run's tokens up to `total`. */
async function waitForTokens(api: APIRequestContext, run: Run, total: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const resp = await api.get(`${API}/sessions/${run.sessionId}`, { headers: AUTH });
        if (!resp.ok()) return null;
        return ((await resp.json()) as { session: { tokens_used: number } }).session.tokens_used;
      },
      { timeout: WORKER_WAIT_MS, message: `run ${run.sessionId} did not reach ${total} tokens` },
    )
    .toBe(total);
}

/** Remove what this test's run wrote, by its session id, and its agent
 *  when no other session belongs to it. */
function removeRun(run: Run): void {
  const args = [
    "exec", "-i", POSTGRES_CONTAINER, "psql", "-U", "flightdeck", "-d", POSTGRES_DB,
    "-tA", "-v", "ON_ERROR_STOP=1", "-v", `sid=${run.sessionId}`, "-v", `aid=${run.agentId}`,
  ];
  const sql = `BEGIN;
    DELETE FROM event_content WHERE session_id = :'sid'::uuid;
    DELETE FROM events WHERE session_id = :'sid'::uuid;
    DELETE FROM directives WHERE session_id = :'sid'::uuid;
    DELETE FROM sessions WHERE session_id = :'sid'::uuid;
    DELETE FROM agents WHERE agent_id = :'aid'::uuid
      AND NOT EXISTS (SELECT 1 FROM sessions WHERE agent_id = :'aid'::uuid);
    COMMIT;`;
  const result = spawnSync("docker", args, { input: sql, encoding: "utf8" });
  if (result.error) throw new Error(`psql: failed to run docker: ${result.error.message}`);
  expect(result.status, `psql: ${result.stderr}`).toBe(0);
}

/** The Agents page narrowed to this run's agent; returns its token total cell. */
async function agentTokensCell(page: Page, run: Run) {
  await page.goto("/agents");
  await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();
  await page.locator('[data-testid="agents-search-input"]').fill(run.agentName);
  await expect(page.locator(`[data-testid="agent-row-${run.agentId}"]`)).toBeVisible({
    timeout: WORKER_WAIT_MS,
  });
  return page.locator(`[data-testid="agent-row-tokens-total-${run.agentId}"]`);
}

test.describe("T150 — an agent's tokens count its failed streams", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun(test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the Agents row's token total counts a failed stream and an embeddings call", async ({
    page,
    request,
  }) => {
    await post(request, sessionStart(run));
    await post(request, call(run));
    await post(request, embeddings(run));
    await post(request, failedStream(run));
    const total = CALL.in + CALL.out + EMBEDDINGS + FAILED_STREAM.in + FAILED_STREAM.out;
    await waitForTokens(request, run, total);

    const cell = await agentTokensCell(page, run);
    await expect(cell).toHaveText(String(total));
  });

  test("a failed stream posted while the Agents page is open is added live", async ({
    page,
    request,
  }) => {
    // The live stream is what this test needs: drop the keep-alive flag
    // the project's storage state sets, before the app reads it.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, DISABLE_KEEPALIVE_WS_STORAGE_KEY);
    await post(request, sessionStart(run));
    await post(request, call(run));
    await waitForTokens(request, run, CALL.in + CALL.out);

    const cell = await agentTokensCell(page, run);
    await expect(cell).toHaveText(String(CALL.in + CALL.out));
    await page.evaluate((key) => {
      (window as unknown as Record<string, boolean>)[key] = true;
    }, NO_RELOAD_MARKER);

    await post(request, failedStream(run));

    await expect(cell).toHaveText(String(CALL.in + CALL.out + FAILED_STREAM.in + FAILED_STREAM.out), {
      timeout: LIVE_WAIT_MS,
    });
    const sameDocument = await page.evaluate(
      (key) => (window as unknown as Record<string, boolean>)[key] === true,
      NO_RELOAD_MARKER,
    );
    expect(sameDocument).toBe(true);
  });
});
