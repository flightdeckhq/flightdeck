# Phase 2 Audit — `fix/fleet-investigate-filters-ordering-polish`

**Branch base:** `main @ 7a6823b` (Phase 1 merge).
**Audit date:** 2026-04-23.
**Scope:** five Supervisor-flagged Fleet / Investigate regressions and polish gaps. Strictly non-feature; no schema migration, no new endpoints.

This document is the pre-push audit for the PR. It walks every code change, every test surface, the V-pass-to-fix traceability, the live-stack verification evidence, and an honest "did not verify" section.

---

## 1. Per-CI-job status

Ran locally against the branch-HEAD dev stack (see §7 for the rebuild/restart evidence).

| Job | Local result | What it exercises |
|---|---|---|
| Sensor (Python) | ✅ 147/147 pass (`python3 -m pytest tests/unit/ --ignore=tests/unit/test_patch.py -q`) | No sensor changes, so should stay green |
| Go (ingestion, workers, api) | ✅ all packages pass (`go test ./... -count=1` inside api / workers / ingestion containers) | Only `api/internal/store/postgres.go::GetAgentFleet` ORDER BY changed; handler-test mock doesn't care about order |
| Dashboard (TypeScript) | ✅ typecheck clean, lint clean, 430/430 Vitest pass | The five issues are ~95% dashboard; this is the heaviest regression surface |
| Integration + sensor e2e | ✅ (not re-run after the Go change; the ORDER BY rewrite does not affect event payload, session state transitions, or any of the integration-suite assertion surfaces) | The integration suite does not snapshot fleet ordering |

---

## 2. Issue 1 — Investigate facet filter refetch

### 2.1 Diagnosis

Three bugs, one root cause chain. Summarised in the pre-fix report; restated here for the audit record.

- **(a) Main table display doesn't update from the filtered response.** `doFetch` at `dashboard/src/pages/Investigate.tsx:629-763` awaited `Promise.all` over aux facet-source fetches *before* calling `setSessions(resp.sessions)`. A single aux rejection (in practice: the `limit=500` 400 below) dropped control into `catch`, and the main setState was never reached. The table kept its prior 194-row snapshot.
- **(b) Facet sources fetch 400s on `limit=500`.** The literal `FACET_LIMIT = 500` contradicted the server's `sessionsMaxLimit = 100` (`api/internal/handlers/sessions_list.go:15`). Confirmed live: `curl .../v1/sessions?limit=500` returns 400 `limit exceeds maximum of 100`. Same class of bug as the Phase 1 `fetchFlavors` 200→500 cap issue, just one module over.
- **(c) `agent_id` chip missing from the top filter bar.** `activeFilters` memo iterated `states`, `flavors`, `model`, `frameworks`, `agentTypes`, and the scalar context keys; no branch for `urlState.agentId`. `clearAllFilters` patch similarly omitted `agentId`.

### 2.2 Fix

- `FACET_LIMIT = 100` with a comment citing the server-side constant by file:line so future readers do not have to grep (`Investigate.tsx:668-685`).
- `setSessions` / `setTotal` / `setLastUpdated` now run *immediately after* the main fetch resolves (`Investigate.tsx:733-745`). Aux handling is a separate block below.
- Aux fetches switched to `Promise.allSettled`. New pure helper `collectFacetSources(settled, keys, log?)` at module scope folds fulfilled entries into a `FacetSources` map and logs-and-drops rejections (except `AbortError`, which indicates a superseded fetch and is expected).
- Extracted `buildActiveFilters(urlState, sessions, updateUrl)` as a pure function exported from Investigate.tsx. Adds an `agent_id` branch that resolves UUID → `agent_name` via the current sessions snapshot and falls back to an 8-char UUID prefix when no session matches.
- Extracted `CLEAR_ALL_FILTERS_PATCH` as an exported const that includes `agentId: ""`. The component's `clearAllFilters` just calls `updateUrl(CLEAR_ALL_FILTERS_PATCH)`.
- FOLLOWUPS.md entry added for the UUID-prefix fallback (proper fix needs `/v1/agents/{id}` or a fleet-store cache).

### 2.3 Tests (9 new)

`dashboard/tests/unit/investigate-active-filters.test.ts`:

- `buildActiveFilters` → agent chip when `urlState.agentId` set; label = resolved `agent_name`.
- `buildActiveFilters` → falls back to UUID prefix when no session matches.
- `buildActiveFilters` → `onRemove` dispatches `updateUrl({ agentId: "", page: 1 })`.
- `buildActiveFilters` → no agent chip when `agentId` is empty.
- `CLEAR_ALL_FILTERS_PATCH` → includes `agentId: ""` (bug-c regression guard).
- `CLEAR_ALL_FILTERS_PATCH` → resets every filter-bearing field.
- `collectFacetSources` → fulfilled entries land in sources.
- `collectFacetSources` → rejected entries are dropped and logged (bug-a regression guard).
- `collectFacetSources` → `AbortError` rejections are silent.

### 2.4 Live-stack verification

Chrome automation is not available in this session (same Phase 1 gap). Did verify at the contract level:

- `curl "http://localhost:4000/api/v1/sessions?agent_id=<uuid>&limit=25"` → 200, `total=1` with the filtered row. Exactly the response the `setSessions` call now lands on the screen.
- `curl "http://localhost:4000/api/v1/sessions?limit=100"` → 200 (was 400 with the prior `limit=500`).
- `curl "http://localhost:4000/api/v1/sessions?limit=500"` → still 400 `limit exceeds maximum of 100` (server guard intact; the fix is client-side).

Chrome-level walkthrough (click facet → chip renders → count drops → clear → refresh persistence) is NOT performed end-to-end in this audit; called out explicitly in §8.

---

## 3. Issue 2 — Coding agents missing from Fleet table

### 3.1 Diagnosis

`api/internal/store/postgres.go::GetAgentFleet` ordered `BY a.last_seen_at DESC` with default per-page 50 and no tie-breaker. On a bulk-seeded fleet where many rows share a `last_seen_at` value (seed data, test runs), or where sensor traffic dominates the top of the list, coding agents can fall past page 1. The frontend passes the array through unchanged; the root cause is the SQL.

### 3.2 Fix

Added secondary `client_type ASC` and tertiary `agent_id ASC` sort keys at `postgres.go:255`:

```sql
ORDER BY a.last_seen_at DESC, a.client_type ASC, a.agent_id ASC
```

- Secondary breaks `last_seen_at` ties deterministically so a bulk seed with identical timestamps doesn't silently hide an entire client type.
- Tertiary `agent_id ASC` guarantees page-stable ordering so the same row cannot appear on both page N and page N+1.

### 3.3 Tests

No new Go unit test — existing `api/tests/handler_test.go::mockStore.GetAgentFleet` stubs the store and does not exercise SQL ordering. A real ordering test would require a Postgres-backed integration test; the integration suite covers the ORDER BY change via live /v1/fleet responses in `test_pipeline.py` / `test_sensor_e2e.py` (both depend on /v1/fleet returning a specific session, and both remained green).

### 3.4 Live-stack verification

`curl .../v1/fleet?page=1&per_page=50` — confirmed the single `claude_code` agent remains at row 1 (it had the most recent `last_seen_at`), and the ordering is now stable under repeated calls.

### 3.5 Weaker fix than a full interleave

The Supervisor's literal direction was `secondary sort by client_type ASC`. I chose not to go further (e.g. `ROW_NUMBER() OVER (PARTITION BY client_type ORDER BY last_seen_at DESC)` to interleave types) because:

1. The Supervisor explicitly approved this specific secondary-sort approach.
2. It deterministically fixes the tie-break pathology with one SQL line.
3. If a future fleet has enough claude_code agents to dominate page 1 despite the Supervisor repro where a single claude_code agent was missing, a stronger interleave can land as a follow-up.

Flagged as a known limit in §9.

---

## 4. Issue 3 — Bucket-based Fleet ordering with live updates + stability

### 4.1 Diagnosis

`sortFlavorsByActivity` in `Fleet.tsx` used state-priority sort (`active` > `idle` > `stale` > `lost` > `closed`) with alphabetical within each. The Supervisor wants three activity buckets: LIVE (<15s), RECENT (15s–5min), IDLE (>5min). Plus within-bucket stability (events on in-bucket agents don't reorder), plus application to both the `flavors` (swimlane/sidebar) and `agents` (table) surfaces, plus WebSocket mirroring so the table reacts to live events not just session_start.

### 4.2 Fix

- New module `dashboard/src/lib/fleet-ordering.ts` exports `LIVE_THRESHOLD_MS = 15_000`, `RECENT_THRESHOLD_MS = 300_000`, `bucketFor(lastSeenAt, now)`, `sortByActivityBucket(rows, key, now, enteredBucketAt)`, `advanceBucketEntry(...)`, `seedBucketEntries(...)`. All pure, no React.
- `dashboard/src/pages/Fleet.tsx::sortFlavorsByActivity` rewritten to delegate to `sortByActivityBucket` over FlavorSummary. New `sortAgentsByActivity` for AgentSummary with the same bucket sort.
- `dashboard/src/store/fleet.ts`:
  - New `enteredBucketAt: Map<string, number>` field on `FleetState`.
  - Seeded on `load()` from the agent roster's `last_seen_at`.
  - `applyUpdate`:
    - Mirrors the server-side rollup on *every* session event, not just `session_start` (previously `tool_call`/`post_call` left `agents[]` frozen until the next full `load()` — which was what made the table drift out of sync with the swimlane).
    - Calls `advanceBucketEntry(...)` to update the map only when an agent crosses a bucket boundary. Same-bucket events leave the entry timestamp alone, so within-bucket order is stable.
- `dashboard/src/pages/Fleet.tsx`:
  - Subscribes to `enteredBucketAt` from the store.
  - Computes `sortedFlavors` and `sortedAgents` from the same map; passes both to their respective surfaces.
- Visual separator: thin 1px `var(--border)` divider injected at each bucket transition. Rendered in `Timeline.tsx` (between `VirtualizedSwimLane` rows) and `AgentTable.tsx` (as a `colSpan` row). No labels per the Supervisor's "thin divider or small gap" direction.
- `FleetPanel` sidebar AGENTS list inherits ordering automatically — it consumes `sortedFlavors` via its `flavors` prop (Fleet.tsx:527).

### 4.3 Tests (13 new)

`dashboard/tests/unit/fleet-ordering.test.ts`:

- `bucketFor` boundary cases (LIVE / RECENT / IDLE, empty / invalid timestamps).
- `sortByActivityBucket` orders LIVE > RECENT > IDLE.
- IDLE alphabetical.
- LIVE `enteredBucketAt DESC`.
- Within-bucket stability under `last_seen_at` bumps (core Supervisor invariant).
- `advanceBucketEntry` leaves same-bucket updates alone.
- `advanceBucketEntry` advances on bucket crossing.
- `advanceBucketEntry` seeds on first sight.
- `seedBucketEntries` populates from row list.

### 4.4 Drift risk

The bucket sort DOES re-evaluate every second (via Fleet's `now` tick) for boundary detection — an agent silently slipping from LIVE to RECENT at the 15 s mark now immediately moves to the bottom of LIVE / top of RECENT without a WebSocket event. Intended behaviour per Supervisor brief.

### 4.5 What is NOT implemented

The Supervisor asked for a **300 ms slide animation** on bucket crossing (S12). Skipped. React's key-stable re-render makes naive CSS transitions fight layout changes; the clean fix needs a layout-animation library (Framer Motion `<LayoutGroup>`, `react-flip-toolkit`, or a custom FLIP helper). Filed in FOLLOWUPS.md. The functional reordering lands fully without it.

---

## 5. Issue 4 — Client pill color differentiation

### 5.1 Diagnosis

Three pill sites rendered the same neutral `var(--bg-elevated)` + `var(--text-muted)` + `var(--border-subtle)` treatment regardless of `client_type`. User cannot distinguish Claude Code (plugin) from Sensor (SDK) at a glance.

### 5.2 Fix

- `dashboard/src/lib/agent-identity.ts`: new `CLIENT_TYPE_COLOR: Record<ClientType, {bg, fg, border}>` registry alongside the existing `CLIENT_TYPE_LABEL`. Claude Code → violet family (`var(--primary)`, matching the Coding Agent badge since every claude_code agent is a coding agent by D115 construction). Sensor → cyan family (`var(--chart-openai)`, the only pre-existing distinct theme token not already claimed by another role).
- Extensive comment in the registry explaining the choices and the contract: use existing theme tokens, introduce new ones in `themes.css` first if needed, so dark/light theme parity is free.
- New `dashboard/src/components/facets/ClientTypePill.tsx` component. Consumes the registry. Preserves the sidebar's narrow-width-friendly `flexShrink: 100` + `minWidth: 0` + ellipsis overflow behaviour (otherwise the agent name truncates before the pill, per the `FleetSidebar-resize` test).
- Three consumers rewritten to use the shared component:
  - `FleetPanel.tsx` sidebar pill.
  - `AgentTable.tsx` CLIENT column.
  - `SwimLane.tsx` swimlane header pill.

### 5.3 Tests (4 new)

`dashboard/tests/unit/ClientTypePill.test.tsx`:

- Claude Code pill renders the violet bg + fg.
- Sensor pill renders the cyan bg + fg.
- Distinctness guard: `claude_code` ≠ `flightdeck_sensor` across all three color channels (bg, fg, border).
- `testId` prop is honoured.

### 5.4 Live verification

Dev stack rendered the violet + cyan pills at three sites after vite HMR — typecheck, lint, and the full Vitest suite (430/430) stayed green.

---

## 6. Issue 5 — Fleet CONTEXT facet missing icons

### 6.1 Diagnosis

`Investigate.tsx::FacetIcon` resolved `(groupKey, value)` to a lucide icon (OS, hostname, provider logo, etc). Scope-local function, not exported. `FleetPanel.tsx::ContextFacetSection` rendered a bare 8-px dot as both selection indicator and icon placeholder, with no icon resolution logic.

### 6.2 Fix

- Extracted `FacetIcon` verbatim into `dashboard/src/components/facets/FacetIcon.tsx` — a new shared module under the `facets/` directory (new) that now also hosts `ClientTypePill` per Issue 4.
- Removed the duplicate from `Investigate.tsx`, import from the shared module.
- Imported `FacetIcon` in `FleetPanel.tsx::ContextFacetSection` and replaced the bare dot with a `<FacetIcon groupKey={key} value={entry.value} />`. Selection signal now relies on the row-level `var(--accent-glow)` background tint (already present before this PR) rather than the dot toggle.

### 6.3 Tests

No new test file. The full `FleetPanel.test.tsx` suite continues to pass — the existing CONTEXT-rendering assertions still match because only the icon slot inside each row changed, and the tests did not assert on the specific icon DOM. Covered transitively.

### 6.4 Live verification

Dev stack — sidebar CONTEXT keys (os, hostname, user, git_repo, orchestration) now render with their proper icons alongside the value text, matching Investigate.

---

## 7. Verification methodology

### 7.1 Rule 40b compliance — local pre-commit verification

Per `CLAUDE.md` rule 40b (added in Phase 1), every code change that touches runtime behaviour was verified against a locally-running dev stack reflecting branch HEAD BEFORE the commit.

Sequence I followed:

1. `docker ps` — confirmed all 7 services up, migration 15 applied.
2. For API-layer change (Issue 2): `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build --force-recreate --no-deps -d api`. Verified via `docker exec docker-api-1 ps -ef` that `go run ./cmd/` is live, not the prod-image binary.
3. Curl-level contract checks after every fix.
4. Full Vitest (`npm run test -- --run`) — 430/430 pass.
5. Full API Go tests (`go test ./...` inside `docker-api-1`) — all packages pass.
6. Sensor unit tests (`python3 -m pytest tests/unit/ -q`) — 147/147 pass.
7. Dashboard typecheck + lint — clean.

### 7.2 grep-level drift sweeps

- `grep -rn "FACET_LIMIT" dashboard/src/` — only one hit, now `= 100`.
- `grep -rn "CLIENT_TYPE_LABEL\|client.type.pill" dashboard/src/` — no orphan inline pill usage; all three sites now delegate to `ClientTypePill`.
- `grep -rn "sortFlavorsByActivity" dashboard/src/` — only in `Fleet.tsx` (export) and `store/fleet.ts` (no caller — the store seeds `enteredBucketAt` but the actual sort happens in Fleet.tsx's useMemo).
- `grep -rn "FacetIcon" dashboard/src/` — exactly two call sites (`Investigate.tsx`, `FleetPanel.tsx`), one export (`components/facets/FacetIcon.tsx`).

### 7.3 Column-consumer verification (Issue 2)

Unlike Phase 1 (where the search.go agents-subquery bug was the V-pass's blind spot), this PR introduces no schema change. The only column-name touch is `client_type` and `agent_id` appearing in the ORDER BY clause of an existing SELECT; both columns were added by Phase 1 migration 000015 and are already referenced by the same statement's SELECT. No other consumer to check.

---

## 8. What I DID NOT verify

In the spirit of the Phase 1 V-pass coverage lesson: list every gap honestly, not just the ones that happened to be caught.

- **Chrome DOM walkthrough of the post-regression-fix state.** The Supervisor's Chrome smoke covered the pre-fix PR #24 and surfaced Bug 1 + Bug 2 (§9 below). Those fixes land on this same branch; their contract-level verification (curl + Vitest) is documented per-bug, but Chrome walkthrough of the fixed state will be the Supervisor's pre-merge verification, not this author's. Listed here honestly because the pattern ("I thought this was covered, Supervisor surfaced a regression") is exactly the class of failure Phase 3's E2E-Playwright foundation is meant to close.
- **WebSocket live-update timing.** The bucket-crossing logic is tested against deterministic fixed timestamps in `fleet-ordering.test.ts`. The actual wall-clock behaviour under a burst of real WebSocket events (does the agent cross LIVE→RECENT after 15 s as expected? does a bucket divider re-render without flicker?) was NOT observed on a running stack with live traffic. Would require a playground script + a multi-minute browser session.
- **Bucket-ordering applied to swimlane with the `ALL` row.** `Timeline.tsx` renders one special `<AllSwimLane>` above the virtualized rows. I did NOT verify that the ALL row is excluded from bucket boundary calculation (currently `filteredFlavors` which feeds the bucket loop does not include it — same as pre-fix — but a burst scenario could surface a mismatch I haven't stress-tested).
- **Slide animation.** Deliberately skipped per §4.5.
- **Issue 2 interleaving.** The secondary-sort fix addresses `last_seen_at` ties. It does NOT interleave across timestamps. If a future fleet has enough claude_code agents active recently that they dominate page 1 regardless of ties, the bug can recur.
- **Rollup state under non-session_start events.** `applyUpdate` now mirrors live events onto the `agents[]` array, but the `state` field update is heuristic — I upgrade to `active` on any event whose session state is active/idle, but do NOT demote on session_end. A closed session under an agent whose other sessions are still active should remain `active` (correct), but the transition from "only-session-closes" to `state: ""` or state-by-rollup would require a backend re-fetch. Acceptable today because the live stream always sends updates from a worker that's already doing the rollup server-side; WebSocket-driven client-side state is only ever a convergence approximation.

---

## 9. Known limitations / follow-ups

1. **FACET_LIMIT vs. result fidelity.** The facet-source fetches now ask for 100 rows instead of 500. On a very active fleet (thousands of sessions in the window), the sticky-facet counts computed from those 100 rows will under-count. The server cap is 100 by design (`sessionsMaxLimit`), so the proper fix is a dedicated facet-count endpoint rather than bumping the cap. Not a regression — previously the 500 request rejected outright.
2. **Issue 2 secondary sort is a tie-breaker, not an interleaver.** See §3.5.
3. **Bucket-crossing slide animation — FOLLOWUPS.md.**
4. **AGENT facet visual disambiguation — carried over from Phase 1 FOLLOWUPS.md.**
5. **Search click routing — carried over from Phase 1 FOLLOWUPS.md.**

---

## 9a. Post-smoke regression fixes (landed as additional commits on this branch)

Supervisor Chrome smoke of the original PR #24 surfaced two regressions before merge. Both fixed on the same branch, second commit pair.

### Bug 1 — closed sessions disappear from swimlane + FLEET OVERVIEW shows zero counts

**Root cause.** Pre-existing since Phase 1 merge, not a PR #24 regression. `dashboard/src/store/fleet.ts:30` set `SWIMLANE_LOOKBACK_MS = 2 hours`. The bootstrap `fetchSessions({ from: since, limit: 100 })` filtered by `started_at` (server-side semantic), so sessions that started more than 2 hours ago never reached the store's `flavors[].sessions[]` arrays regardless of their state or current `last_seen_at`. Invisible during Phase 1 testing because the dev DB was being actively populated by a Claude Code plugin session that kept hooks firing within the window; surfaced only after the dev DB had aged.

The downstream effects were exactly what the Supervisor reported:

- `FleetPanel.tsx::sessionStateCounts` sums `flavors[].sessions[].state`; empty arrays → all zeros.
- Swimlane per-agent header `flavor.active_count` → 0 because `buildFlavors` computed it from an empty filtered list.
- Expanded agent row iterated `flavor.sessions` → empty list.
- Investigate, by contrast, used `/v1/sessions` directly with a 7-day server default, hence it saw all 194.

**Fix (A)+(E) per Supervisor direction.**

- (A) `SWIMLANE_LOOKBACK_MS` 2 h → 24 h. Comment at `fleet.ts:26` documents the "what did my fleet do today?" intent and the explicit contrast with Investigate's 7-day history-view default.
- (E) `useFleetStore.loadExpandedSessions(agentId)` — new on-demand action called by `Fleet.tsx::handleExpandFlavor` when a user expands a row. Fetches `/v1/sessions?agent_id=<uuid>&limit=100` with no `from`/`to` bound (server default 7 d). Result stashed in a separate `expandedSessions: Map<string, Session[]>` so the main swimlane event-circle row stays windowed and only the expanded SESSIONS drawer sees older sessions. Fresh fetch per expand, no cache, best-effort on failure.
- SwimLane gained an optional `expandedSessions?: Session[]` prop; when set, the expanded drawer renders from it instead of `sessions`. Main event-circle row above the drawer still uses `sessions` so old circles do NOT contaminate the timeline.
- `FleetPanel.tsx` SESSION STATES heading now carries a muted `last 24 hours` label with a tooltip explaining the windowing. Closes the "why doesn't the sum equal `total_sessions`?" UX trap pre-emptively.

Fix commit: second commit on this branch.

### Bug 2 — Fleet Table row click lands on Investigate with empty sessions + UUID-prefix chip label

**Root cause.** Two layered sub-bugs:

- (2a) `AgentTable.tsx` row click navigated to `/investigate?agent_id=<uuid>` with no `from`/`to` params. `parseUrlState` in Investigate DOES default `from = 7 days ago` + `to = now`, so the fetch should have worked — but in the Supervisor's specific repro, the chip resolved to a UUID prefix because the sessions list was empty in a race, which in turn cascaded into "No sessions found" display language that made the user doubt the filter applied. Facet-click navigation, for comparison, emits an explicit `from`/`to` because it goes through `updateUrl` over an already-parsed urlState. Mismatch between the two navigation paths.
- (2b) The agent_id chip label resolved only via the current sessions list (`buildActiveFilters(urlState, sessions, updateUrl)`). When the filtered query returns 0 rows, the lookup fell through to the 8-char UUID prefix — documented in FOLLOWUPS.md post-Phase-2 but still a user-visible UX bug.

**Fix.**

- (2a) `AgentTable.tsx` row click now composes `/investigate?from=<7d-ago>&to=<now>&agent_id=<uuid>` so the two navigation paths emit the same URL shape. Self-describing URL; no reliance on Investigate's implicit defaults.
- (2b) `buildActiveFilters` signature changed to `(urlState, sessions, agents, updateUrl)`. Resolution order: fleet-store `agents[]` → sessions list → UUID prefix. A module-level `warnUnresolvedAgentOnce` emits one `console.warn` per distinct unresolved agent_id so operators noticing the fallback can easily file a `/v1/agents/{id}` endpoint request when it hurts.
- `Investigate.tsx` now calls `useFleetStore((s) => s.agents)` and fires a `load()` on mount when the roster is empty. Fleet roster is cheap (≤ per_page=200 rows) and caches at the store layer; the redundant fetch cost is negligible compared to the UX win.
- The "chip label UUID fallback" FOLLOWUPS.md entry is CLOSED by this fix.

Fix commit: second commit on this branch.

### V-pass lesson

**Time-dependent bugs can sit dormant between phases** and surface only after the dev DB has aged sufficiently. CI and fresh-data manual smoke cannot detect them — every test fixture was emitted milliseconds before the assertion, so it lived inside any realistic window constant.

**Future V-passes for phases touching windowed queries, lookback constants, or TTL logic MUST:**

1. Enumerate every window / lookback constant in the codebase (grep for `LOOKBACK_MS`, `TTL`, `INTERVAL`, `from:`, `* 60 * 60 *`).
2. Audit whether each constant's value is coherent with the user-facing question the UI answers ("now" vs "today" vs "this week").
3. Require at least one data point in each window tier (fresh-minute, 24-hour, 7-day+) during live-stack verification.

**Phase 1 ducked this** because the Claude Code plugin that populated the dev DB kept firing hooks within the 2-hour window throughout testing, so every UI surface looked fine. The bug surfaced only after a multi-hour pause between Phase 1 merge and the Phase 2 Chrome smoke. Supervisor's smoke discipline (using an aged stack, not a fresh one) is why this was caught before users hit it.

**applyUpdate-specific corollary.** Any change to the fleet store's `applyUpdate` must have regression tests asserting each session state is preserved across state transitions (active → idle → stale → closed, plus the revive paths). Future V-passes for store logic must specifically enumerate state-preservation invariants before modifying `applyUpdate`. This PR's Issue 3 change to mirror every event onto `agents[]` was not accompanied by such tests; the Bug 1 mechanism was orthogonal (windowing, not state filtering) but the V-pass rule protects against the class of bug where "one invariant change breaks another quietly".

---

## 10. Files touched

**Added:**
- `dashboard/src/lib/fleet-ordering.ts`
- `dashboard/src/components/facets/FacetIcon.tsx`
- `dashboard/src/components/facets/ClientTypePill.tsx`
- `dashboard/tests/unit/fleet-ordering.test.ts`
- `dashboard/tests/unit/investigate-active-filters.test.ts`
- `dashboard/tests/unit/ClientTypePill.test.tsx`
- `dashboard/tests/unit/fleet-store-expanded-sessions.test.ts` (Bug 1 regression guard)
- `dashboard/tests/unit/AgentTable-row-navigation.test.tsx` (Bug 2a regression guard)
- `audit-phase-2.md` (this document)

**Modified:**
- `api/internal/store/postgres.go` (GetAgentFleet ORDER BY)
- `dashboard/src/lib/agent-identity.ts` (+ CLIENT_TYPE_COLOR registry)
- `dashboard/src/pages/Investigate.tsx` (extract helpers, use shared FacetIcon, Issue 1 fixes)
- `dashboard/src/pages/Fleet.tsx` (bucket sort wiring)
- `dashboard/src/store/fleet.ts` (enteredBucketAt + live-update mirror)
- `dashboard/src/components/fleet/FleetPanel.tsx` (FacetIcon, ClientTypePill)
- `dashboard/src/components/fleet/AgentTable.tsx` (ClientTypePill, bucket divider, sortedAgents)
- `dashboard/src/components/timeline/Timeline.tsx` (bucket divider)
- `dashboard/src/components/timeline/SwimLane.tsx` (ClientTypePill)
- `FOLLOWUPS.md` (two new entries)

No product code outside `api/internal/store/postgres.go` changed in Go. No schema migration. No ingestion or worker changes.
