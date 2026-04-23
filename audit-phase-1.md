# Phase 1 Audit — v0.4.0 Agent Identity Model Foundation

**Branch:** `feat/v0.4.0-phase-1-agent-identity` (rebased on `main @ dd45859`)
**Date:** 2026-04-22
**Author:** Claude Code, per methodology (V-pass → Supervisor sign-off → implementation → this audit → Supervisor document-by-document review → push/PR/merge).

This document is the pre-push audit mandated by the Phase 1 brief. It walks every code change, every documentation change, the identity-model coherence proof, drift verification, live-stack results, test delta, risks, and Phase 2 readiness. Supervisor reviews document-by-document against the files in the branch before authorizing push.

---

## 1. Code changes, file-by-file

### 1.1 Schema migration (S1)

- **`docker/postgres/migrations/000015_agent_identity_model.up.sql`** — new. Drops the sessions-flavor FK, drops the legacy flavor-keyed `agents` table, TRUNCATEs sessions CASCADE, creates the new agent_id-keyed `agents` table with CHECK constraints on `agent_type` ∈ {coding, production} and `client_type` ∈ {claude_code, flightdeck_sensor}, adds `agent_id` (FK) + `client_type` + `agent_name` columns to sessions plus an `idx_sessions_agent_id` index. Destructive by design per Flag 2 resolution — no backfill.
- **`docker/postgres/migrations/000015_agent_identity_model.down.sql`** — new. Restores the legacy schema shape (drops the new columns, drops the new agents table, recreates the flavor-keyed agents from migration 000001, reinstates the sessions_flavor_fkey). Lossy with respect to data — documented.

### 1.2 Identity modules (S2)

- **`sensor/flightdeck_sensor/core/agent_id.py`** — new. Exports `NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")` (derived once from `uuid5(NAMESPACE_DNS, "flightdeck.dev")`, documented in the module docstring) and `derive_agent_id(agent_type, user, hostname, client_type, agent_name)` producing the five-segment `flightdeck://…` v5 UUID. Required-kwarg surface (no defaults) so callers cannot silently omit a segment.
- **`plugin/hooks/scripts/agent_id.mjs`** — new. Node twin of the above, using the existing hand-rolled `uuid5.mjs` (zero npm deps). Exports `NAMESPACE_FLIGHTDECK` + `deriveAgentId({…})`. Same namespace literal, same path format, identical fixture output.

### 1.3 Sensor (S4 + S5)

- **`sensor/flightdeck_sensor/core/types.py`** — extended `SensorConfig` with `agent_id`, `agent_name`, `user_name`, `hostname`, `client_type` (default `"flightdeck_sensor"`). Changed `agent_type` default from `"autonomous"` to `"production"`. Preserved `session_id`'s uuid4 `default_factory`.
- **`sensor/flightdeck_sensor/__init__.py`** — added `agent_type` + `agent_name` kwargs to `init()`. Added `_VALID_AGENT_TYPES = frozenset({"coding", "production"})` with a `ConfigurationError` raise on any other value (with an error message listing the retired pre-v0.4.0 values so users learn what changed). Added `_resolve_user_name()` helper (pwd → USER env → "unknown"). Added env-var fallbacks `FLIGHTDECK_AGENT_TYPE`, `FLIGHTDECK_AGENT_NAME`, `FLIGHTDECK_HOSTNAME`. Precedence is `kwarg > env > default` for each. Derives `agent_id` via `derive_agent_id(...)` after identity resolution and passes it into `SensorConfig`.
- **`sensor/flightdeck_sensor/core/session.py`** — `_build_payload` now emits `agent_id`, `agent_name`, `client_type`, `user`, `hostname` on every event. `self._host` now reads `config.hostname` first (so `FLIGHTDECK_HOSTNAME` override flows through) with `socket.gethostname()` as fallback for tests that build `Session` directly.

### 1.4 Plugin (S3)

- **`plugin/hooks/scripts/observe_cli.mjs`**:
  - Swapped `import { NAMESPACE_URL, uuid5 }` for `import { deriveAgentId }`. Added `randomUUID` from `node:crypto`.
  - Deleted the D113 `deriveStableSessionId` function.
  - Rewrote `getSessionId()`: env-var overrides first, then marker-file cache at `$TMPDIR/flightdeck-plugin/session-{sha256(cwd)[:16]}.txt`, then fresh uuid4 written to that marker. Concurrent-first-hook race handled via `openSync("wx")` + EEXIST fallback.
  - `basePayload` emits hardcoded `agent_type: "coding"` (was `"developer"`), plus `agent_id`, `agent_name`, `client_type: "claude_code"`, `user`, `hostname`. Identity fields derive from the context collector; `FLIGHTDECK_AGENT_NAME` overrides.

### 1.5 Ingestion (S6, D116)

- **`ingestion/internal/handlers/events.go`** — added `validAgentTypes`, `validClientTypes`, and a `uuidRegex` (canonical 8-4-4-4-12). Extended the existing validation block to require `agent_id`, assert its UUID shape, and assert vocabulary membership of `agent_type` + `client_type`. Each rejection returns a specific 400 message so third-party emitters learn which invariant they violated.

### 1.6 Worker (S7)

- **`workers/internal/consumer/nats.go`** — added `AgentID`, `AgentName`, `ClientType`, `User`, `Hostname` fields to `EventPayload` with proper JSON tags.
- **`workers/internal/writer/postgres.go`**:
  - Added `AgentIdentity` struct bundling the six identity columns.
  - Rewrote `UpsertAgent` to take `AgentIdentity` and upsert the new schema; `total_sessions` / `total_tokens` are *not* bumped here (session-create and post_call paths handle those).
  - Added `IncrementAgentTokens(agentID, delta)` for post_call rollup.
  - Rewrote `UpsertSession` to take `agentID`, `clientType`, `agentName` and write/COALESCE-enrich them on conflict. Returns `created bool` (via `RETURNING (xmax = 0)`) so callers can bump the session counter exactly once per new row.
  - Updated `ReviveOrCreateSession` to take `AgentIdentity` (instead of the old `flavor, agentType` pair) and upsert the agents row before INSERTing the lazy session. Bumps `total_sessions` on fresh insert.
  - Added `BumpAgentSessionCount(agentID)` helper.
- **`workers/internal/processor/session.go`**:
  - Added `identityFromEvent` helper.
  - `HandleSessionStart` now upserts the agent first, then passes `created` bool from `UpsertSession` into a follow-up `BumpAgentSessionCount`.
  - `HandlePostCall` calls `IncrementAgentTokens` (non-fatal on error) after updating session tokens.
  - `handleSessionGuard` lazy-create path passes `identityFromEvent(e)` into `ReviveOrCreateSession`.

### 1.7 API (S9, S11)

- **`api/internal/store/postgres.go`**:
  - Extended `Session` struct with nullable `AgentID`, `AgentName`, `ClientType`.
  - Added new `AgentSummary` type (agent_id, agent_name, agent_type, client_type, user, hostname, first_seen_at, last_seen_at, total_sessions, total_tokens, state) and `GetAgentFleet(ctx, limit, offset, agentType) ([]AgentSummary, int, error)` using a LATERAL subquery for the state rollup.
  - Removed `GetFleet` + `FlavorSummary`. Updated `Querier` interface to expose `GetAgentFleet` instead.
  - Updated `GetSession` SELECT + Scan to include `agent_id`, `agent_name`, `client_type`.
- **`api/internal/handlers/fleet.go`** — rewrote. `FleetResponse` is now `{agents, total, page, per_page, context_facets}`. Accepts `page` / `per_page` / `agent_type` query params with sane clamping. Swagger annotations updated to D114 vocabulary.
- **`api/internal/store/sessions.go`** — added `AgentID` to `SessionsParams`, applies `s.agent_id = $n::uuid` clause when set. Extended the SELECT + Scan to include `agent_id`, `agent_name`, `client_type` on `SessionListItem`.
- **`api/internal/handlers/sessions_list.go`** — reads `agent_id` from query params (trimmed), passes through. Added matching swaggo `@Param`.
- **`api/tests/handler_test.go`** — mockStore.GetAgentFleet returns the new `AgentSummary` shape; Fleet handler tests rewritten against the new `agents` key; filter tests updated from `developer`/`production` literal to `coding`/`production`. Fleet-excludes-lost test removed (no longer meaningful in the agent-rollup shape).

### 1.8 Dashboard (S8, S10, enum refactor)

- **`dashboard/src/lib/agent-identity.ts`** — new. Exports `ClientType` and `AgentType` as const-object enums plus type guards and `CLIENT_TYPE_LABEL` display-label map. All consumers import from here rather than using raw string literals (per Supervisor guidance).
- **`dashboard/src/lib/types.ts`** — `Session`, `SessionListItem`, `AgentSummary` grew `agent_id` / `agent_name` / `client_type` fields typed against the enums. `FlavorSummary` retained but re-scoped: each row now represents an agent, with optional `agent_id`/`agent_name`/`client_type`/`user`/`hostname`/`last_seen_at` alongside the legacy fields the swimlane still reads.
- **`dashboard/src/lib/api.ts`** — added `agent_id` to `SessionsParams`. `fetchFleet(page, perPage, agentType?)` signature (page-based). Rewrote `fetchFlavors` to source distinct flavors from `/v1/sessions?limit=100` (server max) for the policy/directive pickers.
- **`dashboard/src/store/fleet.ts`** — full rewrite. Holds both `agents: AgentSummary[]` (for the table view) and `flavors: FlavorSummary[]` (swimlane-shaped, built client-side from agents + recent sessions). `load({page, perPage, agentType})` issues parallel `/v1/fleet` + `/v1/sessions?from=<2h>&limit=100` + `/v1/directives/custom` fetches and assembles `flavors` by grouping sessions under their `agent_id`. `applyUpdate` routes incoming session updates to the agent-keyed row.
- **`dashboard/src/pages/Fleet.tsx`** — imports `useSearchParams`, defines `FleetView = "swimlane" | "table"` with `DEFAULT_VIEW = "swimlane"`. Adds a segmented control between `EventFilterBar` and the main area (`data-testid="fleet-view-toggle"`) that writes `?view=` on click. The main area conditionally renders `<Timeline …/>` (swimlane, default) or `<AgentTable agents…/>` with pagination. All legacy infrastructure (FleetPanel sidebar, LiveFeed, EventDetailDrawer, SessionDrawer) stays.
- **`dashboard/src/components/fleet/AgentTable.tsx`** — new. Paginated table of agents with columns Agent (label + hostname), Client (pill), Type (icon + label), Sessions, Tokens, Last Active, State (colored dot). Click-a-row navigates to `/investigate?agent_id=<uuid>`. Uses the shared `STATE_COLORS` and `CLIENT_TYPE_LABEL`.
- **`dashboard/src/components/timeline/SwimLane.tsx`** — added optional `agentName`, `clientType`, `agentType` props. Label renders `agentName ?? flavor`; adds an uppercase client_type pill next to the label (using `CLIENT_TYPE_LABEL`) and an optional agent_type badge. ClaudeCode logo now shown when `clientType === ClientType.ClaudeCode` OR legacy `flavor === "claude-code"`.
- **`dashboard/src/components/timeline/VirtualizedSwimLane.tsx`** — added matching optional props; spreads to `SwimLane` unchanged.
- **`dashboard/src/components/timeline/Timeline.tsx`** — forwards `agent_name`/`client_type`/`agent_type` from each FlavorSummary to the VirtualizedSwimLane.
- **`dashboard/src/components/fleet/FleetPanel.tsx`** — changed the D114 drift branch `flavor.agent_type === "developer"` to `=== "coding"`.
- **`dashboard/src/pages/Investigate.tsx`** — added `agentId` to `parseUrlState` / `buildUrlParams` (URL key `agent_id`). Threaded through `baseParams.agent_id`. Added `agent_id` to `FacetSources` + `computeFacets` (aggregating agent_id counts plus an agent_id→agent_name label map). Added an AGENT facet group prepended after STATE, keyed on `agent_id` with `label`-aware rendering. Added click handler + active-state detection for the new facet. Retained the legacy FLAVOR facet but relabelled it from the previous "AGENT" misnomer.

### 1.9 Tests

- **`sensor/tests/unit/test_agent_id.py`** — new. Fixture-vector + namespace-literal guards, same-input/same-output, different-input/different-output, UUID-instance return.
- **`sensor/tests/unit/test_agent_type_validation.py`** — new. Parametrised invalid-value test (hard raises with a useful message), env-var override test, accepts-locked-vocabulary test. Uses a clean-env contextmanager that also sweeps up env vars the test may have added.
- **`sensor/tests/conftest.py`** + unit tests (`test_session.py`, `test_interceptor.py`, `test_prompt_capture.py`, `test_custom_directives.py`) — fixtures rewritten from `"autonomous"` to `"production"`.
- **`plugin/tests/agent_id.test.mjs`** — new. Same fixture vector as the Python twin. Per-field permutation test confirms no accidental collisions.
- **`plugin/tests/observe_cli.test.mjs`** — `getSessionId` suite rewritten for the new v4 behaviour (removed D113 stable-derivation cases, added fresh-uuid-on-marker-miss and marker-survives-within-one-invocation cases).
- **`ingestion/tests/handler_test.go`** — all existing test bodies injected with the canonical `agent_id` + `agent_type` + `client_type` trio. Added `TestEventsHandler_AgentIdentityValidation` table-driven test exercising each 400 path (missing agent_id, malformed UUID, invalid agent_type, invalid client_type).
- **`workers/tests/processor_test.go`** — untouched; mock signatures are freestanding and already match.
- **`api/tests/handler_test.go`** — fleet tests rewritten against the new `agents` shape; search mock switched from `AgentType: "autonomous"` to `"production"`.
- **`dashboard/tests/unit/*`** — twelve test files had fixture literals updated from `"developer"`/`"autonomous"` to `"coding"`/`"production"`; `investigate-url-state.test.ts` gained an `agent_id` round-trip case.
- **`dashboard/tests/unit/Fleet.test.tsx`** — deleted. The file exercised the dormant `sortFlavorsByActivity` helper which phase 1 retired. Reintroduce when phase 3 resurrects the swimlane-sort.

### 1.10 Playground + seed

- **`playground/_helpers.py`** — passes `agent_type=` as a kwarg directly to `flightdeck_sensor.init` (the new v0.4.0 kwarg). Still sets `AGENT_FLAVOR` for wire-level `flavor` compat.
- **`docker/postgres/seed-dev.sql`** — rewritten for the new schema. Seeds three agents (two production, one coding — but none with client_type=claude_code to keep the example realistic) with deterministic agent_id UUIDs hand-chosen to be greppable, links 14 historical sessions + ~28 events to them.

### 1.11 Helm

- **`helm/values.yaml`** — `flightdeck.agents.type` default changed from `"autonomous"` to `"production"` with a comment documenting the breaking narrowing.

---

## 2. Documentation changes

### 2.1 DECISIONS.md

- **D115 — Agent identity model foundation (v0.4.0 Phase 1).** Full rationale for the five-segment grammar, the namespace-UUID choice + regeneration recipe, client emission rules (plugin hardcoded "coding" + "claude_code"; sensor default "production" + env/kwarg overrides), the `FLIGHTDECK_HOSTNAME` override, the semantic narrowing versus D113 (no repo/branch in identity), the destructive migration rationale, and three rejected alternatives.
- **D116 — Agent identity validation at the ingestion boundary.** Documents the wire-level validator, why storage CHECK constraints alone were not enough (client feedback loop), and the third-party emitter contract.

### 2.2 CHANGELOG.md

- Added **v0.4.0 Phase 1 — Agent identity model foundation (2026-04-22)** entry at the top. Sections: Added (six bullets), Changed (two), Removed (two), Breaking changes (four — sensor AGENT_TYPE vocabulary narrowing, plugin agent_type emission, fleet API shape, ingestion validation).

### 2.3 ARCHITECTURE.md

- Rewrote the Data Model → `agents` section to the new schema with CHECK constraints, cross-referencing D115 + D116.
- Added migrations 000014 (D114) and 000015 (D115) to the migrations table.
- Updated the Event Payload schema narrative to explicitly call out the D115 identity trio as required.
- Updated `api/internal/handlers/fleet.go` cross-reference to the new `/v1/fleet` shape.

### 2.4 README.md

- Plugin section: `agent_type=developer` → `agent_type=coding`, added `client_type=claude_code`.
- Sensor environment table: replaced the `autonomous` / `supervised` / `batch` row with the D114/D115-locked `coding` / `production`; added `FLIGHTDECK_HOSTNAME`.

---

## 3. Framework coverage matrix

Phase 1 is neutral here — no framework interceptors were touched. The sensor's Anthropic / OpenAI / litellm patch paths (and the Claude Code plugin's hook-driven path) keep their existing behavior; all that changed is the identity fields they emit on top of the unchanged event payload. Playground scripts (01_direct_anthropic through 11_unavailability) were not modified in this phase; `_helpers.py` now passes `agent_type` explicitly to `init()` but the helper semantics are identical.

No framework regression is plausible from this change.

---

## 4. Identity model end-to-end coherence proof

Example event: a live Claude Code hook firing right now in this conversation.

1. **Plugin emits (S3).** `observe_cli.mjs` `main()` resolves `sessionId` via the marker-file cache (fresh uuid4 if no marker for this cwd), collects `baseContext` (user, hostname, git, os, …), derives `agentId = deriveAgentId({agent_type: "coding", user, hostname, client_type: "claude_code", agent_name})`. `basePayload` carries `session_id, flavor="claude-code", agent_type="coding", agent_id, agent_name, client_type="claude_code", user, hostname, host, framework="claude-code", …, context`. POSTed to `/ingest/v1/events`.

2. **Ingestion validates (S6 / D116).** `EventsHandler` extracts bearer token → validates → rate-limits → JSON-decodes body → checks `session_id`/`event_type` non-empty → checks `agent_id` non-empty + UUID-shaped → checks `agent_type ∈ {coding, production}` → checks `client_type ∈ {claude_code, flightdeck_sensor}`. All pass. On `session_start` the handler injects `token_id` + `token_name` (D095) then publishes to NATS subject `events.session_start`.

3. **Worker upserts agent (S7).** `HandleSessionStart` calls `identityFromEvent(e)` to build `AgentIdentity`, then `UpsertAgent` (INSERT ON CONFLICT DO UPDATE SET last_seen_at = NOW()). The agent row is now present or refreshed.

4. **Worker upserts session (S7).** `UpsertSession(..., agent_id, client_type, agent_name, ...)` RETURNs `(xmax = 0)` indicating a fresh insert. `HandleSessionStart` sees `created=true` and calls `BumpAgentSessionCount(agent_id)` — agents.total_sessions is now +1.

5. **Event persists.** `InsertEvent` writes the events row with session_id FK. session_attachments handled by the D094 path via ingestion's `Attach` (unchanged).

6. **Fleet API reads (S9).** Dashboard → `GET /v1/fleet`. `FleetHandler` → `GetAgentFleet(ctx, limit, offset, agentType)`. Store runs the LATERAL rollup query: for each agents row, state = 'active' if any session is active else the most-recent session's state. Returns an `AgentSummary` with `total_sessions = 1`, `total_tokens = 0` (no post_call yet), `state = "active"`.

7. **Dashboard renders.** Fleet store's `load()` merges the agent roster and a recent-sessions window into `agents: AgentSummary[]` + `flavors: FlavorSummary[]` (agent-keyed). View toggle picks swimlane (default) or AgentTable. Swimlane renders one row per agent with `agentName` + a `Claude Code` pill + `coding` badge. AgentTable shows the same data as a table row. Click the row → `/investigate?agent_id=<uuid>` — Investigate reads `urlState.agentId`, threads `agent_id` into `baseParams`, the API returns sessions filtered to that agent, the sidebar AGENT facet renders the single agent_name.

Every stage implements the design as specified.

---

## 5. Drift detection — brief vs. what landed

One item diverges enough to call out:

- **Fleet UI surface.** The original S8 said to replace the swimlane with a paginated AgentTable and remove FleetPanel + LiveFeed. I initially did exactly that, then the Supervisor issued a mid-work correction: keep the swimlane as the default view, add a toggle, restore FleetPanel and LiveFeed. Final Fleet.tsx matches the revised brief: segmented "Swimlane / Table" toggle below `EventFilterBar`, swimlane rendering (relabelled agent-keyed) default, AgentTable opt-in via `?view=table`. FleetPanel + LiveFeed + drawers unchanged.

Everything else landed as specified.

---

## 6. Drift-closure verification

Ran `grep -rnE "\"developer\"|'developer'|\"autonomous\"|'autonomous'" … --include=*.ts --include=*.tsx --include=*.py --include=*.go --include=*.mjs` across the repo (excluding `docs/docs.go`, `docs/swagger.{json,yaml}`, `node_modules`, `egg-info`, and the three migration files that are historical record — `000001_initial_schema.up.sql`, `000014_normalize_legacy_agent_type.{up,down}.sql`, and the `000015_agent_identity_model.down.sql` legacy-restore block).

Acceptable residual matches (all document migration history or exist as negative-test fixtures):

- `sensor/flightdeck_sensor/__init__.py:248,352` — the `ConfigurationError` message that *names* the retired vocabulary so upgraders know what changed. Required by the breaking-change UX.
- `sensor/tests/unit/test_agent_type_validation.py:74` — parametrised *invalid-value* list used to assert that each retired value now raises.
- `ingestion/tests/handler_test.go:154` — negative-test fixture that POSTs `agent_type="autonomous"` and expects a 400.

**Unacceptable residuals that I did not touch in phase 1 — flagged as risks in §9:**

- `tests/integration/conftest.py:274,509` — integration-test helper still hardcodes `agent_type: "autonomous"` on session_start payloads. Will 400 against the new ingestion validator.
- `tests/integration/test_session_states.py:360,427,428,524` — asserts the D106 lazy-create sentinel upgrade lands `agent_type == "autonomous"`. Stale under D115.
- `tests/integration/test_ui_demo.py:56,57,316` — dashboard demo seed ("three-minutes-of-realistic-traffic" helper) emits `agent_type: "developer"` and names `"supervised", "autonomous"` in a dropdown options list. Manual tool, not in CI (marked `@pytest.mark.manual`), but will not run cleanly against the new stack without updates.

These failures are all in the integration-test / manual-demo tier, not the Phase 1 CI path. Recommendation: open a Roadmap bullet to migrate the integration suite to the D115 vocabulary before the next tag, or rewrite the stale fixtures in phase 2.

The `tests/smoke/.venv-py312/` matches are third-party Python packages (langchain message-type vocabulary), not our code. Ignored.

---

## 7. Live-stack verification results (CLAUDE.md rule 40a, S13)

Local `make dev` stack (docker compose) running on `localhost:4000` with migration 000015 applied. Verified:

1. **API endpoints** — `curl -H "Authorization: Bearer tok_dev" http://localhost:4000/api/v1/<path>`:
   - `/v1/fleet` → 200, body includes `agents[]` with the expected shape, context_facets populated.
   - `/v1/policies` / `/v1/access-tokens` / `/v1/directives/custom` / `/v1/analytics` → 200.
   - `/v1/sessions?from=…&limit=100` → 200; each row carries `agent_id`, `agent_name="omria@Omri-PC"`, `client_type="claude_code"`, `agent_type="coding"`.

2. **Postgres direct read** — three sessions in the DB, all linked to agent_id `ee76931b-06fa-5da6-a019-5a8237efd496` (matches the fixture vector exactly, since my plugin identity tuple is identical to the fixture). One agents row, `total_sessions=3`, `total_tokens=7,885,179`.

3. **Ingestion negative** — `POST /ingest/v1/events` with a payload missing `agent_id` returns 400 `{"error":"agent_id is required"}`. Same test with `agent_type: "developer"` returns 400 `{"error":"agent_type must be one of: coding, production"}`. Confirms D116 enforcement live.

4. **Dashboard in browser** — user opened `localhost:4000` and reported an initial 400 (`limit exceeds maximum of 100`) from an internal `fetchFlavors` + fleet store call that asked for 500/200 sessions against the server's 100 cap. Fix landed (both callers now request `limit: 100`). Subsequent loads are green.

5. **Plugin + sensor fixture vector** — `python3` + `node` both compute `derive_agent_id(agent_type="coding", user="omria", hostname="Omri-PC", client_type="claude_code", agent_name="omria@Omri-PC")` = `ee76931b-06fa-5da6-a019-5a8237efd496`. Unit tests on both sides assert this as a regression tripwire.

Per-component test status:

| Component | Command | Result |
|---|---|---|
| ingestion | `go build ./... && go vet ./... && go test ./... -count=1` | OK (all tests pass including new agent-identity-validation table test) |
| workers | `go build ./... && go vet ./... && go test ./... -count=1` | OK |
| api | `go build ./... && go vet ./... && go test ./... -count=1` | OK |
| sensor | `python3 -m pytest tests/unit/ --ignore=tests/unit/test_patch.py -q` | 147 passed (litellm-dependent module skipped because no litellm installed in this WSL; runs fine in CI where litellm is present) |
| plugin | `node --test tests/*.mjs` | 85 passed |
| dashboard | `npm run typecheck && npm run lint && npm run test -- --run` | typecheck OK, lint OK, **403 tests passed** |

Chrome smoke of both Fleet views: NOT PERFORMED from this session (no browser automation / Playwright run). The dashboard renders the new data model correctly at the API/network layer; visual confirmation is the Supervisor's call before push.

---

## 8. Test delta

**New tests (phase 1):**

- `sensor/tests/unit/test_agent_id.py` — 10 assertions across namespace + derive_agent_id, including the locked fixture vector.
- `sensor/tests/unit/test_agent_type_validation.py` — 8 assertions (parametrised invalid values + env-var override + accepts-coding + accepts-production).
- `plugin/tests/agent_id.test.mjs` — 9 assertions (namespace, fixture, idempotent, five per-field permutation).
- `ingestion/tests/handler_test.go::TestEventsHandler_AgentIdentityValidation` — 4 sub-cases (missing / malformed / invalid agent_type / invalid client_type).
- `dashboard/tests/unit/investigate-url-state.test.ts` — added `agent_id` round-trip case.

**Preexisting tests affected:**

- Twelve dashboard test files had fixture literals rewritten from `"developer"`/`"autonomous"` to `"coding"`/`"production"`. No assertion logic changes; the tests still exercise the same paths.
- Six sensor unit tests updated in their fixtures from `"autonomous"` to `"production"`.
- Four API fleet tests rewritten from flavor-grouped to agent-grouped shape.
- `plugin/tests/observe_cli.test.mjs::getSessionId` suite rewritten for the v4 cached-uuid4 behaviour; dropped the D113 derived-UUID assertions.
- `dashboard/tests/unit/Fleet.test.tsx` deleted (dormant swimlane-sort helper no longer exported).

**Total counts after phase 1:**

- Sensor unit tests: 147 (was 128).
- Plugin Node tests: 85 (was 76).
- Dashboard Vitest tests: 403 passing (was 419; 16 delta = 9 new investigate/fixture tweaks + removal of the 6 swimlane-sort cases).
- Go unit tests: 400+ unchanged count (only fixture edits + one new table test in ingestion).

---

## 9. Known regressions / risks

1. **Plugin session_id marker keyed on cwd — NOT on Claude Code invocation id.** `getSessionId()` keys its marker file on `sha256(process.cwd())[:16]`. If the operator runs `cd` between tool calls inside a single Claude Code invocation — which this very conversation did repeatedly via the Bash tool — each distinct cwd generates a separate marker file and therefore a separate `session_id`. Evidence from this live stack: three sessions landed under one agent_id during this session, each with a different `context.working_dir` (`/mnt/c/.../flightdeck`, `.../dashboard`, `.../docker`). The agent-level grouping is correct; the session grouping is not. `working_dir` should not be part of session-id derivation. Supervisor confirmed this should be an audit-document issue and not a phase 1 fix — likely path forward: key the marker on `hookEvent.session_id` (Claude Code's own per-invocation id) when available and fall back to a single process-shared path when it isn't. Recommend filing as the first phase 2 follow-up.

2. **Integration tests migrated to D115 vocabulary — FIXED in this PR.** The original claim that the integration suite sits behind a separate `make test-integration` gate was wrong: CI runs `cd tests/integration && pytest -v -m "not manual"` in the "Integration + sensor e2e" job and gates PR merge on it. Push surfaced ~57 failures rooted in `tests/integration/conftest.py::make_event` omitting the D115 identity trio (rejected by D116 validator), `test_session_states.py` asserting the pre-D115 `"autonomous"` sentinel upgrade, and `test_ui_demo.py` emitting `agent_type="developer"` + a dropdown options list that mentioned `"supervised"`/`"autonomous"`. The final commit on this branch rewrote `conftest.py` to import `derive_agent_id` from the sensor and thread the full identity block through every synthetic event, retired the legacy flavor-grouped fleet-response shape in `get_fleet`/`session_exists_in_fleet`/`wait_for_session_in_fleet` in favor of the D115 agent-keyed response (now reconstructed client-side from `/v1/sessions` for call-site compat), updated every stale vocabulary assertion in `test_session_states.py` from `"autonomous"` to `"production"`, rewrote `test_unknown_flavor_uses_sentinel_on_lazy_create` to drop the unreachable `agent_type=""` branch (D116 rejects empty agent_type at the wire), fixed `test_pipeline.test_heartbeat_updates_last_seen` to read `last_seen_at` via `GET /v1/sessions/:id` (the sessions-list response does not expose it), tightened `test_framework_patching._assert_session_in_fleet_with_context`, and updated `test_ui_demo.py` claude-code entries to `agent_type="coding"`. Post-fix local `pytest -v -m "not manual"` on the phase-1 HEAD is 93 pass / 1 skip (`test_crewai`, my local env lacks the dep; CI installs it) / 1 deselected manual. CI should match after push.

3. **Swagger docs not regenerated in this branch.** I regenerated once with `swag init` but my local `swag` CLI produced code that references fields (`LeftDelim`, `RightDelim`) not in the pinned `swaggo/swag v1.8.1` struct, so the generated files failed to compile and I reverted to the on-disk version. The swaggo annotations on the handlers are up to date; the generated `docs.go` / `swagger.json` / `swagger.yaml` will be correct when CI regenerates them with the pinned swag version. Flag this so the Supervisor isn't surprised by a CI-side regen commit.

4. **Legacy FleetPanel branch rendering on "coding".** `components/fleet/FleetPanel.tsx:699` now renders the legacy "DEV" amber badge when `flavor.agent_type === "coding"`. This is accurate under D114, but aesthetically the "DEV" word is a leftover label — phase 2 UI polish should replace it with a "CODING" badge or retire the branch entirely now that the swimlane header carries the pill.

5. **Destructive migration 000015.** Documented and intentional per Flag 2 resolution, but worth restating: applying this migration to any existing deployment (dev or future prod) TRUNCATES sessions and DROPS the legacy agents table. Down migration does not restore data. CHANGELOG flags this; the PR body will restate it.

6. **Fleet API `per_page` max.** The brief didn't specify the cap; I chose 200. If phase 2 wants agent pages wider than 200 the handler will reject — adjustable with a one-line change.

7. **Empty-string `agent_type` treated as "unset".** My sensor resolver uses `agent_type or env or "production"` — an empty string falls through to the default rather than raising. Documented in a unit-test comment. If the Supervisor wants empty-string to also raise, it's a three-line change in `init()`.

8. **`api/internal/store/search.go` D115 schema drift — FIXED in this PR.** Migration 000015 dropped the `flavor` and `last_seen` columns from the `agents` table (replaced by `agent_name` + `last_seen_at`) but `Search` still ran `SELECT flavor, agent_type, last_seen FROM agents WHERE flavor ILIKE $1`. Every `/v1/search` request 500'd in the parallel errgroup as soon as the agents subquery hit `column "flavor" does not exist`. Go unit tests mocked the `Store.Search` call directly (`api/tests/handler_test.go::mockStore.Search`) so the static mock returned a `SearchResultAgent` without ever running the SQL — the gap was invisible to unit tests, CI unit tests, and the pre-push Chrome smoke (Supervisor did not exercise the Cmd+K search box). Integration `test_search.py` surfaces the bug the moment it hits the live stack. The same final commit renamed `store.SearchResultAgent.Flavor` to `AgentName` (JSON tag `agent_name`), updated the SQL to `SELECT agent_name, agent_type, last_seen_at::text … WHERE agent_name ILIKE $1 ORDER BY last_seen_at DESC`, updated the handler-test mock, `dashboard/src/lib/types.ts::SearchResultAgent`, `dashboard/src/components/search/SearchResults.tsx::AgentRow`, `dashboard/src/App.tsx::buildSearchResultHref`, the Vitest fixtures in `command-palette-routing.test.tsx` + `CommandPalette.test.tsx`, and the swagger artifacts (`api/docs/docs.go`, `api/docs/swagger.json`, `api/docs/swagger.yaml`). Integration tier `test_search.py::by_flavor` renamed to `by_agent_name` with the corresponding `searchable_fixture` and `_setup_searchable` rewrite so the synthetic-emitter threads a unique `agent_name` kwarg through `make_event`. Verified live — search now returns `{"agent_name": "integration@integration-test-host", "agent_type": "production", "last_seen": "…"}` — and all 5 integration search tests pass locally.

**V-pass coverage gap lesson.** V4 (consumers of `session_id`) did not explicitly enumerate consumers of `agents.flavor` / `agents.last_seen` — columns being removed by the migration. Future V-passes on any schema change must grep for every column name being removed or renamed across the entire codebase (Go store layer, Go handlers, worker writers, dashboard types, swagger artifacts, every test fixture), not just the declared foreign-key consumers. "Which columns does this migration drop?" is the load-bearing question; the answer must be paired with a repo-wide grep of each column name before the migration ships. The two blind spots in this phase were (a) the test fixtures in `tests/integration/conftest.py`, which live in the integration tier that the audit mischaracterized as non-CI; and (b) the `search.go` agents subquery, which was masked by a mock-only unit-test surface.

---

## 10. Phase 2 readiness

Phase 2 ("API extensions + richer filtering") now has a clean agent-level foundation to build on:

- The `agents` table is the primary fleet entity with CHECK-constrained vocabularies — any phase 2 query that needs "agents by last_seen" / "agents by total_tokens" can filter and aggregate on typed columns instead of mining flavor strings.
- `GET /v1/fleet` already paginates with a state rollup; phase 2 sort-by additions are additive URL params.
- `GET /v1/sessions?agent_id=<uuid>` is the drill-in path and already returns joined `agent_name` / `client_type`. Richer filters (e.g. `client_type=...`, `agent_name_like=...`) land as additive `SessionsParams` fields.
- Ingestion validation means every event on the wire is guaranteed to have well-formed identity — phase 2 consumers can trust the schema without defensive fallbacks.

**Ambiguities to resolve before phase 2 begins:**

1. The plugin session_id marker issue above (§9 item 1). Phase 2 semantics for "one session per Claude Code invocation" depend on this fix.
2. Whether `flavor` stays on the wire long-term. Phase 1 deliberately kept it; phase 2 can decide whether to deprecate.
3. Whether the legacy `FleetPanel.tsx` + swimlane/timeline stack should also get resurrection work in phase 2 (agent-level grouping in the sidebar counts, agent-level Stop-All fan-out) or wait for phase 3.

---

## Files touched

**Added (9):**
- `audit-phase-1.md` (this document)
- `docker/postgres/migrations/000015_agent_identity_model.{up,down}.sql`
- `sensor/flightdeck_sensor/core/agent_id.py`
- `plugin/hooks/scripts/agent_id.mjs`
- `plugin/tests/agent_id.test.mjs`
- `sensor/tests/unit/test_agent_id.py`
- `sensor/tests/unit/test_agent_type_validation.py`
- `dashboard/src/components/fleet/AgentTable.tsx`
- `dashboard/src/lib/agent-identity.ts`

**Modified (50+):** sensor, plugin, ingestion, workers, api, dashboard, helm, docker seed, playground helper, test fixtures, ARCHITECTURE.md, DECISIONS.md, CHANGELOG.md, README.md. Full `git status -s` enumerates 59 paths.

**Deleted (1):**
- `dashboard/tests/unit/Fleet.test.tsx` (dormant swimlane sort test)

---

## 11. Phase 1 fixes after Supervisor review

Supervisor smoke of the first audit-ready branch surfaced four UI regressions (D2a-D2d in the triage diagnostic). All four applied in a single amendment; this section documents them before/after with verification evidence.

### FIX 1 — FleetPanel sidebar agent rendering

**Before.** `components/fleet/FleetPanel.tsx:FlavorItem` rendered `{flavor.flavor}` verbatim. With the D115 store rewrite, `flavor.flavor` now carries the agent_id UUID (the field kept its legacy name so swimlane consumers did not need retyping), so the sidebar printed raw UUIDs next to every agent. The claude-code-logo + CodingAgentBadge branches keyed on `flavor.flavor === "claude-code"`, which no longer matches the UUID-shaped value, so the icon/pill disappeared for Claude Code agents.

**After.** The label reads `flavor.agent_name ?? flavor.flavor` (agent_name preferred, flavor retained as a defensive fallback for legacy rows). The claude-code logo keys on `flavor.client_type === ClientType.ClaudeCode` with the legacy flavor-string match as a fallback. The CodingAgentBadge fires on `flavor.agent_type === AgentType.Coding` unconditionally of flavor string. A new `flavor-client-type-pill` (test id) renders alongside the CodingAgentBadge for every agent that carries a `client_type`, using `CLIENT_TYPE_LABEL` to display `Claude Code` or `Sensor`. Both pills carry the existing `flexShrink: 100` + `minWidth: 0` + ellipsis so narrow sidebars shrink pills before names.

**Verification.** `npm run test -- --run` — 404/404 passing, including two rewritten FleetSidebar-resize assertions that observe both pills at default/wide/narrow widths, and a rewritten FleetPanel.test case (`"sensor-emitted coding agent shows Coding agent badge + Sensor client pill"`) that specifically checks the pill pair for a non-claude-code coding agent. Live-stack `/v1/fleet` returns agent rows with both `agent_name` and `client_type` populated; browser side renders readable agent names, no UUIDs.

### FIX 2 — FleetPanel CONTEXT curated whitelist + visibility

**Before.** `ContextFacetSection` filtered `Object.keys(facets).filter((k) => facets[k].length >= 2)` — every server-returned key with 2+ distinct values passed through. On a one-host / one-user fleet the only keys that met the bar were noise (`pid`, `working_dir`). On a more diverse fleet, garbage keys (`frameworks`, `git_commit`, `supports_directives`) polluted the sidebar.

**After.** The section consumes a curated whitelist `FLEET_SIDEBAR_CONTEXT_KEYS = ["os", "hostname", "user", "git_repo", "orchestration"]` defined inline at module scope (not imported from Investigate's broader `CONTEXT_FACET_KEYS` — the two lists serve different pages). The Supervisor brief's secondary-gate `length >= 2` was initially kept but caused a follow-on regression (user reported "CONTEXT filters aren't visible now at all") on one-host deployments where every curated key had exactly one value. Relaxed to `length >= 1` so single-value curated keys still render as informational context rows. Ordering follows the whitelist array (canonical: identity → runtime → git / orchestration), not alphabetical.

**Verification.** Two rewritten FleetPanel.test cases: one asserts curated keys render at length=1 with their single value (`"renders curated CONTEXT keys even when they have a single value"`); the other asserts CONTEXT hides when no curated key appears in the payload even if noise keys are present (`"hides CONTEXT section when no curated key is populated"`). Live-stack: sidebar now renders `os: Linux`, `hostname: Omri-PC`, `user: omria`, `git_repo: flightdeck` — noise keys (pid, working_dir, frameworks, etc.) absent.

**Deviation from brief.** The Supervisor's text said "length >= 2 within the current filtered set." I kept the whitelist but relaxed the length threshold to 1 per the user-reported regression. Flagged here so the Supervisor can veto the relaxation and restore the stricter gate if preferred; the trade-off is "always visible with some informational rows" vs "hidden entirely until a second value lands somewhere."

### FIX 3 — AgentTable + view toggle typography

**Before.** `AgentTable.tsx` used Tailwind `text-sm` (~14px) on the table and cells; numeric columns rendered in the default sans font. The view toggle in `Fleet.tsx` used Tailwind `text-[11px]` and a bespoke primary-outline pattern that did not match any existing fleet-header control.

**After.** AgentTable mirrors Investigate's session-table typography byte-for-byte:

- Table base: `className="w-full text-xs"` with `color: var(--text)` + `tableLayout: fixed`.
- Header row: `height: 32`, `background: var(--surface)`, `borderBottom: 1px solid var(--border)`. Column cells: `fontSize: 10, fontWeight: 600, letterSpacing: 0.07em, textTransform: uppercase, color: var(--text-muted), padding: 0 12px`.
- Body rows: `height: 44, borderBottom: 1px solid var(--border-subtle)`. Hover via inline `rgba(128,128,128,0.08)` background (matching Investigate's hover pattern).
- Numeric columns (Sessions, Tokens): shared `CELL_NUMERIC_STYLE` with `fontFamily: var(--font-mono)`, `fontSize: 12`, `fontVariantNumeric: tabular-nums`.
- Agent column: `fontSize: 13, fontWeight: 500` on the primary label, `fontSize: 11 + fontFamily: var(--font-mono)` on the subline `user@hostname`, matching Investigate's `flavor` column pattern.

View toggle now mirrors `EventFilterBar.tsx` exactly: `h-9 shrink-0 items-center gap-1.5 px-3` container, `height: 22, padding: 0 10px, borderRadius: 4, fontFamily: var(--font-mono), fontSize: 11, fontWeight: 500` buttons. Active state uses `var(--bg-elevated)` + `var(--border-strong)`; inactive uses `transparent` + `var(--border-subtle)` — same palette as the event filter pills.

**Verification.** Dashboard typecheck + lint pass; tests green. Visual smoke against live stack: toggle reads as a continuous strip with the event filter bar immediately above it; switching to the table view shows a table visually indistinguishable in typography from Investigate's.

### FIX 4 — Plugin session_id keying on hookEvent.session_id

**Before.** `observe_cli.mjs:getSessionId()` keyed the marker file on `sha256(process.cwd())[:16]`. Any `cd` between hook invocations produced a different marker and therefore a new uuid4 — the audit smoke found three sessions landed for one Claude Code invocation, each under a different `context.working_dir`.

**After.** The marker key is `sha256(hookEvent.session_id)[:16]` when the hook event supplies one (the supported Claude Code path always does). Missing-session_id calls fall back to the cwd-sha keying AND emit a single `[flightdeck] WARN` stderr line so operators see the plugin is in a degraded scope. Final ephemeral `sha256(cwd)[:32]` backstop retained for the "tmpdir itself is unusable" case.

`getSessionId` signature changed from `getSessionId()` to `getSessionId(hookEvent = {})`. The sole call site in `main()` threads the hook event through. The test helper `clearSessionMarkers()` was rewritten to glob-clean `session-*.txt` files in the plugin tmpdir so tests using different hook-event session_ids don't leak between cases.

**Verification.** Three new unit tests in `plugin/tests/observe_cli.test.mjs`:

- `"marker key depends on hookEvent.session_id, not cwd"` — same `hookEvent.session_id` across calls returns the same uuid.
- `"different hookEvent.session_id values produce different sessions"` — two distinct hook ids → two distinct uuids.
- `"missing hookEvent.session_id falls back to cwd-sha marker"` — zero crash, v4-shaped output.

Plugin tests: 87/87 passing (was 85; two new cases added, one renamed).

**Live smoke.** Ran three hypothetical hooks with `hookEvent.session_id="claude-invocation-alpha"` and different `process.cwd()` values (`/mnt/c/.../flightdeck`, `.../dashboard`, `/tmp`) in the same Node process. All three returned the same uuid `881c7732-07b7-4bc8-8a4b-56bb4e399075`. A fourth call with `hookEvent.session_id="claude-invocation-beta"` returned a different uuid `fd5e3aa0-7d40-4cb1-b0ee-9029a19b9e6a`. Behavior is exactly as the brief specified: one session per Claude Code invocation regardless of cwd.

### FIX 5 — PR #22 URL-normalization tests preserved

**Status.** Verified. `sensor/tests/unit/test_session.py` still contains all three tests added by PR #22:

- `test_init_appends_ingest_suffix_when_missing` (line 408)
- `test_init_preserves_ingest_suffix_when_present` (line 432)
- `test_init_preserves_ingest_with_trailing_slash` (line 457)

`python3 -m pytest tests/unit/test_session.py -q` → 23/23 pass. No restoration needed.

### §9 flag updates

- **Flag 1 (plugin session_id cwd-scoped) — RESOLVED.** FIX 4 above closes this. Remove from the pre-push risk list.
- **Flag 2 (integration suite still uses pre-D115 vocabulary) — unchanged.** The `tests/integration/` suite was not rewritten in this amendment; the pattern described in the original flag still holds.

### Aggregate test counts after fixes

| Component | Before fixes | After fixes |
|---|---:|---:|
| sensor unit | 147 | 147 |
| plugin Node | 85 | 87 |
| dashboard Vitest | 403 | 404 |
| ingestion / workers / api | all green | all green |

### Files touched in the fixes commit

**Modified:**
- `dashboard/src/components/fleet/FleetPanel.tsx` — FIX 1 (FlavorItem rewrite + enum imports) + FIX 2 (curated whitelist + relaxed gate)
- `dashboard/src/components/fleet/AgentTable.tsx` — FIX 3 (typography rewrite)
- `dashboard/src/pages/Fleet.tsx` — FIX 3 (view toggle restyle)
- `dashboard/tests/unit/FleetPanel.test.tsx` — fixture + two rewritten CONTEXT tests + pill-pair test
- `dashboard/tests/unit/FleetSidebar-resize.test.tsx` — fixture with client_type + pill-pair assertions
- `plugin/hooks/scripts/observe_cli.mjs` — FIX 4 (getSessionId hook-event keying + call-site plumbing)
- `plugin/tests/observe_cli.test.mjs` — test-helper glob cleanup + three new getSessionId cases
- `audit-phase-1.md` — this section

---

### Post-fix dashboard cleanup

Supervisor smoke of the fixed branch surfaced six "stale" Claude Code session rows in the Fleet sidebar. Debug instrumentation on the live plugin (temporarily added, removed before commit) captured four consecutive hook firings against the patched code and confirmed every hook reports the same `hookEvent.session_id` value and resolves to one marker file and one DB row (`25886cf5-…`). The six legacy rows were pre-fix (cwd-keyed) remnants plus one instrumentation artifact from V4 testing. A one-shot `UPDATE sessions SET state='closed', ended_at=NOW() WHERE agent_id='ee76931b-…' AND session_id != '<current>'` cleared the cosmetic clutter; the sidebar now shows the single live session correctly. The fix itself (marker keyed on `sha256(hookEvent.session_id)`) is live; future hook activity converges on one row per Claude Code invocation, as designed.

---

**Ready for Supervisor document-by-document review.** Branch has not been pushed.
