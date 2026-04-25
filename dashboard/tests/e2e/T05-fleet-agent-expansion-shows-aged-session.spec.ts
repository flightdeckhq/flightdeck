import { test, expect } from "@playwright/test";
import {
  CODING_AGENT,
  bringSwimlaneRowIntoView,
  findExpandedBody,
  waitForFleetReady,
} from "./_fixtures";

// T5 — the aged-closed fixture (CODING_AGENT, started 28h ago) is
// a negative-space test: the swimlane (whatever its active time
// scale) NEVER surfaces aged-closed as a circle, because the
// swimlane query bounds itself to the SWIMLANE_LOOKBACK_MS (24h)
// window. The expanded-body MUST surface it after the agent row
// is expanded because loadExpandedSessions fetches with no time
// bound. Rather than asserting on a specific circle count (which
// depends on the time-range toggle the dashboard happens to be
// on), this test asserts the structural invariant: the set of
// session_ids visible in the expanded view is strictly larger
// than the set visible in swimlane circles, and the difference is
// at least one (the aged-closed session that can only be reached
// through expansion).
test.describe("T5 — Agent expansion surfaces session outside swimlane window", () => {
  test("CODING_AGENT expanded body surfaces at least one session NOT in the swimlane", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Resilience pattern P1/P2: scroll the virtualized swimlane
    // until the CODING_AGENT row is mounted. Pre-fix, the test
    // assumed first-page visibility; under realistic data volume
    // the row could be off-screen and the assertion would fail
    // even though the fixture exists.
    const row = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
    await expect(row).toBeVisible();

    // Let the initial fetch settle so the swimlane's circles (if
    // any at the current time scale) are in the DOM.
    await page.waitForTimeout(1500);

    // Count distinct session_ids that have circles in the CODING_AGENT
    // row's swimlane. This is zero in the default 1m view (no
    // fixture session has an event in the last 60 s); it's >=1 in a
    // wider view. Either way, aged-closed's session_id must NEVER
    // appear here.
    const swimlaneSessionIds = await row
      .locator('[data-testid^="session-circle-"]')
      .evaluateAll((nodes) =>
        Array.from(
          new Set(
            nodes
              .map((n) =>
                (n.getAttribute("data-testid") ?? "").replace(
                  "session-circle-",
                  "",
                ),
              )
              .filter(Boolean),
          ),
        ),
      );

    // Expand the row. row.click() with no position will land at
    // the row's center, which under some viewport widths sits on a
    // session circle — EventNode's onClick calls e.stopPropagation
    // and opens the session drawer instead of toggling expansion.
    // Click the upper-left corner of the row so we hit the chevron
    // area inside the left panel (circles live in the right panel
    // only). This is deterministic across viewport widths because
    // the left panel is sticky-positioned at x=0 with width >=240px.
    await row.click({ position: { x: 10, y: 20 } });
    const expandedBody = findExpandedBody(page, CODING_AGENT.name);
    await expect(expandedBody).toHaveAttribute("data-expanded", "true");

    // Expanded body renders one <SessionEventRow> per session. The
    // CODING_AGENT fixture has 6 sessions (fresh-active, recent-
    // closed, aged-closed, stale, error-active, policy-active);
    // see canonical.json. loadExpandedSessions bypasses the 24h
    // swimlane window so every session lands here.
    const expandedSessionIds = await expandedBody
      .locator('[data-testid="session-row"]')
      .evaluateAll((nodes) =>
        Array.from(
          new Set(
            nodes.map((n) => n.getAttribute("data-session-id") ?? ""),
          ),
        ).filter(Boolean),
      );
    expect(
      expandedSessionIds.length,
      `expanded body must list all CODING_AGENT sessions (fresh-active, ` +
        `recent-closed, aged-closed, stale, error-active, policy-active). Saw ` +
        `${expandedSessionIds.length}: ${expandedSessionIds.join(", ")}`,
    ).toBe(6);

    // Structural invariant: at least one session in expanded is NOT in
    // the swimlane. That session is the aged-closed fixture (28h old,
    // outside every Fleet time range). The exact count depends on
    // which time toggle is active; the >=1 delta is the contract.
    const onlyInExpanded = expandedSessionIds.filter(
      (sid) => !swimlaneSessionIds.includes(sid),
    );
    expect(
      onlyInExpanded.length,
      `expanded body must surface at least one session NOT visible in the ` +
        `swimlane (the aged-closed fixture). Saw ${onlyInExpanded.length} ` +
        `(swimlane had ${swimlaneSessionIds.length}, expanded had ` +
        `${expandedSessionIds.length}).`,
    ).toBeGreaterThanOrEqual(1);
  });
});
