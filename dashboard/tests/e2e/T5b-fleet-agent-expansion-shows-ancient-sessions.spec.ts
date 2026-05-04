import { test, expect } from "@playwright/test";
import {
  ANCIENT_AGENT,
  bringSwimlaneRowIntoView,
  findExpandedBody,
  waitForFleetReady,
} from "./_fixtures";

// T5b — V-DRAWER fix regression guard. Sibling to T5: where T5
// confirms the 28h-old aged-closed session surfaces in the
// expanded drawer (>24h Fleet rollup but inside the pre-V-DRAWER
// 7-day API default), T5b confirms a 9-day-old session ALSO
// surfaces -- the case the pre-fix dead-end was hiding.
//
// Pre-fix behaviour: ``loadExpandedSessions`` called
// ``fetchSessions(agent_id, limit=100)`` with no ``from`` bound,
// so the server's 7-day default narrowed the result. An agent
// whose only sessions were >7 days old read "No sessions to
// display for this agent." in the drawer -- a dead-end. Fix:
// pass ``from = new Date(0).toISOString()`` so all-time sessions
// return; render a "View in Investigate →" footer with adaptive
// "Show older sessions" pagination button. This spec asserts the
// post-fix contract.
//
// What MUST NOT happen: the "No sessions to display" copy. That's
// the dead-end the fix exists to prevent. Negative assertion is
// the load-bearing one.
test.describe("T5b — Ancient agent's expanded drawer is not a dead-end", () => {
  test.skip("ancient agent (sessions > 7 days) drawer shows session row + Investigate footer", async ({
    page,
  }) => {
    // Skipped per Rule 40c.1 (no flaky tests merged as-is) + Rule
    // 49 (declined-with-reason in the commit body). Test logic is
    // correct and passes 100% in isolation (``npx playwright test
    // T5b`` returns 2/2 across both themes). Fails intermittently
    // in CI under the full parallel suite — the virtualized
    // swimlane's IntersectionObserver mount cycle races
    // ``bringSwimlaneRowIntoView``'s scroll loop when 8+ Playwright
    // workers hit the dev stack simultaneously with WebSocket-
    // driven re-renders. Defensive helper improvements landed in
    // commit ``4e13bcd3`` (networkidle wait + detach-race
    // try/catch in ``_fixtures.ts``) reduced but did not eliminate
    // the flake.
    //
    // Re-enable once the flake is genuinely closed. Likely fix
    // candidates: replace the scroll-step loop with an
    // ``expect.poll`` + longer total budget; OR add a Fleet-level
    // "search by agent_name" input so the test can target the row
    // directly without scroll-to-find. Rule 40c.1 permits
    // ``test.skip`` as the softer form of "deleted" when the
    // underlying surface is worth keeping coverage for once the
    // flake is closed — the V-DRAWER fix this exercises (sessions
    // older than the swimlane's 24h default window must surface
    // in the expanded drawer) is a real and load-bearing
    // contract, not a test-of-test-infrastructure.
    await page.goto("/");
    await waitForFleetReady(page);

    // Resilience pattern P1/P2: scroll the virtualized swimlane
    // until the ancient agent's row mounts. The agent is
    // alphabetically buried among the dev DB's accumulated
    // ``e2e-*`` rows so first-page visibility isn't guaranteed.
    const row = await bringSwimlaneRowIntoView(page, ANCIENT_AGENT.name);
    await expect(
      row,
      `swimlane row for ${ANCIENT_AGENT.name} must mount via the bring-into-view helper`,
    ).toBeVisible();

    // Expand the row. Click the upper-left chevron area to avoid
    // landing on a session circle (T5's same trick).
    await row.click({ position: { x: 10, y: 20 } });
    const expandedBody = findExpandedBody(page, ANCIENT_AGENT.name);
    await expect(expandedBody).toHaveAttribute("data-expanded", "true");

    // Positive assertion: ≥1 session row renders. The ancient
    // session's started_at is 9 days ago; pre-fix it was hidden.
    const sessionRows = expandedBody.locator(
      '[data-testid="session-row"]',
    );
    await expect(sessionRows.first()).toBeVisible({ timeout: 5000 });
    expect(await sessionRows.count()).toBeGreaterThanOrEqual(1);

    // Negative assertion (load-bearing): the dead-end copy must
    // NOT render. This is the regression guard the fix exists for.
    await expect(
      expandedBody.locator('[data-testid="swimlane-expanded-empty"]'),
      "ancient-agent drawer must not render the 'No sessions to display' dead-end",
    ).toHaveCount(0);

    // Footer present: "View in Investigate →" link is the
    // dedicated full-history surface. Always rendered when at
    // least one session is visible.
    const footerLink = expandedBody.locator(
      '[data-testid="swimlane-expanded-investigate-link"]',
    );
    await expect(footerLink).toBeVisible();
    const href = await footerLink.getAttribute("href");
    expect(href).toMatch(/\/investigate\?agent_id=/);
    // Click navigates to the Investigate page filtered to this
    // agent. URL gets the deep-link param.
    await footerLink.click();
    await expect(page).toHaveURL(/\/investigate\?agent_id=/);
  });
});
