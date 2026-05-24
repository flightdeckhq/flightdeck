/**
 * T79 — navigating directly to `/events?run=<id>` opens the run
 * drawer on page load, with no click.
 *
 * Phase 4 wave 2 contract: `?run=` is the run-drawer deep-link
 * parameter. A bookmark or command-palette result that carries it
 * must resolve the run drawer immediately on load.
 *
 * Theme-agnostic — structural locators only.
 */
import { test, expect } from "@playwright/test";
import { CODING_AGENT } from "./_fixtures";

test.describe("T79 — /events ?run= deep-link", () => {
  test("?run=<id> opens the run drawer without a click", async ({ page }) => {
    // Resolve a real seeded session id for the coding-agent fixture.
    const sp = new URLSearchParams({
      flavor: CODING_AGENT.flavor,
      from: "2020-01-01T00:00:00Z",
      limit: "1",
    });
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions?${sp.toString()}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "sessions API call must succeed").toBe(true);
    const body = await resp.json();
    const sessions = (body.sessions ?? []) as Array<{ session_id: string }>;
    expect(
      sessions.length,
      "API must return ≥1 coding-agent session",
    ).toBeGreaterThanOrEqual(1);
    const sid = sessions[0].session_id;

    await page.goto(`/events?run=${sid}`);

    // The run drawer mounts from the URL param alone — no click.
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible({
      timeout: 10_000,
    });
    // The deep-link param survives — no redirect away from ?run=.
    await expect(page).toHaveURL(new RegExp(`run=${sid}`));
  });
});
