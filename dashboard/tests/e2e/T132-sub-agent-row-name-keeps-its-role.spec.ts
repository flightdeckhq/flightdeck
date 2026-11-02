import { test, expect, type Locator, type Page } from "@playwright/test";
import { LEFT_PANEL_WIDTH_KEY } from "@/lib/constants";
import {
  FANOUT_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T132 — A sub-agent row's name keeps its role readable.
//
// A Claude Code sub-agent is named {parent}/{role}, so the role is
// the only part of the name that differs from the parent's row. At
// the 460 px default the trailing chrome (client pill, agent-type
// badge, provider icon, the `↳ parent` pill) used to squeeze the
// name link down to its 3rem floor, which read `e2e-t…` with the
// role gone. The name now renders as a head, which gives way first,
// and a role suffix that keeps its full width; the relationship pill
// shrinks before the name does.
//
// The role check compares the role span's box with its text's own
// width (a Range), not scrollWidth with clientWidth: both of those
// round to whole pixels, and a fraction of a pixel of shrink is
// already enough for Chromium to draw `/wor…`. An unshrunk span and
// its text run snap to the same layout unit, so they compare equal.
//
// Geometry only, so both theme projects run it unchanged.

test.use({ viewport: { width: 1600, height: 1400 } });

// Float noise only. A shrunk role is short by at least a layout unit
// (1/64 px, about 0.016), which this does not forgive.
const EPSILON_PX = 0.001;

async function openFleetAtDefaultWidth(page: Page): Promise<Locator> {
  await page.addInitScript((key) => {
    localStorage.removeItem(key);
  }, LEFT_PANEL_WIDTH_KEY);
  await page.goto("/");
  await waitForFleetReady(page);
  const row = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-topology", "child");
  // Measure with the label font loaded, not a fallback.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return row;
}

async function measureName(link: Locator) {
  return link.evaluate((el) => {
    const role = el.querySelector<HTMLElement>(
      '[data-testid="swimlane-agent-name-role"]',
    );
    const head = el.querySelector<HTMLElement>(
      '[data-testid="swimlane-agent-name-head"]',
    );
    if (!role || !head) return null;
    const text = document.createRange();
    text.selectNodeContents(role);
    const linkBox = el.getBoundingClientRect();
    const roleBox = role.getBoundingClientRect();
    return {
      linkWidth: linkBox.width,
      linkRight: linkBox.right,
      roleBoxWidth: roleBox.width,
      roleTextWidth: text.getBoundingClientRect().width,
      roleRight: roleBox.right,
      headWidth: head.getBoundingClientRect().width,
    };
  });
}

test.describe("T132 — sub-agent row name keeps its role", () => {
  test("at the 460 px default the worker row shows its whole /worker role", async ({
    page,
  }) => {
    const row = await openFleetAtDefaultWidth(page);
    const link = row.getByTestId("swimlane-agent-name-link");
    await expect(link).toHaveAttribute("title", FANOUT_FIXTURE.workerName);
    await expect(link.getByTestId("swimlane-agent-name-role")).toHaveText(
      `/${FANOUT_FIXTURE.workerRole}`,
    );
    await expect(link).toHaveText(FANOUT_FIXTURE.workerName);

    const m = await measureName(link);
    expect(m).not.toBeNull();
    // The link no longer sits on its 3rem (48 px) floor.
    expect(m!.linkWidth).toBeGreaterThan(48);
    // The role span is as wide as its text: no ellipsis, not even a
    // sub-pixel one, and it is not clipped by the link.
    expect(m!.roleBoxWidth).toBeGreaterThanOrEqual(m!.roleTextWidth - EPSILON_PX);
    expect(m!.roleRight).toBeLessThanOrEqual(m!.linkRight + EPSILON_PX);
    // The relationship pill gave way before the name: it sits on its
    // 1.75rem (28 px) floor or above, never at zero.
    const pill = row.getByTestId("swimlane-relationship-pill");
    const pillWidth = await pill.evaluate((el) => el.getBoundingClientRect().width);
    expect(pillWidth).toBeGreaterThanOrEqual(28 - EPSILON_PX);
  });

  test("dragging the column narrower takes width from the head and leaves the role whole", async ({
    page,
  }) => {
    const row = await openFleetAtDefaultWidth(page);
    const link = row.getByTestId("swimlane-agent-name-link");
    const before = await measureName(link);
    expect(before).not.toBeNull();
    // Narrow the column by half the slack the link has over its role,
    // so the head still has width to give: measured, not a fixed
    // width, because the label chrome's width follows the font.
    const slack = before!.linkWidth - before!.roleTextWidth;
    expect(slack, "the default leaves the link wider than its role").toBeGreaterThanOrEqual(4);
    const dx = Math.floor(slack / 2);

    // The handle spans the whole swimlane; grab it level with the
    // worker row, which is in view.
    const handle = page.getByTestId("left-panel-resize-handle");
    const box = await handle.boundingBox();
    const rowBox = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(rowBox).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = rowBox!.y + rowBox!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - dx, y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await measureName(link))?.linkWidth ?? 0)
      .toBeLessThan(before!.linkWidth - dx / 2);

    const m = await measureName(link);
    expect(m).not.toBeNull();
    expect(m!.linkWidth).toBeGreaterThan(m!.roleTextWidth);
    expect(m!.roleBoxWidth).toBeGreaterThanOrEqual(m!.roleTextWidth - EPSILON_PX);
    expect(m!.roleRight).toBeLessThanOrEqual(m!.linkRight + EPSILON_PX);
    // The head is what gave way.
    expect(m!.headWidth).toBeLessThan(before!.headWidth);
    expect(m!.headWidth).toBeGreaterThan(0);
    const headTruncated = await link
      .getByTestId("swimlane-agent-name-head")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(headTruncated).toBe(true);
  });
});
