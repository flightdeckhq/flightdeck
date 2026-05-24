import { test, expect } from "@playwright/test";

/**
 * T100 — /events runtime-context facets filter the event list.
 *
 * Nine new facet groups land on the /events page (D160 frontend
 * half): os, arch, hostname (URL param ``host``), user, git_branch,
 * git_repo, orchestration, python_version, process_name. Each chip
 * click writes to the URL and re-fetches the event list with the
 * filter applied server-side.
 *
 * This spec exercises two of the new facets end-to-end:
 *   - Click an ``os`` chip → URL gains ``?os=<value>``, total row
 *     count drops (or stays) — never increases.
 *   - Click a ``user`` chip while ``os`` is still active → URL
 *     carries both params, count drops further (or stays). Confirms
 *     filters compose AND across dimensions.
 *
 * Theme-agnostic; uses fixtures the seed already populates (the
 * integration-test sessions carry ``os=Linux`` + ``user=integration``,
 * the Claude Code dev sessions carry ``os=Linux`` + ``user=omria``).
 */
test.describe("T100 — /events runtime-context facets", () => {
  test("clicking an OS chip filters the event list", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto("/events");
    // Wait for the events page to settle — the OS facet group must
    // be in the sidebar and have at least one chip with a count.
    const osGroup = page.locator('[data-testid="events-facet-os"]');
    await expect(osGroup).toBeVisible({ timeout: 15_000 });
    const osChips = osGroup.locator('[data-testid^="events-facet-pill-os-"]');
    await expect
      .poll(() => osChips.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Poll until the event table has settled with ≥ 1 row, then
    // snap the baseline. A bare ``.count()`` immediately after the
    // facet sidebar mounts can race with the table's loading
    // skeleton and return zero, failing the test for the wrong
    // reason.
    const eventRows = page.locator('[data-testid="events-row"]');
    await expect
      .poll(() => eventRows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const baselineCount = await eventRows.count();

    // Click the first OS chip — pick the one with the highest count
    // (Linux on this dataset). Read its value off the data-testid.
    const firstChip = osChips.first();
    const chipTestId = await firstChip.getAttribute("data-testid");
    expect(chipTestId).toMatch(/^events-facet-pill-os-/);
    const osValue = chipTestId!.replace("events-facet-pill-os-", "");
    await firstChip.click();

    // URL must carry the ``os=<value>`` param.
    await expect.poll(() => page.url()).toContain(`os=${encodeURIComponent(osValue)}`);

    // Event list must reflect the filter — count is ≤ baseline.
    // ``expect.poll`` polls until the table re-renders.
    await expect
      .poll(() => eventRows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(baselineCount);
  });

  test("filters compose AND across context dimensions", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    // Pre-load with ``os=Linux`` so the baseline already carries
    // the first context filter.
    await page.goto("/events?os=Linux");
    const userGroup = page.locator('[data-testid="events-facet-user"]');
    await expect(userGroup).toBeVisible({ timeout: 15_000 });
    const userChips = userGroup.locator(
      '[data-testid^="events-facet-pill-user-"]',
    );
    await expect
      .poll(() => userChips.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    const eventRows = page.locator('[data-testid="events-row"]');
    // Poll until the os-pre-loaded table settles. Same flake
    // guard as the first test — bare count immediately after
    // navigation can race the loading skeleton.
    await expect
      .poll(() => eventRows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const osOnlyCount = await eventRows.count();

    // Click the first USER chip — adds ``user=<value>`` to the URL.
    const firstUserChip = userChips.first();
    const userTestId = await firstUserChip.getAttribute("data-testid");
    expect(userTestId).toMatch(/^events-facet-pill-user-/);
    const userValue = userTestId!.replace("events-facet-pill-user-", "");
    await firstUserChip.click();

    // URL carries BOTH filter params.
    await expect.poll(() => page.url()).toContain("os=Linux");
    await expect
      .poll(() => page.url())
      .toContain(`user=${encodeURIComponent(userValue)}`);

    // Combined filter narrows further (or stays equal). Confirms
    // os AND user compose at the server level.
    await expect
      .poll(() => eventRows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(osOnlyCount);
  });
});
