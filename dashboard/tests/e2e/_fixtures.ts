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
 * Wait for the Fleet page to settle: the first fixture row must be
 * visible in whichever view is active (swimlane or table). Prefer
 * this over networkidle, which is flaky under Playwright's HMR dev
 * mode. The function races a swimlane locator against a table
 * locator so callers on either view get a single wait helper.
 */
export async function waitForFleetReady(page: Page): Promise<void> {
  const swimlane = findSwimlaneRow(page, CODING_AGENT.name);
  const table = findAgentTableRow(page, CODING_AGENT.name);
  // Race the two locators. Playwright's `or` resolves when either
  // matches — `waitFor` then settles on the winner.
  await swimlane.or(table).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
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
