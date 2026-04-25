import { test, expect } from "@playwright/test";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T6 — the truncation contract end-to-end. <TruncatedText> only
// sets the native `title` attribute when scrollWidth > clientWidth.
// Force a narrow viewport so the 70-char TRUNCATION_AGENT name
// overflows, and assert its row contains a span whose title equals
// the full agent name. The negative path ("no title when text
// fits") is exercised by TruncatedText.test.tsx (unit) — here we
// cover the browser-layout path that the unit test can't reach:
// ResizeObserver actually firing in a real viewport, the computed
// scrollWidth/clientWidth actually disagreeing, and the layout
// math delivering the truncated ellipsis the user sees.
test.describe("T6 — Agent-name truncation surfaces full value via title attr", () => {
  test("narrow viewport: long-name fixture has title='<full name>'", async ({
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

    // <TruncatedText> sets title reactively after ResizeObserver
    // fires. Use expect.poll so the assertion survives the single
    // tick between mount and the first measurement. The truncated
    // span is the only one in the row's left panel whose title
    // matches the full agent name exactly.
    await expect
      .poll(
        async () =>
          row.locator(`span[title="${TRUNCATION_AGENT.name}"]`).count(),
        {
          message:
            "expected a span with title equal to the full agent name when the row is narrow",
          timeout: 5_000,
        },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
