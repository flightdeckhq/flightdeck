import { test, expect, type Locator, type Page } from "@playwright/test";
import { LEFT_PANEL_WIDTH_KEY } from "@/lib/constants";
import {
  CONNECTOR_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T135 — A child row's label hides the circles scrolled under it.
//
// The swimlane's label column is sticky: when the timeline scrolls
// sideways, circles slide under it. A root row's label paints the
// row's opaque --surface. A child row's tint is translucent, and a
// label that only inherited it let those circles show through over
// the pills and the status badge. The label now paints the same look
// in opaque layers, with the colour the rows sit on at the bottom
// (--bg in Fleet, --surface in the per-agent modal).
//
// The spec scrolls one of a child row's circles to the middle of the
// row's label, in Fleet and in the per-agent modal, then checks that
// the label's computed background colour (its bottom layer) is fully
// opaque. Colours differ per theme, so it checks only alpha (rule
// 40c.3).
//
// The child row is the connector anchor (e2e-test-fresh-subagent),
// which seed.py gives a tool_call at NOW-5s on every keep-alive cycle,
// so the default 1m window always holds a circle of it. The label
// column is widened to its 640 px maximum in a 1000 px window. The
// timeline then scrolls far enough to centre a circle under the label
// once it is ~31 s old (~33 s in the modal), and to bring it under the
// label's right part once it is ~10 s old (~12 s). A younger circle is
// scrolled as far as the range allows, and the poll waits for it to
// age.

test.use({ viewport: { width: 1000, height: 1200 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "640");
  }, LEFT_PANEL_WIDTH_KEY);
});

/** Alpha channel of a computed CSS colour (``rgb()`` / ``rgba()``). */
function alphaOf(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unexpected colour format: ${color}`);
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? Number(parts[3]) : 1;
}

/** Scroll ``scroller`` to centre ``row``'s oldest circle under the
 *  row's label, or as close as the scroll range allows; then report
 *  whether a circle the panel does not clip has its centre inside the
 *  label, half a circle in from either edge. */
async function scrollACircleUnderTheLabel(scroller: Locator, row: Locator): Promise<boolean> {
  const rowHandle = await row.elementHandle();
  return scroller.evaluate((sc, r) => {
    const rowEl = r as Element;
    const labelBox = () => rowEl.querySelector(".swimlane-row-label")!.getBoundingClientRect();
    const panelBox = () =>
      rowEl.querySelector('[data-testid="swimlane-timeline-panel"]')!.getBoundingClientRect();
    // Circles the panel shows: one of them under the label is one the
    // label has to hide.
    const shown = () => {
      const panel = panelBox();
      return Array.from(rowEl.querySelectorAll("[data-event-id]"))
        .map((c) => c.getBoundingClientRect())
        .filter((b) => b.left >= panel.left && b.right <= panel.right);
    };
    const label = labelBox();
    const centres = shown().map((b) => b.left + b.width / 2);
    if (centres.length > 0) {
      // The oldest circle needs the least scroll. A young one needs
      // more than the range holds, so clamp to the range's end.
      const want = sc.scrollLeft + (Math.min(...centres) - (label.left + label.width / 2));
      sc.scrollLeft = Math.min(Math.max(want, 0), sc.scrollWidth - sc.clientWidth);
    }
    const after = labelBox();
    return shown().some((b) => {
      const cx = b.left + b.width / 2;
      return cx > after.left + b.width / 2 && cx < after.right - b.width / 2;
    });
  }, rowHandle);
}

async function expectOpaqueLabel(row: Locator): Promise<void> {
  const bg = await row.evaluate((r) => {
    const cs = getComputedStyle(r.querySelector(".swimlane-row-label")!);
    return { color: cs.backgroundColor, image: cs.backgroundImage };
  });
  expect(alphaOf(bg.color), `label background ${bg.color}`).toBe(1);
  expect(bg.image).toContain("linear-gradient");
}

async function circleUnderLabel(page: Page, scrollTestId: string, row: Locator): Promise<void> {
  const scroller = page.getByTestId(scrollTestId);
  await expect
    .poll(() => scrollACircleUnderTheLabel(scroller, row), {
      timeout: 15_000,
      message: "one of the child row's circles must sit under its label",
    })
    .toBe(true);
}

test.describe("T135 — a child row's label hides the circles scrolled under it", () => {
  test("in Fleet", async ({ page }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    const row = await bringSwimlaneRowIntoView(page, CONNECTOR_FIXTURE.childName);
    await expect(row).toHaveAttribute("data-topology", "child");
    await circleUnderLabel(page, "fleet-main-scroll", row);
    await expectOpaqueLabel(row);
  });

  test("in the per-agent swimlane modal", async ({ page }) => {
    await page.goto("/agents");
    await page.getByTestId("agents-search-input").fill(CONNECTOR_FIXTURE.parentName);
    const tableRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .filter({ hasText: CONNECTOR_FIXTURE.parentName })
      .first();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    const agentId = await tableRow.getAttribute("data-agent-id");
    await page.getByTestId(`agent-row-open-swimlane-modal-${agentId}`).click();
    const modal = page.getByTestId("per-agent-swimlane-modal");
    await expect(modal).toBeVisible();

    const row = modal.locator(
      `[data-testid="swimlane-agent-row-${CONNECTOR_FIXTURE.childName}"]`,
    );
    await expect(row).toHaveAttribute("data-topology", "child");
    await circleUnderLabel(page, "per-agent-swimlane-modal-scroll", row);
    await expectOpaqueLabel(row);
  });
});
