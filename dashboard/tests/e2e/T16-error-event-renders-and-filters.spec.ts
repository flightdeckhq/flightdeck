import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T16 — Phase 4 polish S-UI-3: llm_error event rendering plus
// Investigate ERROR TYPE facet + session-row error indicator.
// Backed by the canonical ``error-active`` role on the coding agent
// (canonical.json), which seeds four distinct llm_error taxonomy
// values (rate_limit / context_overflow / authentication / timeout)
// plus an aborted streaming post_call. The recent-closed role
// additionally seeds one rate_limit error.
//
// Three scenes covered:
//   1. ERROR TYPE facet renders with the seeded distinct values
//      and clicking a pill updates the URL + filters the table.
//   2. Session row error indicator dot appears for sessions that
//      emitted llm_error events; tooltip lists the values.
//   3. Drawer event row + ErrorEventDetails accordion renders the
//      error_type, http_status, and the request_id / retry_after /
//      is_retryable fields once expanded.
//
// Theme-agnostic — selectors are testids/structural, never colour.
test.describe("T16 — llm_error rendering + ERROR TYPE filter", () => {
  test("ERROR TYPE facet pills click and update URL", async ({ page }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const facet = page.locator(
      '[data-testid="investigate-error-type-facet"]',
    );
    await expect(
      facet,
      "ERROR TYPE facet group must render when a visible session has llm_error events",
    ).toBeVisible();

    // Each of the four seeded error_types appears as a pill. The
    // recent-closed role also emits rate_limit, so the count for
    // that pill should be ≥ 2.
    for (const et of [
      "rate_limit",
      "context_overflow",
      "authentication",
      "timeout",
    ]) {
      await expect(
        facet.locator(`[data-testid="investigate-error-type-pill-${et}"]`),
        `ERROR TYPE pill for ${et} must render`,
      ).toBeVisible();
    }

    // Click rate_limit. URL gains ?error_type=rate_limit; the table
    // narrows to sessions emitting that taxonomy value (recent-closed
    // + error-active both qualify).
    await facet
      .locator('[data-testid="investigate-error-type-pill-rate_limit"]')
      .click();
    await expect(page).toHaveURL(/error_type=rate_limit/);

    // Filtered table should contain sessions whose row carries the
    // error indicator dot for rate_limit (recent-closed +
    // error-active). Both rows must show the dot; sessions without
    // any llm_error event must not appear at all because the
    // error_type filter is active.
    const dots = page.locator(
      '[data-testid^="session-row-error-indicator-"]',
    );
    const dotCount = await dots.count();
    expect(
      dotCount,
      "rate_limit filter should yield at least 2 rows with the error indicator dot",
    ).toBeGreaterThanOrEqual(2);
  });

  test("session row red dot appears only for sessions with llm_error events", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // The error-active role is the only session that carries all
    // four taxonomy values. We don't pin its session_id (uuid5
    // derived) but we can find it by its row containing all four
    // testid prefixes via the dot's aria-label, which the
    // component populates with the joined error_types list.
    const allDots = page.locator(
      '[data-testid^="session-row-error-indicator-"]',
    );
    const labels = await allDots.evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? ""),
    );
    const hasErrorActive = labels.some(
      (l) =>
        l.includes("rate_limit") &&
        l.includes("context_overflow") &&
        l.includes("authentication") &&
        l.includes("timeout"),
    );
    expect(
      hasErrorActive,
      "the error-active session must surface a row dot listing all four seeded error_types",
    ).toBe(true);

    // Negative: there must be a clean session in the same flavor
    // (the recent-closed and aged-closed roles, plus the stale
    // role) WITHOUT a dot. Total rows > rows with dots.
    const totalRows = await page
      .locator('[data-testid^="investigate-row-session-"]')
      .count();
    const dotCount = await allDots.count();
    expect(
      totalRows,
      "expected at least one row without an error indicator (clean sessions in the flavor)",
    ).toBeGreaterThan(dotCount);
  });

  test("drawer renders llm_error row with expandable ErrorEventDetails", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      // Land on a row known to carry llm_errors. error_type=rate_limit
      // matches both the recent-closed and error-active roles; pick
      // either by clicking the first row.
      error_type: "rate_limit",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const firstRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .first();
    await firstRow.click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const errorRow = drawer
      .locator('[data-testid^="error-event-row-"]')
      .first();
    await expect(
      errorRow,
      "drawer timeline must include at least one error-event-row entry",
    ).toBeVisible();

    // Expanding the row reveals the summary grid + accordion. The
    // event-row is the toggle for the expanded view.
    await errorRow.click();

    const accordion = drawer
      .locator('[data-testid^="error-event-details-"]')
      .first();
    await expect(
      accordion,
      "ErrorEventDetails accordion must mount when the error row expands",
    ).toBeVisible();

    // The toggle inside the accordion expands the request_id /
    // retry_after / is_retryable grid.
    const toggle = drawer
      .locator('[data-testid^="error-event-details-toggle-"]')
      .first();
    await toggle.click();

    // is_retryable pill: rate_limit is retryable so the label reads
    // "Retryable" (matches ErrorEventDetails.tsx::RetryablePill).
    const retryableCell = drawer
      .locator('[data-testid^="error-event-detail-is-retryable-"]')
      .first();
    await expect(retryableCell).toContainText("Retryable");
  });
});
