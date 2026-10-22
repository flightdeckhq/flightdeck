import { test, expect } from "@playwright/test";

/**
 * T115 — no page asks for an agent summary without an agent id.
 *
 * Guarded regression: the per-agent swimlane modal stays mounted
 * while closed and called the summary hook with an empty id, so
 * every page load sent ``GET /v1/agents//summary`` and logged a 404
 * in the console. The hook now fetches nothing for an empty id.
 *
 * The /agents page still fetches real summaries (one per row), so
 * the journey also proves the guard did not stop legitimate
 * fetches. Theme-agnostic; runs under both Playwright projects.
 */
const ROUTES = ["/", "/agents", "/events", "/policies", "/directives", "/analytics", "/settings"];

test.describe("T115 — no empty-id agent summary request", () => {
  test("no route requests /v1/agents//summary; /agents requests real summaries", async ({
    page,
  }) => {
    const emptyIdRequests: string[] = [];
    const summaryRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/v1/agents//summary")) emptyIdRequests.push(url);
      else if (/\/v1\/agents\/[^/]+\/summary/.test(url)) summaryRequests.push(url);
    });

    for (const route of ROUTES) {
      await page.goto(route);
      if (route === "/agents") {
        await expect(
          page.locator('[data-testid^="agent-row-"]').first(),
        ).toBeVisible({ timeout: 10_000 });
        await expect.poll(() => summaryRequests.length).toBeGreaterThan(0);
      }
      // Let each page's mount-time requests go out. Bounded, as in
      // _fixtures.ts: a live dev stack keeps a WebSocket and polls
      // open, so idle may never be reached.
      try {
        await page.waitForLoadState("networkidle", { timeout: 5_000 });
      } catch {
        /* proceed with whatever has loaded */
      }
    }

    expect(emptyIdRequests).toEqual([]);
  });
});
