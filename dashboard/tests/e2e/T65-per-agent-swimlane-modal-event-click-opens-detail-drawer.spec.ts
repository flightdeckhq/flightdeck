/**
 * T65 — clicking an event circle inside the per-agent swimlane
 * modal opens the stacked EventDetailDrawer.
 *
 * The modal mounts the existing EventDetailDrawer as a sibling
 * inside its Dialog content — the drawer renders position:fixed
 * over the entire viewport so it stacks above the modal
 * regardless of any nested-portal concerns. Clicking a
 * `data-testid^="session-circle-"` element inside the modal's
 * swimlane body fires the EventDetailDrawer mount.
 */
import { test, expect } from "@playwright/test";

test.describe("T65 — modal event-circle click opens stacked drawer", () => {
  test("event circle inside modal mounts EventDetailDrawer", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-table"]')).toBeVisible();

    // Open the modal on the e2e-test-coding-agent row. Its
    // keep-alive watchdog pins a fresh tool_call every cycle so
    // the modal's scoped swimlane reliably has in-window events
    // to render. Picking a canonical fixture name keeps the
    // test deterministic across the dev DB's varying noise.
    const codingRow = page
      .locator(
        '[data-testid^="agent-row-"][data-agent-id] >> nth=0 >> visible=true',
      )
      .first();
    void codingRow; // placate the linter if unused below
    const allRows = page.locator(
      '[data-testid^="agent-row-"][data-agent-id]',
    );
    await expect.poll(async () => allRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    // Walk the rows looking for e2e-test-coding-agent by reading
    // each row's identity cell text. The fixture name appears in
    // the row's identity cell so this is a deterministic match.
    const targetName = "e2e-test-coding-agent";
    const count = await allRows.count();
    let agentId = "";
    for (let i = 0; i < count; i++) {
      const row = allRows.nth(i);
      const text = (await row.textContent()) ?? "";
      if (text.includes(targetName)) {
        agentId = (await row.getAttribute("data-agent-id")) ?? "";
        break;
      }
    }
    expect(agentId).not.toBe("");
    const statusBtn = page.locator(
      `[data-testid="agent-row-open-swimlane-modal-${agentId}"]`,
    );
    await statusBtn.click();
    await expect(
      page.locator('[data-testid="per-agent-swimlane-modal"]'),
    ).toBeVisible();

    // Widen the modal's time-range to 1h so the seeded events
    // are guaranteed in-domain (the modal defaults to 1h
    // anyway; this is belt-and-suspenders for parallel-worker
    // timing under heavy load).
    await page
      .locator('[data-testid="per-agent-swimlane-modal-time-1h"]')
      .click();

    // The modal's swimlane body renders a `Timeline` scoped to
    // the focused agent. Wait for the body to mount and for at
    // least one swimlane row inside it to materialise — the
    // event-circle assertion below targets that row.
    const modalBody = page.locator(
      '[data-testid="per-agent-swimlane-modal-body"]',
    );
    await expect(modalBody).toBeVisible({ timeout: 5_000 });

    // Wait for at least one event circle to materialise inside
    // the modal body. The selector is scoped to the modal so
    // any background swimlane circles on the page don't satisfy
    // the assertion accidentally. The modal's swimlane scopes
    // flavors to the focused agent + its sub-agents, so the
    // count includes circles from any of those rows.
    const circle = modalBody
      .locator('[data-testid^="session-circle-"]')
      .first();
    await expect
      .poll(async () => circle.count(), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await circle.click({ force: true });

    // EventDetailDrawer doesn't carry a top-level data-testid
    // but always renders an internal `data-testid="detail-badge"`
    // + Close button (aria-label="Close"). Asserting the badge
    // is more specific than the Close button (which the modal
    // header's close button also exposes).
    await expect(page.locator('[data-testid="detail-badge"]')).toBeVisible({
      timeout: 5_000,
    });
  });
});
