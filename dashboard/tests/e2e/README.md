# Dashboard E2E tests (Playwright)

End-to-end browser tests for the Flightdeck dashboard. Runs on every
PR and tags the release with a green/red gate per CLAUDE.md rule
40c. Located at `dashboard/tests/e2e/`; shares a seeded Python
fixture dataset with the pytest integration suite via
`tests/shared/fixtures.py` + `tests/e2e-fixtures/seed.py`.

## What's covered

The T1–T10 catalog lives one file per journey:

| File | Journey |
|------|---------|
| `T01-fleet-page-renders-full-state.spec.ts` | Fleet mounts, 3 fixture agents visible, canonical-pair invariant guard (no SENSOR + coding anomaly row) |
| `T02-fleet-table-view-toggle-and-navigate.spec.ts` | View toggle persists to `?view=table`; row click deep-links to `/investigate?agent_id=…&from=…&to=…` with ~7-day window |
| `T03-investigate-facet-filtering-intersection.spec.ts` | Two facets compose via AND; × on a pill relaxes to the single filter; result stays non-empty |
| `T04-investigate-session-drawer-deep-dive.spec.ts` | Drawer opens from row click; tabs (timeline/prompts/directives) work; close via X |
| `T05-fleet-agent-expansion-shows-aged-session.spec.ts` | Expanded body surfaces ≥1 session (aged-closed, 28h old) that no swimlane time-range can show |
| `T06-truncation-and-tooltip.spec.ts` | Narrow viewport: 70-char fixture name gets `title` attribute via `<TruncatedText/>` |
| `T07-fleet-to-investigate-context.spec.ts` | Fleet CONTEXT filter does NOT leak into Investigate's URL on agent-row deep-link |
| `T08-cross-page-navigation-state.spec.ts` | Back/forward restore URLs verbatim; deep-link trio (agent_id+from+to) survives the round-trip |
| `T09-swimlane-table-parity.spec.ts` | Swimlane and table views render identical agent sets |
| `T10-wholedashboard-smoke.spec.ts` | Every top-level page mounts with no console errors (Fleet / Investigate / Analytics / Directives / Policies / Settings) |

The additional `_fixtures.ts` helper exports shared fixture
metadata (agent names, flavors, role timeline offsets) and locator
helpers (`findSwimlaneRow`, `findAgentTableRow`, `findExpandedBody`,
`waitForFleetReady`, `waitForInvestigateReady`).

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

Phase 3 added 6 new testids (see `audit-phase-3.md` for the
before/after counts):

- `swimlane-agent-row-<agent_name>` (SwimLane row header)
- `swimlane-expanded-body` + `data-expanded="true|false"`
- `session-circle-<session_id>` (EventNode circles)
- `session-row` + `data-session-id` (SessionEventRow)
- `session-drawer` (SessionDrawer root)
- `active-filter-pill` + `active-filter-remove` (Investigate chip)

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
