/**
 * T162 — The Prompts tab shows a tool call's captured arguments and
 * result.
 *
 * The sensor stores a tool call's arguments and result in
 * event_content's tool_input / tool_output columns and puts `{}` in the
 * response column. Each test posts a capture-on run through ingestion in
 * the sensor's own wire shape (interceptor/base.py and interceptor/mcp.py
 * build the content envelope), then opens it:
 *
 * - a sensor tool_call's Prompts tab, in the run drawer and in the event
 *   drawer, shows its arguments as fields and no `{}` response;
 * - an mcp_tool_call's Prompts tab shows its arguments and its result.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const AUTH = { Authorization: "Bearer tok_dev" };
const INGEST = "http://localhost:4000/ingest/v1";
const API = "http://localhost:4000/api/v1";
const HOST = "e2e-t162-host";

/** How long the setup waits for the worker to store a run's events. */
const WORKER_WAIT_MS = 15_000;

/** What the tests post as the tool calls' captured content. */
const TOOL_ARGS = { query: "eiffel tower completion year", type: "search" };
const MCP_ARGS = { path: "/etc/hosts" };
const MCP_RESULT = { content: [{ type: "text", text: "127.0.0.1 localhost" }], isError: false };
const MCP_SERVER = "filesystem";

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
    agentName: `e2e-t162-${project}-${suffix}`,
    flavor: `e2e-t162-${project}-${suffix}`,
  };
}

/** Each event a second after the last, so the run's order is fixed. */
function stamp(offsetSeconds: number): string {
  return new Date(Date.now() - 60_000 + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function event(
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
    agent_type: "production",
    agent_name: run.agentName,
    client_type: "flightdeck_sensor",
    user: "e2e",
    hostname: HOST,
    ...fields,
  };
}

/** The sensor's tool-capture content envelope (_build_tool_capture_content). */
function toolContent(run: Run, provider: string, model: string, toolInput: unknown, toolOutput: unknown) {
  return {
    system: null,
    messages: [],
    tools: null,
    response: {},
    input: null,
    tool_input: toolInput,
    tool_output: toolOutput,
    provider,
    model,
    session_id: run.sessionId,
    event_id: "",
    captured_at: new Date().toISOString(),
  };
}

const sessionStart = (run: Run) =>
  event(run, "session_start", 0, {
    capture_prompts: true,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  });

/** An LLM-side tool_call: arguments only, the sensor never sees the result. */
const toolCall = (run: Run) =>
  event(run, "tool_call", 1, {
    model: "gpt-4o-mini",
    tool_name: "web_search_call",
    has_content: true,
    content: toolContent(run, "llm", "gpt-4o-mini", TOOL_ARGS, null),
  });

const mcpToolCall = (run: Run) =>
  event(run, "mcp_tool_call", 2, {
    tool_name: "read_file",
    server_name: MCP_SERVER,
    transport: "stdio",
    duration_ms: 12,
    has_content: true,
    content: toolContent(run, "mcp", MCP_SERVER, MCP_ARGS, MCP_RESULT),
  });

async function post(api: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const resp = await api.post(`${INGEST}/events`, { headers: AUTH, data: body });
  expect(resp.ok(), `POST ${String(body.event_type)}: ${resp.status()} ${await resp.text()}`).toBe(
    true,
  );
}

interface StoredEvent {
  id: string;
  event_type: string;
  has_content: boolean;
}

/** Post the run and wait until the worker stored both tool calls with content. */
async function seedRun(api: APIRequestContext, run: Run): Promise<Record<string, StoredEvent>> {
  await post(api, sessionStart(run));
  await post(api, toolCall(run));
  await post(api, mcpToolCall(run));
  let byType: Record<string, StoredEvent> = {};
  await expect
    .poll(
      async () => {
        const resp = await api.get(`${API}/sessions/${run.sessionId}`, { headers: AUTH });
        if (!resp.ok()) return 0;
        const events = ((await resp.json()) as { events: StoredEvent[] }).events;
        byType = Object.fromEntries(events.map((e) => [e.event_type, e]));
        return events.filter((e) => e.has_content).length;
      },
      { timeout: WORKER_WAIT_MS, message: `run ${run.sessionId} did not store its tool content` },
    )
    .toBe(2);
  return byType;
}

/** Remove what this test's run wrote, by its session id, and its agent
 *  when no other session belongs to it. */
function removeRun(run: Run): void {
  const args = [
    "exec", "-i", "docker-postgres-1", "psql", "-U", "flightdeck", "-d", "flightdeck",
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

/** The event drawer's Prompts tab for one event. */
async function openEventPrompts(page: Page, run: Run, eventId: string) {
  await page.goto(`/events?event=${eventId}&event_session=${run.sessionId}`);
  const drawer = page.getByTestId("event-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-tab-prompts").click();
  return drawer;
}

test.describe("T162 — the Prompts tab shows a tool call's arguments and result", () => {
  let run: Run;

  test.beforeEach(() => {
    run = newRun(test.info().project.name);
  });

  test.afterEach(() => {
    removeRun(run);
  });

  test("the API serves the tool call's arguments in tool_input", async ({ request }) => {
    const events = await seedRun(request, run);
    const resp = await request.get(`${API}/events/${events.tool_call!.id}/content`, { headers: AUTH });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { tool_input?: unknown; response?: unknown };
    expect(body.tool_input).toEqual(TOOL_ARGS);
    expect(body.response).toEqual({});
  });

  test("a sensor tool_call's Prompts tab shows its arguments, in the run drawer and the event drawer", async ({
    page,
    request,
  }) => {
    const events = await seedRun(request, run);
    const toolCallId = events.tool_call!.id;

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

    // The event drawer shows the same.
    const drawer = await openEventPrompts(page, run, toolCallId);
    const args = drawer.getByTestId("prompt-box-tool-input");
    await expect(args).toBeVisible();
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
    const events = await seedRun(request, run);
    const drawer = await openEventPrompts(page, run, events.mcp_tool_call!.id);
    await expect(drawer.getByTestId("prompt-box-tool-input")).toContainText(MCP_ARGS.path);
    const result = drawer.getByTestId("prompt-box-tool-output");
    await expect(result).toBeVisible();
    await expect(result).toContainText("127.0.0.1 localhost");
    await expect(drawer.getByTestId("prompt-box-response")).toHaveCount(0);
  });
});
