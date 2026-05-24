import type { Page, Locator } from "@playwright/test";

// Poll for a locator to mount (count > 0) without using a fixed
// waitForTimeout sleep (qa.md: "No waitForTimeout for
// synchronization in any test at any level"). Caps polling at
// ``timeoutMs`` so a row that never materialises returns false
// quickly. Sample interval is 50 ms — short enough that a
// commit-cycle race resolves within one or two samples.
async function pollForMount(
  locator: Locator,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 50;
  while (Date.now() < deadline) {
    if ((await locator.count()) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return (await locator.count()) > 0;
}

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
  // Phase 5 — ``mcp-active`` carries one event of each of the six
  // MCP types plus ``context.mcp_servers[]`` populated with two
  // server fingerprints. T25 (Phase 5 dashboard E2E) deep-links to
  // a session of this role and asserts on badge / icon / drawer
  // panel / facet rendering. Only the sensor agent gets it because
  // the Python sensor emits all six event types per Phase 5 D1;
  // the Claude Code plugin path will be tested separately.
  sessionRoles: [
    "fresh-active",
    "recent-closed",
    "aged-closed",
    "stale",
    "mcp-active",
  ],
} as const;

/** Phase 5 — MCP fixture metadata. Mirrors the ``mcp-active`` role
 *  on the sensor agent in canonical.json. T25 reads these names to
 *  assert the MCP SERVER facet, the drawer's MCP SERVERS panel, and
 *  the session listing's ``mcp_server_names[]`` aggregation surface
 *  the right names. */
export const MCP_FIXTURE = {
  role: "mcp-active",
  servers: [
    {
      name: "fixture-stdio-server",
      transport: "stdio",
      version: "1.0.0",
    },
    {
      name: "fixture-http-server",
      transport: "http",
      version: "0.9.2",
    },
  ],
  toolCallToolName: "echo",
  resourceUri: "mem://demo",
  promptName: "greet",
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
 * Parse a URL for the Events page deep-link params that surface
 * agent context (agent_id, from, to). Returns the three values as
 * an object.
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
 * Wait for the Fleet page to settle: at least one swimlane row has
 * mounted. Prefer this over networkidle, which is flaky under
 * Playwright's HMR dev mode.
 *
 * Critical: does not assert on a *specific* fixture being visible.
 * The Fleet swimlane uses an IntersectionObserver-backed
 * virtualizer (see VirtualizedSwimLane.tsx), so under realistic
 * data volume any given fixture may be off-screen at initial
 * render. Callers must use ``bringSwimlaneRowIntoView`` to scroll
 * a fixture into view before asserting on it.
 */
export async function waitForFleetReady(page: Page): Promise<void> {
  const anySwimlaneRow = page
    .locator('[data-testid^="swimlane-agent-row-"]')
    .first();
  await anySwimlaneRow.waitFor({ state: "visible", timeout: 15_000 });
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
  // Step ~3.3 rows at a time. 200px keeps the IntersectionObserver
  // sampling window (rootMargin=200 around the visible band)
  // overlapping between adjacent steps, so a row that materializes
  // briefly between scrolls is always re-checked before it
  // virtualizes again. Pre-fix stepPx=600 routinely overshot the
  // 5-7 row materialization band (rootMargin 200 + clientHeight 320
  // ≈ 720px of materialized DOM at any one time) and the helper
  // could miss a row that briefly mounted between samples.
  const stepPx = opts.stepPx ?? 200;
  const maxSteps = opts.maxSteps ?? 240;
  const target = page.locator(
    `[data-testid="swimlane-agent-row-${agentName}"]`,
  );
  // Under parallel-suite load the swimlane re-renders frequently as
  // WebSocket events arrive from concurrent tests, so a one-shot
  // scroll-and-grab races the IntersectionObserver. Wait for
  // network-idle first so the initial agent roster + the first
  // batch of WS-driven re-renders have settled before we start
  // scrolling. networkidle returns when there have been no
  // network requests for 500 ms, which is long enough that
  // virtualization's mount/unmount churn isn't actively destroying
  // rows under our scroll loop. Bounded at 5 s so a chatty CI dev
  // stack can't hang the helper indefinitely; the existing
  // scroll-loop fallback below handles the case where idle is
  // never reached.
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    /* fall through — proceed with whatever has loaded */
  }
  // Cheap path: row already mounted (top of LIVE bucket / small DB).
  // Wrap the scroll in try/catch — under parallel-suite load the row
  // can detach mid-call as the virtualized swimlane re-renders on
  // incoming WebSocket events from other concurrent tests, throwing
  // a 2000ms timeout that pre-fix bubbled all the way up and failed
  // the test outright. Falling through to the snap-to-top + scroll
  // loop below recovers cleanly because those steps re-evaluate
  // ``target.count()`` after each scroll.
  if ((await target.count()) > 0) {
    try {
      await target.first().scrollIntoViewIfNeeded({ timeout: 2000 });
      return target;
    } catch {
      /* fall through to the scroll loop below */
    }
  }
  // D126 step 8: agents may live ABOVE the initial viewport (top
  // of the activity bucket — fresh sub-agents that closed seconds
  // ago land high in the swimlane sort but the initial scroll
  // position is mid-list on a populated fleet). Try a snap to the
  // top of the swimlane container so the bucket head materializes
  // before the down-scroll loop kicks in.
  await page.evaluate(() => {
    const anyRow = document.querySelector(
      '[data-testid^="swimlane-agent-row-"]',
    ) as HTMLElement | null;
    if (!anyRow) return;
    let node: HTMLElement | null = anyRow;
    while (node) {
      const style = window.getComputedStyle(node);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  });
  // Poll for the target to materialise after the snap-to-top.
  // Replaces a pre-fix ``waitForTimeout(150)`` fixed sleep that
  // violated qa.md ("no waitForTimeout for synchronization") and
  // was the mechanical root cause of T34's parallel-worker flake
  // — under workers=4 contention the 150 ms pause was not long
  // enough for the IntersectionObserver commit. Polling for
  // count > 0 is deterministic regardless of contention. Cap at
  // 1.5 s so the helper falls through to the scroll loop quickly
  // when the target is genuinely off-screen.
  if (await pollForMount(target, 1_500)) {
    try {
      await target.first().scrollIntoViewIfNeeded({ timeout: 2000 });
      return target;
    } catch {
      /* fall through to the scroll loop below */
    }
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
    // Poll the target's mount state instead of sleeping. The
    // IntersectionObserver fires synchronously on layout and
    // React commits within a few ms; under parallel-worker load
    // the fixed-sleep pre-fix (waitForTimeout(150)) was sometimes
    // shorter than the commit cycle and the helper would skip
    // past a briefly-materialised row. ``pollForMount`` caps at
    // 500 ms — generous enough to absorb a slow commit, short
    // enough to keep the scroll loop progressing.
    if (await pollForMount(target, 500)) {
      try {
        await target.first().scrollIntoViewIfNeeded({ timeout: 2000 });
        return target;
      } catch {
        // Detach race — keep scrolling. The next iteration's count
        // re-check + scrollBy gives virtualization another chance
        // to settle. Without this catch the very last step that
        // would have succeeded throws and surfaces as a test fail.
      }
    }
  }
  // Return the locator anyway so the caller's expect.toBeVisible()
  // produces the useful failure message.
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
