import type { FullConfig } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LONG_RUN_FIXTURE } from "./_fixtures";
import { BASE_URL } from "./_stack";

// Playwright global setup hook. Seeds the canonical E2E fixture
// dataset into the running dev stack before any project starts.
//
// The seeder lives outside the dashboard package because the same
// event-builder helpers (tests/shared/fixtures.py) drive the pytest
// integration suite — one copy of the HTTP/identity contract is
// better than two that drift. Shelling to python3 from TypeScript is
// the cost of that sharing, paid once per `playwright test` invocation.
//
// Interpreter selection: respect the PYTHON env var when set
// (CI threads PYTHON=python through the workflow; local dev loops
// without venv activation can point at sensor/.venv/bin/python). Fall
// back to python3 on PATH — works whether the user has the venv
// activated or installed flightdeck_sensor into the system interpreter.
//
// The script is idempotent: repeat runs against an already-seeded
// stack skip sessions whose event counts clear the completeness bar,
// so local dev loops don't pay the seed cost every time the user
// re-runs Playwright.
//
// dashboard/package.json is ``"type": "module"`` so __dirname is not
// injected. Recover it from import.meta.url the ESM way.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The binary serves the dashboard it embeds, and `make dev` returns
// only once both of its health endpoints answer, so a stack that is up
// serves / at once. This wait is the run's check that a stack with a
// dashboard answers at the base URL at all: without one every spec
// would fail on its first navigation, each with its own timeout. Half
// a minute covers a stack that is restarting (`make dev-restart`) when
// the run starts, without holding a run that has no stack for long.
const DASHBOARD_READY_TIMEOUT_MS = 30_000;
// One request a second is enough to start the suite within a second of
// the dashboard coming up.
const DASHBOARD_READY_POLL_MS = 1_000;

async function waitForDashboard(baseURL: string): Promise<void> {
  const deadline = Date.now() + DASHBOARD_READY_TIMEOUT_MS;
  let last = "no response yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseURL, { redirect: "manual" });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, DASHBOARD_READY_POLL_MS));
  }
  throw new Error(
    `globalSetup: the dashboard at ${baseURL} did not serve within ` +
      `${DASHBOARD_READY_TIMEOUT_MS / 1000}s (last: ${last}). Is the dev stack up (make dev)? ` +
      `A 503 means the binary has no dashboard bundle: start it without FLIGHTDECK_DEV_WEBUI=0.`,
  );
}

const AUTH = { Authorization: "Bearer tok_dev" };

// How long the worker gets to store the long-run fixture after it is
// posted. It stores a run's events one at a time, each its own commit:
// the 2,051 events took 6 to 9 s on a CI runner and 12 to 15 s on a
// WSL dev box. Two minutes leaves room for a slow runner without
// hiding a worker that never stores the run.
const LONG_RUN_STORED_TIMEOUT_MS = 120_000;
// Two small API reads per poll; four a second starts the suite within
// a quarter second of the last event landing.
const LONG_RUN_POLL_MS = 250;

/** The run of the newest stored needle, or null while none is searchable. */
async function longRunSession(api: string): Promise<string | null> {
  const res = await fetch(`${api}/v1/search?q=${LONG_RUN_FIXTURE.needle}`, { headers: AUTH });
  if (!res.ok) return null;
  const body = (await res.json()) as { events?: { tool_name: string; session_id: string }[] };
  const hit = (body.events ?? []).find((e) => e.tool_name === LONG_RUN_FIXTURE.needle);
  return hit?.session_id ?? null;
}

/** How many events the run holds. */
async function runEventCount(api: string, sessionId: string): Promise<number> {
  const res = await fetch(
    `${api}/v1/events?from=1970-01-01T00:00:00Z&session_id=${sessionId}&limit=1`,
    { headers: AUTH },
  );
  if (!res.ok) return 0;
  return ((await res.json()) as { total: number }).total;
}

// Seed the long-run fixture when the stack has none, then wait until
// the worker has stored every event of it. The needle is posted last,
// so a stack whose needle is searchable was seeded by an earlier run.
// Here, not in the spec that reads it: see LONG_RUN_FIXTURE.
async function ensureLongRun(baseURL: string, python: string, repoRoot: string): Promise<void> {
  const api = `${baseURL}/api`;
  if ((await longRunSession(api)) === null) {
    // The seeder posts through the fixtures module, which takes the
    // stack from the FLIGHTDECK_TEST_* variables. Every other
    // FLIGHTDECK_* variable is a sensor or plugin setting of the
    // developer's own shell and stays out of the child.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("FLIGHTDECK_") && !key.startsWith("FLIGHTDECK_TEST_")) delete env[key];
    }
    const script = resolve(repoRoot, "tests", "e2e-fixtures", "seed_long_run.py");
    const result = spawnSync(
      python,
      [script, LONG_RUN_FIXTURE.needle, String(LONG_RUN_FIXTURE.calls)],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    if (result.error) {
      throw new Error(`globalSetup: failed to spawn ${python} for seed_long_run.py: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`globalSetup: seed_long_run.py exited ${result.status}: ${result.stderr}`);
    }
  }
  const deadline = Date.now() + LONG_RUN_STORED_TIMEOUT_MS;
  let stored = 0;
  while (Date.now() < deadline) {
    const sessionId = await longRunSession(api);
    stored = sessionId ? await runEventCount(api, sessionId) : 0;
    if (stored > LONG_RUN_FIXTURE.calls) return;
    await new Promise((r) => setTimeout(r, LONG_RUN_POLL_MS));
  }
  throw new Error(
    `globalSetup: the long-run fixture was not stored within ${LONG_RUN_STORED_TIMEOUT_MS / 1000}s ` +
      `(${stored} of its events are stored, more than ${LONG_RUN_FIXTURE.calls} are expected). ` +
      `Is the worker consuming?`,
  );
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? BASE_URL;
  const tReady = Date.now();
  await waitForDashboard(baseURL);
  console.log(
    `[playwright globalSetup] dashboard ready after ${((Date.now() - tReady) / 1000).toFixed(1)}s`,
  );

  const repoRoot = resolve(__dirname, "..", "..", "..");
  const seedScript = resolve(repoRoot, "tests", "e2e-fixtures", "seed.py");
  const python = process.env.PYTHON ?? "python3";

  const t0 = Date.now();
  const result = spawnSync(python, [seedScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw new Error(
      `globalSetup: failed to spawn ${python} seeder: ${result.error.message}. ` +
        `Is ${python} on PATH? Set PYTHON to override. ` +
        `Is the dev stack running (make dev)?`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `globalSetup: seeder exited with status ${result.status}. ` +
        `Check stderr above for details (commonly: dev stack not up, or ` +
        `FLIGHTDECK_* env vars interfering).`,
    );
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // Keep the success line terse; the seeder itself prints per-session
  // seeded/skipped/backdated counts so re-printing them here would be
  // noise.
  console.log(`[playwright globalSetup] seed complete in ${elapsed}s`);

  const tLongRun = Date.now();
  await ensureLongRun(baseURL, python, repoRoot);
  console.log(
    `[playwright globalSetup] long-run fixture stored after ${((Date.now() - tLongRun) / 1000).toFixed(1)}s`,
  );

  // ── Keep-alive watchdog ────────────────────────────────────────────
  // The workers reconciler (ReconcileStaleSessions in
  // workers/internal/writer/writer.go, ticking every
  // FLIGHTDECK_RECONCILER_INTERVAL_SECS, 5 s on the dev stack) marks
  // state='active' → 'stale' on any session whose ``last_seen_at`` is
  // older than the 2-min stale threshold.
  // The seeded active-class fixtures (fresh-active / error-active /
  // mcp-active / policy-active) are pinned at seed time; without
  // refresh they age past stale within ~2-3 min of CI runtime, after
  // which tests filtering ``?state=active`` return 0 results.
  //
  // The sub-agent E2E specs (T28-T40) pushed total CI suite
  // runtime past 5 minutes — well beyond the seed-once-then-test
  // assumption. Before them the suite finished inside the 2-min window
  // and got away with no keep-alive. T14, T15, T25-18 fail in
  // neon-dark (the second-half of the test queue) for exactly this
  // reason; the same tests pass in clean-light because clean-light
  // tests run earlier while fixtures are still fresh.
  //
  // The watchdog spawns a detached background bash loop that calls
  // ``seed.py --reseed-active-only`` every 30 sec — well under the
  // 2-min stale threshold, which is what matters; the tick only sets
  // how soon after that threshold a row is marked — so active
  // fixtures stay state='active' for the entire test run regardless
  // of suite duration. globalTeardown.ts reads the PID off
  // ``globalThis.__flightdeck_e2e_keepalive_pid`` and SIGTERMs it
  // when the runner exits.
  const KEEPALIVE_INTERVAL_SEC = 30;
  const child = spawn(
    "bash",
    [
      "-c",
      `while true; do "${python}" "${seedScript}" --reseed-active-only ` +
        `>/dev/null 2>&1; sleep ${KEEPALIVE_INTERVAL_SEC}; done`,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "ignore",
      detached: true,
    },
  );
  // Detach so the child survives if the parent exits abnormally; the
  // teardown's SIGTERM is the normal exit path. ``unref`` lets the
  // Node event loop drain even though the child is alive.
  child.unref();
  (globalThis as unknown as Record<string, unknown>)
    .__flightdeck_e2e_keepalive_pid = child.pid;
  console.log(
    `[playwright globalSetup] keep-alive watchdog started ` +
      `(pid=${child.pid}, interval=${KEEPALIVE_INTERVAL_SEC}s)`,
  );
}
