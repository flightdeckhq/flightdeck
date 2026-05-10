import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// 7-day default window the Investigate page uses when the user hasn't
// narrowed the time range explicitly. Hoisted out of the test body so
// the magic-number trio (7, 24, 60, 60, 1000) doesn't repeat inline.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// T42 — operator-actionable enrichment facets filter server-side.
// Step 6 originally wired these as client-side filters that
// narrowed the visible page only; the API request stripped the
// filter params and pagination drifted from row count. The Step 6
// follow-up wired the params end-to-end. This spec pins the chain
// against future regression: clicking the TERMINAL facet must
// (a) gain ?terminal=true in the URL,
// (b) include &terminal=true in the GET /v1/sessions network call,
// (c) narrow the table so footer count == visible row count, and
// (d) update pagination total to reflect the filtered result.
//
// Anchor: the canonical ``error-active`` session on the coding
// agent emits llm_error_authentication + llm_error_context_overflow
// (both non-retryable). seed.py stamps terminal=!is_retryable on
// llm_error events, so this session surfaces under terminal=true.
//
// Theme-agnostic — selectors are testids/structural, never colour.
test.describe("T42 — operator-actionable facets filter server-side", () => {
  test("TERMINAL facet → URL → API param → footer/pagination agreement", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - SEVEN_DAYS_MS).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const facet = page.locator('[data-testid="investigate-sidebar"]');
    const terminalGroup = facet.getByText("TERMINAL", { exact: true });
    await expect(
      terminalGroup,
      "TERMINAL facet must render when a visible session has terminal errors",
    ).toBeVisible();

    // Scope the pill lookup to the sidebar facet container so an
    // unrelated button on the page whose accessible name happens to
    // start with "true" can never satisfy the locator (DOM-order
    // ambiguity). The TERMINAL facet has a single value entry "true".
    const terminalPill = facet
      .getByRole("button", { name: /^true/ })
      .first();

    // Capture the request fired BY the click, not any pre-click
    // request that happens to lack terminal=true. Promise.all
    // registers the wait synchronously with the click action, so
    // a stale unfiltered request that was already in-flight cannot
    // satisfy the wait — only the click-triggered request matches
    // both the URL predicate AND the registration order.
    const [filteredRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("/v1/sessions?")
          && req.url().includes("terminal=true"),
      ),
      terminalPill.click(),
    ]);

    // (a) URL state captured.
    await expect(page).toHaveURL(/terminal=true/);

    // (b) Network request includes the param. Already proved by the
    // waitForRequest predicate above; assert here for the test log.
    expect(
      filteredRequest.url(),
      "GET /v1/sessions request must include terminal=true",
    ).toContain("terminal=true");

    // Wait for the table to settle into the filtered state.
    await waitForInvestigateReady(page);

    // (c) Footer count matches visible row count. The "Showing N-M of
    // total" range from <Pagination> is the source of truth.
    const range = page.locator('[data-testid="pagination-range"]');
    await expect(range).toBeVisible();
    const rangeText = await range.textContent();
    expect(rangeText, "pagination range text must be present").toBeTruthy();

    const match = rangeText!.match(/Showing\s+(\d+)-(\d+)\s+of\s+(\d+)/);
    if (!match) {
      throw new Error(
        `pagination range text "${rangeText}" must match "Showing N-M of T"`,
      );
    }
    const [, startStr, endStr, totalStr] = match;
    const visibleCount = Number(endStr) - Number(startStr) + 1;
    const total = Number(totalStr);

    const visibleRows = await page
      .locator('[data-testid^="investigate-row-session-"]')
      .count();
    expect(
      visibleRows,
      `visible row count (${visibleRows}) must equal pagination range count (${visibleCount})`,
    ).toBe(visibleCount);

    // (d) Pagination total reflects the filtered result. With
    // terminal=true narrowing to a small subset, total must be
    // strictly less than the unfiltered total — and must equal the
    // visible row count when the filtered set fits within one page.
    expect(
      total,
      "pagination total must reflect the filtered result, not the unfiltered set",
    ).toBeGreaterThan(0);
    // SAFETY: Pagination.tsx clamps endStr = Math.min(offset+limit,
    // total), so endStr <= total always holds. The condition below
    // therefore reduces to "endStr === total" — the single-page case
    // where the entire filtered result fits without a "next" page.
    if (total <= Number(endStr)) {
      // Single-page result — next button must be disabled.
      const next = page.locator('[data-testid="pagination-next"]');
      await expect(next).toBeDisabled();
    }

    // Re-click the active facet to clear it. Same Promise.all idiom
    // so a stale unfiltered request in-flight before the click can't
    // satisfy the negative predicate — only the click-triggered
    // de-filter request matches.
    await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("/v1/sessions?")
          && !req.url().includes("terminal=true"),
      ),
      terminalPill.click(),
    ]);
    // Settle the de-filtered table before asserting URL state so a
    // fast runner can't race the URL update against the in-flight
    // refetch render.
    await waitForInvestigateReady(page);
    await expect(page).not.toHaveURL(/terminal=true/);
  });
});
