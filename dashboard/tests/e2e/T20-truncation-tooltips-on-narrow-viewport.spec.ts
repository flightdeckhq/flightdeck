import { test, expect } from "@playwright/test";
import {
  TRUNCATION_AGENT,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T20 — agent-name-link tooltip browser-layer regression guard.
// T6 covers the same fixture but at one viewport width; this spec
// adds hover-on-link + resize-stability coverage so the contract
// holds from a real operator perspective.
//
// What this guards (in addition to T6):
//   1. Hovering the link does not strip the ``title`` attribute
//      (a regression where a parent pointer-events:none ancestor
//      swallowed the event before the link received it would
//      still pass a static count assertion but would fail to
//      deliver the OS tooltip).
//   2. After resize from narrow → wide → narrow, the title attr
//      survives. The Fix-2 contract is "always-on title", so the
//      attr is unconditional — but the assertion still catches a
//      future refactor that re-introduces a measurement-loop or
//      a conditional render that drops the attr on a wide
//      viewport.
test.describe("T20 — Agent-name link tooltip survives hover + resize", () => {
  test("hover on a truncated row exposes the full agent_name via title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    // The title lives on the swimlane-agent-name-link element
    // itself. Poll on the attribute to ride out the mount tick.
    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect
      .poll(async () => link.getAttribute("title"), {
        message:
          "expected swimlane-agent-name-link[title] equal to the full agent name",
        timeout: 5_000,
      })
      .toBe(TRUNCATION_AGENT.name);

    await link.hover();
    await expect(link).toHaveAttribute("title", TRUNCATION_AGENT.name);
  });

  test("title survives a narrow → wide → narrow resize cycle", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await waitForFleetReady(page);

    const row = await bringSwimlaneRowIntoView(page, TRUNCATION_AGENT.name);
    await expect(row).toBeVisible();

    const link = row.locator('[data-testid="swimlane-agent-name-link"]');
    await expect
      .poll(async () => link.getAttribute("title"), { timeout: 5_000 })
      .toBe(TRUNCATION_AGENT.name);

    // Wide viewport — the always-on contract means the title
    // stays even though the text now fits. A regression that
    // re-introduced conditional title would drop the attr on
    // this step.
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect
      .poll(async () => link.getAttribute("title"), { timeout: 5_000 })
      .toBe(TRUNCATION_AGENT.name);

    // Back to narrow — title still present after the resize
    // cycle, locking in the "always-on" contract end-to-end.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect
      .poll(async () => link.getAttribute("title"), {
        message:
          "title must remain attached after the viewport returns to narrow width",
        timeout: 5_000,
      })
      .toBe(TRUNCATION_AGENT.name);
  });
});
