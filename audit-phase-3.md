# Phase 3 — E2E Playwright Foundation Audit

Phase 3 establishes a Playwright end-to-end test suite for the
Flightdeck dashboard, anchored on a canonical Python-seeded
fixture dataset shared with the pytest integration suite. This
document captures the V-pass decisions, the existing-spec audit,
the fixture dataset, the data-testid delta, CI wiring, and the
bug-coverage map that motivates the suite.

---

## 1. Decisions recap (V-PRE + V5 resolution)

### V-PRE-1: Test location — Option B

Tests land at `dashboard/tests/e2e/` next to the dashboard unit
tests, not at a repo-root `e2e/` directory.

Rationale: the Playwright config ( `dashboard/playwright.config.ts`)
already carries dual-theme project scaffolding (rule 14) and a
bearer-token header for the auth-gated `/v1/*` endpoints. Moving
to a repo-root location would require either duplicating that
config or a brittle relative path dance from outside
`dashboard/`. Option B keeps the dashboard's Playwright
invocation (`npm run test:e2e`) self-contained and lets the
repo's CI step just `cd dashboard`.

### V-PRE-4: Existing-spec audit

See section 3.

### V5.T6: Truncation tooltip assertion

Dropped the native-tooltip hover assertion. `<TruncatedText/>`
sets the native HTML `title` attribute exactly when
`scrollWidth > clientWidth`. T6 asserts directly on
`getAttribute("title")` and skips any hover/reveal dance.

The negative path ("no title when text fits") is covered by the
existing unit test `dashboard/tests/unit/TruncatedText.test.tsx`
-- which runs the component in JSDOM and controls both axes of
the layout without fighting Fleet's `leftPanelWidth` state. T6
scopes to the positive (end-to-end) truncation path only.

### V5.T7: Fleet CONTEXT facet behavior

**Decision: CONTEXT facets are clickable; clicking toggles an
in-memory `contextFilters` state in Fleet.tsx. The filter is NOT
URL-persisted and does NOT leak to Investigate on deep-link
navigation.**

Source references:

- `dashboard/src/components/fleet/FleetPanel.tsx:471-577`
  (`ContextFacetSection` rendering).
- `dashboard/src/components/fleet/FleetPanel.tsx:530-570`
  (per-value clickable row, `data-testid="context-value-<key>-<value>"`).
- `dashboard/src/pages/Fleet.tsx:214` (`handleContextFilter`
  local-state toggle).
- `dashboard/src/components/fleet/AgentTable.tsx:177-195`
  (agent-row click deep-link to `/investigate`, carries
  `agent_id + from + to` only).

T7 locks this as explicit behaviour: applying a CONTEXT filter
then clicking an agent row sends the user to Investigate whose
URL contains the fleet deep-link trio but NO context key. A future
PR that decides to carry CONTEXT across pages will surface here
and can be deliberated rather than drifted into.

### V5.T8: Investigate URL state serialization

**Decision: 16 URL-serialized dimensions, owned by
`dashboard/src/pages/Investigate.tsx:32-105`
(`parseUrlState`/`buildUrlParams`). Fleet→Investigate deep-link
carries exactly `agent_id + from + to` (7-day window). Browser
back restores Fleet's URL verbatim; browser forward restores the
Investigate URL verbatim.**

Source references:

- `dashboard/src/pages/Investigate.tsx:32-75` (`parseUrlState`).
- `dashboard/src/pages/Investigate.tsx:77-105` (`buildUrlParams`).
- `dashboard/tests/unit/investigate-url-state.test.ts` — 18
  round-trip tests (one per dimension + composition) already
  lock the serialization contract. T8 layers on the
  cross-page-navigation invariant which unit tests can't reach.

No bug was found during the pre-work. The half-persist
state T8 was designed to guard against was a hypothetical; the
current implementation is clean.

---

## 2. Methodology update — CLAUDE.md rule 40c

Added as four sub-rules (40c, 40c.1, 40c.2, 40c.3) covering:

- 40c — every UI-touching phase adds E2E tests at
  `dashboard/tests/e2e/`; tests named after the user journey they
  cover.
- 40c.1 — flaky tests are fixed or deleted, never merged as-is.
  Playwright config sets `retries: 1` on CI, `0` locally.
- 40c.2 — E2E as the pre-commit smoke gate for UI work
  (inherits from 40b).
- 40c.3 — theme coverage: every spec runs under `neon-dark` AND
  `clean-light`, assertions stay theme-agnostic.

See `CLAUDE.md:281-337` for the full text.

---

## 3. Existing-spec audit

The pre-Phase-3 suite held four trivial page-mount stubs
introduced in Phase 5 Part 1b to verify the bearer-token
auth-wiring reaches the browser:

| Existing spec (pre-Phase-3)    | URL visited    | Assertions    | Maps to | Action |
|--------------------------------|----------------|---------------|---------|--------|
| `analytics.spec.ts`            | `/analytics`   | title + no pageerror | T10 (Analytics sub-test) | **Retired** — subsumed |
| `fleet.spec.ts`                | `/`            | title + no pageerror | T1 + T10 | **Retired** — subsumed |
| `killswitch.spec.ts`           | `/directives` (sic — filename mismatch) | title + no pageerror | T10 (Directives sub-test) | **Retired** — subsumed, removes filename-vs-URL drift |
| `search.spec.ts`               | `/investigate` (sic — filename mismatch) | title + no pageerror | T3/T4/T10 | **Retired** — subsumed |

Every assertion in the four stubs is covered by T10
(`wholedashboard-smoke.spec.ts`) which iterates over every
top-level page and asserts `title === "Flightdeck"` + zero
`pageerror` — same contract, one spec instead of four, no
filename-vs-URL mismatch.

The four stub files are deleted in this PR. Nothing was deleted
without subsumption.

---

## 4. Fixture dataset

Declarative source of truth: `tests/e2e-fixtures/canonical.json`.

### Agents

| agent_name | agent_type | client_type | flavor | model | framework | roles |
|------------|------------|-------------|--------|-------|-----------|-------|
| `e2e-test-coding-agent` | coding | claude_code | `e2e-claude-code` | claude-sonnet-4-5 | claude-code | fresh-active, recent-closed, aged-closed, stale |
| `e2e-test-sensor-agent-prod` | production | flightdeck_sensor | `e2e-research-agent` | gpt-4o-mini | langchain | fresh-active, recent-closed, aged-closed, stale |
| `e2e-test-sensor-agent-long-name-for-truncation-testing-really-quite-long` | production | flightdeck_sensor | `e2e-code-agent` | claude-sonnet-4-5 | langchain | fresh-active, recent-closed |

### Sessions — role timeline

All offsets are seconds from seed time (negative = past). Session
IDs are `uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck-e2e/<agent_name>/<role>")` — deterministic across
runs.

| Role | started_offset_sec | ended_offset_sec | Force-set state | Purpose |
|------|--------------------|------------------|-----------------|---------|
| `fresh-active` | -30 | null | `active` (pinned every seed; extra `tool_call` at -5s emitted every run to stay in the 1m swimlane window) | T1 LIVE bucket; T5 swimlane vs expanded delta |
| `recent-closed` | -600 | -120 | (server default closed on session_end) | T1 RECENT bucket; T3 single-filter result retention; T5 expanded surface |
| `aged-closed` | -100800 (-28h) | -97200 (-27h) | `closed` (forced; session_end can race session_start persist) | T5 anchor — MUST NOT appear in swimlane; MUST appear in expanded |
| `stale` | -10800 (-3h) | null | `lost` (past reconciler thresholds; pinning makes test-stable on fresh seed) | T1 non-active state; T5 expanded surface |

### Events per session

Every session lands:

- `session_start` at `started_offset_sec`
- `pre_call` / `post_call` pair at +5s / +8s from start (tokens_input/output, latency_ms)
- `tool_call` at +10s (tool_name + tool_input + tool_result on the same payload — see `seed.py` note about the lack of a separate `tool_result` event type)
- `session_end` (for closed roles) at `ended_offset_sec`

Fresh-active additionally receives one extra `tool_call` at -5s
on EVERY seed run (see section 6 for the rationale).

### Seed idempotency

`seed.py` checks each session for `>= 3 events` before re-emitting.
A fully-seeded session is a no-op on subsequent runs — except for
fresh-active's last_seen_at/started_at pin and the extra
`tool_call`, both of which run every time. Backdating of
aged-closed and stale happens every run (cheap UPDATE via
`docker exec psql`); re-running is safe.

---

## 5. Data-testid delta

Pre-Phase-3 inventory (grep `data-testid=` on `dashboard/src`):
**~139 occurrences**.

Phase 3 additions: **6 new data-testids** (target was ≤10).

| File | Line | testid | Purpose |
|------|------|--------|---------|
| `src/components/timeline/SwimLane.tsx` | 156 | `swimlane-agent-row-<agent_name>` | Per-agent row handle. `<TruncatedText>` can collapse the visible name to an ellipsis, so text-based selection is unreliable |
| `src/components/timeline/SwimLane.tsx` | 272 | `swimlane-expanded-body` + `data-expanded="true|false"` | Expansion state probe for T5 |
| `src/components/timeline/EventNode.tsx` | 130 | `session-circle-<session_id>` | Per-session swimlane circle; multiple circles per session (one per event) share the testid and tests filter via `.evaluateAll` |
| `src/components/timeline/SessionEventRow.tsx` | 161 | `session-row` + `data-session-id=<uuid>` | Expanded-body session row |
| `src/components/session/SessionDrawer.tsx` | 435 | `session-drawer` | Drawer root, visibility assertion |
| `src/pages/Investigate.tsx` | 1383, 1403 | `active-filter-pill` | Each active-filter chip in the top bar |
| `src/pages/Investigate.tsx` | 1398, 1412 | `active-filter-remove` | X button inside a chip |

Post-Phase-3 inventory: **~145 occurrences**, +6 semantic
additions (the Investigate pair appears at two code locations
each but represents one semantic concept per pair).

Naming follows the existing `<domain>-<component>-<role>`
convention. No existing testids renamed.

---

## 6. Implementation notes — wall-clock-aware seeding

The canonical fixture design assumed events seeded with
`timestamp = NOW - offset` would stay at that offset. In practice
the Fleet swimlane defaults to a 1-minute time domain, and test
runs can land 5+ minutes after the initial seed. Event timestamps
then sit outside the domain and the `AggregatedSessionEvents`
filter at `src/components/timeline/SwimLane.tsx:655-658` drops
them — which produced a "zero circles" bug during first-pass
verification.

Fix: `seed.py` emits a fresh `tool_call` event at `timestamp=NOW-5s`
for every fresh-active session on EVERY seed run, regardless of
idempotency. The session stays in the 1m window irrespective of
how long ago the original seed ran. Documented in the seed
source where the refresh happens.

---

## 7. Bug-coverage map — E2E tests as regression guards

Observed UI regressions in Phase 1 / Phase 2 that would have been
caught by the Phase 3 suite:

| Past regression | Root cause | Which Tnn guards against recurrence |
|-----------------|------------|-------------------------------------|
| KI20 (Phase 1) — phantom "CODING SENSOR" rows in Fleet | conftest.py defaulted to illegal `client_type=flightdeck_sensor` + `agent_type=coding` pair; dashboard rendered the combo | T1 canonical-pair invariant |
| KI22 (Phase 2) — global 12 px font-mono override collapsed Investigate rows on light theme | a loose CSS rule clobbered every mono element across both themes | T10 (both themes × all pages) would have flagged the layout break |
| PR #24 Bug 2 (Phase 1) — agent_id chip in Investigate resolved to UUID prefix instead of agent_name | Fleet store not hydrated on mount; Investigate couldn't resolve the identity | T2 (Fleet → Investigate deep-link, agent_id round-trips cleanly) |
| Phase 2 Supervisor-smoke bug — truncated agent_name had no hover reveal | `<TruncatedText>` contract was partially applied | T6 (title attribute on overflow) |
| Repeat class — Fleet table vs swimlane drift (not yet observed but plausible) | the two views wired separately to the fleet store | T9 (parity invariant) |
| Aged-session visibility (latent) — expanded-drawer behaviour for 24h+ sessions | loadExpandedSessions bypasses the time bound | T5 guards the behaviour from regressing to "expanded also honours 24h" |

---

## 8. CI job

`.github/workflows/ci.yml` now has an `e2e` job running in
parallel with `integration` (both depend on
`sensor + go + dashboard`). Steps:

1. Checkout + setup Python 3.12 + setup Node 20.
2. Install sensor with `[dev,anthropic,openai]` extras (seed.py
   needs `flightdeck_sensor.core.agent_id.derive_agent_id`).
3. Install dashboard deps (`npm ci` in `dashboard/`).
4. Install Playwright Chromium with `--with-deps`.
5. `make dev` (boots the full stack).
6. `make seed-e2e` (explicit seed step — surfaces failure
   separately from the test run's globalSetup).
7. `npx playwright test` (both themes, both chromium channels).
8. On failure: upload `dashboard/playwright-report/` and
   `dashboard/test-results/` as artifacts with 14-day retention.
9. Dump stack logs + `make down` in always-cleanup step.

Duration target: <5 min. Local run measured ~27 s for 30 tests.

### Post-merge action required

`E2E (Playwright)` must be added as a required status check on
the `main` branch protection rule. Claude Code cannot change
branch protection (requires repo-admin); the Supervisor handles
this after merge. The PR body includes this request explicitly.

---

## 9. Makefile dedup

Before: two targets named `test-e2e` at lines 26 and 33. Line 26
drove sensor pytest e2e; line 33 drove Playwright. Make silently
picked one (last-definition wins), hiding the other.

After:

- `test-sensor-e2e` — sensor pytest e2e (former line 26).
- `test-e2e` — Playwright (former line 33).
- `test-e2e-ui` — Playwright UI mode.
- `seed-e2e` — new, runs `python3 tests/e2e-fixtures/seed.py`
  for local fixture iteration.

The `.PHONY` target list updated accordingly.

---

## 10. Known gaps and deferred items

- **T4 Directives tab.** Seeded fixtures don't register custom
  directives, so the Directives tab is not rendered. T4 tests
  timeline + prompts only and conditionally clicks Directives
  when present. A future test that seeds a custom directive on
  a fixture flavor could cover the Directives tab specifically;
  not in scope for Phase 3.
- **T6 negative path.** Covered by
  `dashboard/tests/unit/TruncatedText.test.tsx`, not by the E2E
  suite. The fleet `leftPanelWidth` state makes a reliable "no
  truncation" scenario hard to produce in a real viewport; the
  unit test is the right level.
- **T9 deep parity.** Only asserts agent-count parity. Session
  counts, ordering, bucket dividers are identical by construction
  but would benefit from a deeper cross-check. Deferred unless a
  regression surfaces.
- **Dev DB pollution.** Local runs against a DB accumulated from
  prior test runs can push fixtures off-screen under swimlane
  virtualization. README covers the `make dev-reset` remedy. CI
  always has a clean stack so this only bites local iteration.
- **Fresh-active timing.** Forward-dating is belt-and-suspenders
  — the seed runs every Playwright invocation via globalSetup
  anyway, so fresh-active has always-current state. If a future
  PR needs a test that runs >15 min after seed (e.g. reconciler
  simulation), it should call `make seed-e2e` explicitly.
- **Aged-closed session_id not exposed in `_fixtures.ts`.** T5
  asserts on the structural invariant (expanded > swimlane)
  rather than on the specific aged-closed UUID. A future version
  could parse `canonical.json` + derive uuid5 in a setup fixture
  and assert on the exact ID; current approach is less precise
  but avoids needing a uuid5 implementation in TypeScript.
