import { test, expect } from "@playwright/test";
import {
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T34 — Sub-agent time flow connectors. Design § 4.3: a Bezier
// connector line between a parent's spawn event circle and the
// child's first event circle when both swimlane rows are
// simultaneously visible in the time window. Hover on either
// endpoint brightens the matching line; rest opacity is 10%,
// hover opacity 50%. Both themes per Rule 40c.3.

// Tall viewport so all D126 fixture rows mount without
// IntersectionObserver virtualization eviction (same pattern as
// T28 / T29 / T30 / T36).
test.use({ viewport: { width: 1280, height: 1800 } });

test.describe("T34 — Sub-agent time flow connectors", () => {
  test("connector line renders from parent's spawn event to child's first event", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    // Widen the time range so the seeded crewai-* event timestamps
    // (started_offset_sec: -180s for the researcher) land inside
    // the swimlane's visible domain. The default 1m window omits
    // them; 15m comfortably covers every D126 fixture.
    await page.getByRole("button", { name: "1h", exact: true }).click();
    // bringSwimlaneRowIntoView below internally polls
    // (maxSteps=80, retrying scrollIntoViewIfNeeded between
    // scrolls) so it absorbs the timeline's reflow latency
    // without a fixed wait. No-fixed-timeouts rule.

    // Force both endpoints into view: the CrewAI parent and one
    // of its children. The connector overlay's useLayoutEffect
    // gates on both rows being mounted simultaneously (= both
    // have a [data-agent-id] wrapper in the DOM at that moment).
    await bringSwimlaneRowIntoView(page, "e2e-test-crewai-parent");
    await bringSwimlaneRowIntoView(page, "e2e-test-crewai-researcher");

    // The overlay SVG mounts as a sibling of the grid + circles;
    // a single instance covers every connector line. At least
    // one connector path with the canonical id shape exists.
    const overlay = page.locator(
      '[data-testid="sub-agent-connector-overlay"]',
    );
    await expect(overlay).toBeAttached();
    const connectors = page.locator('[data-testid^="sub-agent-connector-"]');
    expect(await connectors.count()).toBeGreaterThanOrEqual(2);
    const paths = page.locator(
      '[data-testid^="sub-agent-connector-"][data-hover]',
    );
    // Wait for at least one path to mount — the connector
    // useLayoutEffect fires after the eventsCache fills (a few
    // hundred ms post-fetch) and the 1s bump-nonce kicker re-
    // runs the spec build until events resolve. 15s timeout
    // covers worst-case parallel-worker contention.
    await expect.poll(async () => paths.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("hovering a connector path toggles its data-hover attribute", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await page.getByRole("button", { name: "1h", exact: true }).click();
    // bringSwimlaneRowIntoView's internal scroll-and-find loop
    // absorbs the timeline reflow latency (see test 1 for rationale).
    await bringSwimlaneRowIntoView(page, "e2e-test-crewai-parent");
    await bringSwimlaneRowIntoView(page, "e2e-test-crewai-researcher");

    const path = page
      .locator('[data-testid^="sub-agent-connector-"][data-hover]')
      .first();
    // Wait for the connector to land — the spec list builds
    // asynchronously after eventsCache fills (see test 1 for the
    // same wait). 15s timeout covers parallel-worker contention.
    await expect.poll(
      async () =>
        page
          .locator('[data-testid^="sub-agent-connector-"][data-hover]')
          .count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);
    // The path is an SVG element with opacity 0.1 at rest;
    // Playwright's toBeVisible() flags very-thin or low-opacity
    // SVG paths as hidden. Assert presence via attached state +
    // attribute reads instead — the contract is the data-hover
    // toggle, not a CSS visibility check.
    await expect(path).toBeAttached();
    await expect(path).toHaveAttribute("data-hover", "false");
    await expect(path).toHaveAttribute("opacity", "0.1");
    // Drive the React hover handler directly via the SVG element's
    // native ``mouseover`` event. Playwright's ``hover()`` aims at
    // the locator's bounding-box centre, which on a quadratic
    // Bezier with a slowly-drifting parent end (the time axis
    // advances ~0.1px per rAF tick) sometimes lands just outside
    // the stroke geometry — Playwright reports "hovered" but the
    // SVG element never registered a mouseenter and the React
    // ``setInternalHover`` setter never fires. Dispatching the
    // event directly on the resolved element bypasses both the
    // bounding-box geometry and the rAF drift. The same
    // ``mouseover`` event React maps to its synthetic
    // ``onMouseEnter`` handler when bubbling through the SVG
    // subtree (mouseenter doesn't bubble; mouseover does and
    // React's syntheticEvent system normalises both).
    await path.evaluate((el) => {
      el.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
    await expect(path).toHaveAttribute("data-hover", "true");
    await expect(path).toHaveAttribute("opacity", "0.5");
  });

  test("connector overlay reports zero connectors when no parent / child pair is mounted", async ({
    page,
  }) => {
    // Open Fleet with a flavor filter that only matches a lone
    // agent — the overlay SVG still mounts (it's the timeline's
    // composed-in-connector-aware-mode signal) but its
    // ``data-connector-count`` reads 0, and zero <path> children
    // render. The design § 4.3 "no overdraw" lock applies to
    // path count, not to the empty SVG container.
    await page.goto("/?flavor=e2e-ancient-agent");
    await waitForFleetReady(page);
    const overlay = page.locator(
      '[data-testid="sub-agent-connector-overlay"]',
    );
    await expect(overlay).toBeAttached();
    await expect(overlay).toHaveAttribute("data-connector-count", "0");
    expect(
      await page.locator('[data-testid^="sub-agent-connector-"][data-hover]').count(),
    ).toBe(0);
  });
});
