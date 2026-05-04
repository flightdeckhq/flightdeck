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

  // D126 UX revision (post-merge polish, pre-merge land):
  // chevron-expand-inline + session-id-link-navigate split. The
  // chevron and the session-id link are independent affordances —
  // chevron toggles inline expansion (metrics + mini-timeline +
  // messages); session-id link rebinds the drawer to the related
  // session.
  test("UX revision: chevron expands inline AND session-id link navigates (independent affordances)", async ({
    page,
  }) => {
    // Use the depth-2 middle session so both SPAWNED FROM + SUB-AGENTS
    // sections are present — covers both affordance pairs in one
    // run.
    await openSessionDrawer(page, "31841e06-182e-5199-a44b-6e245aab5370");
    const drawer = page.locator('[data-testid="session-drawer"]');

    // ── Chevron click on SPAWNED FROM card expands inline ──────
    // Pre-fix the whole card was a single navigate-button. Post-fix
    // the chevron is a dedicated toggle and the session-id text is
    // a separate link. Clicking the chevron must NOT rebind the
    // drawer — the URL ?session= param stays on the current
    // session_id (depth2-middle).
    const chevronToggle = drawer.locator(
      '[data-testid="sub-agents-spawned-from-toggle"]',
    );
    await expect(chevronToggle).toBeVisible();
    await chevronToggle.click();
    // Expansion body materialises — mini-timeline testid appears
    // inside the SPAWNED FROM card.
    await expect(
      drawer.locator('[data-testid="sub-agents-spawned-from-mini-timeline"]'),
    ).toBeVisible();
    // URL session param unchanged — chevron did NOT navigate.
    expect(page.url()).toContain(
      "session=31841e06-182e-5199-a44b-6e245aab5370",
    );

    // ── Session-id link click rebinds drawer to the parent ─────
    // The link in the SPAWNED FROM card carries
    // ``sub-agents-spawned-from-link`` testid. Clicking it calls
    // onSwitchSession with the parent's id; the drawer rebinds and
    // the URL ?session= param flips.
    const parentLink = drawer.locator(
      '[data-testid="sub-agents-spawned-from-link"]',
    );
    await expect(parentLink).toBeVisible();
    await parentLink.click();
    // URL flips to the parent (depth2-grand). Use poll-until-settle
    // so the drawer's AnimatePresence-wrapped rebind doesn't race
    // the assertion (per feedback_animatepresence_settle_poll
    // memory).
    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toContain(
      "session=31841e06-182e-5199-a44b-6e245aab5370",
    );
    expect(page.url()).toMatch(/session=[0-9a-f-]{36}/);
  });

  test("UX revision: child row chevron expands inline (independent of the row's session-id link)", async ({
    page,
  }) => {
    // CrewAI parent has 2 children. Open the parent's drawer, click
    // a child row's chevron, assert the mini-timeline + summary
    // metrics render inline without rebinding the drawer.
    await openSessionDrawer(page, "e69d1efb-bef3-509a-9bf5-576b23422206");
    const drawer = page.locator('[data-testid="session-drawer"]');
    // Find the first child row's chevron toggle. testid format:
    // sub-agents-child-toggle-<session_id>.
    const firstChildToggle = drawer
      .locator('[data-testid^="sub-agents-child-toggle-"]')
      .first();
    await expect(firstChildToggle).toBeVisible();
    await firstChildToggle.click();
    // Mini-timeline materialises inline. testid pattern:
    // sub-agents-child-<session_id>-mini-timeline. The
    // ``[data-testid^="sub-agents-child-"][data-testid$="-mini-timeline"]``
    // selector targets only child-row mini-timelines (not the
    // SPAWNED FROM section's, which would have prefix
    // ``sub-agents-spawned-from-``).
    await expect(
      drawer
        .locator(
          '[data-testid^="sub-agents-child-"][data-testid$="-mini-timeline"]',
        )
        .first(),
    ).toBeVisible();
    // Drawer URL still points at the parent (chevron did not
    // navigate).
    expect(page.url()).toContain(
      "session=e69d1efb-bef3-509a-9bf5-576b23422206",
    );
    // Summary metrics row is also visible inside the expanded body.
    await expect(
      drawer.locator('[data-testid="sub-agents-expansion-metrics"]').first(),
    ).toBeVisible();
  });
});
