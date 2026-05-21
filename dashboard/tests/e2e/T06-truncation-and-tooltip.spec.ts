import { test, expect } from "@playwright/test";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T6 — the truncation contract end-to-end. The swimlane agent-name
// link now carries an always-on ``title`` attribute equal to the
// full agent name (the directive that introduced this trades the
// pre-Fix-2 conditional ResizeObserver-driven title for an
// unconditional one: hover reveals the complete name even when the
// text fits, so the user contract is single-shape and a wide-
// viewport regression can't strip the tooltip silently). The
// browser-layer assertions here continue to verify the title
// reaches the DOM under realistic data volume + virtualisation.
test.describe("T6 — Agent-name link always exposes full value via title attr", () => {
  test("narrow viewport: long-name fixture has title='<full name>' on the link", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    // Resilience P1/P2: the long-name fixture is alphabetically
    // buried under realistic data volume (the swimlane virtualizes
    // off-screen rows). Scroll until the row mounts.
    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    // The title lives on the swimlane-agent-name-link itself
    // (an <a> rendered by react-router's Link). It's set
    // synchronously during render rather than reactively after
    // ResizeObserver fires, so the assertion converges on the
    // first paint -- expect.poll is left in place as a small
    // safety net for the swimlane row's mount tick.
    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect
      .poll(async () => link.getAttribute("title"), {
        message:
          "expected swimlane-agent-name-link[title] to equal the full agent name",
        timeout: 5_000,
      })
      .toBe(TRUNCATION_AGENT.name);
  });
});
