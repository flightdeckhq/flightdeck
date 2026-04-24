import { defineConfig, devices } from "@playwright/test";

// D095 + Phase 5 Part 1b hardcoded access token. Every request
// (page navigations, XHRs, and fetches fired by the app) picks up
// this header so the dashboard reaches the gated /v1/* endpoints.
// Matches the dev-time ACCESS_TOKEN in src/lib/api.ts.
const ACCESS_TOKEN = "tok_dev";

// The dashboard renders in two themes -- neon-dark (default) and
// clean-light. Playwright projects map onto those themes by
// pre-setting the persisted theme in localStorage before each test,
// so a single spec file runs in both aesthetics without per-test
// branching. The theme key mirrors dashboard/src/hooks/useTheme.ts.
// Rule 40c.3 (theme coverage) relies on this shape: every spec runs
// under both projects and must not hardcode theme-specific selectors
// or colours.
const THEME_STORAGE_KEY = "flightdeck:theme";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // Rule 40c.1 (E2E stability). One retry on CI is a tolerance
  // buffer for genuine infrastructure blips (stack boot, NATS
  // reconnect, WSL disk flush). Zero locally so flakes surface on
  // the first run and get fixed, not hidden behind a retry window.
  retries: process.env.CI ? 1 : 0,
  // 30 s per test default; specs that need more (slow seed races,
  // large-data renders) override via test.setTimeout() inline.
  timeout: 30_000,
  // Dual reporter. "list" for human-readable local output; "html"
  // produces the artifact the E2E CI job uploads on failure. Keep
  // open:'never' so Playwright doesn't try to spawn a browser when
  // the CI runner finishes.
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  // Global setup seeds the canonical E2E fixtures via
  // tests/e2e-fixtures/seed.py before any project starts. The script
  // is idempotent -- re-running over a pre-seeded stack is a no-op --
  // so localhost dev loops don't pay the seed cost per invocation.
  // String path rather than require.resolve — dashboard/package.json
  // is "type": "module", so CommonJS require is not in scope.
  // Playwright resolves the path relative to this config file.
  globalSetup: "./tests/e2e/globalSetup.ts",
  use: {
    baseURL: "http://localhost:4000",
    // Auth-gated /v1/* endpoints need the bearer token on every
    // request the browser issues. Page navigations and XHRs both
    // pick this up; WebSocket upgrades use the ?token= query
    // parameter set by the app code (useFleet.ts).
    extraHTTPHeaders: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    trace: "retain-on-failure",
    // Screenshot on failure feeds the debugging path documented in
    // tests/e2e/README.md. Successful runs skip the capture so CI
    // artifact bundles stay small.
    screenshot: "only-on-failure",
  },
  projects: [
    // Fleet-read tests run under both themes. T11 is excluded because
    // it mutates fleet-wide state via POST /v1/admin/reconcile-agents
    // and the resulting websocket broadcast invalidates concurrently-
    // running read tests' in-flight assertions. The admin-ops-*
    // projects below re-run under both themes AFTER these complete,
    // via project ``dependencies``.
    {
      name: "neon-dark",
      testIgnore: /T11-.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        storageState: {
          cookies: [],
          origins: [
            {
              origin: "http://localhost:4000",
              localStorage: [
                { name: THEME_STORAGE_KEY, value: "neon-dark" },
              ],
            },
          ],
        },
      },
    },
    {
      name: "clean-light",
      testIgnore: /T11-.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        storageState: {
          cookies: [],
          origins: [
            {
              origin: "http://localhost:4000",
              localStorage: [
                { name: THEME_STORAGE_KEY, value: "clean-light" },
              ],
            },
          ],
        },
      },
    },
    // Admin-ops tests (currently only T11). Mutate fleet-wide state
    // and must run serially after the read tests have completed so
    // the reconcile's websocket broadcast doesn't race T1/T2/T5/T7/
    // T9's Fleet renderings. Project dependencies handle the
    // sequencing.
    //
    // The two admin-ops-* projects must ALSO be serial relative to
    // each other because both instances of T11 would otherwise run
    // reconcile in parallel and one's call corrects the drift the
    // other just created — leaving the second instance to observe
    // ``agents_updated=0`` and fail. The chain:
    //
    //   neon-dark + clean-light       (parallel)
    //     ↓
    //   admin-ops-neon-dark           (waits for both above)
    //     ↓
    //   admin-ops-clean-light         (waits for admin-ops-neon-dark)
    {
      name: "admin-ops-neon-dark",
      testMatch: /T11-.*\.spec\.ts/,
      dependencies: ["neon-dark", "clean-light"],
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        storageState: {
          cookies: [],
          origins: [
            {
              origin: "http://localhost:4000",
              localStorage: [
                { name: THEME_STORAGE_KEY, value: "neon-dark" },
              ],
            },
          ],
        },
      },
    },
    {
      name: "admin-ops-clean-light",
      testMatch: /T11-.*\.spec\.ts/,
      dependencies: ["admin-ops-neon-dark"],
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        storageState: {
          cookies: [],
          origins: [
            {
              origin: "http://localhost:4000",
              localStorage: [
                { name: THEME_STORAGE_KEY, value: "clean-light" },
              ],
            },
          ],
        },
      },
    },
  ],
});
