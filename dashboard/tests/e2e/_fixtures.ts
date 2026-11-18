import { createHash, randomUUID } from "node:crypto";
import { expect, type Page, type Locator } from "@playwright/test";
import { PRIVATE_FIXTURE_HOSTS } from "./_private-fixtures";
import { API_URL, INGEST_URL } from "./_stack";

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
  /** Pydantic AI run with capture declared but its own content switch
   *  off: capture on, no content stored. */
  noContent: "e2e-genai-no-content",
  /** The Pydantic AI tool run replayed without capture: capture off. */
  captureOff: "e2e-genai-capture-off",
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
const GENAI_API = API_URL;

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
 *  sub-agent refresh leaves every fan-out run alone. The coordinator's
 *  second sub-agent, ``/wide``, has five runs started together in the
 *  same statement: one more than a row's four run lanes. */
export const FANOUT_FIXTURE = {
  coordinatorName: "e2e-test-fanout@e2e-host-fanout",
  workerName: "e2e-test-fanout@e2e-host-fanout/worker",
  workerRole: "worker",
  /** The three worker runs started together. */
  workerRoles: ["fanout-worker-1", "fanout-worker-2", "fanout-worker-3"],
  /** The worker's earlier lost run. */
  workerLostRole: "fanout-worker-lost",
  wideName: "e2e-test-fanout@e2e-host-fanout/wide",
  /** The five wide runs started together. */
  wideRoles: ["fanout-wide-1", "fanout-wide-2", "fanout-wide-3", "fanout-wide-4", "fanout-wide-5"],
} as const;

/** The long-run fixture: one run of e2e-test-long-run holding ``calls``
 *  tool calls and, newest of all, one tool call named ``needle``.
 *  globalSetup seeds it through ingestion
 *  (tests/e2e-fixtures/seed_long_run.py) once per stack and waits until
 *  the worker has stored it, before any spec starts. It is not seeded
 *  from a spec: the worker announces every event it stores on the live
 *  stream, so a run seeded while specs run sends about 2,050 frames to
 *  every page that has the stream on, and that page stops answering
 *  for seconds. */
export const LONG_RUN_FIXTURE = {
  needle: "e2e-long-run-needle",
  calls: 2050,
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
  /** A stale run open from -240 s, last seen at -200 s, beside an
   *  active run open from -200 s: two lanes, the stale run's line dashed
   *  from its last signal. */
  quiet: { name: "e2e-test-run-quiet", roles: { stale: "quiet-stale", live: "quiet-live" } },
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

// The most frames the swimlane walk waits after one scroll step for
// the rows in view to mount. They mount one or two frames after the
// scroll, on an idle machine and on a saturated one alike; the cap
// only matters for a placeholder that never mounts, and keeps the walk
// moving past it. 30 frames is half a second at 60 fps, and longer
// under load, where frames come slower.
const SETTLE_FRAMES_MAX = 30;
// The rootMargin of the IntersectionObserver that mounts swimlane rows
// (dashboard/src/components/timeline/VirtualizedSwimLane.tsx).
const SWIMLANE_ROW_ROOT_MARGIN_PX = 200;
// How far one step of the walk scrolls: about 3.3 rows. A step no
// taller than the scroller's visible box keeps every row in view for
// at least one step, and the walk waits for the rows in view to mount
// before the next step, so no row is scrolled past unseen. A larger
// step of 600 px could overshoot the box (about 310 px tall at the
// default viewport).
const SWIMLANE_WALK_STEP_PX = 200;
// The most steps one walk takes: 48 000 px of rows, a thousand agents,
// far past any seeded or accumulated fleet. The walk stops at the
// scroller's bottom before this on every real fleet.
const SWIMLANE_WALK_MAX_STEPS = 240;

/** The selector of an agent's swimlane row (see ``findSwimlaneRow``). */
function swimlaneRowSelector(agentName: string): string {
  return `[data-testid="swimlane-agent-row-${agentName}"]`;
}

/** What ``readSwimlaneRows`` reads off one mounted swimlane row, all of
 *  it at the same moment. */
export interface SwimlaneRowLabels {
  /** Whether the row has a box and is not hidden: what Playwright's
   *  ``toBeVisible`` checks. */
  visible: boolean;
  /** The client-type pill's text, trimmed (CSS shows it upper-case);
   *  null when the row has no pill. */
  clientTypePill: string | null;
  /** The agent-type badge's text, trimmed (CSS shows it upper-case);
   *  null when the row has no badge. */
  agentTypeBadge: string | null;
}

/** Each agent's row as ``readSwimlaneRows`` found it, or null for a row
 *  the walk never saw mounted. */
export type SwimlaneRowsRead = Record<string, SwimlaneRowLabels | null>;

interface SwimlaneFindArgs {
  /** Agent name -> the selector of its swimlane row. */
  targets: Record<string, string>;
  /** Scroll the first target's row into view once it is found. */
  scrollIntoView: boolean;
  stepPx: number;
  maxSteps: number;
  settleFramesMax: number;
  rootMarginPx: number;
}

/**
 * Runs in the page, as one evaluation: finds the swimlane row of every
 * target and reads its labels at the moment it is mounted.
 *
 * Rows already mounted are read at once. For the others it snaps the
 * scroller to the top (agents may live above the initial viewport:
 * fresh sub-agents that closed seconds ago land high in the swimlane
 * sort while the initial scroll position is mid-list on a populated
 * fleet), then walks it down in ``stepPx`` steps until every target has
 * been read, the scroller reaches its bottom, or ``maxSteps`` steps
 * have run.
 *
 * After each scroll the walk waits, frame by frame, for the rows now in
 * view to mount. A row mounts when its IntersectionObserver callback,
 * delivered after the frame that laid out the scroll, sets state and
 * React commits it, which can be a frame or two after the scroll. A
 * placeholder (``data-virtualized``) inside the scroller's visible box
 * is a row still waiting for that, so the walk takes the next step only
 * once no placeholder is left in view, or after ``settleFramesMax``
 * frames. The targets are checked after every frame.
 *
 * With ``scrollIntoView`` the first target's row, when mounted at the
 * end, is scrolled into view in the same evaluation, centred when it is
 * not fully in view (Chromium's ``scrollIntoViewIfNeeded``, the
 * alignment Playwright's own scroll uses). Nothing waits for the row to
 * hold still first: the page moves rows legitimately (the first render
 * mounts every row and the observer swaps those out of view for
 * placeholders; a row crossing an activity bucket moves the bucket
 * divider), and Playwright's wait for a row to hold still (two
 * animation frames with the same box) can use up a 2 s timeout on a
 * busy page.
 *
 * Self-contained: Playwright sends its source to the page, so it uses
 * nothing from this module.
 */
async function findSwimlaneRows(args: SwimlaneFindArgs): Promise<SwimlaneRowsRead> {
  const { targets, scrollIntoView, stepPx, maxSteps, settleFramesMax, rootMarginPx } = args;
  const found: SwimlaneRowsRead = {};
  for (const name of Object.keys(targets)) found[name] = null;
  const read = (row: HTMLElement): SwimlaneRowLabels => {
    const box = row.getBoundingClientRect();
    const pill = row.querySelector('[data-testid="swimlane-client-type-pill"]');
    const badge = row.querySelector('[data-testid="swimlane-agent-type-badge"]');
    return {
      visible:
        box.width > 0 &&
        box.height > 0 &&
        window.getComputedStyle(row).visibility !== "hidden",
      clientTypePill: pill ? (pill.textContent ?? "").trim() : null,
      agentTypeBadge: badge ? (badge.textContent ?? "").trim() : null,
    };
  };
  // Read every target not read yet whose row is mounted; true once
  // every target has been read.
  const readMounted = (): boolean => {
    let all = true;
    for (const [name, selector] of Object.entries(targets)) {
      if (found[name]) continue;
      const row = document.querySelector<HTMLElement>(selector);
      if (row) found[name] = read(row);
      else all = false;
    }
    return all;
  };
  const finish = (): SwimlaneRowsRead => {
    const first = Object.values(targets)[0];
    const row = scrollIntoView && first ? document.querySelector<HTMLElement>(first) : null;
    if (row) {
      const chromium = row as HTMLElement & {
        scrollIntoViewIfNeeded?: (centerIfNeeded?: boolean) => void;
      };
      if (chromium.scrollIntoViewIfNeeded) chromium.scrollIntoViewIfNeeded(true);
      else row.scrollIntoView({ block: "center", inline: "nearest" });
    }
    return found;
  };
  if (readMounted()) return finish();

  // The closest overflow:auto/scroll ancestor of a mounted row; the
  // document when there is none. No mounted row at all: nothing to walk.
  const anyRow = document.querySelector<HTMLElement>('[data-testid^="swimlane-agent-row-"]');
  if (!anyRow) return found;
  let scroller: HTMLElement | null = null;
  for (let node: HTMLElement | null = anyRow; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") {
      scroller = node;
      break;
    }
  }
  const scrolling = scroller ?? document.documentElement;
  const scrollTop = () => (scroller ? scroller.scrollTop : window.scrollY);
  const scrollDown = () => (scroller ?? window).scrollBy({ top: stepPx, behavior: "instant" });
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  // True when no placeholder sits in the box the rows' observer mounts
  // (the scroller's visible box, within the viewport and its root
  // margin), i.e. every row in view is mounted.
  const rowsInViewMounted = () => {
    const top = -rootMarginPx;
    const bottom = window.innerHeight + rootMarginPx;
    const clip = scroller?.getBoundingClientRect();
    const boxTop = clip ? Math.max(clip.top, top) : top;
    const boxBottom = clip ? Math.min(clip.bottom, bottom) : bottom;
    for (const el of scrolling.querySelectorAll('[data-virtualized="true"]')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > boxTop && r.top < boxBottom) return false;
    }
    return true;
  };
  // Wait for the rows in view to mount; true once every target is read.
  const settle = async () => {
    for (let frame = 0; frame < settleFramesMax; frame += 1) {
      await nextFrame();
      if (readMounted()) return true;
      if (rowsInViewMounted()) return false;
    }
    return readMounted();
  };
  if (scroller) scroller.scrollTop = 0;
  if (await settle()) return finish();
  for (let step = 0; step < maxSteps; step += 1) {
    const before = scrollTop();
    scrollDown();
    const moved = scrollTop() !== before;
    if (await settle()) return finish();
    // The scroller is at its bottom: every row has been in view.
    if (!moved) break;
  }
  return finish();
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
 * One browser evaluation (``findSwimlaneRows``) finds the row, walking
 * the scroller from the top when it is not mounted, and scrolls it into
 * view: one page round trip however far down the row sits. A round trip
 * costs up to a second or more under load with tracing on, so a lookup
 * of one round trip per step, or one that waits for the row to hold
 * still before scrolling, could spend a whole test's budget.
 * If the row never appears, the locator returned is the test
 * assertion's responsibility -- callers should follow up with
 * ``await expect(locator).toBeVisible()`` so a missing row produces
 * a clean failure with the locator's natural error message.
 *
 * The row can move or unmount again after this returns: the page keeps
 * re-rendering. A check that reads the row's own content should read it
 * with ``readSwimlaneRows`` inside ``expect.poll`` instead, which finds
 * and reads the row in the same evaluation.
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
  const selector = swimlaneRowSelector(agentName);
  // Under parallel-suite load the swimlane re-renders frequently as
  // WebSocket events arrive from concurrent tests, so a one-shot
  // scroll-and-grab races the IntersectionObserver. Wait for
  // network-idle first so the initial agent roster + the first
  // batch of WS-driven re-renders have settled before we start
  // scrolling. networkidle returns when there have been no
  // network requests for 500 ms, which is long enough that
  // virtualization's mount/unmount churn isn't actively destroying
  // rows under our scroll loop. Bounded at 5 s so a chatty CI dev
  // stack can't hang the helper indefinitely; the walk below
  // handles the case where idle is never reached.
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    /* fall through — proceed with whatever has loaded */
  }
  // The walk finds the scroller from a mounted row: wait for one.
  await page
    .locator('[data-testid^="swimlane-agent-row-"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.evaluate(findSwimlaneRows, {
    targets: { [agentName]: selector },
    scrollIntoView: true,
    stepPx: opts.stepPx ?? SWIMLANE_WALK_STEP_PX,
    maxSteps: opts.maxSteps ?? SWIMLANE_WALK_MAX_STEPS,
    settleFramesMax: SETTLE_FRAMES_MAX,
    rootMarginPx: SWIMLANE_ROW_ROOT_MARGIN_PX,
  });
  // Return the locator whether or not the row was found, so the
  // caller's expect.toBeVisible() produces the useful failure message.
  return page.locator(selector);
}

/**
 * Find the swimlane rows of ``agentNames`` and read each one's labels
 * (``SwimlaneRowLabels``), in one browser evaluation; a row the walk
 * never saw mounted reads null. Made for ``expect.poll``: each attempt
 * finds and reads every row at the moment it is mounted, so a check
 * does not depend on a row staying put between page round trips while
 * the Fleet re-renders, re-sorts and swaps rows out of view, and its
 * cost does not grow with the number of rows checked.
 *
 *   await expect
 *     .poll(() => readSwimlaneRows(page, [CODING_AGENT.name]))
 *     .toEqual({ [CODING_AGENT.name]: { visible: true, ... } });
 *
 * It does not wait for the page: with no row mounted yet every row
 * reads null, and the poll tries again. It leaves the scroller where
 * the walk stopped.
 */
export async function readSwimlaneRows(
  page: Page,
  agentNames: readonly string[],
): Promise<SwimlaneRowsRead> {
  const targets: Record<string, string> = {};
  for (const name of agentNames) targets[name] = swimlaneRowSelector(name);
  return page.evaluate(findSwimlaneRows, {
    targets,
    scrollIntoView: false,
    stepPx: SWIMLANE_WALK_STEP_PX,
    maxSteps: SWIMLANE_WALK_MAX_STEPS,
    settleFramesMax: SETTLE_FRAMES_MAX,
    rootMarginPx: SWIMLANE_ROW_ROOT_MARGIN_PX,
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


/** An agent's id by its name, from the fleet roster the dashboard
 *  loads (``GET /v1/fleet``, paged). */
export async function agentIdByName(page: Page, agentName: string): Promise<string> {
  const perPage = 200;
  for (let p = 1; p <= 50; p++) {
    const resp = await page.request.get(`${GENAI_API}/v1/fleet?page=${p}&per_page=${perPage}`, {
      headers: GENAI_AUTH,
    });
    if (!resp.ok()) throw new Error(`fleet page ${p}: ${resp.status()}`);
    const { agents } = (await resp.json()) as {
      agents: { agent_id: string; agent_name: string }[] | null;
    };
    const hit = agents?.find((a) => a.agent_name === agentName);
    if (hit) return hit.agent_id;
    if (!agents || agents.length < perPage) break;
  }
  throw new Error(`no agent named ${agentName} in the fleet`);
}

/** Open the per-agent swimlane modal for ``agentName`` the way an
 *  operator does from anywhere: its agent drawer (the ``?agent_drawer=``
 *  param) and the drawer's "Open in swimlane". Returns the modal. */
export async function openPerAgentModal(page: Page, agentName: string): Promise<Locator> {
  const agentId = await agentIdByName(page, agentName);
  await page.goto(`/?agent_drawer=${encodeURIComponent(agentId)}`);
  const drawer = page.locator(`[data-testid="agent-drawer"][data-agent-id="${agentId}"]`);
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.locator('[data-testid="agent-drawer-open-swimlane"]').click();
  const modal = page.locator('[data-testid="per-agent-swimlane-modal"]');
  await modal.waitFor();
  return modal;
}

/** How long the private-agent helpers wait for the worker to store a
 *  run or an event: what the dashboard then fetches. */
const PRIVATE_STORE_WAIT_MS = 15_000;
/** The host the private runs send: the pre-flight's marker for them
 *  (_private-fixtures.ts). */
const PRIVATE_HOST = PRIVATE_FIXTURE_HOSTS.privateAgent;
/** The model the private runs report: the lane label shows it, and an
 *  LLM call on it carries no marker text. */
const PRIVATE_MODEL = "claude-sonnet-4-5";

/** An agent of one spec run's own, made through ingestion: no other
 *  spec, no seed and no keep-alive posts to its runs, so what its lanes
 *  draw is only what the spec posts. */
export interface PrivateAgent {
  agentId: string;
  agentName: string;
  flavor: string;
  sessionIds: string[];
  /** A sub-agent's role, on every event it posts. */
  role?: string;
  /** A sub-agent's parent run for each of its runs, by index: the
   *  ``parent_session_id`` its ``session_start`` carries. */
  parentSessionIds?: string[];
}

function privateEvent(
  agent: PrivateAgent,
  sessionId: string,
  eventType: string,
  at: Date,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: sessionId,
    flavor: agent.flavor,
    event_type: eventType,
    host: PRIVATE_HOST,
    framework: "claude-code",
    model: PRIVATE_MODEL,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_used_session: 0,
    token_limit_session: null,
    latency_ms: null,
    tool_name: null,
    tool_input: null,
    tool_result: null,
    has_content: false,
    content: null,
    capture_prompts: true,
    timestamp: at.toISOString(),
    agent_id: agent.agentId,
    agent_type: "coding",
    agent_name: agent.agentName,
    client_type: "claude_code",
    user: "e2e-runner",
    hostname: PRIVATE_HOST,
    ...(agent.role ? { agent_role: agent.role } : {}),
    ...extra,
  };
  if (eventType === "session_start") {
    payload.sensor_version = "e2e-fixture/0.0.0";
    payload.context = { os: "Linux", arch: "x86_64", hostname: PRIVATE_HOST, user: "e2e-runner" };
  }
  return payload;
}

async function postPrivateEvent(page: Page, payload: Record<string, unknown>): Promise<void> {
  const resp = await page.request.post(`${INGEST_URL}/v1/events`, { headers: GENAI_AUTH, data: payload });
  if (!resp.ok()) {
    throw new Error(`POST ${String(payload.event_type)}: ${resp.status()} ${await resp.text()}`);
  }
}

async function privateSession(
  page: Page,
  sessionId: string,
): Promise<{ state: string; events: { id: string; event_type: string; tool_name: string | null }[] } | null> {
  const resp = await page.request.get(`${GENAI_API}/v1/sessions/${sessionId}`, { headers: GENAI_AUTH });
  if (resp.status() === 404) return null;
  if (!resp.ok()) throw new Error(`session ${sessionId}: ${resp.status()}`);
  const body = (await resp.json()) as {
    session: { state: string };
    events: { id: string; event_type: string; tool_name: string | null }[];
  };
  return { state: body.session.state, events: body.events };
}

/**
 * An agent of this spec run's own, named ``e2e-test-<label>-<id>``, with
 * ``runs`` run ids, nothing posted yet. The spec keeps it before
 * ``startPrivateAgent`` waits, so its ``afterEach`` can end whatever runs
 * a failed start left open.
 */
export function createPrivateAgent(label: string, runs: number): PrivateAgent {
  return {
    agentId: randomUUID(),
    agentName: `e2e-test-${label}-${randomUUID().slice(0, 8)}`,
    flavor: `e2e-${label}`,
    sessionIds: Array.from({ length: runs }, () => randomUUID()),
  };
}

/**
 * A sub-agent of the private agent ``parent``, named
 * ``<parent name>/<role>``, with one run under each of ``parentSessionIds``
 * (runs of ``parent``), nothing posted yet. Start it with
 * ``startPrivateAgent`` after its parent, and end it with
 * ``endPrivateAgent``.
 */
export function createPrivateSubAgent(
  parent: PrivateAgent,
  role: string,
  parentSessionIds: string[],
): PrivateAgent {
  return {
    agentId: randomUUID(),
    agentName: `${parent.agentName}/${role}`,
    flavor: parent.flavor,
    sessionIds: parentSessionIds.map(() => randomUUID()),
    role,
    parentSessionIds,
  };
}

/**
 * Start every run of ``agent`` with a ``session_start`` dated
 * ``startedAgoMs`` before now, and wait until each is stored and active.
 * The date places the start's circle on the lanes; the worker dates the
 * run itself when it takes the event. End it with ``endPrivateAgent``.
 */
export async function startPrivateAgent(
  page: Page,
  agent: PrivateAgent,
  { startedAgoMs = 0 }: { startedAgoMs?: number } = {},
): Promise<void> {
  const at = new Date(Date.now() - startedAgoMs);
  for (const [i, sessionId] of agent.sessionIds.entries()) {
    const parent = agent.parentSessionIds?.[i];
    await postPrivateEvent(
      page,
      privateEvent(agent, sessionId, "session_start", at, parent ? { parent_session_id: parent } : {}),
    );
  }
  for (const sessionId of agent.sessionIds) {
    await expect
      .poll(async () => (await privateSession(page, sessionId))?.state ?? null, {
        timeout: PRIVATE_STORE_WAIT_MS,
        message: `run ${sessionId} did not start`,
      })
      .toBe("active");
  }
}

/** Post one ``tool_call`` named ``toolName`` on the private run
 *  ``sessionId``, ``agoMs`` before now, wait until it is stored, and
 *  return its event id. */
export async function postPrivateToolCall(
  page: Page,
  agent: PrivateAgent,
  sessionId: string,
  toolName: string,
  agoMs: number,
): Promise<string> {
  await postPrivateEvent(
    page,
    privateEvent(agent, sessionId, "tool_call", new Date(Date.now() - agoMs), {
      tool_name: toolName,
      latency_ms: 11,
    }),
  );
  let eventId: string | undefined;
  await expect
    .poll(
      async () => {
        eventId = (await privateSession(page, sessionId))?.events.find((e) => e.tool_name === toolName)?.id;
        return eventId;
      },
      { timeout: PRIVATE_STORE_WAIT_MS, message: `${toolName} on ${sessionId} was not stored` },
    )
    .toBeDefined();
  return eventId!;
}

/** Post one ``post_call`` on the private run ``sessionId``, now, with its
 *  captured ``content`` (the event_content envelope: provider, model,
 *  system, messages, tools, response) and ``fields`` over the run's own
 *  (another client's identity, the call's model and provider); wait
 *  until it is stored with its content, and return its event id. A run
 *  takes one such call: the first stored ``post_call`` is the one. */
export async function postPrivatePostCall(
  page: Page,
  agent: PrivateAgent,
  sessionId: string,
  content: Record<string, unknown>,
  fields: Record<string, unknown> = {},
): Promise<string> {
  await postPrivateEvent(
    page,
    privateEvent(agent, sessionId, "post_call", new Date(), {
      tokens_input: 90,
      tokens_output: 15,
      tokens_total: 105,
      latency_ms: 700,
      ...fields,
      has_content: true,
      content: { ...content, session_id: sessionId, event_id: "" },
    }),
  );
  let eventId: string | undefined;
  await expect
    .poll(
      async () => {
        eventId = (await privateSession(page, sessionId))?.events.find((e) => e.event_type === "post_call")?.id;
        return eventId;
      },
      { timeout: PRIVATE_STORE_WAIT_MS, message: `the post_call on ${sessionId} was not stored` },
    )
    .toBeDefined();
  return eventId!;
}

/** End every run of a private agent, so none stays open after its spec:
 *  each run's end is posted even when another's is refused (a run a
 *  failed start never stored). */
export async function endPrivateAgent(page: Page, agent: PrivateAgent): Promise<void> {
  for (const sessionId of agent.sessionIds) {
    await page.request.post(`${INGEST_URL}/v1/events`, {
      headers: GENAI_AUTH,
      data: privateEvent(agent, sessionId, "session_end", new Date()),
    });
  }
}
