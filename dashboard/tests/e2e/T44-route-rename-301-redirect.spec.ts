/**
 * T44 — /investigate -> /events 301 redirect.
 *
 * The Investigate page renders at the ``/events`` route in the
 * Vite router; the nginx edge keeps a permanent 301 from
 * ``/investigate`` so operator bookmarks, saved deep links, and
 * any external references continue to resolve. This spec pins the
 * three guarantees on that redirect:
 *
 *   1. Direct HTTP probe (no following) returns 301 with
 *      ``Location: /events`` (or query-preserving variant).
 *   2. Browser-level ``page.goto('/investigate?...')`` resolves
 *      to ``/events?...`` — the URL bar must reflect the new
 *      canonical path, not the legacy one.
 *   3. Query strings survive the redirect verbatim, so
 *      ``/investigate?agent_id=<uuid>`` reaches the same
 *      filtered view as the renamed route.
 *
 * Theme-agnostic by construction: the spec doesn't touch rendered
 * DOM beyond the URL bar, so both ``neon-dark`` and ``clean-light``
 * projects exercise the same redirect contract (Rule 40c.3).
 */
import { test, expect } from "@playwright/test";

test.describe("/investigate -> /events route rename", () => {
  test("direct HTTP probe returns 301 to /events", async ({ request }) => {
    // ``maxRedirects: 0`` keeps Playwright's request fixture from
    // silently following the 301 so we can inspect the Location
    // header itself. The probe runs against the nginx edge — which
    // is what production users hit — not the Vite dev server.
    const res = await request.get("/investigate", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    const location = res.headers()["location"];
    expect(location).toBeDefined();
    expect(location).toMatch(/\/events($|\?)/);
  });

  test("direct HTTP probe preserves query string verbatim", async ({
    request,
  }) => {
    const res = await request.get(
      "/investigate?agent_id=550e8400-e29b-41d4-a716-446655440000",
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(301);
    expect(res.headers()["location"]).toContain(
      "/events?agent_id=550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("browser navigation lands on /events with the address bar updated", async ({
    page,
  }) => {
    await page.goto("/investigate");
    // After the 301, the browser URL bar must read /events — not
    // /investigate. Assertion uses toHaveURL so Playwright polls
    // until the renderer settles on the post-redirect URL rather
    // than racing the redirect on its first frame.
    await expect(page).toHaveURL(/\/events($|\?|#)/);
  });

  test("deep link query params survive the redirect end-to-end", async ({
    page,
  }) => {
    await page.goto(
      "/investigate?agent_id=550e8400-e29b-41d4-a716-446655440000",
    );
    await expect(page).toHaveURL(
      /\/events\?agent_id=550e8400-e29b-41d4-a716-446655440000/,
    );
  });
});
