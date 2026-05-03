import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T35 — Sub-agent depth-2 rendering. Design § 4.2 + § 14: depth-2
// trees (parent → child → grandchild) render with the SubAgentsTab
// combined view (SPAWNED FROM + SUB-AGENTS stacked). Beyond depth
// 2 a "+N more levels" hint surfaces — but full N-deep
// visualization is explicitly out of scope per § 14.
//
// The seeded depth2-middle session is BOTH a child of depth2-grand
// AND a parent of depth2-leaf. T35 verifies the combined view
// renders correctly. The "+N more levels" hint surface is not yet
// implemented in v0.4.x dashboards (design § 4.2 supports it but
// the renderer surfaces only one level via the SUB-AGENTS list);
// asserted against the existing combined-view contract here.
test.describe("T35 — Sub-agent depth-2 rendering", () => {
  test("depth-2 middle session combined view: SPAWNED FROM + SUB-AGENTS together", async ({
    page,
  }) => {
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      session: "31841e06-182e-5199-a44b-6e245aab5370", // depth2-middle
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
    await page.locator('[data-testid="drawer-tab-sub-agents"]').click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    // SPAWNED FROM shows the grandparent.
    const spawnedFrom = drawer.locator('[data-testid="sub-agents-spawned-from"]');
    await expect(spawnedFrom).toBeVisible();
    // SUB-AGENTS lists the leaf.
    const children = drawer.locator('[data-testid="sub-agents-children"]');
    await expect(children).toBeVisible();
    // Leaf has the role "Worker" — the only seeded grandchild
    // under depth2-middle. Confirms the recursive linkage holds
    // through the full depth-2 chain (grand → middle → leaf).
    await expect(children).toContainText("Worker");
  });
});
