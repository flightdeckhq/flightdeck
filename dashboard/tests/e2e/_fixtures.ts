import { createHash } from "node:crypto";
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
  // ``mcp-active`` carries one event of each of the six
  // MCP types plus ``context.mcp_servers[]`` populated with two
  // server fingerprints. T25 deep-links to
  // a session of this role and asserts on badge / icon / drawer
  // panel / facet rendering. Only the sensor agent gets it because
  // the Python sensor emits all six event types;
  // the Claude Code plugin path will be tested separately.
  sessionRoles: [
    "fresh-active",
    "recent-closed",
    "aged-closed",
    "stale",
    "mcp-active",
  ],
} as const;

/** MCP fixture metadata. Mirrors the ``mcp-active`` role
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
 * Ancient-agent fixture: an agent whose only seeded session is > 7
 * days old. Used by T5b to confirm the expanded swimlane drawer
 * surfaces sessions older than a 7-day window.
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

/** The Claude Code session reported over OpenTelemetry. Seeded by
 *  tests/e2e-fixtures/otlp_seed.py as one OTLP log export to
 *  ``POST /v1/logs``; the ids are ingestion's uuid5 derivation from
 *  the Claude Code ``session.id`` ``e2e-otlp-observer`` (and the
 *  sub-agent's ``agent_id`` ``e2eotlpchild01``). The root is pinned
 *  ``active`` on every seed run; the child is closed by its
 *  ``subagent_completed``. */
export const OTLP_AGENT = {
  name: "e2e-test-otlp@e2e-otlp-host",
  childName: "e2e-test-otlp@e2e-otlp-host/general-purpose",
  flavor: "e2e-otlp-claude-code",
  rootSessionId: "deeedb28-e808-5aca-9706-f3b038b36058",
  childSessionId: "7458fc5a-bb89-5a06-9644-413ca42f5907",
  claudeCodeVersion: "2.1.316",
  model: "claude-haiku-4-5-20251001",
  /** The root's api_request: Claude Code's own cost and TTFT. */
  rootCallCostUsd: 0.0173255,
  rootCallTtftMs: 935,
  rootCallRequestId: "req_e2e_otlp_root_1",
  mcpServer: "e2e-otlp-mcp",
  deniedTool: "Bash",
} as const;

/** The agent-framework runs tests/e2e-fixtures/genai_seed.py sends
 *  through the OTLP GenAI receiver, by flavor. Every seed replays each
 *  run under a fresh trace id dated at the seed, so a spec takes the
 *  newest trace of a flavor (``newestGenaiRun``). An agent's name is
 *  ``<flavor>/<agent>``, a sub-agent's ``<root agent name>/<role>``,
 *  and the unattributed session's the flavor alone. */
export const GENAI_FIXTURE = {
  /** Pydantic AI tool run, capture on: two calls and a tool call. */
  pydanticAi: "e2e-genai-pydantic-ai",
  /** Strands tool run under the older GenAI conventions. */
  strands: "e2e-genai-strands",
  /** OpenAI Agents hand-off: triage_agent hands off to weather_agent. */
  openaiHandoff: "e2e-genai-openai-handoff",
  /** Google ADK tool run: call content from its log records; its
   *  tool call carries none. */
  googleAdk: "e2e-genai-google-adk",
  /** Pydantic AI model call that failed: one llm_error. */
  modelError: "e2e-genai-model-error",
  /** Synthetic depth-2 run (coordinator -> researcher ->
   *  fact_checker) and, in a trace of its own, an unattributed call. */
  depth2: "e2e-genai-depth2",
} as const;

/** One stored session of a GenAI fixture run. */
export interface GenaiSession {
  session_id: string;
  agent_id: string;
  agent_name: string;
  started_at: string;
  context: Record<string, unknown>;
}

/** One stored event of a GenAI fixture session. */
export interface GenaiEvent {
  id: string;
  session_id: string;
  event_type: string;
  has_content: boolean;
  tool_name: string | null;
  payload?: Record<string, unknown>;
}

const GENAI_AUTH = { Authorization: "Bearer tok_dev" };
const GENAI_API = "http://localhost:4000/api";

/** The sessions of a GenAI fixture flavor's newest seeded run: every
 *  session of the trace whose session started last (a hand-off's two
 *  roots share one trace), keyed by agent name. The depth-2 flavor's
 *  unattributed session is in a trace of its own, read with
 *  ``unattributed: true``. */
export async function newestGenaiRun(
  page: Page,
  flavor: string,
  opts: { unattributed?: boolean } = {},
): Promise<Map<string, GenaiSession>> {
  const params = new URLSearchParams({
    flavor,
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    sort: "started_at",
    order: "desc",
    limit: "50",
  });
  const resp = await page.request.get(`${GENAI_API}/v1/sessions?${params}`, {
    headers: GENAI_AUTH,
  });
  if (!resp.ok()) throw new Error(`sessions of ${flavor}: ${resp.status()}`);
  const all = ((await resp.json()) as { sessions: GenaiSession[] }).sessions.filter(
    (s) => (s.context?.otel_unattributed === true) === (opts.unattributed === true),
  );
  const newest = all[0];
  if (!newest) throw new Error(`no seeded GenAI run of ${flavor}`);
  const trace = newest.context?.otel_trace_id;
  return new Map(
    all.filter((s) => s.context?.otel_trace_id === trace).map((s) => [s.agent_name, s]),
  );
}

/** A GenAI fixture session's events, oldest first. */
export async function genaiEvents(page: Page, sessionId: string): Promise<GenaiEvent[]> {
  const resp = await page.request.get(`${GENAI_API}/v1/sessions/${sessionId}`, {
    headers: GENAI_AUTH,
  });
  if (!resp.ok()) throw new Error(`session ${sessionId}: ${resp.status()}`);
  return ((await resp.json()) as { events: GenaiEvent[] }).events;
}

/** The one session of ``run`` named ``name``. */
export function genaiSession(run: Map<string, GenaiSession>, name: string): GenaiSession {
  const s = run.get(name);
  if (!s) throw new Error(`no session ${name} in [${[...run.keys()].join(", ")}]`);
  return s;
}

/** The SubAgentConnector in-window anchor pair. seed.py pins both
 *  runs active and posts a fresh tool_call on each at NOW-5s on every
 *  keep-alive cycle, so the pair always has a connector at 1m and
 *  wider ranges. */
export const CONNECTOR_FIXTURE = {
  parentName: "e2e-test-connector-parent",
  childName: "e2e-test-fresh-subagent",
} as const;

/** The fan-out fixture: a coordinator named like a Claude Code plugin
 *  agent ({user}@{host}) and its same-role sub-agent, named
 *  {parent}/{role} as the plugin names one. The worker agent holds an
 *  earlier lost run (started -2 h, last seen -1 h 55 min) and three
 *  runs started together. seed.py's fan-out refresh pins the
 *  coordinator and the three open worker runs in one statement on the
 *  full seed and every keep-alive cycle, posting the coordinator's
 *  spawn tool_call 1 s before the workers' tool_calls; T56's
 *  sub-agent refresh leaves every fan-out run alone. */
export const FANOUT_FIXTURE = {
  coordinatorName: "e2e-test-fanout@e2e-host-fanout",
  workerName: "e2e-test-fanout@e2e-host-fanout/worker",
  workerRole: "worker",
} as const;

/** The run-glyph lane fixtures (canonical.json roles that declare
 *  ``lane_segments``). seed.py's lane pin moves each run's events and
 *  session row back to its declared offsets from NOW on the full seed
 *  and every keep-alive cycle, all of them in one psql call, so they
 *  drift at most one keep-alive cycle plus a spec's own runtime. T56's sub-agent refresh never touches them (none is a
 *  sub-agent). Offsets are seconds from NOW. */
export const LANE_FIXTURES = {
  /** A [-150, -90] closed, B open from -120, C open from -60: C
   *  takes A's freed track. */
  laneReuse: {
    name: "e2e-test-run-lane-reuse",
    roles: { a: "lane-reuse-a", b: "lane-reuse-b", c: "lane-reuse-c" },
  },
  /** First run closed at -15 s, second open from 3 ms before that. */
  handoff: {
    name: "e2e-test-run-handoff",
    roles: { first: "handoff-first", second: "handoff-second" },
  },
  /** One run closed 10 s ago that started 2 h ago. */
  long: { name: "e2e-test-run-long", roles: { run: "long-closed" } },
  /** One run 2 s long, closed at -118 s. */
  short: { name: "e2e-test-run-short", roles: { run: "short-closed" } },
  /** A run with segments [-400, -340] and [-60, open], and a run
   *  [-250, -150] inside its gap. */
  resumed: {
    name: "e2e-test-run-resumed",
    roles: { resumed: "resumed-run", inGap: "resumed-gap-run" },
  },
  /** Lost runs (one last seen 1 h 55 min ago, one 40 min ago) and a run
   *  the reaper closed a minute ago, last seen 30 min ago. */
  lost: {
    name: "e2e-test-run-lost",
    roles: { earlier: "lost-earlier", recent: "lost-recent", reaped: "reaped-run" },
  },
  /** A run started 30 h ago (outside the Fleet's 24 h sessions page),
   *  last seen 20 min ago, reaped 2 min ago: only the agent's
   *  recent_sessions rollup carries it. */
  reapedOld: { name: "e2e-test-run-reaped-old", roles: { run: "reaped-old-run" } },
} as const;

/** The session id seed.py derives for a canonical (agent, role) pair:
 *  uuid5 of ``flightdeck-e2e/{agent_name}/{role}`` in the Flightdeck
 *  namespace (``_derive_session_id``). */
export function fixtureSessionId(agentName: string, role: string): string {
  return uuid5(`flightdeck-e2e/${agentName}/${role}`, FLIGHTDECK_NAMESPACE);
}

const FLIGHTDECK_NAMESPACE = "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61";

/** RFC 4122 version-5 UUID (SHA-1), as Python's ``uuid.uuid5``. */
function uuid5(name: string, namespace: string): string {
  const ns = Uint8Array.from(
    namespace.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)),
  );
  const bytes = createHash("sha1")
    .update(Buffer.concat([Buffer.from(ns), Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
 * SwimLane.tsx header div). Use this rather than
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
  // virtualizes again. A larger stepPx=600 routinely overshot the
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
  // a 2000ms timeout that would otherwise bubble all the way up and fail
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
  // Agents may live ABOVE the initial viewport (top
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
  // Replaces a ``waitForTimeout(150)`` fixed sleep that
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
    // a fixed sleep (waitForTimeout(150)) was sometimes
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

/**
 * Open the agent drawer from an /agents table row by clicking the
 * row's agent name. Clicking the row itself aims at the centre of its
 * box, and which cell sits there depends on the data and column widths:
 * it can be a topology pill or a sparkline, which handle the click
 * themselves and do not open the drawer. The name cell is plain text
 * on every row, so the click always reaches the row's handler.
 */
export async function openAgentDrawerFromRow(row: Locator): Promise<void> {
  await row.locator('[data-testid^="agent-row-name-"]').first().click();
}

