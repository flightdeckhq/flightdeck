import { test, expect } from "@playwright/test";
import { LEFT_PANEL_WIDTH_KEY } from "@/lib/constants";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T94 — swimlane-agent-name-link survives the 200-px panel floor
// with a readable head + working title tooltip. Without the
// explicit min-width on the link the trailing shrink-0 pills +
// provider/OS/orchestration icons + relationship pill + status
// badge would claim every pixel of available row space and the
// name link would flex-shrink to clientWidth=0 — the name would
// disappear entirely while a hover tooltip on an invisible
// element is operator-unreadable. Fix 4 puts a hard 3-rem
// minimum on the link so the column's `overflow: hidden`
// clips the trailing siblings BEFORE the name shrinks below
// readability.
//
// Contract this spec locks in at LEFT_PANEL_MIN_WIDTH (200 px):
//   1. ``clientWidth > 0`` — the link is rendered with a
//      non-zero width.
//   2. ``scrollWidth > clientWidth`` — the long name overflows
//      the link's rendered width, so the ellipsis path engages.
//   3. ``title === <full agent name>`` — the always-on tooltip
//      carries the complete value, so hover surfaces what the
//      ellipsis hides.
//
// Runs under both ``neon-dark`` and ``clean-light`` Playwright
// projects (Rule 40c.3). The link's geometry is theme-agnostic
// (font size + min-width are both theme-stable), so the same
// assertions hold under both projects without any per-theme
// branching.
test.describe("T94 — Swimlane agent-name link survives min panel width", () => {
  test("at LEFT_PANEL_MIN_WIDTH the link keeps a readable ellipsis + title", async ({
    page,
  }) => {
    // Seed the panel width to its 200-px floor BEFORE React boots
    // so the lazy useState initialiser reads it and the layout
    // mounts at the most extreme narrow-column case. addInitScript
    // fires on every navigation; T94 does not reload mid-test so
    // it's the right tool here (the addInitScript-on-reload
    // anti-pattern T91/T93 fixed only bites when a reload follows
    // a state-changing action).
    // Pass the canonical key via `arg` rather than a literal string
    // so a future rename of LEFT_PANEL_WIDTH_KEY in constants.ts
    // either ripples here automatically OR fails the test loudly,
    // instead of silently seeding the wrong key and letting the test
    // mount at the default width (which would still satisfy the
    // long-name geometry but stop testing the 200-px contract).
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, "200");
      },
      { key: LEFT_PANEL_WIDTH_KEY },
    );
    // Use a wide viewport so Fleet's swimlane doesn't horizontally
    // scroll the test fixture row off-screen-left; T91 already
    // exercises the horizontal scroll regime. Here the only
    // dimension under test is the left-panel width.
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    // Use the long-name fixture — its 70-char name guarantees the
    // text content's intrinsic width is far larger than 3 rem, so
    // scrollWidth > clientWidth deterministically engages even on
    // wide test displays.
    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect(link).toBeVisible();

    // Geometry: link must render with non-zero width, and the long
    // text inside must overflow that rendered width. Both halves
    // of the contract evaluate INSIDE the poll predicate so a
    // stale first-paint returning ``clientWidth=0`` keeps the poll
    // re-firing instead of satisfying a shape-only guard. Playwright's
    // ``expect`` lacks ``toSatisfy``; collapsing the contract into a
    // single boolean returned from the poll target + ``.toBe(true)``
    // gives the same predicate-IS-contract semantics with the
    // matchers actually supported by Playwright.
    await expect
      .poll(
        async () =>
          link.evaluate(
            (el) =>
              el.clientWidth > 0 && el.scrollWidth > el.clientWidth,
          ),
        {
          message:
            "link.clientWidth must remain > 0 and scrollWidth > clientWidth at the 200-px panel floor (anti-collapse + ellipsis-engaged contract)",
          timeout: 5_000,
        },
      )
      .toBe(true);

    // Also surface the actual measurements in the test output for
    // post-hoc debugging — if the poll above ever times out, this
    // follow-up evaluate gives a future investigator the exact
    // clientWidth/scrollWidth values rather than just "predicate
    // returned false". The values are also used as a sanity floor
    // (clientWidth >= 3rem worth of pixels at the test font).
    const geometry = await link.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(geometry.clientWidth).toBeGreaterThanOrEqual(40);
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);

    // Title attribute — always-on, carries the full agent name.
    // The geometry contract is meaningful only if hover surfaces
    // the complete value; this assertion locks the two together.
    await expect
      .poll(async () => link.getAttribute("title"), {
        message:
          "expected swimlane-agent-name-link[title] to equal the full agent name at the 200-px panel floor",
        timeout: 5_000,
      })
      .toBe(TRUNCATION_AGENT.name);
  });
});
