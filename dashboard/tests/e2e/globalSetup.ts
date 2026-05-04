import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export default async function globalSetup(): Promise<void> {
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

  // ── Keep-alive watchdog ────────────────────────────────────────────
  // The workers reconciler (workers/internal/writer/postgres.go:651,
  // 60-second tick, 2-min stale threshold) marks state='active' →
  // 'stale' on any session whose ``last_seen_at`` is older than 2 min.
  // The seeded active-class fixtures (fresh-active / error-active /
  // mcp-active / policy-active) are pinned at seed time; without
  // refresh they age past stale within ~2-3 min of CI runtime, after
  // which tests filtering ``?state=active`` return 0 results.
  //
  // D126 added 13 new E2E specs (T28-T40) that pushed total CI suite
  // runtime past 5 minutes — well beyond the seed-once-then-test
  // assumption. Pre-D126 the suite finished inside the 2-min window
  // and got away with no keep-alive. T14, T15, T25-18 fail in
  // neon-dark (the second-half of the test queue) for exactly this
  // reason; the same tests pass in clean-light because clean-light
  // tests run earlier while fixtures are still fresh.
  //
  // The watchdog spawns a detached background bash loop that calls
  // ``seed.py --reseed-active-only`` every 30 sec — well under the
  // 60-sec reconciler tick AND the 2-min stale threshold — so active
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
