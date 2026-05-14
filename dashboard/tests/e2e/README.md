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

### Selectors

Prefer semantic selectors first (`getByRole`, `getByText`,
`getByLabel`). `data-testid` only where semantic selectors are
brittle or the text itself is dynamic. When introducing a new
testid, follow the existing `<domain>-<component>-<role>`
convention: `fleet-*`, `swimlane-*`, `session-*`, `context-*`,
`investigate-*`.

Structural testids the suite relies on:

- `swimlane-agent-row-<agent_name>` + `data-agent-id` + `data-topology` (SwimLane row root)
- `swimlane-run-bracket-start-<sid_prefix>` + `swimlane-run-bracket-end-<sid_prefix>` (RunBracket)
- `swimlane-agent-status-badge` + `data-state` (AgentStatusBadge)
- `swimlane-sub-agent-lost-dot` (lost sub-agent cue inside the row strip)
- `session-circle-<session_id>` (EventNode circles)
- `session-row` + `data-session-id` (SessionEventRow, inside the drawer)
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

The `.github/workflows/ci.yml` job `e2e` runs in parallel with the
`integration` job. It checks out the repo, installs sensor + dashboard
deps, installs Chromium via Playwright, boots the dev stack,
seeds fixtures, runs the suite, and uploads `playwright-report/`
+ `test-results/` on failure. Duration target is <5 minutes.

Branch protection on `main` should require the `E2E (Playwright)`
check before merge; the supervisor sets this post-Phase-3 because
Claude Code lacks repo-admin.

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
