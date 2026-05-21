import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T93 — fleet-wide ALL aggregate row is collapsible with state
// persisted to localStorage. Default is collapsed (``"1"`` in
// storage, ``data-collapsed="true"`` on the swimlane-all wrapper):
// once ``/agents`` exists as the dedicated fleet-overview surface,
// the pulse line is redundant and hiding it by default keeps the
// swimlane dense. The chevron toggle remains available so an
// operator can expand on demand; the choice survives reloads.
//
// What this spec locks in:
//
//   1. Default collapsed — clean localStorage, page load: the
//      toggle bar renders, ``data-collapsed`` reads ``"true"``,
//      the ``swimlane-all-pulse`` pane is absent.
//   2. Click expands — pulse pane appears, ``data-collapsed``
//      flips to ``"false"``.
//   3. Expanded state persists — reload, pulse still present.
//   4. Click again collapses — pulse pane gone.
//   5. Collapsed state persists — reload, still collapsed.
//
// Each transition is asserted via the wrapper's ``data-collapsed``
// attribute (single source of truth that the unit + E2E tests
// both inspect) plus presence/absence of ``swimlane-all-pulse``
// so the assertion remains true under AnimatePresence-style
// overlapping mounts as well as plain conditional rendering.
test.describe("T93 — Swimlane ALL row collapsible + persisted", () => {
  test("collapsed by default; toggle expands; state survives reload both ways", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    // Clear AFTER initial mount via page.evaluate (not
    // addInitScript) so the reloads in steps 3 and 5 read the
    // toggle-persisted flag rather than re-firing the clear.
    // addInitScript fires on every navigation including reloads,
    // which would wipe what the toggle just wrote. Pattern matches
    // T23's investigate-sidebar-resizable spec.
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck-all-row-collapsed"),
    );
    await page.reload();
    await waitForFleetReady(page);

    const allRow = page.locator('[data-testid="swimlane-all"]');
    const toggle = page.locator('[data-testid="swimlane-all-toggle"]');
    const pulse = page.locator('[data-testid="swimlane-all-pulse"]');

    // 1. Default collapsed — toggle bar present, pulse pane absent.
    await expect(allRow).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(allRow).toHaveAttribute("data-collapsed", "true");
    await expect(pulse).toHaveCount(0);

    // 2. Click expands. Poll on data-collapsed so the assertion
    // converges as soon as React commits the new state.
    await toggle.click();
    await expect(allRow).toHaveAttribute("data-collapsed", "false");
    await expect(pulse).toBeVisible();

    // localStorage carries the expanded flag.
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            localStorage.getItem("flightdeck-all-row-collapsed"),
          ),
        { timeout: 5_000 },
      )
      .toBe("0");

    // 3. Reload — expanded state persists.
    await page.reload();
    await waitForFleetReady(page);
    const allRowAfterExpand = page.locator('[data-testid="swimlane-all"]');
    await expect(allRowAfterExpand).toHaveAttribute("data-collapsed", "false");
    await expect(
      page.locator('[data-testid="swimlane-all-pulse"]'),
    ).toBeVisible();

    // 4. Toggle again — collapses.
    await page.locator('[data-testid="swimlane-all-toggle"]').click();
    await expect(allRowAfterExpand).toHaveAttribute("data-collapsed", "true");
    await expect(page.locator('[data-testid="swimlane-all-pulse"]')).toHaveCount(
      0,
    );

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            localStorage.getItem("flightdeck-all-row-collapsed"),
          ),
        { timeout: 5_000 },
      )
      .toBe("1");

    // 5. Reload — collapsed state persists.
    await page.reload();
    await waitForFleetReady(page);
    const allRowAfterCollapse = page.locator('[data-testid="swimlane-all"]');
    await expect(allRowAfterCollapse).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(
      page.locator('[data-testid="swimlane-all-pulse"]'),
    ).toHaveCount(0);
  });
});
