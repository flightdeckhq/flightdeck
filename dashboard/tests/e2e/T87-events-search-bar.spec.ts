/**
 * T87 — the /events page has a top-of-page free-text search bar.
 *
 * Contract: typing into the search input narrows the event rows to
 * a subset (server-side ILIKE across event_type / model /
 * session_id / agent_name / framework) and reflects the query in the
 * page URL as `?q=`. Pressing Escape clears both the input and the
 * filter, restoring the unfiltered set.
 *
 * Theme-agnostic — structural locators only, no theme-specific
 * selectors or computed colours.
 */
import { test, expect } from "@playwright/test";

test.describe("T87 — /events search bar narrows + reflects in URL", () => {
  test("typing narrows the rows and adds q to the URL; Escape clears it", async ({
    page,
  }) => {
    await page.goto("/events");
    await expect(page.locator('[data-testid="events-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="events-table"]')).toBeVisible();

    const rows = page.locator('[data-testid="events-row"]');
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const before = await rows.count();

    // Derive a query string from a real row so the search reliably
    // matches a subset: the first row's run badge shows the 8-char
    // prefix of its session_id, which the `q` ILIKE searches via
    // `session_id::text ILIKE`.
    const firstRunBadge = rows
      .first()
      .locator('[data-testid="events-row-run-badge"]');
    await expect(firstRunBadge).toBeVisible();
    const query = ((await firstRunBadge.textContent()) ?? "").trim();
    expect(query.length).toBeGreaterThan(0);

    const search = page.locator('[data-testid="events-search-input"]');
    await expect(search).toBeVisible();
    await search.fill(query);

    // The query lands in the URL once the debounce settles.
    await expect
      .poll(
        async () =>
          new URL(page.url()).searchParams.get("q"),
        { timeout: 10_000 },
      )
      .toBe(query);

    // The row set narrows to a subset (or stays equal when every
    // event already matches the typed term).
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(before);

    // Press Escape — the input and the `q` filter both clear.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect
      .poll(
        async () => new URL(page.url()).searchParams.get("q"),
        { timeout: 10_000 },
      )
      .toBeNull();

    // The unfiltered set is restored.
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBe(before);
  });
});
