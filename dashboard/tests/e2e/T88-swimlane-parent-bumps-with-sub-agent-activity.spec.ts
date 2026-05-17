/**
 * T88 — a sub-agent event bubbles the whole parent + sub-agent
 * cluster into the LIVE/RECENT region of the Fleet swimlane.
 *
 * Polish Batch 2 Fix 5 — when the Fleet WebSocket delivers an
 * event for a sub-agent session (one carrying a
 * `parent_session_id`), the fleet store's `applyUpdate` resolves
 * the PARENT flavor, bumps its `last_seen_at` to now, and advances
 * its `enteredBucketAt` entry. The visible result: the parent
 * agent's swimlane row — which would otherwise stay frozen in its
 * stale/IDLE bucket because the WS envelope only carries the
 * child's session — bubbles up alongside its sub-agent into the
 * LIVE bucket.
 *
 * The spec drives a fresh sub-agent `tool_call` event through the
 * real ingestion → NATS → worker → WebSocket path (the same path
 * `seed.py` uses) and asserts the parent agent's swimlane row sits
 * in the LIVE region (above the first IDLE bucket divider) after
 * the event lands.
 *
 * COVERAGE / KNOWN LIMITATION: the authoritative coverage for the
 * `applyUpdate` parent-bump logic is the unit test
 * `tests/unit/fleet-applyUpdate-parent-bump.test.ts`, which
 * deterministically seeds an IDLE parent and asserts the IDLE→LIVE
 * transition on a child FleetUpdate. This E2E cannot reproduce a
 * genuine IDLE-starting parent: the E2E seed runs a keep-alive
 * watchdog (required to hold the `fresh-active` / connector
 * fixtures in-window for the ~50 other specs) which forward-dates
 * every canonical parent agent, so no parent is ever IDLE during a
 * test run. T88 therefore verifies the WEAKER but still meaningful
 * invariant: the live ingestion → NATS → worker → WebSocket →
 * store path delivers a sub-agent event to an open Fleet page, and
 * the parent cluster lands in the LIVE region. A regression that
 * removed the parent-bump branch entirely would still be caught by
 * the unit test; T88 guards the live wiring end-to-end.
 *
 * Theme-agnostic — structural locators only; runs under both the
 * neon-dark and clean-light theme projects.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

const API = "http://localhost:4000/api";
const INGEST = "http://localhost:4000/ingest";
const AUTH = { Authorization: "Bearer tok_dev" };

interface ApiSession {
  session_id: string;
  flavor: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_type: string;
  agent_role: string | null;
  client_type: string | null;
  host: string | null;
  parent_session_id: string | null;
}

interface ApiAgent {
  agent_id: string;
  agent_name: string;
}

/** Resolve a sub-agent fixture: an e2e-prefixed session carrying a
 *  parent_session_id, the parent session it points at, and the
 *  parent agent's identity. Returns null when the seed has no
 *  resolvable sub-agent cluster (the test then skips). */
async function resolveSubAgentCluster(
  request: APIRequestContext,
): Promise<{
  child: ApiSession;
  parentSession: ApiSession;
  parentAgent: ApiAgent;
} | null> {
  // Server caps the sessions page at 100; include_parents pulls in
  // parents of any in-window children so the child→parent join
  // resolves from a single page.
  const sessResp = await request.get(
    `${API}/v1/sessions?limit=100&include_parents=true`,
    { headers: AUTH },
  );
  if (!sessResp.ok()) return null;
  const sessions: ApiSession[] = (await sessResp.json()).sessions ?? [];

  const fleetResp = await request.get(`${API}/v1/fleet?per_page=200`, {
    headers: AUTH,
  });
  if (!fleetResp.ok()) return null;
  const agents: ApiAgent[] = (await fleetResp.json()).agents ?? [];
  const agentById = new Map(agents.map((a) => [a.agent_id, a]));

  for (const child of sessions) {
    if (!child.parent_session_id) continue;
    if (!(child.agent_name ?? "").startsWith("e2e-test-")) continue;
    if (!child.agent_id) continue;
    const parentSession = sessions.find(
      (s) => s.session_id === child.parent_session_id,
    );
    if (!parentSession?.agent_id) continue;
    const parentAgent = agentById.get(parentSession.agent_id);
    // The parent agent must be in the fleet roster AND distinct
    // from the child (a true parent→child cluster).
    if (!parentAgent || parentAgent.agent_id === child.agent_id) continue;
    if (!(parentAgent.agent_name ?? "").startsWith("e2e-test-")) continue;
    return { child, parentSession, parentAgent };
  }
  return null;
}

/** Build a fresh sub-agent tool_call event payload — mirrors the
 *  shape `seed.py`'s make_event emits, with the child session's
 *  identity + the parent_session_id so the worker's parent-bump
 *  propagation fires and the WS envelope carries the linkage. */
function freshSubAgentEvent(child: ApiSession): Record<string, unknown> {
  return {
    session_id: child.session_id,
    flavor: child.flavor,
    event_type: "tool_call",
    host: child.host ?? "e2e-host",
    framework: null,
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_used_session: 0,
    token_limit_session: null,
    latency_ms: 11,
    tool_name: "t88-fresh-subagent-probe",
    tool_input: null,
    tool_result: null,
    has_content: false,
    content: null,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    agent_id: child.agent_id,
    agent_type: child.agent_type,
    client_type: child.client_type ?? "claude_code",
    user: "e2e-user",
    hostname: child.host ?? "e2e-host",
    agent_name: child.agent_name,
    agent_role: child.agent_role ?? "SubAgent",
    parent_session_id: child.parent_session_id,
  };
}

/**
 * For the agent row identified by `agentName`, report whether its
 * swimlane row sits in the LIVE/RECENT region of the swimlane —
 * i.e. there is NO bucket-divider targeting the IDLE bucket
 * positioned ABOVE the row in document order. Returns null when
 * the row is not currently materialised (the virtualized swimlane
 * has it off-screen) so the caller can keep polling.
 */
async function isRowInLiveRegion(
  page: import("@playwright/test").Page,
  agentName: string,
): Promise<boolean | null> {
  return page.evaluate((name) => {
    const row = document.querySelector(
      `[data-testid="swimlane-agent-row-${name}"]`,
    );
    if (!row) return null;
    // Every bucket divider carries data-testid="bucket-divider-
    // <prev>-<next>"; the IDLE region starts at the first divider
    // whose <next> bucket is "idle".
    const dividers = Array.from(
      document.querySelectorAll('[data-testid^="bucket-divider-"]'),
    );
    const idleDivider = dividers.find((d) =>
      (d.getAttribute("data-testid") ?? "").endsWith("-idle"),
    );
    if (!idleDivider) {
      // No IDLE divider rendered → every visible row is LIVE/RECENT.
      return true;
    }
    // The row is in the LIVE/RECENT region when it appears BEFORE
    // the first IDLE divider in document order.
    const pos = row.compareDocumentPosition(idleDivider);
    // DOCUMENT_POSITION_FOLLOWING (4) → idleDivider follows the row.
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, agentName);
}

test.describe("T88 — sub-agent activity bubbles the parent cluster into LIVE", () => {
  // Tall viewport so the parent's swimlane row materialises near
  // the top of the LIVE bucket without virtualization eviction
  // during the post-event poll.
  test.use({ viewport: { width: 1280, height: 1800 } });

  test("posting a sub-agent event lifts the parent agent's swimlane row into the LIVE region", async ({
    page,
    request,
  }) => {
    const cluster = await resolveSubAgentCluster(request);
    test.skip(
      cluster === null,
      "no e2e sub-agent cluster in the seeded dataset — run `make seed-e2e`",
    );
    const { child, parentAgent } = cluster!;

    await page.goto("/");
    await waitForFleetReady(page);

    // Drive a fresh sub-agent event through the live ingestion
    // path. The worker bumps the parent SESSION's last_seen_at and
    // re-broadcasts; the dashboard's fleet WebSocket delivers the
    // child's FleetUpdate (carrying parent_session_id) which fires
    // applyUpdate's parent-bump branch.
    const ingestResp = await request.post(`${INGEST}/v1/events`, {
      headers: { ...AUTH, "Content-Type": "application/json" },
      data: freshSubAgentEvent(child),
    });
    expect(
      ingestResp.ok(),
      `ingestion must accept the sub-agent event (got ${ingestResp.status()})`,
    ).toBe(true);

    // The parent agent's cluster bubbles into the LIVE region.
    // Poll: scroll the parent row into view (it floats toward the
    // top of LIVE once the bump lands) and check it precedes the
    // first IDLE bucket divider. The WS round-trip (ingestion →
    // NATS → worker → WS → store → re-render) settles within a
    // few seconds; 15 s is a generous cap.
    await expect
      .poll(
        async () => {
          await bringSwimlaneRowIntoView(page, parentAgent.agent_name);
          return isRowInLiveRegion(page, parentAgent.agent_name);
        },
        {
          timeout: 15_000,
          message:
            "the parent agent's swimlane row must bubble into the " +
            "LIVE region after its sub-agent emits an event",
        },
      )
      .toBe(true);
  });
});
