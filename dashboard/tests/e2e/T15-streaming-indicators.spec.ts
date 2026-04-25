import { test, expect, type Page } from "@playwright/test";
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
// Both scenes deep-link into the candidate session via
// ``?session=<id>`` -- the dashboard's drawer URL param. Sequential
// row clicks against the drawer overlay are flaky, deep-linking
// avoids the choreography entirely.
test.describe("T15 — Streaming indicators", () => {
  test("happy-path streaming post_call shows STREAM badge with chunk stats", async ({
    page,
  }) => {
    const sessionIds = await fetchActiveCodingSessionIds(page);
    expect(sessionIds.length).toBeGreaterThanOrEqual(1);

    let asserted = false;
    for (const sid of sessionIds) {
      const params = new URLSearchParams({
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
        flavor: CODING_AGENT.flavor,
        state: "active",
        session: sid,
      });
      await page.goto(`/investigate?${params.toString()}`);
      await waitForInvestigateReady(page);
      const drawer = page.locator('[data-testid="session-drawer"]');
      await expect(drawer).toBeVisible();
      const happy = drawer.locator('[data-testid^="stream-badge-"]');
      const aborted = drawer.locator('[data-testid^="stream-aborted-"]');
      if (
        (await happy.count()) > 0 &&
        (await aborted.count()) === 0
      ) {
        asserted = true;
        const first = happy.first();
        await expect(first).toBeVisible();
        await expect(first).toHaveText("STREAM");
        const title = await first.getAttribute("title");
        expect(title).not.toBeNull();
        expect(title!).toContain("chunks=42");
        expect(title!).toContain("p50=25ms");
        expect(title!).toContain("p95=80ms");
        expect(title!).toContain("max_gap=150ms");
        break;
      }
    }
    expect(
      asserted,
      "at least one active coding session must carry a happy-path STREAM badge",
    ).toBe(true);
  });

  test("aborted streaming post_call shows ABORTED badge with abort_reason", async ({
    page,
  }) => {
    // Filter the API directly to the error-active session: state=
    // active + error_type=rate_limit narrows to error-active only
    // (recent-closed has rate_limit but is state=closed).
    const sessionIds = await fetchActiveCodingSessionIds(
      page,
      "&error_type=rate_limit",
    );
    expect(
      sessionIds.length,
      "expected exactly one active coding session matching rate_limit (error-active)",
    ).toBeGreaterThanOrEqual(1);

    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      flavor: CODING_AGENT.flavor,
      error_type: "rate_limit",
      state: "active",
      session: sessionIds[0],
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);

    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer).toBeVisible();

    const abortedBadge = drawer
      .locator('[data-testid^="stream-aborted-"]')
      .first();
    await expect(
      abortedBadge,
      "error-active session must surface an ABORTED stream badge",
    ).toBeVisible();
    await expect(abortedBadge).toHaveText("ABORTED");

    const title = await abortedBadge.getAttribute("title");
    expect(title).not.toBeNull();
    expect(title!).toContain("abort_reason=client_aborted");
  });
});

async function fetchActiveCodingSessionIds(
  page: Page,
  extraQs: string = "",
): Promise<string[]> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions?flavor=${encodeURIComponent(
      CODING_AGENT.flavor,
    )}&state=active&from=2020-01-01T00:00:00Z&limit=100${extraQs}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  return ((body.sessions ?? []) as Array<{ session_id: string }>).map(
    (s) => s.session_id,
  );
}
