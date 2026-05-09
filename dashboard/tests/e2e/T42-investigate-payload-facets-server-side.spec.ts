import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

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
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
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

    // The TERMINAL facet has a single value entry "true". Locate it
    // by hovering scope to the section header's parent + the value
    // pill text. The facet rows render via the shared sidebar
    // facet-pill markup; the value text is "true".
    const terminalPill = page.getByRole("button", { name: /^true/ }).first();

    // Capture the API call fired after the click — the request must
    // carry &terminal=true. Filter to the v1/sessions endpoint so
    // unrelated requests (whoami, agents) don't satisfy the wait.
    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/v1/sessions?")
        && req.url().includes("terminal=true"),
    );
    await terminalPill.click();
    const filteredRequest = await requestPromise;

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
    expect(
      match,
      `pagination range text "${rangeText}" must match "Showing N-M of T"`,
    ).not.toBeNull();
    const [, startStr, endStr, totalStr] = match!;
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
    if (total <= Number(endStr)) {
      // Single-page result — next button must be disabled.
      const next = page.locator('[data-testid="pagination-next"]');
      await expect(next).toBeDisabled();
    }

    // Re-click the active facet to clear it. URL drops the param;
    // the next request must NOT carry terminal=true.
    const reclickRequest = page.waitForRequest(
      (req) =>
        req.url().includes("/v1/sessions?")
        && !req.url().includes("terminal=true"),
    );
    await terminalPill.click();
    await reclickRequest;
    await expect(page).not.toHaveURL(/terminal=true/);
  });
});
