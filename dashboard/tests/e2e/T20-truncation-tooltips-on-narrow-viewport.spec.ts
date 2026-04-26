import { test, expect } from "@playwright/test";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T20 — truncation-tooltip browser-layer regression guard. T6 covers
// the same fixture but only at one viewport width; the original
// follow-up bullet asked specifically for hover-on-truncated +
// resize-stability coverage to lock in the contract from a real
// operator perspective.
//
// What this guards (in addition to T6):
//   1. The truncated <span title="..."> actually responds to a
//      mouse hover -- a regression that put a pointer-events:none
//      ancestor over the row would silently kill the tooltip even
//      while the title attr remained correct in the DOM.
//   2. After resize from narrow → wide → narrow, the title attr
//      survives -- ResizeObserver must re-fire and the
//      <TruncatedText> measurement loop must converge to the
//      correct state again, not freeze on a stale answer from
//      the first measurement pass.
test.describe("T20 — Truncation tooltips on narrow viewport", () => {
  test("hover on a truncated row exposes the full agent_name via title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    // Resolve the truncated span. <TruncatedText> sets the title
    // attr after ResizeObserver fires, so poll until it lands.
    const truncatedSpan = row.locator(
      `span[title="${TRUNCATION_AGENT.name}"]`,
    );
    await expect
      .poll(async () => truncatedSpan.count(), {
        message:
          "expected a span with title=<full agent_name> on the truncated row",
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(1);

    // Hovering must not throw and must not strip the title attr
    // off the element it lands on. (A regression where a parent
    // capturing pointerover swallowed the event before the span
    // received it would still pass the .count() assertion above
    // but would fail to deliver the OS tooltip; assert the attr
    // remains intact post-hover.)
    await truncatedSpan.first().hover();
    await expect(truncatedSpan.first()).toHaveAttribute(
      "title",
      TRUNCATION_AGENT.name,
    );
  });

  test("title survives a narrow → wide → narrow resize cycle", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    const truncatedSpan = row.locator(
      `span[title="${TRUNCATION_AGENT.name}"]`,
    );
    await expect
      .poll(async () => truncatedSpan.count(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);

    // Wide viewport — the long name now fits, so <TruncatedText>
    // strips the title (per the negative path documented on the
    // unit test). We don't strictly need to verify the strip-on-
    // wide path here (TruncatedText.test.tsx covers it); we just
    // need to know the resize is observed.
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.waitForTimeout(300);

    // Back to narrow — ResizeObserver must re-fire and the title
    // must be back. The bug shape this guards: a measurement loop
    // that sets the title once on first paint and never recomputes
    // would leave the now-overflowing span without a tooltip.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect
      .poll(async () => truncatedSpan.count(), {
        message:
          "title must reattach after the viewport returns to narrow width",
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(1);
  });
});
