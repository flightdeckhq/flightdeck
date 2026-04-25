import type { Page, Locator } from "@playwright/test";

// Shared fixture metadata for the E2E suite. Mirrors the canonical
// dataset seeded by tests/e2e-fixtures/seed.py (via canonical.json).
// Duplicated here rather than parsed at runtime so test authors see
// the contract inline and TypeScript can enforce the shape. Any
// change to canonical.json MUST be reflected here -- mismatched
// fixture metadata produces confusing failures during assertions.
//
// Every agent name is prefixed with E2E_PREFIX so specs can
// discriminate our fixtures from any other data in the shared dev
// DB. Rule P1 (find-my-fixture, not assume-first-row).
export const E2E_PREFIX = "e2e-test-";

export const CODING_AGENT = {
  name: "e2e-test-coding-agent",
  agentType: "coding",
  clientType: "claude_code",
  flavor: "e2e-claude-code",
  model: "claude-sonnet-4-5",
  framework: "claude-code",
  sessionRoles: ["fresh-active", "recent-closed", "aged-closed", "stale"],
} as const;

export const SENSOR_AGENT = {
  name: "e2e-test-sensor-agent-prod",
  agentType: "production",
  clientType: "flightdeck_sensor",
  flavor: "e2e-research-agent",
  model: "gpt-4o-mini",
  framework: "langchain",
  sessionRoles: ["fresh-active", "recent-closed", "aged-closed", "stale"],
} as const;

// Long-named fixture drives T6 (truncation + title tooltip). At the
// narrow CI viewport (≤900 px), the agent-name span overflows and
// <TruncatedText> sets the native `title` attribute. At 1600 px the
// short-named CODING_AGENT/SENSOR_AGENT fit, and the negative
// assertion proves `title` stays unset when no truncation occurs.
export const TRUNCATION_AGENT = {
  name: "e2e-test-sensor-agent-long-name-for-truncation-testing-really-quite-long",
  agentType: "production",
  clientType: "flightdeck_sensor",
  flavor: "e2e-code-agent",
  model: "claude-sonnet-4-5",
  framework: "langchain",
  sessionRoles: ["fresh-active", "recent-closed"],
} as const;

/**
 * V-DRAWER fixture: an agent whose only seeded session is > 7 days
 * old. Used by T5b to confirm the expanded swimlane drawer surfaces
 * sessions outside the API's pre-V-DRAWER 7-day default window.
 * Distinct agent (not just a new role on an existing one) so the
 * Chrome-verifiable expectation is: ancient-only agent's drawer
 * shows ≥1 session, never the dead-end "No sessions to display"
 * copy. Seeded via canonical.json's ``ancient-only`` role with
 * started_offset_sec = -9 days.
 */
export const ANCIENT_AGENT = {
  name: "e2e-test-ancient-agent",
  agentType: "production",
  clientType: "flightdeck_sensor",
  flavor: "e2e-ancient-agent",
  model: "gpt-4o-mini",
  framework: "langchain",
  sessionRoles: ["ancient-only"],
} as const;

export const ALL_FIXTURE_AGENTS = [
  CODING_AGENT,
  SENSOR_AGENT,
  TRUNCATION_AGENT,
] as const;

// Role → approximate started_offset_sec from canonical.json. Tests
// assert on the derived UI state (swimlane visibility, expansion
// fallback) rather than raw timestamps, but having the offsets here
// documents the canonical dataset shape in one place.
export const ROLE_OFFSETS = {
  "fresh-active": { startedSec: -30, endedSec: null },
  "recent-closed": { startedSec: -600, endedSec: -120 },
  "aged-closed": { startedSec: -100800, endedSec: -97200 },
  stale: { startedSec: -10800, endedSec: null },
} as const;

// Swimlane renders a 24-hour window (fleet.ts SWIMLANE_LOOKBACK_MS).
// aged-closed sits outside at 28h, so T5 asserts it does NOT appear
// in the swimlane but DOES appear in the expanded-body list (which
// fetches with no time bound).
export const SWIMLANE_LOOKBACK_SEC = 24 * 60 * 60;

/**
 * Locate the swimlane row for an agent by agent_name. Swimlane rows
 * carry data-testid="swimlane-agent-row-<agent_name>" (added to
 * SwimLane.tsx header div in Phase 3). Use this rather than
 * getByText(agentName) because <TruncatedText> may collapse the
 * visible text to an ellipsis on narrow viewports -- the testid is
 * the authoritative handle.
 */
export function findSwimlaneRow(page: Page, agentName: string): Locator {
  return page.locator(`[data-testid="swimlane-agent-row-${agentName}"]`);
}

/**
 * Locate the table-view row for an agent by agent_id. agent_id is
 * not stable across seeds unless computed from the canonical
 * identity quintuple -- and we don't want to duplicate that
 * derivation in TS. Fall back to filtering the row set by agent
 * name text, which works because AgentTable renders the full name
 * in a cell (no TruncatedText on the primary name column).
 */
export function findAgentTableRow(page: Page, agentName: string): Locator {
  return page
    .locator('[data-testid^="fleet-agent-row-"]')
    .filter({ hasText: agentName });
}

/**
 * Locate the expanded-body container for an agent. data-expanded is
 * "true" when the row is open. Used by T5 to gate on expansion
 * before scanning the expanded session list.
 *
 * DOM shape (SwimLane.tsx):
 *   <div border-bottom>        — outer wrapper per flavor
 *     <div data-testid="swimlane-agent-row-...">   — clickable header
 *     <div data-testid="swimlane-expanded-body">   — SIBLING of the row
 *   </div>
 *
 * The xpath walks from row → following-sibling at the same depth. The
 * expanded-body sits next to the row inside the flavor's outer
 * wrapper. No `..` parent traversal needed.
 */
export function findExpandedBody(page: Page, agentName: string): Locator {
  const row = findSwimlaneRow(page, agentName);
  return row.locator(
    "xpath=following-sibling::div[@data-testid='swimlane-expanded-body']",
  ).first();
}

/**
 * Parse "?view=" from a URL string. Returns null if absent.
 * Fleet's view toggle persists via URL param; T2 and T9 assert on
 * the expected value.
 */
export function viewFromUrl(url: string): string | null {
  const u = new URL(url);
  return u.searchParams.get("view");
}

/**
 * Parse a URL for the Investigate deep-link params that Fleet→Investigate
 * emits (agent_id, from, to). Returns the three values as an object.
 * T2 / T7 / T8 assert on the presence and approximate range.
 */
export function investigateParamsFromUrl(url: string): {
  agentId: string | null;
  from: string | null;
  to: string | null;
} {
  const u = new URL(url);
  return {
    agentId: u.searchParams.get("agent_id"),
    from: u.searchParams.get("from"),
    to: u.searchParams.get("to"),
  };
}

/**
 * Wait for the Fleet page to settle: SOMETHING in the swimlane or
 * table view has mounted. Prefer this over networkidle, which is
 * flaky under Playwright's HMR dev mode.
 *
 * Critical: this no longer asserts on a *specific* fixture being
 * visible. The Fleet swimlane uses an IntersectionObserver-backed
 * virtualizer (see VirtualizedSwimLane.tsx), so under realistic
 * data volume (Phase 3 + Phase 4 dev DBs accumulate hundreds of
 * agents) any given fixture may be off-screen at initial render
 * even though it exists. Pinning readiness to a specific fixture
 * was the P2 violation that made T01/T05/T06/T09 flake. After this
 * settles, callers must use ``bringSwimlaneRowIntoView`` to scroll
 * a fixture into view before asserting on it.
 */
export async function waitForFleetReady(page: Page): Promise<void> {
  // First swimlane row OR first agent-table row -- whichever shows
  // up. Doesn't matter which agent that row represents, only that
  // the page has mounted some data.
  const anySwimlaneRow = page
    .locator('[data-testid^="swimlane-agent-row-"]')
    .first();
  const anyTableRow = page
    .locator('[data-testid^="fleet-agent-row-"]')
    .first();
  await anySwimlaneRow.or(anyTableRow).waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

/**
 * Scroll the Fleet swimlane container until the row for ``agentName``
 * is mounted in the DOM, then return its locator. Companion to
 * ``waitForFleetReady`` for resilience patterns P1 (find-my-fixture)
 * and P2 (paginate/scroll instead of assuming first-row visibility).
 *
 * The swimlane is virtualized: rows that haven't been intersected
 * with the viewport are placeholders without the
 * ``swimlane-agent-row-<name>`` testid. Scrolling the parent flex
 * container forces the IntersectionObserver to mount additional
 * rows, eventually exposing the target.
 *
 * The function probes the DOM after each chunked scroll step (up to
 * ``maxSteps`` × ``stepPx``) and returns as soon as the row mounts.
 * If the row never appears, the locator returned is the test
 * assertion's responsibility -- callers should follow up with
 * ``await expect(locator).toBeVisible()`` so a missing row produces
 * a clean failure with the locator's natural error message.
 *
 * Mirrors what a real operator does when hunting a known agent in a
 * long fleet: scroll the list. The dashboard does NOT yet expose a
 * Fleet-level search input that would let us filter the swimlane by
 * agent_name; until it does, scroll-to-find is the user-realistic
 * test path.
 */
export async function bringSwimlaneRowIntoView(
  page: Page,
  agentName: string,
  opts: { stepPx?: number; maxSteps?: number } = {},
): Promise<Locator> {
  const stepPx = opts.stepPx ?? 600;
  const maxSteps = opts.maxSteps ?? 80;
  const target = page.locator(
    `[data-testid="swimlane-agent-row-${agentName}"]`,
  );
  // Cheap path: row already mounted (top of LIVE bucket / small DB).
  if ((await target.count()) > 0) {
    await target.first().scrollIntoViewIfNeeded({ timeout: 2000 });
    return target;
  }
  // Resolve the closest scrollable ancestor of any mounted swimlane
  // row. Fleet's main view sits inside a ``flex-1`` div with
  // ``overflowY: auto`` -- evaluating against a known mounted row
  // is more robust than guessing the selector.
  const anyRow = page
    .locator('[data-testid^="swimlane-agent-row-"]')
    .first();
  await anyRow.waitFor({ state: "visible", timeout: 10_000 });
  for (let i = 0; i < maxSteps; i += 1) {
    // Scroll the closest overflow:auto ancestor by `stepPx`. JSDom
    // doesn't ship `closest()` finding overflow ancestors; walk up
    // the tree and check computed style.
    await anyRow.evaluate(
      (el, step) => {
        let node: HTMLElement | null = el as HTMLElement;
        while (node) {
          const style = window.getComputedStyle(node);
          if (
            style.overflowY === "auto" ||
            style.overflowY === "scroll"
          ) {
            node.scrollBy(0, step);
            return;
          }
          node = node.parentElement;
        }
        // Fallback: scroll the document.
        window.scrollBy(0, step);
      },
      stepPx,
    );
    // Let the IntersectionObserver fire and React commit.
    // 150ms is generous; the observer fires synchronously on layout
    // and React commits within a few ms, but Playwright's snapshot
    // can race the layout in HMR mode.
    await page.waitForTimeout(150);
    if ((await target.count()) > 0) {
      await target.first().scrollIntoViewIfNeeded({ timeout: 2000 });
      return target;
    }
  }
  // Return the locator anyway so the caller's expect.toBeVisible()
  // produces the useful failure message.
  return target;
}

/**
 * Scroll the Fleet table view until the row containing ``agentName``
 * is visible. Table view uses standard pagination (50 rows per
 * page by default), not virtualization -- but if the fixture sits
 * on a later page, we need to navigate to that page first. The
 * table-view variant is intentionally simpler: paginate forward
 * until the row's text appears.
 */
export async function bringTableRowIntoView(
  page: Page,
  agentName: string,
  opts: { maxPages?: number } = {},
): Promise<Locator> {
  const maxPages = opts.maxPages ?? 10;
  const target = findAgentTableRow(page, agentName);
  if ((await target.count()) > 0) return target;
  for (let i = 0; i < maxPages; i += 1) {
    const nextBtn = page.locator(
      '[aria-label="Go to next page"], [data-testid="pagination-next"]',
    );
    if ((await nextBtn.count()) === 0) break;
    if ((await nextBtn.first().isDisabled().catch(() => true))) break;
    await nextBtn.first().click();
    await page.waitForTimeout(200);
    if ((await target.count()) > 0) return target;
  }
  return target;
}

/**
 * Wait for Investigate to settle: the sessions table header row is
 * visible. Pagination + filter state may still be finalising but
 * the table scaffold is up.
 */
export async function waitForInvestigateReady(page: Page): Promise<void> {
  await page
    .locator("table")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}
