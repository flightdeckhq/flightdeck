import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

// T38 — Cross-agent message rendering. Drawer Sub-agents tab's
// per-child MESSAGES preview: INPUT preview (200 chars), OUTPUT
// preview, click-to-expand fetches via /v1/events/{id}/content for
// the >8 KiB overflow case (D126 § 6 contract). capture_prompts=
// false renders the Rule 21 disabled state.
test.describe("T38 — Cross-agent message rendering", () => {
  test("inline incoming + outgoing messages render under SPAWNED FROM (child view)", async ({
    page,
  }) => {
    // CrewAI Researcher child — captured_input + captured_output
    // are inline strings in canonical.json; both fit under 200
    // chars so the preview shows the full body.
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      session: "3f9d2b65-d3a0-5340-893a-f526bdf5ed87",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
    await page.locator('[data-testid="drawer-tab-sub-agents"]').click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    // Per the D126 UX revision (DECISIONS.md "UX revision 2026-05-04"),
    // own-side INPUT/OUTPUT messages live INSIDE the chevron-
    // expanded body of the SPAWNED FROM card alongside the metrics
    // summary + mini-timeline. Expand the card first.
    await drawer
      .locator('[data-testid="sub-agents-spawned-from-toggle"]')
      .click();
    // Own-side INPUT (received from parent) renders.
    await expect(drawer.locator('[data-testid="sub-agents-own-input"]'))
      .toContainText("Gather sources");
    // Own-side OUTPUT (sent back to parent) renders.
    await expect(drawer.locator('[data-testid="sub-agents-own-output"]'))
      .toContainText("Pulled 12 sources");
  });

  test("overflow body lazy-fetches via /v1/events/{id}/content on expand", async ({
    page,
  }) => {
    // subagent-overflow-input fixture: incoming_message has
    // has_content=true and the 9 KiB body lives in event_content.
    // Expand triggers the GET that pulls the full body.
    const params = new URLSearchParams({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      session: "89b00d96-cd22-5314-ad18-4123632f6a1e",
    });
    await page.goto(`/investigate?${params.toString()}`);
    await waitForInvestigateReady(page);
    await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
    await page.locator('[data-testid="drawer-tab-sub-agents"]').click();

    const drawer = page.locator('[data-testid="session-drawer"]');
    // UX revision: expand the SPAWNED FROM card before the message
    // previews materialise.
    await drawer
      .locator('[data-testid="sub-agents-spawned-from-toggle"]')
      .click();
    const ownInput = drawer.locator('[data-testid="sub-agents-own-input"]');
    await expect(ownInput).toBeVisible();
    // The header annotation flags the overflow shape.
    await expect(ownInput).toContainText("overflow");
    // Click Expand → lazy fetch fires and the full body lands.
    const expandBtn = ownInput.locator(
      '[data-testid="sub-agents-own-input-expand"]',
    );
    await expandBtn.click();
    // The synthetic body in canonical.json starts with
    // "OVERFLOW INPUT BODY". Wait for it to land after the fetch.
    await expect(ownInput).toContainText("OVERFLOW INPUT BODY", {
      timeout: 5000,
    });
  });

  test("capture_prompts=false renders the Rule 21 disabled state", async ({
    page,
  }) => {
    // Open a sub-agent session that does NOT have capture
    // enabled. The seeded crewai-researcher session above DOES
    // have capture enabled (every seeded session ships with
    // captures); to assert the disabled-state contract we'd need
    // a fixture without captures. The seed currently captures on
    // every session; this test pins the contract via the unit
    // suite (SubAgentsTab.test.tsx covers the disabled-state
    // branch). E2E coverage of the false-path is recorded here as
    // .skip so the test enumerates without requiring a fixture
    // change for the v0.4.x suite.
    test.skip(
      true,
      "capture_prompts=false fixture not seeded; covered by unit suite (SubAgentsTab.test.tsx)",
    );
    await page.goto("/");
  });
});
