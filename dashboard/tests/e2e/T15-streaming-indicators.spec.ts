import { test, expect } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T15 — Phase 4 polish S-UI-2: streaming indicators on post_call
// rows. Two seeded variants:
//   - fresh-active role: a happy-path streaming post_call (final
//     outcome=completed). Expectation: ``stream-badge-<id>`` is
//     visible with the ``STREAM`` label and a title attribute that
//     carries chunks/p50/p95/max_gap.
//   - error-active role: an aborted streaming post_call (final
//     outcome=aborted). Expectation: ``stream-aborted-<id>`` is
//     visible with the ``ABORTED`` label and the title attribute
//     carries abort_reason.
//
// Theme-agnostic: every assertion is structural (testid, text,
// title attribute). No colour comparisons.
test.describe("T15 — Streaming indicators", () => {
  test("happy-path streaming post_call shows STREAM badge with chunk stats", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const activeRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .filter({ hasText: "active" })
      .first();
    await activeRow.click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    // The fresh-active role seeds a single streaming post_call with
    // final_outcome=completed. The aborted variant lives in the
    // error-active role on a different session, so the only
    // ``stream-badge-*`` here is the happy-path one.
    const streamBadge = drawer.locator(
      '[data-testid^="stream-badge-"]',
    );
    await expect(
      streamBadge,
      "happy-path streaming post_call must surface a STREAM badge",
    ).toBeVisible();
    await expect(streamBadge).toHaveText("STREAM");

    // Title attribute carries the per-chunk stats (chunks=N · p50=Xms
    // · p95=Yms · max_gap=Zms). Read the attribute directly so the
    // assertion doesn't depend on the renderer's tooltip
    // implementation.
    const title = await streamBadge.getAttribute("title");
    expect(title, "STREAM badge must carry a title with chunk stats").not.toBeNull();
    expect(title!).toContain("chunks=42");
    expect(title!).toContain("p50=25ms");
    expect(title!).toContain("p95=80ms");
    expect(title!).toContain("max_gap=150ms");

    // The aborted variant must NOT appear on the fresh-active
    // session — those errors live on the error-active role only.
    await expect(
      drawer.locator('[data-testid^="stream-aborted-"]'),
    ).toHaveCount(0);
  });

  test("aborted streaming post_call shows red ABORTED badge with abort_reason", async ({
    page,
  }) => {
    // The error-active role lives only on the coding agent. Filter
    // by the agent's error_type=rate_limit (which the same role
    // emits) so we land on it without depending on row order.
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      error_type: "rate_limit",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    // The error-active role is state=active (its session_end was
    // never emitted). Recent-closed also carries a rate_limit error
    // and matches the filter, so we resolve by clicking the
    // active-state row -- error-active is the unique active row in
    // the filtered set.
    const errorActiveRow = page
      .locator('[data-testid^="investigate-row-session-"]')
      .filter({ hasText: "active" })
      .first();
    await expect(errorActiveRow).toBeVisible();
    await errorActiveRow.click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const abortedBadge = drawer.locator(
      '[data-testid^="stream-aborted-"]',
    );
    await expect(
      abortedBadge,
      "error-active session must surface an ABORTED stream badge",
    ).toBeVisible();
    await expect(abortedBadge).toHaveText("ABORTED");

    const title = await abortedBadge.getAttribute("title");
    expect(title, "ABORTED badge must carry abort_reason in title").not.toBeNull();
    expect(title!).toContain("abort_reason=client_aborted");
  });
});
