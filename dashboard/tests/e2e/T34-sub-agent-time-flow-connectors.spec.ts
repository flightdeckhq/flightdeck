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

    // Force both endpoints into view simultaneously. The connector
    // overlay's useLayoutEffect skips any pair where either row
    // is virtualized (placeholder), so scrolling sequentially —
    // parent first, then child — can leave the parent in the
    // virtualized band by the time the child's scroll finishes.
    // The β-grouping order places children immediately after
    // their parent, so a single bringSwimlaneRowIntoView on the
    // child materialises the parent in the SAME scroll position
    // as a side effect.
    await bringSwimlaneRowIntoView(page, "e2e-test-crewai-researcher");

    // The overlay SVG mounts as a sibling of the grid + circles;
    // a single instance covers every connector line. The overlay
    // carries ``data-connector-count`` reflecting the
    // spec-list length AFTER the useLayoutEffect resolves — wait
    // on that BEFORE looking for the path elements so the
    // assertion doesn't race the geometry pass.
    const overlay = page.locator(
      '[data-testid="sub-agent-connector-overlay"]',
    );
    await expect(overlay).toBeAttached();
    await expect
      .poll(
        async () => {
          const v = await overlay.getAttribute("data-connector-count");
          return v ? parseInt(v, 10) : 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
    const connectors = page.locator('[data-testid^="sub-agent-connector-"]');
    // At least one connector must render — the test's intent is to
    // verify the connector machinery, not to count fixtures.
    await expect
      .poll(async () => connectors.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
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
    // Single bringSwimlaneRowIntoView on the child materialises
    // the parent at the same scroll position via β-grouping (see
    // first test for rationale).
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

  test("connector overlay reports zero connectors when filtered to a lone agent", async ({
    page,
  }) => {
    // Click the sidebar entry for ``e2e-test-ancient-agent`` to
    // apply the flavor filter to a lone agent (no children, no
    // parent — pure root with no parent_session_id linkage). With
    // only the ancient-agent's rows rendered, the connector
    // overlay's iteration over filteredFlavors finds zero
    // parent-child pairs and reports ``data-connector-count="0"``
    // with no <path> children. The design's "no overdraw" lock
    // applies to path count, not to the empty SVG container.
    //
    // Pre-D115 this test used ``?flavor=e2e-ancient-agent`` as a
    // URL pre-condition; post-D115 the ``flavor`` query param maps
    // to agent_id (UUID), so the URL-param path no longer narrows
    // the swimlane. Clicking the sidebar entry exercises the same
    // setFlavorFilter store action a real operator would trigger.
    await page.goto("/");
    await waitForFleetReady(page);
    const sidebarEntry = page.locator(
      '[data-testid="fleet-sidebar-agent-e2e-test-ancient-agent"]',
    );
    await expect(sidebarEntry).toBeVisible({ timeout: 10_000 });
    await sidebarEntry.click();

    const overlay = page.locator(
      '[data-testid="sub-agent-connector-overlay"]',
    );
    await expect(overlay).toBeAttached();
    await expect
      .poll(async () => overlay.getAttribute("data-connector-count"), {
        timeout: 8_000,
      })
      .toBe("0");
    expect(
      await page
        .locator('[data-testid^="sub-agent-connector-"][data-hover]')
        .count(),
    ).toBe(0);
  });
});
