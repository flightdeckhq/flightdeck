import { test, expect, type APIRequestContext } from "@playwright/test";
import { SWIMLANE_LOOKBACK_SEC, waitForFleetReady } from "./_fixtures";

// T130 — the Fleet sidebar's agent-row controls reach every live run of
// that agent that can act, and nothing else. Agents A and B share one
// flavor. Stop All on A's row, and a custom directive sent from it,
// reach A's two runs the page shows and a third live run of A the page
// never loaded (it started past the swimlane's 24 h sessions page and
// behind five newer runs of A), and never B's run. The delivery check
// asks ingestion the way a sensor does: the next event of each run
// returns its pending directive and marks it delivered, so nothing is
// left pending. Assertions are structural, theme-agnostic (Rule 40c.3).
//
// The fixture is this spec's own, created through ingestion with fixed
// ids and refreshed on every run (each run's session_start makes the
// live runs active again). One set per theme project: the projects run
// at the same time, and a directive one sends must not reach the
// other's runs. It is not one of the seed's keep-alive roles, whose
// periodic events would take a pending directive before the check.

const AUTH = { Authorization: "Bearer tok_dev" };
const INGEST = "http://localhost:4000/ingest/v1";
const API = "http://localhost:4000/api/v1";
const HOST = "e2e-fleet-controls-host";

/** Age of the run the page never loads, in hours: past the swimlane's
 *  24 h sessions page and inside ingestion's 48 h clock-skew window. */
const UNLOADED_RUN_AGE_HOURS = 30;
/** The fleet's per-agent rollup carries an agent's five newest runs
 *  (RecentSessionsPerAgent in api/internal/store/postgres.go); the
 *  unloaded run sits behind at least that many. */
const RECENT_SESSIONS_PER_AGENT = 5;
/** How long the setup waits for the worker to store a run's state. */
const WORKER_WAIT_MS = 15_000;
/** session_start attempts per live run. A run the setup has just
 *  created with a backdated event can be closed by the reconciler's
 *  orphan reap before its session_start lands; the next start revives
 *  it. */
const START_ATTEMPTS = 3;
/** Heartbeats the setup sends at most to drain a live run's leftover
 *  pending directives; a run interrupted mid-test leaves at most two. */
const MAX_DRAIN_POSTS = 10;

interface Agent {
  id: string;
  name: string;
}
interface Run {
  sessionId: string;
  agent: Agent;
}
interface Envelope {
  directive?: {
    action: string;
    payload?: { fingerprint?: string; directive_name?: string } | null;
  } | null;
}

function fixtureFor(project: string) {
  const n = project === "clean-light" ? "2" : "1";
  const id = (tail: string) => `e2e13000-000${n}-4000-8000-${tail.padStart(12, "0")}`;
  const agentA: Agent = { id: id("a"), name: `e2e-test-fleet-controls-a-${project}` };
  const agentB: Agent = { id: id("b"), name: `e2e-test-fleet-controls-b-${project}` };
  return {
    flavor: `e2e-fleet-controls-${project}`,
    agentA,
    agentB,
    /** A's live runs the page loads. */
    loadedRuns: [
      { sessionId: id("a1"), agent: agentA },
      { sessionId: id("a2"), agent: agentA },
    ],
    /** A live run of A the page never loads. */
    unloadedRun: { sessionId: id("a0"), agent: agentA },
    /** A's closed runs: with the two loaded ones, five runs newer than
     *  the unloaded one. */
    closedRuns: ["ac1", "ac2", "ac3"].map((t) => ({ sessionId: id(t), agent: agentA })),
    /** B's live run, in A's flavor. */
    otherAgentRun: { sessionId: id("b1"), agent: agentB },
    directive: {
      name: "e2e_fleet_controls_rotate",
      fingerprint: `e2e-fleet-controls-${project}`,
    },
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

function eventFor(
  fx: Fixture,
  run: Run,
  eventType: string,
  at: Date = new Date(),
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: run.sessionId,
    flavor: fx.flavor,
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
    capture_prompts: true,
    timestamp: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent_id: run.agent.id,
    agent_type: "production",
    agent_name: run.agent.name,
    client_type: "flightdeck_sensor",
    user: "e2e",
    hostname: HOST,
    ...extra,
  };
  if (eventType === "session_start") {
    payload.sensor_version = "e2e-fixture/0.0.0";
    payload.context = { os: "Linux", arch: "x86_64", hostname: HOST, user: "e2e" };
  }
  return payload;
}

async function postEvent(api: APIRequestContext, payload: Record<string, unknown>): Promise<Envelope> {
  const resp = await api.post(`${INGEST}/events`, { headers: AUTH, data: payload });
  expect(
    resp.ok(),
    `POST /v1/events ${String(payload.event_type)} for ${String(payload.session_id)}: ${resp.status()} ${await resp.text()}`,
  ).toBe(true);
  return (await resp.json()) as Envelope;
}

/** The run's session row, or null before the worker has stored it. */
async function sessionRow(
  api: APIRequestContext,
  sessionId: string,
): Promise<{ state: string; started_at: string } | null> {
  const resp = await api.get(`${API}/sessions/${sessionId}`, { headers: AUTH });
  if (resp.status() === 404) return null;
  expect(resp.ok(), `GET /v1/sessions/${sessionId}: ${resp.status()}`).toBe(true);
  return ((await resp.json()) as { session: { state: string; started_at: string } }).session;
}

async function waitForState(api: APIRequestContext, run: Run, state: string | "stored"): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await sessionRow(api, run.sessionId);
        return state === "stored" ? row !== null : row?.state;
      },
      { timeout: WORKER_WAIT_MS, message: `run ${run.sessionId} did not reach ${state}` },
    )
    .toBe(state === "stored" ? true : state);
}

/** session_start makes a run active again and keeps its started_at. */
async function startUntilActive(api: APIRequestContext, fx: Fixture, run: Run): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await postEvent(api, eventFor(fx, run, "session_start"));
    try {
      await waitForState(api, run, "active");
      return;
    } catch (err) {
      if (attempt >= START_ATTEMPTS) throw err;
    }
  }
}

/** Take a live run's leftover pending directives (from a run of this
 *  spec that stopped before its delivery check) so the check reads only
 *  the directive the test sends. */
async function drainPending(api: APIRequestContext, run: Run): Promise<void> {
  for (let i = 0; i < MAX_DRAIN_POSTS; i++) {
    const resp = await api.post(`${INGEST}/heartbeat`, {
      headers: AUTH,
      data: { session_id: run.sessionId },
    });
    expect(resp.ok(), `heartbeat ${run.sessionId}: ${resp.status()}`).toBe(true);
    if (!((await resp.json()) as Envelope).directive) return;
  }
  throw new Error(`run ${run.sessionId} still has pending directives after ${MAX_DRAIN_POSTS} heartbeats`);
}

async function prepareFixture(api: APIRequestContext, fx: Fixture): Promise<void> {
  // The custom directive the shared flavor registers (an upsert).
  const register = await api.post(`${API}/directives/register`, {
    headers: AUTH,
    data: {
      flavor: fx.flavor,
      directives: [
        {
          fingerprint: fx.directive.fingerprint,
          name: fx.directive.name,
          description: "E2E fixture directive",
          flavor: fx.flavor,
          parameters: [],
        },
      ],
    },
  });
  expect(register.ok(), `register directive: ${register.status()}`).toBe(true);

  // A's closed runs, created once.
  for (const run of fx.closedRuns) {
    const row = await sessionRow(api, run.sessionId);
    if (row === null) {
      await postEvent(api, eventFor(fx, run, "session_start"));
      await waitForState(api, run, "stored");
    }
    if (row?.state !== "closed") {
      await postEvent(api, eventFor(fx, run, "session_end"));
      await waitForState(api, run, "closed");
    }
  }

  // The run the page never loads is created by a backdated event: a run
  // a non-start event creates starts at that event's time.
  if ((await sessionRow(api, fx.unloadedRun.sessionId)) === null) {
    const startedAt = new Date(Date.now() - UNLOADED_RUN_AGE_HOURS * 60 * 60 * 1000);
    await postEvent(api, eventFor(fx, fx.unloadedRun, "post_call", startedAt, { tokens_total: 1 }));
    await waitForState(api, fx.unloadedRun, "stored");
  }

  const liveRuns = [...fx.loadedRuns, fx.unloadedRun, fx.otherAgentRun];
  for (const run of liveRuns) await startUntilActive(api, fx, run);
  for (const run of liveRuns) await drainPending(api, run);
}

/** One event per live run; returns the directive each response carries. */
async function deliveries(api: APIRequestContext, fx: Fixture, runs: Run[]) {
  const out: Record<string, Envelope["directive"]> = {};
  for (const run of runs) {
    const envelope = await postEvent(
      api,
      eventFor(fx, run, "post_call", new Date(), { tokens_total: 10 }),
    );
    out[run.sessionId] = envelope.directive ?? null;
  }
  return out;
}

test.describe("T130 — Fleet agent-row controls reach only that agent", () => {
  // Both tests direct the same runs; they must not interleave.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext();
    try {
      await prepareFixture(api, fixtureFor(testInfo.project.name));
    } finally {
      await api.dispose();
    }
  });

  test("Stop All stops every live run of the agent, one the page never loaded included, and no other agent's", async ({
    page,
    request,
  }, testInfo) => {
    const fx = fixtureFor(testInfo.project.name);

    // Precondition: the third live run is outside both windows the page
    // loads, so only a stop the API fans out can reach it.
    const unloaded = await sessionRow(request, fx.unloadedRun.sessionId);
    expect(unloaded?.state).toBe("active");
    const unloadedStart = Date.parse(unloaded!.started_at);
    expect(unloadedStart, "the run started before the swimlane's sessions page").toBeLessThan(
      Date.now() - SWIMLANE_LOOKBACK_SEC * 1000,
    );
    const listed = await request.get(`${API}/sessions`, {
      headers: AUTH,
      params: {
        agent_id: fx.agentA.id,
        from: new Date(unloadedStart - 60 * 60 * 1000).toISOString(),
        to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        limit: "50",
      },
    });
    expect(listed.ok()).toBe(true);
    const newer = ((await listed.json()) as { sessions: { started_at: string }[] }).sessions.filter(
      (s) => Date.parse(s.started_at) > unloadedStart,
    );
    expect(newer.length, "runs of A newer than the unloaded one").toBeGreaterThanOrEqual(
      RECENT_SESSIONS_PER_AGENT,
    );

    await page.goto("/");
    await waitForFleetReady(page);
    const row = page.getByTestId(`fleet-sidebar-agent-${fx.agentA.name}`);
    await expect(row).toBeVisible();
    await row.getByTestId(`flavor-stop-all-button-${fx.agentA.id}`).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(`Stop all runs of ${fx.agentA.name}?`);
    // The page holds two of A's three live runs: the dialog promises no
    // count.
    await expect(dialog).toContainText(
      "Every active or idle run of this agent that can take a stop will receive a shutdown directive, including runs this page has not loaded.",
    );
    await dialog.getByRole("button", { name: "Stop All", exact: true }).click();
    await expect(row.getByTestId(`flavor-stop-all-sent-${fx.agentA.id}`)).toHaveText(
      "Stop sent to 3 runs",
    );
    // The confirm click is inside the dialog, not on the row: the
    // sidebar is not filtered to the agent.
    await expect(row.getByRole("button", { name: "Clear filter" })).toHaveCount(0);

    const got = await deliveries(request, fx, [...fx.loadedRuns, fx.unloadedRun, fx.otherAgentRun]);
    for (const run of [...fx.loadedRuns, fx.unloadedRun]) {
      expect(got[run.sessionId]?.action, `A's run ${run.sessionId}`).toBe("shutdown");
    }
    expect(got[fx.otherAgentRun.sessionId], "B's run shares the flavor but not the agent").toBeNull();
  });

  test("a custom directive sent from the agent's row reaches only that agent's runs", async ({
    page,
    request,
  }, testInfo) => {
    const fx = fixtureFor(testInfo.project.name);
    await page.goto("/");
    await waitForFleetReady(page);
    const row = page.getByTestId(`fleet-sidebar-agent-${fx.agentA.name}`);
    await expect(row).toBeVisible();
    await row.getByTestId(`flavor-directives-button-${fx.agentA.id}`).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(`Trigger directives on ${fx.agentA.name}`);
    const run = dialog.getByTestId(`directive-run-${fx.directive.name}`);
    await expect(run).toHaveText("Trigger on this agent's runs");
    await run.click();
    await expect(dialog.getByTestId(`directive-sent-${fx.directive.name}`)).toHaveText(
      "Directive sent to 3 runs",
    );
    await expect(row.getByRole("button", { name: "Clear filter" })).toHaveCount(0);

    const got = await deliveries(request, fx, [...fx.loadedRuns, fx.unloadedRun, fx.otherAgentRun]);
    for (const r of [...fx.loadedRuns, fx.unloadedRun]) {
      const directive = got[r.sessionId];
      expect(directive?.action, `A's run ${r.sessionId}`).toBe("custom");
      expect(directive?.payload?.fingerprint).toBe(fx.directive.fingerprint);
      expect(directive?.payload?.directive_name).toBe(fx.directive.name);
    }
    expect(got[fx.otherAgentRun.sessionId], "B's run shares the flavor but not the agent").toBeNull();
  });
});
