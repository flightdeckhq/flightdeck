/**
 * A run that T162, T163 and T165 post through ingestion in the sensor's
 * own wire shape (T166 in the Claude Code plugin's): a session_start
 * declaring the capture posture, then
 * calls whose captured content travels in the event_content envelope
 * (T165: OpenAI Responses and litellm text_completion post_calls). T162 and T163 post tool
 * calls whose captured arguments and result travel in the event_content
 * envelope the sensor builds (interceptor/base.py and interceptor/mcp.py,
 * ``_build_tool_capture_content``): ``tool_input`` / ``tool_output``,
 * with ``{}`` in ``response``. Each test creates its own run and removes
 * it afterwards.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_URL, INGEST_URL, POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";

export const AUTH = { Authorization: "Bearer tok_dev" };
const INGEST = `${INGEST_URL}/v1`;
export const API = `${API_URL}/v1`;
const HOST = "e2e-tool-content-host";

/** How long the setup waits for the worker to store a run's events. */
const WORKER_WAIT_MS = 15_000;

/** What the tests post as the tool calls' captured content. */
export const TOOL_ARGS = { query: "eiffel tower completion year", type: "search" };
export const MCP_ARGS = { path: "/etc/hosts" };
export const MCP_RESULT = { content: [{ type: "text", text: "127.0.0.1 localhost" }], isError: false };
export const MCP_SERVER = "filesystem";
export const PROMPT_ARGS = { name: "Ada" };
export const PROMPT_RENDERED = [{ role: "user", content: { type: "text", text: "Greet Ada warmly" } }];

export interface Run {
  sessionId: string;
  agentId: string;
  agentName: string;
  flavor: string;
}

export function newRun(spec: string, project: string): Run {
  const suffix = randomUUID().slice(0, 8);
  return {
    sessionId: randomUUID(),
    agentId: randomUUID(),
    agentName: `e2e-${spec}-${project}-${suffix}`,
    flavor: `e2e-${spec}-${project}-${suffix}`,
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

/** The sensor's tool-capture content envelope. */
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

export const sessionStart = (run: Run, capturePrompts: boolean) =>
  event(run, "session_start", 0, {
    capture_prompts: capturePrompts,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  });

/** An LLM-side tool_call: arguments only, the sensor never sees the result. */
export const toolCall = (run: Run) =>
  event(run, "tool_call", 1, {
    model: "gpt-4o-mini",
    tool_name: "web_search_call",
    has_content: true,
    content: toolContent(run, "llm", "gpt-4o-mini", TOOL_ARGS, null),
  });

export const mcpToolCall = (run: Run) =>
  event(run, "mcp_tool_call", 2, {
    tool_name: "read_file",
    server_name: MCP_SERVER,
    transport: "stdio",
    duration_ms: 12,
    has_content: true,
    content: toolContent(run, "mcp", MCP_SERVER, MCP_ARGS, MCP_RESULT),
  });

export const mcpPromptGet = (run: Run) =>
  event(run, "mcp_prompt_get", 3, {
    tool_name: "greet",
    prompt_name: "greet",
    server_name: MCP_SERVER,
    transport: "stdio",
    duration_ms: 9,
    has_content: true,
    content: toolContent(run, "mcp", MCP_SERVER, PROMPT_ARGS, PROMPT_RENDERED),
  });

/** A post_call carrying the content envelope the sensor stores for it.
 *  T165 posts OpenAI Responses calls (instructions in ``system``,
 *  ``input`` verbatim, ``messages`` empty) and a litellm
 *  ``text_completion`` (its ``prompt`` in ``input``). */
export const contentPostCall = (run: Run, offsetSeconds: number, content: Record<string, unknown>) =>
  event(run, "post_call", offsetSeconds, {
    model: "gpt-4o-mini",
    provider: "openai",
    tokens_input: 40,
    tokens_output: 8,
    tokens_total: 48,
    latency_ms: 900,
    has_content: true,
    content: { ...content, session_id: run.sessionId, event_id: "" },
  });

/** The identity fields of the Claude Code plugin's events. */
const PLUGIN_FIELDS = { client_type: "claude_code", agent_type: "coding", framework: "claude-code" };

/** A session_start as the Claude Code plugin sends it, capture on (T166). */
export const pluginSessionStart = (run: Run) =>
  event(run, "session_start", 0, {
    ...PLUGIN_FIELDS,
    capture_prompts: true,
    sensor_version: "e2e-fixture/0.0.0",
    context: { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" },
  });

/** A tool_call as the Claude Code plugin sends it (T166): the sanitised
 *  input in ``tool_input`` and as a ``tool_use`` block under ``tools``,
 *  and the tool's response as the stored text of a ``tool_result`` block
 *  under ``response``. Each block names the values the plugin cut in its
 *  own ``truncated`` (JSON Pointers), beside the value. */
export const pluginToolCall = (
  run: Run,
  offsetSeconds: number,
  toolName: string,
  input: Record<string, unknown>,
  storedResult: string,
  cuts: { input?: string[]; output?: string[] } = {},
) =>
  event(run, "tool_call", offsetSeconds, {
    ...PLUGIN_FIELDS,
    model: "claude-opus-5-5",
    tool_name: toolName,
    tool_input: JSON.stringify(input),
    latency_ms: 4200,
    duration_ms: 4200,
    has_content: true,
    content: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      system: null,
      messages: [],
      tools: [{ type: "tool_use", name: toolName, input, ...(cuts.input ? { truncated: cuts.input } : {}) }],
      response: [{ type: "tool_result", content: storedResult, ...(cuts.output ? { truncated: cuts.output } : {}) }],
      session_id: run.sessionId,
      event_id: "",
    },
  });

/** An MCP tool call with nothing captured: what a capture-off run sends,
 *  and what a capture-on run sends for a call with no arguments or result. */
export const bareMcpToolCall = (run: Run) =>
  event(run, "mcp_tool_call", 4, {
    tool_name: "list_dir",
    server_name: MCP_SERVER,
    transport: "stdio",
    duration_ms: 7,
  });

async function post(api: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const resp = await api.post(`${INGEST}/events`, { headers: AUTH, data: body });
  expect(resp.ok(), `POST ${String(body.event_type)}: ${resp.status()} ${await resp.text()}`).toBe(
    true,
  );
}

export interface StoredEvent {
  id: string;
  event_type: string;
  tool_name: string | null;
  has_content: boolean;
}

/** Post the run's events in order and wait until the worker stored all of
 *  them; returns the stored events. */
export async function seedRun(
  api: APIRequestContext,
  run: Run,
  events: Record<string, unknown>[],
): Promise<StoredEvent[]> {
  for (const body of events) await post(api, body);
  let stored: StoredEvent[] = [];
  await expect
    .poll(
      async () => {
        const resp = await api.get(`${API}/sessions/${run.sessionId}`, { headers: AUTH });
        if (!resp.ok()) return 0;
        stored = ((await resp.json()) as { events: StoredEvent[] }).events;
        return stored.length;
      },
      { timeout: WORKER_WAIT_MS, message: `run ${run.sessionId} did not store its events` },
    )
    .toBe(events.length);
  return stored;
}

/** The stored event of a type (and tool name, when several share it). */
export function storedEvent(events: StoredEvent[], eventType: string, toolName?: string): StoredEvent {
  const found = events.find(
    (e) => e.event_type === eventType && (toolName === undefined || e.tool_name === toolName),
  );
  expect(found, `no stored ${eventType}${toolName ? ` ${toolName}` : ""}`).toBeDefined();
  return found!;
}

/** Remove what a run wrote, by its session id, and its agent when no
 *  other session belongs to it. */
export function removeRun(run: Run): void {
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

/** The event drawer for one event of the run, on its Details tab. */
export async function openEventDrawer(page: Page, run: Run, eventId: string) {
  await page.goto(`/events?event=${eventId}&event_session=${run.sessionId}`);
  const drawer = page.getByTestId("event-detail-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}
