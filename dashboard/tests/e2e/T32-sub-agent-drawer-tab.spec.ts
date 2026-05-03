import { test, expect, type Page } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T32 — Sub-agents drawer tab. Three layouts per design § 4.2:
//   * Parent only: SUB-AGENTS section listing children.
//   * Child only: SPAWNED FROM section pointing at the parent.
//   * Depth-2: both stacked, SPAWNED FROM on top.
// Drives the SubAgentsTab gating + SPAWNED FROM / SUB-AGENTS
// section presence per design doc § 5.2.

async function openSessionDrawer(page: Page, sessionId: string): Promise<void> {
  const params = new URLSearchParams({
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    session: sessionId,
  });
  await page.goto(`/investigate?${params.toString()}`);
  await waitForInvestigateReady(page);
  await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
  // Sub-agents tab — gated on parent_session_id OR has-children.
  const tabBtn = page.locator('[data-testid="drawer-tab-sub-agents"]');
  await expect(tabBtn).toBeVisible();
  await tabBtn.click();
  await expect(
    page.locator('[data-testid="sub-agents-tab-content"]'),
  ).toBeVisible();
}

test.describe("T32 — Sub-agents drawer tab", () => {
  test("parent-only session: SUB-AGENTS section renders, SPAWNED FROM does not", async ({
    page,
  }) => {
    // CrewAI parent's fresh-active session — has 2 children but
    // no parent of its own. Session id is derived deterministically
    // from the seed: see canonical.json/seed.py uuid5 namespace.
    await openSessionDrawer(page, "e69d1efb-bef3-509a-9bf5-576b23422206");
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer.locator('[data-testid="sub-agents-children"]')).toBeVisible();
    await expect(drawer.locator('[data-testid="sub-agents-spawned-from"]')).toHaveCount(0);
  });

  test("child-only session: SPAWNED FROM renders, SUB-AGENTS does not", async ({
    page,
  }) => {
    // CrewAI Researcher session — child of the parent above, no
    // children of its own.
    await openSessionDrawer(page, "3f9d2b65-d3a0-5340-893a-f526bdf5ed87");
    const drawer = page.locator('[data-testid="session-drawer"]');
    await expect(drawer.locator('[data-testid="sub-agents-spawned-from"]')).toBeVisible();
    await expect(drawer.locator('[data-testid="sub-agents-children"]')).toHaveCount(0);
  });

  test("depth-2 middle session: BOTH sections render, SPAWNED FROM on top", async ({
    page,
  }) => {
    // depth2-middle: child of depth2-grand AND parent of depth2-leaf.
    await openSessionDrawer(page, "31841e06-182e-5199-a44b-6e245aab5370");
    const drawer = page.locator('[data-testid="session-drawer"]');
    const spawnedFrom = drawer.locator('[data-testid="sub-agents-spawned-from"]');
    const children = drawer.locator('[data-testid="sub-agents-children"]');
    await expect(spawnedFrom).toBeVisible();
    await expect(children).toBeVisible();
    // SPAWNED FROM precedes SUB-AGENTS in DOM order so the visual
    // reading flow is "where I came from, then what I spawned"
    // (design § 4.2 / sub-question 4.2 lock).
    const spawnedFromBox = await spawnedFrom.boundingBox();
    const childrenBox = await children.boundingBox();
    expect(spawnedFromBox).not.toBeNull();
    expect(childrenBox).not.toBeNull();
    expect(spawnedFromBox!.y).toBeLessThan(childrenBox!.y);
  });
});
