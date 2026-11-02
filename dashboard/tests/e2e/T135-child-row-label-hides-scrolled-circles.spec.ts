import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  FANOUT_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T135 — A child row's label hides the circles scrolled under it.
//
// The swimlane's label column is sticky: when the timeline scrolls
// sideways, the window's older circles slide under it. A root row's
// label paints the row's opaque --surface. A child row's tint is
// translucent, and a label that only inherited it let those circles
// show through over the pills and the status badge. The label now
// paints the same look in opaque layers, with the colour the rows sit
// on at the bottom (--bg in Fleet, --surface in the per-agent modal).
//
// With a circle under the worker row's label, in Fleet and in the
// modal, the label's computed background colour (its bottom layer)
// must be fully opaque. Colours differ per theme, so the spec checks
// only alpha (rule 40c.3).

// Narrow enough that Fleet's timeline (460 px label + 900 px panel)
// scrolls sideways beside the 240 px sidebar.
test.use({ viewport: { width: 1280, height: 1200 } });

/** Alpha channel of a computed CSS colour (``rgb()`` / ``rgba()``). */
function alphaOf(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unexpected colour format: ${color}`);
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? Number(parts[3]) : 1;
}

/** Whether some circle of ``row`` is centred under its label. */
async function labelCoversACircle(row: Locator): Promise<boolean> {
  return row.evaluate((r) => {
    const label = r.querySelector(".swimlane-row-label")!.getBoundingClientRect();
    return Array.from(r.querySelectorAll("[data-event-id]")).some((c) => {
      const b = c.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      return cx > label.left && cx < label.right;
    });
  });
}

async function labelBackground(row: Locator): Promise<{ color: string; image: string }> {
  return row.evaluate((r) => {
    const cs = getComputedStyle(r.querySelector(".swimlane-row-label")!);
    return { color: cs.backgroundColor, image: cs.backgroundImage };
  });
}

async function scrollFullyRight(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
}

test.describe("T135 — a child row's label hides the circles scrolled under it", () => {
  test("in Fleet, with the timeline scrolled to now", async ({ page }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await page.getByRole("button", { name: "5m", exact: true }).click();
    const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
    await expect(row).toHaveAttribute("data-topology", "child");
    await scrollFullyRight(page, "fleet-main-scroll");

    await expect
      .poll(() => labelCoversACircle(row), {
        timeout: 15_000,
        message: "a worker circle must sit under the label for the check to mean anything",
      })
      .toBe(true);
    const bg = await labelBackground(row);
    expect(alphaOf(bg.color), `label background ${bg.color}`).toBe(1);
    expect(bg.image).toContain("linear-gradient");
  });

  test("in the per-agent swimlane modal", async ({ page }) => {
    await page.goto("/agents");
    await page.getByTestId("agents-search-input").fill(FANOUT_FIXTURE.coordinatorName);
    const tableRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .filter({ hasText: FANOUT_FIXTURE.coordinatorName })
      .first();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    const agentId = await tableRow.getAttribute("data-agent-id");
    await page.getByTestId(`agent-row-open-swimlane-modal-${agentId}`).click();
    const modal = page.getByTestId("per-agent-swimlane-modal");
    await expect(modal).toBeVisible();
    await modal.getByTestId("per-agent-swimlane-modal-time-5m").click();

    const row = modal.locator(
      `[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.workerName}"]`,
    );
    await expect(row).toHaveAttribute("data-topology", "child");
    await scrollFullyRight(page, "per-agent-swimlane-modal-scroll");

    await expect
      .poll(() => labelCoversACircle(row), {
        timeout: 15_000,
        message: "a worker circle must sit under the label for the check to mean anything",
      })
      .toBe(true);
    const bg = await labelBackground(row);
    expect(alphaOf(bg.color), `label background ${bg.color}`).toBe(1);
    expect(bg.image).toContain("linear-gradient");
  });
});
