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
const THEME_STORAGE_KEY = "flightdeck:theme";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
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
  },
  projects: [
    {
      name: "neon-dark",
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
