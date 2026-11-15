/**
 * T56 — Every sub-agent swimlane row renders at least one event
 * circle on the live stack.
 *
 * Regression guard for the recent-sessions windowing. The
 * ``AgentSummary.recent_sessions`` rollup on ``/v1/fleet`` carries
 * each agent's most-recent sessions independent of the paginated
 * ``/v1/sessions`` page; the swimlane row reads its event circles
 * from those sessions via the merge in
 * ``dashboard/src/store/fleet.ts::buildFlavors``.
 *
 * Shape of the guarded bug: 16 of 17 sub-agent rows had
 * ``data-topology="child"`` but rendered with zero event circles
 * regardless of which time window the operator selected, because
 * ``buildFlavors`` couldn't find sessions for them in the
 * paginated ``/v1/sessions`` page. The fix attaches a
 * ``recent_sessions`` rollup on /v1/fleet so each row's session
 * slice is always populated; rendering then becomes a function
 * of the operator-selected time range.
 *
 * The test widens the time picker to ``1h`` before scanning so
 * every seeded sub-agent fixture's events fall inside the
 * visible window. The default time range on page load is ``1m``
 * (live-monitor view); closed sub-agent rows legitimately
 * render empty at that default — the operator widens the
 * picker to see history.
 *
 * The assertion is positive on every canonical sub-agent row
 * (``data-testid`` prefixed with ``swimlane-agent-row-e2e-test-``).
 * Real-world sub-agent rows that landed in the dev DB outside
 * the seed (e.g. operator-invoked Claude Code Task subagents)
 * are not part of the canonical contract and are tolerated.
 *
 * Theme-agnostic; runs under both projects via the Playwright
 * project matrix.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// Tall viewport so every seeded sub-agent row materialises
// simultaneously. The default viewport virtualises rows past the
// bottom edge; the regression guard must scan every child row, not
// just the visible-by-default subset.
test.use({ viewport: { width: 1280, height: 2200 } });

// A swimlane row's testid is this prefix and the agent name; the
// canonical seeded rows are the agents named ``e2e-test-*``.
const ROW_TESTID_PREFIX = "swimlane-agent-row-";
const CANONICAL_ROW_TESTID_PREFIX = `${ROW_TESTID_PREFIX}e2e-test-`;
const SESSION_CIRCLE_SELECTOR = '[data-testid^="session-circle-"]';
// What the scan reports when no canonical child row has mounted.
const NO_CANONICAL_CHILD_ROW = "(no canonical sub-agent row mounted)";

// How long the scan waits for every canonical child row to hold a
// session circle once the window is 1h. On CI under load the rows
// have their circles 0.1-2 s after the widening, and the steps before
// the scan (navigate, widen, scroll pass) take up to about 11 s of the
// 30 s test budget. 15 s is several times the settle time and still
// ends inside the budget, so a row that never gets its circle fails
// this assertion, by name, rather than the test timeout.
const CIRCLES_SETTLE_TIMEOUT_MS = 15_000;

// Resolve the seed helper relative to this spec so the worker
// invocation works regardless of where `npm run test:e2e` is
// launched from. ``dashboard/package.json`` is ``type: module``
// so ``__dirname`` is not injected — recover it from ``import.
// meta.url`` the ESM way, identical to ``globalSetup.ts``.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SEED_SCRIPT = resolve(
  REPO_ROOT,
  "tests",
  "e2e-fixtures",
  "seed.py",
);

// Time-anchor T56's fixtures against the wall-clock 1 h window.
//
// The dashboard's swimlane time-range picker maxes out at 1 h
// (TIMELINE_RANGE_MS). The Playwright globalSetup keep-alive
// watchdog refreshes only the active-role fixtures every 30 s;
// closed sub-agent fixtures carry their seed-time timestamps
// forward and after ~1 h of dev-stack uptime they fall outside
// the 1 h window. T56 then reds out against unchanged code — a
// flake by Rule 40c.1.
//
// Hardening: before every T56 run, invoke ``seed.py
// --refresh-subagent-events`` to pin the most-recent event of
// each closed sub-agent fixture to NOW − 30 s (plus bumps to
// sessions.last_seen_at and agents.last_seen_at). The refresh
// is idempotent and touches only the 9 closed sub-agent
// fixtures the assertion below scans, so other specs'
// invariants (event counts, run-bracket geometry, sub-agent
// connector overlays) are untouched.
test.beforeAll(() => {
  const python = process.env.PYTHON ?? "python3";
  const result = spawnSync(
    python,
    [SEED_SCRIPT, "--refresh-subagent-events"],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  // Separate the two failure modes so a missing-interpreter (ENOENT)
  // doesn't get misdiagnosed as a script crash. Mirrors the pattern
  // in ``globalSetup.ts``.
  if (result.error) {
    throw new Error(
      `T56 beforeAll: failed to spawn ${python}: ${result.error.message}. ` +
        `Is ${python} on PATH? Set PYTHON to override.`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    throw new Error(
      `T56 beforeAll: seed.py --refresh-subagent-events exited ${result.status}\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
});

test.describe("T56 — Every sub-agent row renders circles", () => {
  test("every visible data-topology=child row has at least one session circle", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Widen the swimlane window to ``1h`` before scanning. The
    // default time range on page load is ``1m`` (live-monitor
    // view); closed sub-agent fixtures whose events sit at
    // NOW-2m to NOW-7m legitimately render with no circles in
    // that window. The ``recent_sessions`` rollup contract is
    // about data availability — when the operator widens the
    // picker, every canonical sub-agent row must surface its
    // circles from the embedded slice without a follow-up
    // fetch. The button label "1h" is the picker's widest
    // option and reliably covers every canonical fixture.
    await page.getByRole("button", { name: "1h" }).click();

    // The fleet sometimes lazily materialises rows as they scroll
    // into the IntersectionObserver-tracked band. Scroll the whole
    // swimlane top → bottom in chunks so every row mounts before
    // the assertion fires.
    await page.evaluate(async () => {
      const scroller =
        document.querySelector('[data-testid="swimlane-scroll"]') ??
        document.scrollingElement;
      if (!scroller) return;
      const total = scroller.scrollHeight;
      const step = window.innerHeight * 0.8;
      for (let y = 0; y <= total; y += step) {
        scroller.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      scroller.scrollTop = 0;
    });

    // Restrict the assertion target to canonical seeded
    // sub-agent fixtures (data-testid prefixed with
    // ``swimlane-agent-row-e2e-test-``). Real-world sub-agent
    // rows that landed in the dev DB outside the seed
    // (e.g. operator-invoked Claude Code Task subagents) are
    // tolerated even if their rows render empty — those
    // sessions are not part of the canonical fixture contract.
    // The recent_sessions rollup is still verified for them
    // via the integration test ``test_fleet_recent_sessions.py``.
    const canonicalChildRows = page.locator(
      `[data-topology="child"][data-testid^="${CANONICAL_ROW_TESTID_PREFIX}"]`,
    );

    // Wait until every canonical child row holds a session circle.
    // The whole scan is one browser evaluation per poll: the rows,
    // and whether each holds a circle, are read in a single round
    // trip however many sub-agent rows the seed declares, and the
    // poll retries until the parallel /v1/sessions/:id event fetches
    // have settled. The rows that still lack a circle come back by
    // agent name, so a failure names them. No canonical row at all
    // returns NO_CANONICAL_CHILD_ROW, which fails the same assertion:
    // the test needs at least one such row to say anything.
    await expect
      .poll(
        () =>
          canonicalChildRows.evaluateAll(
            (rows, { circleSelector, prefix, none }) => {
              if (rows.length === 0) return [none];
              return rows
                .filter((row) => row.querySelector(circleSelector) === null)
                .map((row) => {
                  const testId = row.getAttribute("data-testid") ?? "";
                  const agentId = row.getAttribute("data-agent-id") ?? "?";
                  return `${testId.slice(prefix.length)} (agent ${agentId})`;
                });
            },
            {
              circleSelector: SESSION_CIRCLE_SELECTOR,
              prefix: ROW_TESTID_PREFIX,
              none: NO_CANONICAL_CHILD_ROW,
            },
          ),
        {
          message:
            "every canonical sub-agent row holds a session circle (received: " +
            "the rows that hold none). The recent_sessions rollup must surface " +
            "event circles for every seeded sub-agent row regardless of where " +
            "its sessions fall in the global /v1/sessions page.",
          timeout: CIRCLES_SETTLE_TIMEOUT_MS,
        },
      )
      .toEqual([]);
  });
});
