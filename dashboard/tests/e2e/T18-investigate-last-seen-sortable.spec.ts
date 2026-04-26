import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T18 — Phase 4.5 S-TBL-1: "Last Seen" column on the Investigate
// session table is sortable. Click reorders by last_seen_at DESC
// (newest first); click again reorders ASC.
//
// Anchor: the coding-agent fixture has six sessions with varied
// last_seen_at across roles (fresh-active is recent, ancient-only on
// the dedicated agent is days old). The test asserts the relative-
// time labels appear and the URL gains ?sort=last_seen_at on click.
test.describe("T18 — Last seen column sortable", () => {
  test("click 'Last seen' header sorts by recency, click again reverses", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // The header carries the testid investigate-th-last-seen.
    const header = page.locator('[data-testid="investigate-th-last-seen"]');
    await expect(header).toBeVisible();
    // Click to activate sort. Default first click → desc per
    // handleSort's implementation.
    await header.click();
    await expect(page).toHaveURL(/sort=last_seen_at/);
    // ``order=desc`` is the default; buildUrlParams omits when default.
    await expect(page).not.toHaveURL(/order=asc/);

    // Click again toggles to ascending.
    await header.click();
    await expect(page).toHaveURL(/sort=last_seen_at/);
    await expect(page).toHaveURL(/order=asc/);
  });

  test("Last seen cells render relative under 60m and absolute beyond", async ({
    page,
  }) => {
    // The coding-agent fixture seeds four sessions that span the
    // S-TBL-1 60-minute threshold:
    //   fresh-active : last_seen ≈ 30s ago    → "just now" / relative
    //   recent-closed: last_seen ≈ 2m ago     → relative
    //   aged-closed  : last_seen ≈ 27h ago    → absolute
    //   stale        : last_seen ≈ 3h ago     → absolute
    // The assertion below checks both branches render -- locale-free
    // by leaning on a structural separator: the absolute format
    // ``Apr 25, 09:51 PM`` always contains "HH:MM" with a colon, the
    // relative format ("just now" / "Xm ago") never does.
    const params = new URLSearchParams({
      from: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const cells = page.locator(
      '[data-testid^="investigate-row-last-seen-"]',
    );
    const count = await cells.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const texts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      texts.push(((await cells.nth(i).textContent()) ?? "").trim());
    }

    const RELATIVE = /^(just now|\d+m ago|\d+s ago)$/;
    const relativeCount = texts.filter((t) => RELATIVE.test(t)).length;
    const absoluteCount = texts.filter(
      (t) => !RELATIVE.test(t) && /\d:\d{2}/.test(t),
    ).length;

    expect(
      relativeCount,
      `expected ≥1 relative cell among ${JSON.stringify(texts)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      absoluteCount,
      `expected ≥1 absolute cell among ${JSON.stringify(texts)}`,
    ).toBeGreaterThanOrEqual(1);

    // Hour/day relative shapes are the regression that motivated this
    // test -- the spec eliminated them. None of the rendered cells
    // should match those.
    for (const t of texts) {
      expect(t, `unexpected hour/day relative shape: ${t}`).not.toMatch(
        /^\d+(h|d) ago$/,
      );
    }
  });
});
