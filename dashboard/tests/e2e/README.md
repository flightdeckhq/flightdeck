# Dashboard E2E tests (Playwright)

End-to-end browser tests for the Flightdeck dashboard. Runs on every
PR and tags the release with a green/red gate per CLAUDE.md rule
40c. Located at `dashboard/tests/e2e/`; shares a seeded Python
fixture dataset with the pytest integration suite via
`tests/shared/fixtures.py` + `tests/e2e-fixtures/seed.py`.

## What's covered

The catalog lives one file per journey. Test numbers are stable
identifiers; gaps (T02, T05, T07–T09, T11, T13, T31, T37) represent
specs that were removed when the affordances they covered were
removed (the `?view=table` toggle, the swimlane expand-row drawer,
the swimlane↔table parity assertion). The current journeys:

| File | Journey |
|------|---------|
| `T01-fleet-page-renders-full-state.spec.ts` | Fleet mounts, fixture agents visible, canonical-pair invariant guard |
| `T03-investigate-facet-filtering-intersection.spec.ts` | Two facets compose via AND; × on a pill relaxes to the single filter |
| `T04-investigate-session-drawer-deep-dive.spec.ts` | Drawer opens from row click; tabs work; close via X |
| `T06-truncation-and-tooltip.spec.ts` | Narrow viewport: long fixture name gets `title` attribute via `<TruncatedText/>` |
| `T10-wholedashboard-smoke.spec.ts` | Every top-level page mounts with no console errors |
| `T12-agent-chip-resolves-name-from-agent-endpoint.spec.ts` | Agent chip renders human-readable name from `/v1/agents/{id}` |
| `T14-embeddings-event-renders.spec.ts` | Embeddings event renders + drawer content tab works |
| `T15-streaming-indicators.spec.ts` | In-flight streaming run shows streaming pill |
| `T16-error-event-renders-and-filters.spec.ts` | llm_error events render; error_type facet filters |
| `T17-policy-events-render-and-filter.spec.ts` | Policy events render; matched_entry_id facet filters |
| `T18-investigate-last-seen-sortable.spec.ts` | Last-seen header is sortable ASC / DESC |
| `T19-investigate-state-sortable.spec.ts` | State header sorts by lifecycle severity ordinal |
| `T20-truncation-tooltips-on-narrow-viewport.spec.ts` | Truncation tooltips on multiple cells at narrow viewport |
| `T21-fleet-no-coding-sensor-anomaly.spec.ts` | Canonical pair invariant: no coding + sensor anomaly row |
| `T22-client-type-label-parity.spec.ts` | ClientTypePill text matches API client_type |
| `T23-investigate-sidebar-resizable.spec.ts` | Investigate sidebar drag-resize persists across reload |
| `T24-fleet-swimlane-horizontal-scroll.spec.ts` | Swimlane scrolls horizontally; sticky agent-name column |
| `T25-mcp-observability.spec.ts` | MCP server names + events render across surfaces |
| `T26-theme-matrix-canary.spec.ts` | Theme storage seeds neon-dark + clean-light identically |
| `T27-fleet-sidebar-policy-events.spec.ts` | Sidebar policy events section + count |
| `T28-claude-code-subagent-fleet-rendering.spec.ts` | Claude Code subagent renders as child topology |
| `T29-crewai-multi-agent-rendering.spec.ts` | CrewAI multi-agent runs render with role attribution |
| `T30-langgraph-multi-node-rendering.spec.ts` | LangGraph multi-node runs render with node attribution |
| `T32-sub-agent-drawer-tab.spec.ts` | Sub-agent drawer tab shows parent / child relationship |
| `T33-sub-agent-investigate-facets.spec.ts` | `is_sub_agent` facet filters Investigate scope |
| `T34-sub-agent-time-flow-connectors.spec.ts` | Bezier connectors from parent spawn → child first event |
| `T35-sub-agent-depth-2-rendering.spec.ts` | Two-level sub-agent hierarchy renders correctly |
| `T36-relationship-pill-navigation.spec.ts` | Click relationship pill jumps to target agent's row |
| `T38-cross-agent-message-rendering.spec.ts` | Cross-agent messages render on parent + child rows |
| `T39-sub-agent-analytics-dimensions.spec.ts` | `agent_role`, `parent_session_id` analytics dimensions |
| `T40-sub-agent-failure-row-cue.spec.ts` | Lost sub-agent surfaces red `i` cue on row + drawer |
| `T41-mcp-policy-operator-workflow.spec.ts` | MCP policy create / edit / dry-run / enforce workflow |
| `T42-investigate-payload-facets-server-side.spec.ts` | Payload facets compose server-side |
| `T43-swimlane-bucket-divider-cluster-integrity.spec.ts` | Bucket divider gridlines stay aligned across clusters |
| `T44-route-rename-301-redirect.spec.ts` | `/investigate` → `/events` 301 with query string preserved |
| `T45-swimlane-one-row-per-agent.spec.ts` | SwimLane renders one row per agent (no session sub-rows) |
| `T46-swimlane-subagent-indent.spec.ts` | Sub-agent rows render with `data-topology="child"` indent |
| `T47-run-bracket-hover-tooltip.spec.ts` | Hovering a run bracket shows tooltip with run metadata |
| `T48-run-bracket-click-opens-run-drawer.spec.ts` | Clicking a run bracket opens the drawer scoped to that run |
| `T49-agent-label-strip-ordering.spec.ts` | Label strip left-to-right order matches the locked spec |
| `T50-active-status-pulse.spec.ts` | AgentStatusBadge pulses only when state is `active` |
| `T51-view-table-toggle-removed.spec.ts` | `?view=table` URL no longer renders an alternate view |
| `T52-concurrent-runs-offset.spec.ts` | Two concurrent runs on the same agent anchor to opposite edges |
| `T53-run-bracket-end-square-live.spec.ts` | RunBracket end-square glyph (■) mounts for a closed-in-window session — regression guard for the end-glyph render path |
| `T54-child-row-bg-tint.spec.ts` | Child swimlane rows carry a visually distinct `background-color` from root rows — regression guard against an inline-style override beating the `[data-topology="child"]` CSS rule |
| `T55-swimlane-sub-agent-session-circle-renders.spec.ts` | Sub-agent swimlane row renders event circles and the connector overlay anchors at least one Bezier path for an in-window parent-child pair — regression guard for the agent-row `last_seen_at` bump that keeps sub-agent rows materialised at default viewport |
| `T131-event-circles-sit-on-their-row-centre.spec.ts` | Event circles sit on their row's centre line; the expanded ALL row's circles stay inside the row and share the agent rows' x |
| `T132-sub-agent-row-name-keeps-its-role.spec.ts` | A `{parent}/{role}` sub-agent row keeps its `/role` whole at the 460 px default and when the column is dragged narrower; the head gives way |
| `T133-sub-agent-connector-ends-on-the-circles-it-joins.spec.ts` | Every connector starts on its parent circle's rim and ends on its child circle's centre |
| `T134-hovering-a-run-lights-its-connectors.spec.ts` | Hovering a run's mark (or keyboard-focusing its glyph) lights exactly that run's connectors: a parent its fan-out, a child its own link |
| `T135-child-row-label-hides-scrolled-circles.spec.ts` | With circles scrolled under a child row's sticky label, in Fleet and in the per-agent modal, the label's background is fully opaque |
| `T136-freed-top-lane-is-reused.spec.ts` | A run that starts after an earlier run ended takes the top lane that run freed; the run still overlapping takes the second lane |
| `T137-runs-started-together-keep-reachable-glyphs.spec.ts` | Three runs started together keep disjoint start glyphs; each hit-tests to itself and opens its own run's tooltip |
| `T138-back-to-back-runs-keep-both-glyphs.spec.ts` | At 5m a hand-off (with 3 ms of worker-clock overlap) stays one lane and reads ■▶, both glyphs reachable |
| `T139-closed-run-shows-its-end-with-the-start-off-screen.spec.ts` | At 5m, 15m and 1h a closed run whose start is before the window shows its end square, with a time in its tooltip |
| `T140-lost-run-ends-with-a-hollow-square.spec.ts` | Lost and reaped runs end at their last signal with a hollow square; an earlier lost run draws nothing |
| `T141-resumed-run-draws-its-segments.spec.ts` | A resumed run draws ▶ ■ ▶ with a gap, and a run inside the gap keeps the row one lane |
| `T142-short-run-keeps-its-start-before-its-end.spec.ts` | A run narrower than its glyphs reads ▶■, and no glyph covers its start circle's centre |
| `T143-reaped-run-older-than-the-sessions-page-ends-at-its-last-signal.spec.ts` | A reaped run older than the 24 h sessions page, with its events kept from the page, ends at its last signal with a hollow square, from the rollup's `close_reasons` |
| `T144-fleet-range-switch-keeps-cached-circles.spec.ts` | Widening the Fleet range and switching back keeps a run's newest circle even when the new window's pages lack it; the wider window loads newest first with the keyset cursor (its `limit` rewritten to 50 to force paging) |
| `T145-per-agent-modal-run-glyph-opens-the-run-drawer.spec.ts` | A start triangle in the per-agent swimlane modal opens the run drawer on its run inside the modal; Esc closes the drawer, then the modal |
| `T153-overlapping-runs-split-the-row-into-lanes.spec.ts` | The fan-out worker's three overlapping runs split its one 48 px row into three lanes: each run's circles, start glyph and solid line share its lane's centre, and its earlier lost run takes no lane |
| `T154-row-without-overlap-keeps-one-line.spec.ts` | A single-run row and a hand-off row stay one line: no run lines, 22 px circles on the row's centre line |
| `T155-runs-past-four-share-the-overflow-lane.spec.ts` | Five runs started together draw four lanes with `data-lane-overflow`; the last two share the fourth, every start glyph hit-tests to itself and the shared ones say `shared by 2 runs` |
| `T156-sub-agent-connector-ends-on-the-child-run-lane.spec.ts` | Each coordinator-to-worker connector ends on its run's circle, one end per lane at distinct heights |
| `T157-quiet-run-line-turns-dashed.spec.ts` | A stale run's line is solid to its last signal and dashed after it (`data-tail="quiet"`); the active run's line stays solid |
| `T158-run-line-opens-its-run-when-no-glyph-is-in-view.spec.ts` | With neither run's glyphs in view, each run line takes keyboard focus and Enter opens its run drawer; with the glyphs in view the lines leave the tab order |
| `T150-agent-tokens-count-failed-streams.spec.ts` | The Agents row's token total counts a failed stream's billed tokens and an embeddings call after a load, and adds a failed stream posted while the page is open without a reload |

The `_fixtures.ts` helper exports shared fixture metadata (agent
names, flavors, role timeline offsets) and locator helpers:
`findSwimlaneRow`, `bringSwimlaneRowIntoView`, `waitForFleetReady`,
`waitForInvestigateReady`, `investigateParamsFromUrl`.

## Running locally

Prerequisites: a running dev stack and Playwright's Chromium
browser installed.

```bash
# Boot the stack (idempotent — re-running is safe)
make dev

# Install Playwright browsers once per machine
cd dashboard
npx playwright install chromium --with-deps

# Run the full suite (neon-dark + clean-light, ~30s on fresh DB)
npm run test:e2e
# or
make test-e2e
```

For iteration:

```bash
npm run test:e2e:headed           # watch it run in a real Chromium
npm run test:e2e:ui               # Playwright's interactive UI mode
npx playwright test T05           # single test by filename substring
npx playwright show-trace <path>  # inspect a failed run's trace.zip
```

### Seeding the fixture dataset manually

`globalSetup.ts` seeds the canonical dataset before every
`playwright test` invocation, but you can re-seed by hand while
iterating on a fixture shape:

```bash
make seed-e2e
# or
python3 tests/e2e-fixtures/seed.py
```

The seeder is idempotent: sessions with ≥3 events are skipped on
subsequent runs. Fresh-active sessions get a fresh `tool_call`
event every run so they stay visible in the default 1-minute
swimlane window regardless of how long ago the previous seed ran.

### Accumulated dev-DB data and virtualization

The Fleet swimlane uses `VirtualizedSwimLane`; off-screen rows
render as same-height spacers, not real DOM. In practice this
means: if a dev machine's Postgres holds agents from months of
prior test runs, the fixture agents can land 30+ positions down
the sorted list and never enter the viewport. Tests key on
`data-testid` attributes, not text, so the testids simply aren't
in the DOM.

Remedies:

- `make dev-reset` wipes volumes — the clean slate is what CI
  always sees, so this is the fastest way to make local behaviour
  match CI.
- Stop any background agent that's pushing events to the dev
  stack (e.g. `FLIGHTDECK_SERVER=http://localhost:4000` set in
  your shell while a Claude Code plugin session is active).

## Architecture

### Fixtures

`tests/e2e-fixtures/canonical.json` is the declarative source of
truth — agent names, flavors, role timeline offsets. Three
agents, two with the full four session roles (fresh-active,
recent-closed, aged-closed, stale) and one with the two roles
needed by the truncation test. Session IDs derive deterministically
from `uuid5(NAMESPACE, "flightdeck-e2e/<agent_name>/<role>")` so
the same IDs land on every seed run.

`tests/e2e-fixtures/seed.py` reads `canonical.json`, POSTs events
to the ingestion API (using `tests/shared/fixtures.py::make_event`
— the same builder the pytest integration suite uses), then
back-dates aged-closed/stale sessions via `docker exec psql` so
their visible timestamps match the declared offsets. Fresh-active
sessions get an extra `tool_call` event every seed run to keep
their in-window recency invariant.

`dashboard/tests/e2e/_fixtures.ts` mirrors the canonical metadata
in TypeScript so spec files reference agents and roles via
type-safe constants instead of stringly-typed magic.

The fan-out fixture (`FANOUT_FIXTURE`) is a coordinator,
`e2e-test-fanout@e2e-host-fanout`, and its same-role sub-agent
`e2e-test-fanout@e2e-host-fanout/worker`: an earlier lost run (started
-2 h, last seen -1 h 55 min) and three runs started together. Roles
with `fanout_group` are pinned by `seed.py::_refresh_fanout` in one
psql statement, so they share one NOW(), on the full seed and on every
keep-alive cycle, which also posts the coordinator's spawn event 1 s
before the workers' events. Every fan-out role declares
`skip_subagent_refresh`, so T56's `--refresh-subagent-events` never
moves it, and the lost run is pinned once by the full seed.

The run-glyph lane fixtures (`LANE_FIXTURES`, the `e2e-test-run-*`
agents) are roles that declare `lane_segments`: the run's segments as
`[start, end]` offsets from NOW (`end` null while open) and its
`lane_state`, optionally a last-signal offset and a close reason (the
reaped run's `orphan_timeout`). `seed.py::_pin_lane_fixtures` pins
each run's session row back to those offsets in one psql call for all
of them, on the full seed and on every keep-alive cycle, so a spec sees
them at most one keep-alive cycle plus its own runtime late. A role
that sets `lane_shift_events` (the resumed run and the short run,
whose specs read their `session_end` boundaries) has its whole event
stream shifted with the row; every other lane run reads its boundaries
from the row, since the swimlane ignores events dated before
`started_at`. The pin drops every `session_end` a role does not
declare (the reaper's work on a stack left running without the
keep-alive, or a client closing a fixture run mid-suite), and pins the agents' `last_seen_at` 60 s back
(`LANE_AGENT_SEEN_AGO_SEC`), so their rows sit just below the Fleet's
LIVE rows: near enough for the lane specs to scroll to quickly, without
crowding the LIVE rows other specs read out of view. None is a sub-agent, so T56's refresh leaves them alone.
`fixtureSessionId(agent, role)` derives a fixture run's session id the
way `seed.py::_derive_session_id` does.

### Selectors

Prefer semantic selectors first (`getByRole`, `getByText`,
`getByLabel`). `data-testid` only where semantic selectors are
brittle or the text itself is dynamic. When introducing a new
testid, follow the existing `<domain>-<component>-<role>`
convention: `fleet-*`, `swimlane-*`, `session-*`, `context-*`,
`investigate-*`.

Structural testids the suite relies on:

- `swimlane-agent-row-<agent_name>` + `data-agent-id` + `data-topology` (SwimLane row root)
- `swimlane-run-bracket-start-<sid_prefix>` + `swimlane-run-bracket-end-<sid_prefix>` (RunBracket; a resumed run has one per segment), with `data-session-id`, `data-run-lane` (`0` is the top lane), `data-segment-index` and, on an end, `data-end-kind` (`closed` or `lost`); the row carries `data-lane-count` (1 to 4) and, with more runs overlapping than lanes, `data-lane-overflow="true"`
- `swimlane-run-line-<sid_prefix>` (RunLine, one per segment on a split row), with `data-session-id`, `data-run-lane`, `data-segment-index`, `data-tail` (`live` or `quiet`), `data-shared` in the overflow lane and `data-highlighted`; its parts are `swimlane-run-solid-part` and `swimlane-run-quiet-tail`, and its tooltip `swimlane-run-line-tooltip-<sid_prefix>`
- `swimlane-agent-status-badge` + `data-state` (AgentStatusBadge)
- `swimlane-sub-agent-lost-dot` (lost sub-agent cue inside the row strip)
- `session-circle-<session_id>` (EventNode circles), with `data-event-id`, `data-session-id` and, on an agent row, `data-run-lane`
- `session-drawer` (SessionDrawer root)
- `active-filter-pill` + `active-filter-remove` (Events page facet chip)
- `virtualized-placeholder` (off-screen SwimLane placeholder)

### Find-my-fixture, not assume-first-row

Dev DBs are shared and noisy. Every spec filters by the
`e2e-test-` prefix or targets an exact fixture name before
asserting. Never `.first()` on an unfiltered locator — the first
row in the DB might be unrelated data.

### No setTimeout; prefer auto-wait

Playwright's `click`, `expect`, and `waitFor` have built-in
timeouts. Use those. Explicit `waitFor` is only justified for
non-DOM events (WebSocket connects, URL-param writes). Never use
`setTimeout` — it flakes under load and hides real timing bugs.

## Theme agnosticism

Playwright projects `neon-dark` and `clean-light` seed each theme
via localStorage before every test. Every spec runs under both.
Per rule 40c.3, spec files MUST NOT hardcode theme-specific
selectors or colours — assertions reference CSS custom
properties (`var(--text)`, `var(--accent)` …) indirectly via
structural position, never by computed colour value.

## CI integration

The suite runs in `.github/workflows/ci.yml` as four shards
(`e2e-shard`, `npx playwright test --shard=N/4`, both theme projects),
in parallel with the `integration` job. Each shard runs on its own
runner: it installs sensor + dashboard deps and Chromium, boots its own
stack with the dashboard serving its production bundle
(`docker/docker-compose.e2e.yml` layered on the dev compose files,
instead of the Vite dev server), seeds fixtures, runs its share of the
tests, uploads a blob report, and uploads `test-results/` on failure.
The `E2E (Playwright)` job then merges the four blob reports into one
HTML report (the `playwright-report` artifact) and fails unless every
shard passed. A shard takes about 7 minutes.

To run the suite locally against the bundle rather than the dev server,
boot the stack with the same override:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.e2e.yml up --build -d
```

Branch protection on `main` should require the `E2E (Playwright)`
check before merge; a repository admin sets it.

## Debugging failures

1. **Read the last message** — Playwright prints the failing
   locator, the expected value, and the actual.
2. **Open the trace** — `npx playwright show-trace
   test-results/<slug>/trace.zip`. The viewer walks every step
   with pre/post-screenshots and the network panel.
3. **Run with `--headed`** — watch the browser. Useful for
   flake diagnosis and for understanding what the page actually
   looks like during a specific failure.
4. **Use `--ui`** — interactive runner; pause on failure, step
   through, re-run a single spec without re-seeding.
5. **Screenshots on failure** — saved to
   `test-results/<test>/test-failed-<n>.png`.
6. **Dashboard console logs** — forward via
   `page.on("console", …)` in a debug spec. Browser errors
   (pageerror) fail T10 automatically.

Common classes of flake:

- **Stale dashboard build** — `docker restart docker-dashboard-1`
  after editing source. Vite HMR in Docker + WSL is occasionally
  unreliable.
- **Dev-DB pollution** — `make dev-reset` + re-seed.
- **Aged fresh-active** — if a session's state is `stale` when
  the test expects `active`, the seed hasn't been re-run
  recently. `make seed-e2e` pins state+last_seen_at.

## Adding a new test

1. File name: `Tnn-<short-journey>.spec.ts` (zero-padded, kebab-case).
2. Import shared helpers from `./_fixtures`.
3. Use `waitForFleetReady(page)` or `waitForInvestigateReady(page)`
   as your first wait after `page.goto`.
4. Scope every locator with a fixture-prefix filter.
5. Prefer fixture-metadata-derived expected values over hardcoded
   counts.
6. Run locally twice against unchanged code before pushing — rule
   40c.1 forbids flakes.

## Adding a new fixture shape

1. Update `canonical.json` with the new agent / role / timeline.
2. Mirror the constants in `_fixtures.ts`.
3. If the new fixture needs custom seeding logic (e.g. an event
   pattern not covered by the existing four roles), extend
   `tests/e2e-fixtures/seed.py::_post_session_events` and keep
   the idempotency check honest.
4. If the new fixture drives a new test, add the test; don't
   silently expand an existing one.
