# Changelog

All notable changes to Flightdeck are documented here.

## Unreleased — Per-agent landing page + UI reshape

Backend foundations and Fleet view reshape for the per-agent
landing page (D157).

### Added

- **`/agents` route — one-row-per-agent table.** SentinelOne-grade
  list with KPI sparklines (Tokens / Latency p95 / Errors / Sessions
  / Cost, all 7-day totals + day-bucketed sparklines over the
  trailing 7 days, sourced from `GET /v1/agents/:id/summary`). Filter
  chips compose AND across dimensions and OR within: `state`,
  `agent_type`, `client_type`, `framework`. Sortable column headers (the
  numeric column totals are the sort key; the sparkline tiles are
  visual). Pagination defaults to page size 50. Per-row hover
  surfaces **Open mini-swimlane** and **Open in events** quick
  actions. `?focus=<agent_id>` URL param scrolls the targeted
  row into view and applies a subtle highlight for a few seconds.
  Per-agent KPI values are cached on first load and updated in
  place from live activity, so the table never fully re-renders
  when an event arrives.
- **Per-agent swimlane modal.** Clicking the status badge on any
  `/agents` row opens a large modal dialog containing
  a single-agent swimlane scoped to that agent's flavor only.
  Header carries agent name + topology pill + status badge + KPI
  totals summary. Time-range picker (5m / 15m / 30m / 1h / 24h,
  defaults to 1h) affects the modal's events only — the `/agents`
  table sparklines remain fixed at 7d/day. **Show sub-agents**
  toggle defaults ON for parents and is disabled + off for lone
  agents; when ON, the modal renders the parent row plus every
  sub-agent row with the connector overlay linking each parent to
  its sub-agents. Clicking an event circle inside the modal opens
  the event detail panel stacked above the modal without closing it.
  Closing the modal preserves the `/agents` table's scroll position.
- **Agents nav link.** Added between Fleet and Events in the top
  nav.
- **Fleet swimlane label → `/agents?focus=…`.** Clicking the agent
  name in the swimlane's left strip navigates to the `/agents`
  page with the row pre-scrolled and highlighted.
- **`AgentSummary.recent_sessions` on `GET /v1/fleet`.** Each
  agent row carries a per-agent rollup of its most-recent sessions
  (capped at 5 per agent, newest-first by `started_at`, with
  `session_id` ascending as a deterministic tie-breaker). Fetched
  in a single batched query per fleet page; lean projection
  (identity + lifecycle + `framework` attribution + sub-agent
  linkage; no enrichment columns). The `framework` field
  (bare-name `sessions.framework`) backs the `/agents` page
  framework filter chips. The Fleet swimlane prefers this embedded
  rollup over the paginated `/v1/sessions` intersection, so an
  agent's row renders event circles regardless of where its
  sessions fall in the global sessions page window.
- **`/v1/analytics?filter_agent_id=<uuid>`.** Scopes any analytics
  metric (including the four sub-agent-aware metrics) to events
  from sessions owned by a single agent. UUID validated at the
  handler boundary; composes with the other `filter_*` params via
  AND.
- **`GET /v1/agents/{id}/summary`.** Per-agent activity summary
  over a 1h / 24h / 7d / 30d window. Returns totals (tokens,
  errors, sessions, cost_usd, latency_p50_ms, latency_p95_ms)
  and a per-bucket series. Errors count `event_type='llm_error'`
  only; latency percentiles use `event_type='post_call'`,
  matching the analytics endpoint convention. Default bucket
  derived from period (1h/24h → hour, 7d/30d → day).
- **Run boundary glyphs on the swimlane.** Each agent row
  carries per-run glyphs at the start X and end X: a filled
  play-button triangle (▶) at the start and a filled solid
  square (■) at the end. The square is sized at ~1.3× the
  triangle's bbox area so the closure reads heavier than
  the opening — operators scan rows for the square to find
  where a run actually closed. Hover on either glyph
  surfaces a tooltip with `run_id` + start + end (or
  `running`) + state + total tokens. Click on either glyph
  opens the session drawer scoped to that run. Concurrent
  runs of the same agent render glyph pairs on offset
  anchors (top edge / bottom edge); active / idle / stale
  / lost runs render only the start triangle — absence of
  the end square communicates "still running."
- **Agent status badge on swimlane rows.** At the right edge of
  each swimlane row's label strip, a badge renders the agent's
  rolled-up state (the highest-priority state across the agent's
  runs), with a pulsing dot when the state is `active`.
  Theme-agnostic.
- **`GET /v1/sessions?include_parents=true`.** Opt-in flag that
  augments the response with the parent session of every child
  session in the page, even when the parent falls outside the
  time-range filter or the `LIMIT` window. The Fleet swimlane
  opts in so a sub-agent whose parent fell off the 100-row page
  still resolves topology in the front-end relationship walk;
  the Events page omits the flag so its pagination math stays
  exact.
  `total` continues to count only filtered rows; `sessions[]`
  may exceed `total` when parents ride along.

### Changed

- **Swimlane reshape: one row per agent.** Events from every one
  of an agent's runs stream onto a single timeline row. Sub-agent
  rows continue to render indented beneath their parent via
  `data-topology="child"` and `SubAgentConnector.tsx` Bezier
  paths from each parent spawn event to its child's first event.
- **Agent label strip ordering.** Left-to-right inside each
  swimlane row's left panel: optional `ClaudeCodeLogo` (when
  `client_type === "claude-code"`) → agent name →
  `ClientTypePill` → agent_type badge → provider icon → OS
  icon → orchestration icon → `RelationshipPill` (lone /
  ↳ parent / ⤴ N) → optional `SubAgentLostDot` →
  `AgentStatusBadge`. The provider / OS / orchestration icons
  derive from the agent's most-recent session; per-event
  provider logos on the event circles carry the granular
  per-call attribution.
- **Vocabulary rename (Session → Run) in dashboard chrome + docs.**
  Operator-facing strings ("Total Sessions" → "Total Runs",
  "Session States" → "Run States", "No sessions found" → "No
  runs found", etc.) updated across the dashboard, README, and
  sensor docstring prose. Wire-level identifiers (DB columns,
  event_type literals, the `session_id` kwarg, URL query params,
  type discriminants) are unchanged.
- **Route rename `/investigate` → `/events`.** The Vite router
  mounts the Investigate page component at `/events`; the
  nginx edge (dev + prod) serves a permanent 301 from
  `/investigate` preserving the query string. Internal links
  and the `/v1/agents` row navigation updated.

### Removed

- **`?view=table` Fleet view toggle + `AgentTable.tsx`.** Fleet
  renders the swimlane unconditionally. `TopologyCell` was
  extracted to `dashboard/src/components/fleet/TopologyCell.tsx`
  before the container deletion so future agent-listing surfaces
  can consume it.
- **Swimlane expand-row affordance.** The chevron-toggled
  expanded session-list drawer, its "Show older runs" pagination
  affordance, and the "View in Events →" deep-link are gone. The
  related fleet-store actions (`loadExpandedSessions`,
  `loadMoreExpandedSessions`) are removed. The full per-agent
  history surface returns in the upcoming agent drawer.

### Fixed

- **Sub-agent rows now materialise + render event circles +
  anchor connector overlays at default viewport.** The keep-alive
  watchdog forward-dated session-level timestamps but never bumped
  the AGENT row's `last_seen_at` (the worker stamps it on
  session_start only; subsequent tool_call events skip it). Result
  pre-fix: the agent's row sank into a "stale" bucket, the
  IntersectionObserver virtualized it off-screen at default
  viewport, the swimlane row never mounted, event circles never
  rendered, and the connector overlay reported
  `data-connector-count="0"` with zero paths even though the
  fixture's session was present in the API. The watchdog now
  bumps `agents.last_seen_at` whenever it forward-dates an
  active-role session.
- **Sub-agent rows on busy fleets no longer render as `lone`.**
  Deployments with more than ~20 active agents could push a
  sub-agent's parent off the 100-row swimlane fetch window;
  `deriveRelationship` then failed and the sub-agent stamped
  as topology="lone" instead of indented under its parent.
  The new `include_parents=true` flag on `GET /v1/sessions`
  pulls those parents back into the response so the front-end
  resolver finds them.
- **`SubAgentLostDot` stickiness.** A sub-agent that ran lost
  once and then recovered via state-revival kept the red `i`
  dot lit because the SwimLane scan looked for any historical
  lost session. The dot now fires only when the MOST RECENT
  session for a given sub-agent role is in `lost` state; an
  old lost run followed by a healthy retry leaves the dot off.
- **Sub-agent connector geometry anchors on first in-domain
  event.** `Timeline.tsx`'s connector pass previously picked
  `childEvents[0]` (the child's absolute first event) as the
  spawn anchor, then checked whether that timestamp fell inside
  the visible domain. Long-running child sessions whose
  `session_start` is at an old timestamp but which have fresh
  `tool_call` events from the keep-alive watchdog at NOW-30s
  failed that domain check and the connector skipped the pair —
  even though the child had visible event circles inside the
  window. The pass now picks the child's first event INSIDE the
  domain as the anchor, matching the swimlane's visible state.
- **Idempotent seed treats sessions missing `session_start` as
  incomplete.** `tests/e2e-fixtures/seed.py::_session_is_complete`
  previously gated only on event count + `phase4_extras`
  coverage. A session whose keep-alive extras
  (`mcp_tool_list` / `mcp_tool_call` / ...) survived a dev DB
  wipe but whose original `session_start` was gone would pass
  the completeness check and never re-emit `session_start`. The
  worker's lazy-create path stamped `context = NULL`, breaking
  the dashboard's MCP SERVERS panel for the `mcp-active`
  fixture. The check now also requires a `session_start` event
  in the events list; a session without one re-emits its full
  base sequence including the authoritative `context.mcp_servers`
  fingerprint.

## Unreleased — MCP Protection Policy + operator-actionable enrichment

Per-flavor enforcement of which MCP servers an agent is allowed to
talk to (D127–D132, D134–D147), plus operator-actionable enrichment
for every event family (D148–D154) and lifecycle correctness fixes
(plugin SessionEnd cache invalidation; worker `orphan_timeout`
reaper completing the close_reason vocabulary). Rides on the
existing `ClientSession` patch surface (D117) and the standard
event pipeline. v0.6 enforces policy decisions as configured
(block raises, warn passes through). See
**D127–D132, D134–D154**.

### Added

- **Identity model.** Server identity is `(URL, name)`. URL is the
  security key; name is display + tamper-evidence. HTTP and stdio
  canonical forms locked. Fingerprint = sha256(canonical_url +
  0x00 + name); first 16 hex chars displayed (D127).
- **Two-scope policy model.** One global policy + zero or more
  per-flavor policies. Global carries the mode (allowlist or
  blocklist); per-flavor carries allow / deny entry deltas.
  Auto-created empty blocklist global on install — fully
  permissive by default (D134).
- **Per-server resolution.** Most-specific scope wins: flavor
  entry → global entry → global-mode default. Three-step
  deterministic algorithm (D135).
- **Storage schema (binding contract for migrations 000018 + 000019 + 000020).**
  Three live tables: `mcp_policies` (live state, with empty-
  blocklist global row seeded at install), `mcp_policy_entries`
  (live entries), `mcp_policy_audit_log` (operator-initiated
  mutations only — actor + diff). Schema documented in
  ARCHITECTURE.md "MCP Protection Policy" → "Storage schema"
  with binding-contract note (D128, D141, D142).
- **Fetch + cache contract.** Sensor fetches at `init()` and
  caches on Session for the session's lifetime; new policy
  applies at the next `session_start`. Plugin fetches at
  `SessionStart` with one-hour disk cache at
  `~/.claude/flightdeck/mcp_policy_cache.json`. Dashboard hits
  REST directly. Fail-open per Rule 28 on control-plane outage
  (D129).
- **Sensor block contract.** New typed exception
  `flightdeck.MCPPolicyBlocked`. Block path emits
  `policy_mcp_block`, flushes the event queue synchronously, then
  raises so frameworks surface the failure as a tool-call error
  (D130).
- **Three new event types.** `policy_mcp_warn`,
  `policy_mcp_block`, `mcp_server_name_changed`. The
  name-changed event is sensor-emitted observation only (NOT an
  audit-log row; the audit log records operator mutations only).
  Auto-routes through the existing `events.>` NATS catch-all
  (D131).
- **Plugin remembered decisions.** Local file at
  `~/.claude/flightdeck/remembered_mcp_decisions.json`, per-token,
  populated by Claude Code's `PermissionRequest`
  yes-and-remember. Lazy-syncs to control plane on a best-effort
  basis (D132).
- **Control-plane API surface.** Endpoints under
  `/v1/mcp-policies` for read / resolve / mutate / audit /
  metrics / templates / apply_template. Read-open / mutation-
  admin auth split per D147. Contract documented in
  ARCHITECTURE.md.
- **`helm/Makefile sync-migrations` is now a chart-render
  prerequisite.** `lint`, `template`, `install`, and `upgrade`
  targets all depend on it, so chart commands always render
  against an in-sync set of migrations. Target now `mkdir -p
  migrations/` ahead of the copy so a freshly-cloned tree (where
  the gitignored directory is absent) works on first invocation
  (D136).

### Changed

- **Migration source-of-truth refactor (D136).**
  `helm/migrations/` is no longer tracked in git; the directory
  is now a build artifact populated by `helm/Makefile
  sync-migrations` from `docker/postgres/migrations/` (the
  canonical source). Closes the "Helm migration parity backfill"
  Roadmap bullet inline. The 28 previously-committed
  `helm/migrations/*.sql` files are removed in the same commit
  that adds the `.gitignore` entry, the Makefile prerequisite
  wiring, and the migrations-configmap.yaml header documentation
  update.

### Deprecated

(none — reserved for the section)

### Decisions

- **D127** MCP server identity canonical form — URL is security
  key, name is display + tamper-evidence; HTTP / stdio canonical
  rules; sha256 hash with 0x00 separator.
- **D128** Two-scope policy storage schema — four tables
  (`mcp_policies` + entries + versions + audit log); binding
  contract for migration 000018.
- **D129** Fetch + cache contract per surface — sensor at
  `init()`, plugin at `SessionStart` with disk TTL, dashboard
  direct REST. Mid-session updates apply at next session start.
- **D130** Sensor block contract — typed
  `flightdeck.MCPPolicyBlocked` exception with synchronous flush
  before raise.
- **D131** Three new event types
  (`policy_mcp_warn` / `policy_mcp_block` /
  `mcp_server_name_changed`); name-changed is a sensor-emitted
  EventType only, not an audit-log row.
- **D132** Plugin remembered-decisions local file with lazy
  control-plane sync.
- **D133** v0.6 soft-launch warn-only default with
  `FLIGHTDECK_MCP_POLICY_DEFAULT` escape hatch.
  **(Superseded by D145 in step 6.8 cleanup — soft-launch
  override removed; v0.6 enforces as configured.)**
- **D134** Mode lives on the global policy only; per-flavor
  carries allow / deny entry deltas. Storage CHECK enforces.
- **D135** Per-server precedence: most-specific scope wins
  (flavor → global → global-mode default).
- **D136** Migration source-of-truth refactor —
  `docker/postgres/migrations/` is canonical and tracked in git;
  `helm/migrations/` is a build artifact (gitignored) populated by
  `helm/Makefile sync-migrations` wired as a prerequisite of every
  chart-render target.
- **D138** Three locked policy templates ship with the API
  (`strict-baseline`, `permissive-dev`,
  `strict-with-common-allows`); the third carries a URL-
  maintenance warning surfaced both in the YAML file header and
  in the `description` field returned by
  `GET /v1/mcp-policies/templates`.

### Added (control-plane API)

- **Control-plane endpoints under `/v1/mcp-policies/...`**
  (kebab-plural, matching the `access-tokens` convention). Read +
  resolve (3): `GET /global`, `GET /:flavor`, `GET /resolve`.
  Write (4): `POST /:flavor`, `PUT /global`, `PUT /:flavor`,
  `DELETE /:flavor`. Audit (2): `GET /:flavor/audit-log`,
  `GET /global/audit-log`. Metrics + templates (3): `GET
  /:flavor/metrics`, `GET /templates`, `POST /:flavor/apply_template`.
  Plus `GET /v1/whoami` for dashboard role detection (D147).
- **Read-open vs mutation-admin scope split per D147.** All GETs
  accept any valid bearer token; mutations require the validator's
  `IsAdmin=true` (production admin token or `tok_admin_dev` in
  dev). The dashboard reads `/v1/whoami` once at session start and
  gates mutation CTAs accordingly.
- **Install-time seed of the empty-blocklist global policy.**
  Migration `000019_mcp_protection_policy_seed_global` writes the
  empty global row at install time per D141, closing the cold-
  boot race where api beat workers to a fresh postgres and 500'd
  every `GET /global` until manual restart. The
  `store.EnsureGlobalMCPPolicy` boot hook stays as a defensive
  idempotent retry for install paths that may run api before the
  migrator.
- **Go-side identity helper at `api/internal/mcp_identity/`**
  mirrors the Python and Node primitives. All three implementations
  (Python, JS, Go) load the same `tests/fixtures/mcp_identity_vectors.json`
  and produce byte-identical fingerprints.
- **Three policy templates** (D138) embedded via `embed.FS` from
  `api/internal/handlers/mcp_policy_templates/*.yaml`. Templates
  surface via `GET /v1/mcp-policies/templates` and apply via
  `POST :flavor/apply_template` (idempotent PUT-replace, bumps
  version, audit-log entry carries `applied_template=<name>`).

### Added (sensor enforcement)

- **Sensor-side enforcement at `ClientSession.call_tool`** (D130).
  The MCP interceptor's existing call-tool wrapper consults the
  per-session policy cache; emits `POLICY_MCP_WARN` and proceeds
  on warn decisions, emits `POLICY_MCP_BLOCK` + flushes the queue
  + raises typed `flightdeck.MCPPolicyBlocked` on block decisions.
  Frameworks surface the block as a tool-call failure in the agent
  reasoning loop. Initialize-time wrapper additionally emits
  `MCP_SERVER_NAME_CHANGED` when a known canonical URL appears
  under a new declared name (D131).
- **Three new EventType enum members** — `POLICY_MCP_WARN`,
  `POLICY_MCP_BLOCK`, `MCP_SERVER_NAME_CHANGED`. NATS subjects auto-
  routed via the existing `events.>` catch-all; the worker switch
  extends to persist them through the standard pipeline (D131).
- **`MCPPolicyCache`** at `sensor/flightdeck_sensor/core/mcp_policy.py`
  — fetches the global + flavor policies at session preflight (two
  HTTP calls alongside the existing token-policy fetch), caches the
  D135 resolution algorithm's inputs in memory for the session's
  lifetime. Refresh on `policy_update` directive applies at the next
  `session_start` so in-flight sessions keep their policy regime
  (D129).
- **`init(mcp_block_on_uncertainty=True)` kwarg** — operator failsafe
  for the cache-miss + control-plane-unreachable path. When the
  policy fetch fails AND this kwarg is true, MCP tool calls block
  with `decision_path="mode_default"` so a paranoid deployment
  doesn't fall open silently. Default is `False`; operators opt in
  per agent.
### Added (ingestion + worker)

- **Ingestion payload validation** for the three new event types
  (Rule 36). Missing `fingerprint` / `server_url` / `decision_path`
  / `policy_id` on warn / block events rejects with 400 at the API
  boundary; missing `fingerprint_old` / `fingerprint_new` /
  `name_old` / `name_new` on the name-changed event rejects with
  400.
- **Worker persistence** — the existing `event.go` switch extends
  to route `policy_mcp_warn` / `policy_mcp_block` (alongside the
  pre-existing `policy_warn` / `policy_block`) and
  `mcp_server_name_changed` (alongside the pre-existing `mcp_*`
  family). InsertEvent inserts the event_type + full payload as
  before; no schema or insert-path change.

### Added (playground demos)

- **Six new Rule 40d playground demos** at `playground/18_*` through
  `playground/23_*` (numbers 16/17 are already taken by the D126
  sub-agent demos):
  - `18_mcp_policy_warn.py` — flavor deny+warn entry; POLICY_MCP_WARN
    lands; tool call proceeds.
  - `19_mcp_policy_block.py` — flavor deny+block entry;
    POLICY_MCP_BLOCK lands; MCPPolicyBlocked raised.
  - `20_mcp_policy_block_on_uncertainty.py` — invalid api_url +
    `mcp_block_on_uncertainty=True`; block fires from the local
    failsafe with `decision_path=mode_default`,
    `scope=local_failsafe`.
  - `21_mcp_policy_blocklist.py` — global blocklist + global deny
    entry; block fires via `decision_path=global_entry`. Mutates
    the global policy; restores at end.
  - `22_mcp_policy_crewai.py` — CrewAI transitive coverage via
    `mcpadapt`. Self-skips without `ANTHROPIC_API_KEY` +
    `OPENAI_API_KEY`.
  - `23_mcp_policy_langgraph.py` — LangGraph transitive coverage
    via `langchain-mcp-adapters`. Self-skips without
    `ANTHROPIC_API_KEY`.
- **New Make targets:** `playground-mcp-policy-warn`,
  `playground-mcp-policy-block`,
  `playground-mcp-policy-block-on-uncertainty`,
  `playground-mcp-policy-blocklist`,
  `playground-mcp-policy-crewai`,
  `playground-mcp-policy-langgraph`. Each follows Rule 40a.A
  (meaningful flavor + agent_type) and 40a.B (capture_prompts=True).

### Added (plugin enforcement)

- **Plugin SessionStart MCP policy fetch + cache (D139).** The
  Claude Code plugin's `observe_cli.mjs` dispatcher branches on
  `SessionStart` to read `.mcp.json`, fingerprint each declared
  server via the step-2 identity primitive, and batch-fetch
  global + flavor policies in parallel via
  `GET /v1/mcp-policies/global` + `GET /v1/mcp-policies/{flavor}`.
  Decisions cache to `$TMPDIR/flightdeck-plugin/mcp-policy-<session_id>.json`
  for the session's lifetime. Non-`allow` decisions emit
  `policy_mcp_warn` / `policy_mcp_block` events at session boot
  for fleet visibility. Fail-open per Rule 28.
- **Plugin PreToolUse per-call gate.** `mcp__<server>__<tool>`
  calls hit the cached policy + the remembered-decisions file
  (read fresh per invocation so concurrent Claude Code sessions
  see each other's approvals in real time). The hook returns
  `{decision: "deny", reason: "..."}` for block, `{decision:
  "ask"}` for unknown-allowlist + interactive (Claude Code's
  built-in yes/no prompt), and proceeds normally for allow /
  warn / remembered-allow.
- **Plugin PostToolUse reactive de-facto-approval write (D139).**
  When an `mcp__<server>__<tool>` call succeeds AND the server
  was unknown-allowlist on this session AND no remembered
  decision exists yet for the active token: the plugin writes
  `~/.claude/flightdeck/remembered_mcp_decisions-<tokenPrefix>.json`
  AND emits `mcp_policy_user_remembered` event. The reactive
  flow is the closest functional equivalent given Claude Code's
  built-in `ask` returns yes/no only with no built-in "remember"
  affordance — documented in D139's body.
- **New event type `mcp_policy_user_remembered`** — emitted by
  the plugin (not the sensor) directly via the standard
  ingestion HTTP POST path. Ingestion validates required fields
  at the API boundary; workers project the payload onto
  `events.payload` via the existing BuildEventExtra path.
- **Two new plugin helper modules:**
  `plugin/hooks/scripts/mcp_policy.mjs` (fetch + evaluate +
  per-session cache) and
  `plugin/hooks/scripts/remembered_decisions.mjs` (per-token
  local cache with atomic temp-file + rename writes). Both ship
  zero npm dependencies — only `node:crypto`, `node:fs`,
  `node:path`, the `URL` global, and `process.env`. Imports the
  step-2 `mcp_identity.mjs` primitive for the cross-language
  fingerprint contract.
- **`Stop` hook cleanup** of the per-session policy marker file
  so `$TMPDIR/flightdeck-plugin/mcp-policy-*.json` doesn't grow
  unbounded.

### Decisions

- **D139** Plugin yes-and-remember semantics: local cache + emit
  `mcp_policy_user_remembered` event. No policy mutation. Reactive
  PreToolUse-`ask` + PostToolUse-de-facto-approval flow given
  Claude Code's `ask` is yes/no only.

### Added (dashboard surfaces)

- **MCP Protection sub-tab on the unified `/policies` page**
  (D146). Token Budget is the other sub-tab; Token Budget is the
  default on visit. `?policy=mcp` deep-links to MCP Protection.
  Within the sub-tab: shadcn `<Select>` scope picker (Global +
  per-flavor) with URL-synced active scope. Mode toggle editable
  on Global only (D134); BOU toggle editable per-scope.
- **Entry table** with search / sort / multi-select / status
  pills. Skeleton-row loaders, teaching empty-state copy
  ("Add your first allow rule to start gating this flavor").
  Empty-state quick-start link: when `entries.length === 0` AND
  no template applied this session, "Quick start: apply a
  template →" opens a dropdown of the three templates with
  one-line descriptions; apply hides the link for the rest of
  the session.
- **Add / edit dialog** with debounced (300ms) live fingerprint
  preview via `GET /v1/mcp-policies/resolve`. Three identity
  implementations remain locked (Python / Node mjs / Go); the
  dashboard reuses the server-side canonicalisation rather than
  introducing a fourth TypeScript port (Step 6 plan amendment 2).
- **Resolve preview panel** (collapsible). Renders decision +
  decision_path + scope + fingerprint.
- **Audit trail panel.** Paginated table with event_type / actor
  / date filters; expandable per-row payload JSON.
- **Tooltips lifted verbatim** from ARCHITECTURE.md sub-sections
  (identity model, mode semantics).
- **Adjacent surfaces extensions:**
  - Fleet sidebar `PolicyEvents` panel renders the four new
    MCP-policy event types with a chroma hierarchy that
    separates enforcement from FYI: amber (warn), red (block),
    purple/info (name_changed, user_remembered). No themes.css
    edit; reuses existing CSS variables (Step 6 plan
    amendment 1).
  - Investigate event-type chip picker carries dedicated chips
    for the four MCP-policy event types under their own
    collapsible "MCP POLICY" facet group. No new analytics
    dimension (Rule 25 lock).
  - SessionDrawer `MCPServersPanel` rows render the policy
    decision as inline coloured text next to the server name
    (`[server-name] · ALLOW` / `WARN` / `BLOCK` /
    `BLOCK (default)`) using the existing chroma family. The
    pill design tried twice in step 6.7 is dropped — inline
    text passes the 1-second-glance bar where the pill
    didn't.
- **New shadcn/ui Tabs primitive** at `components/ui/tabs.tsx`
  wrapping the `@radix-ui/react-tabs` dependency. Reused for
  the unified `/policies` page sub-tabs (D146).

### Changed (step 6.5)

- **Metrics endpoint time-series.** `GET /v1/mcp-policies/:flavor/metrics`
  now returns `granularity` ("hour" for `period=24h`, "day" for
  `period=7d` / `30d`) and a zero-filled `buckets` array
  alongside the existing per-server aggregates. The dashboard
  metrics panel switches from a stacked horizontal bar to a
  Recharts `LineChart` — one line per server, summed
  block + warn per bucket — with the per-server warn / block
  split rendered as a small table beneath the sparklines.
  Zero-fill via SQL `generate_series` so empty buckets ship
  through with empty `Blocks` / `Warns` arrays — sparse data
  on a security dashboard would render 3 days of nothing
  followed by a spike as a gradual ramp, which misleads.
  Pre-step-6.5 callers that read `blocks_per_server` /
  `warns_per_server` continue working unchanged.

### Added (step 6.5 playground demos)

- **`24_mcp_policy_langchain.py`** — explicit-LangChain MCP
  policy demo via `langchain-mcp-adapters`. Three back-to-back
  scenarios (warn + block + allow) with policy events asserted
  per scenario. Fills the Rule 40d coverage gap LangGraph
  (demo 23) covers transitively but not for the explicit
  LangChain `AgentExecutor` + `create_tool_calling_agent`
  invocation pattern.
- **`25_mcp_policy_llamaindex.py`** — LlamaIndex MCP policy
  demo via `llama-index-tools-mcp` (a different adapter
  package than `langchain-mcp-adapters` — independent drift
  surface). Same warn / block / allow shape. Carries an
  inline note about lazy-importing `BasicMCPClient` /
  `McpToolSpec` after `flightdeck_sensor.patch()` runs;
  llama-index's module-import time captures `stdio_client`
  before the patch otherwise.
- **`langchain>=0.3,<1`** added to sensor dev extras (was
  missing the umbrella package — only the
  `langchain-anthropic` / `langchain-openai` /
  `langchain-mcp-adapters` siblings were listed).
- **New `flightdeck_sensor.compat.crewai_mcp` module** with
  `crewai_mcp_schema_fixup()` helper. Strips
  JSON-Schema-2020-12-invalid keys from CrewAI tools'
  `args_schema` serialisation (empty `anyOf`, null `enum` /
  `items`, empty `properties` paired with empty `anyOf`) and
  infers a missing `type` from the property's default value
  when the empty `anyOf` was the previous type carrier. Mutates
  each tool's `args_schema` Pydantic class so every downstream
  consumer (CrewAI's `generate_model_description`, the LLM
  provider's tool-conversion path, raw `model_json_schema()`
  calls) sees the cleaned schema. Idempotent. Workaround for an
  upstream mcpadapt schema-generation bug; see README "Known
  framework constraints" for the operator-facing explanation
  and the Roadmap for the removal checkbox.

### Added (step 6.6 — live MCP server population + UI polish)

- **`mcp_server_attached` event type (D140).** Sensor emits
  whenever an MCP server is initialised after `session_start`,
  carrying the full fingerprint (URL canonical, name, transport,
  protocol version, version, capabilities, instructions,
  attached_at). Worker projects into `sessions.context.mcp_servers`
  via idempotent UPSERT-with-dedup keyed on `(name, server_url)`
  — no `context.mcp_servers` schema change. Closes the gap where
  the SessionDrawer's MCP SERVERS panel rendered empty for live
  in-flight sessions whose MCP servers attached after
  `session_start` (the common case for `mcpadapt`-style agents).
  Fail-open per Rule 27.
- **Live SessionDrawer re-fetch via fleet WebSocket.**
  `useFleetStore` gains a `lastEvent` field; SessionDrawer bumps
  a `revalidationKey` when an `mcp_server_attached` event arrives
  on the matching session, and `useSession` re-fetches the
  session detail. MCP SERVERS panel populates within 2-3s of an
  attach.
- **Dedicated MCP POLICY facet on Investigate.** The four
  MCP-policy event types (`policy_mcp_warn`, `policy_mcp_block`,
  `mcp_server_name_changed`, `mcp_policy_user_remembered`) split
  out of the generic POLICY facet into their own collapsible
  filter group so operators can isolate MCP-policy traffic
  without filtering it out of every other policy view.
- **Rule 40c.4 in CLAUDE.md.** Codifies the live-load Chrome
  verification pattern as a hard rule for every dashboard step.
  Mocks-passing is necessary but insufficient; surfaces must be
  opened in real Chrome against branch HEAD with the
  build SHA logged in the verification report.

### Changed (step 6.6 — MCP Policies UX polish)

- **Tab overflow.** ``Tabs`` replaced by a shadcn ``Select``
  scope picker with an "Editing scope" label and a
  ``N flavor(s) + Global`` / ``Global only — no flavor activity
  yet`` context note. Scales linearly with flavor count rather
  than horizontal-scrolling at 6+ flavors.
- **Mode toggle prominence.** ``MCPPolicyHeader`` rebuilt as two
  stacked sections — "Policy mode" header + segmented control
  + Allow-list / Block-list descriptive copy, plus a separate
  "Block on uncertainty" sub-section that's hidden entirely
  under blocklist mode (D134 only-meaningful-in-allowlist;
  hide-rather-than-grey precedent: Salesforce / Atlassian /
  Linear). Server-side BOU value persists across mode flips.
- **Form validation timing.** Entry dialog defers the red
  "URL is required" list until the operator's first submit
  attempt — opening the dialog with empty fields no longer reads
  as "the form is broken before I've typed anything".
- **Admin-token error CTAs (9 sites).** Every "Admin token
  required" error funnels through a single
  ``adminTokenError(action)`` helper in ``lib/api.ts`` that
  appends actionable localStorage instructions:
  "Set the flightdeck-access-token localStorage key in this
  browser to an admin-scoped token (DevTools → Application →
  Local Storage), then reload."
- **Audit pager hide-on-empty.** Pager skips render on the
  first-page empty state — no more "0–0 on this page" with
  greyed-out Prev/Next next to an empty card.
- **Audit empty-state hint.** "No audit log entries yet." gets
  a second muted line: "Adding an entry, changing the mode, or
  importing YAML creates an entry here."
- **Active scope styling.** Scope-picker SelectTrigger gets an
  accent left-border + font-semibold so the scope being edited
  reads as the page's primary context, not just a dropdown
  control.

### Removed (step 6.8 cleanup)

- **Version history feature (D142).** Per-PUT snapshot table
  ``mcp_policy_versions`` and the version-bump column on
  ``mcp_policies`` retire (migration 000020). Three control-plane
  endpoints removed: ``GET /:flavor/versions``,
  ``GET /:flavor/versions/:version_id``, ``GET /:flavor/diff``.
  Dashboard removes the version-list panel and diff viewer. The
  audit log carries the modification trail; reintroduction is on
  the README Roadmap.
- **Dry-run preview feature (D143).** ``POST /:flavor/dry_run``
  endpoint, store method, and the dashboard Recharts stacked-bar
  preview retire. The replay-via-``sessions.context.mcp_servers``
  binding strategy (D137) had structural unresolvable-count
  limits that didn't justify the implementation surface for v0.6.
  Operators iterate via add-entry → observe live events.
  Reintroduction on the Roadmap.
- **YAML import / export (D144).** Two endpoints removed:
  ``POST /:flavor/import``, ``GET /:flavor/export``. Dashboard
  textarea editor removed. The templates endpoints
  (``/templates``, ``/apply_template``) stay — those are server-
  owned YAML and have small surface area. Reintroduction on the
  Roadmap.
- **Soft-launch banner + override behavior (D145, supersedes
  D133).** Sensor ``apply_soft_launch`` removed; ``policy_mcp_block``
  decisions emit ``policy_mcp_block`` and raise ``MCPPolicyBlocked``
  per D130. ``FLIGHTDECK_MCP_POLICY_DEFAULT`` env var removed.
  ``would_have_blocked`` payload field removed everywhere it
  threaded (event-payload type, ingestion validation, dashboard
  renderers, swagger, tests). Dashboard ``MCPSoftLaunchBanner``
  + ``SOFT_LAUNCH_ACTIVE`` constant removed. Pre-v0.6 has no
  users to protect against blast-radius; v0.6 enforces as
  configured.
- **Metrics panel from MCP Policies management surface.** The
  ``GET /:flavor/metrics`` endpoint and store method STAY (read-
  open per D147; analytics or future surfaces may consume); only
  the dashboard panel on the policy management screen is removed.
- **Templates as primary picker.** The 3-card grid on the policy
  management page is removed. The ``/templates`` and
  ``/apply_template`` endpoints stay. Templates surface as a
  single "Quick start: apply a template →" link in the empty
  state when ``entries.length === 0`` AND no template applied
  this session.
- **`/mcp-policies` route (D146).** Hard 404; no redirect. Pre-
  v0.6 has no users with bookmarks to break.

### Changed (step 6.8 cleanup)

- **Unified `/policies` page (D146).** Token Budget and MCP
  Protection live as sub-tabs under one route. Default tab Token
  Budget; ``?policy=mcp`` deep-links MCP Protection. The shadcn
  ``<Tabs>`` primitive added in step 6/6.5 powers the sub-tabs.
- **Read-open / mutation-admin auth split (D147).** All MCP
  policy GETs accept any authenticated bearer token; mutations
  require the validator's ``IsAdmin=true``. The previously
  aspirational "read-only vs admin-grade" designation becomes
  real — a new ``adminGate()`` middleware wraps mutations and
  returns 403 for ``IsAdmin=false`` tokens.
- **Mode toggle visual treatment.** Active option carries a
  solid background fill (var(--primary)) with white text and a
  subtle shadow; inactive options are transparent background +
  muted text. 150ms ease-out transition on background-color and
  color, no layout reflow on click. Keyboard arrow keys move
  active state. Replaces the prior text-color-only segmented-
  control.
- **MCP server policy decision rendering (SessionDrawer).** The
  pill drops in favour of inline coloured text next to the
  server name: ``[server-name] · ALLOW`` / ``WARN`` / ``BLOCK``
  / ``BLOCK (default)``. Same chroma family as before; mode-
  default rendered with reduced opacity + italic. The pill
  design failed the 1-second-glance bar in two iterations.
- **Audit transaction simplification.** Mutation transactions
  drop the version-bump and snapshot-write steps (D142).
  Five-step transaction: SELECT FOR UPDATE → UPDATE policy →
  DELETE entries → INSERT new entries → INSERT audit-log entry.

### Added (step 6.8 cleanup)

- **`GET /v1/whoami`** (D147). Returns ``{role: "admin"|"viewer",
  token_id}`` for the authenticated bearer. The dashboard calls
  this once at session start (App.tsx / auth context bootstrap),
  stores the role, and components that render mutation buttons
  gate on ``role === "admin"``. Read-open scope.
- **Viewer-mode dashboard treatment.** Mode toggle: disabled +
  tooltip ("Read-only — admin token required to change mode").
  Add Entry / row edit/delete / template apply: hidden entirely.
  The previous "Admin token required" inline error wall is gone
  because reads are open now.

### Decisions (step 6.8 cleanup)

- **D142** Drop MCP policy version history; audit log is the
  durable primitive. Migration 000020 drops the
  ``mcp_policy_versions`` table and the ``version`` column.
- **D143** Drop dry-run preview from v0.6.
- **D144** Drop YAML import/export from v0.6; UI is the canonical
  edit path. Templates endpoints stay.
- **D145** Drop soft-launch banner + override behavior.
  Supersedes D133.
- **D146** Unified ``/policies`` page (Token Budget + MCP
  Protection sub-tabs). Hard 404 on ``/mcp-policies``.
- **D147** Read-open / mutation-admin auth split for MCP policy
  endpoints. New ``GET /v1/whoami``.
  **(Superseded by D156 in post-Phase-7 cleanup — single-tier auth.
  See breaking-change note below.)**

### Added (Phase 7 — operator-actionable enrichment)

- **D148 — shared `policy_decision` block.** Every policy event
  (warn / degrade / block / mcp_warn / mcp_block /
  mcp_server_attached / mcp_server_name_changed) now carries a
  uniform `policy_decision` summary
  (`{policy_id, scope, decision, reason}`) so operators read one
  shape across the policy event family.
- **D149 — sensor-minted UUIDs + `originating_event_id` chain.**
  Sensor mints the event UUID at emission time and stamps
  `originating_event_id` on follow-on events emitted within the
  same call window. The dashboard renders an intra-session jump
  affordance from any chained event back to its origin.
- **D150 — `event_content` `tool_input` / `tool_output` columns.**
  MCP tool capture (`mcp_tool_call`, `mcp_prompt_get`) and
  LLM-side `tool_call` events now route arguments + results
  through dedicated columns instead of the LLM-prompt-style
  repurposing of `messages` / `response`. Migration 000021 adds
  the columns; sensor + plugin route to them when
  `capture_prompts=True`.
- **D151 — MCP enforcement on all server-access paths.** The
  policy enforcement that originally gated `call_tool` is now
  generalized across all six MCP paths
  (`call_tool`, `list_tools`, `read_resource`, `list_resources`,
  `get_prompt`, `list_prompts`) so a deny entry blocks every
  surface, not just the tool-call hot path. `mcp_tool_call`
  events carry an `originating_call_context` field naming
  the path.
- **D152 — session lifecycle operator-actionable enrichment.**
  `session_start` adds `sensor_version` + `interceptor_versions`
  + `policy_snapshot`. `session_end` adds the `close_reason`
  enum (`normal_exit` / `directive_shutdown` / `policy_block` /
  `orphan_timeout` / `sigkill_detected` / `unknown`),
  `policy_actions_summary`, and `last_event_id`. New
  `mcp_server_name_changed` event type detects display-name
  drift on a stable URL.
- **D153 — LLM family operator-actionable enrichment.**
  `pre_call` / `post_call` carry `estimated_via` (which estimator
  produced the token count), `policy_decision_pre` (what the
  policy would have done before the call), `provider_metadata`
  (per-provider attributes the operator wants in the timeline).
  `embeddings` carries `output_dimensions`. `llm_error` carries
  `retry_attempt` + `terminal` so retry chains read at a glance.
- **D154 — dashboard surface for operator-actionable enrichment.**
  Five new sidebar facets on Investigate (CLOSE REASON, POLICY
  EVENT TYPES, ERROR TYPES, MCP SERVER NAMES, ESTIMATED VIA)
  backed by per-session aggregate columns and a
  `GET /v1/sessions` filter expansion. `EnrichmentSummary`
  renders per-event chips for every D152/D153 field. SessionDrawer
  MCP SERVERS panel renders per-server policy decisions inline.
- **Plugin SessionEnd cache invalidation.** Plugin's `SessionEnd`
  hook now invalidates the on-disk session-id cache so the
  next interaction mints a fresh `session_id` rather than
  reusing the closed one (which the worker's closed-skip path
  silently dropped). Sub-agents from a still-live parent now
  nest correctly under the live parent in the Investigate
  swimlane instead of rendering as top-level orphans.
- **Worker `orphan_timeout` reaper.** Reconciler now closes
  `lost` sessions that have been silent past
  `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS` (default 24h), stamping
  `close_reason=orphan_timeout` via a synthetic `session_end`
  event so the dashboard's CloseReason facet surfaces the
  reconciler's verdict alongside happy-path shutdowns.

### Decisions (Phase 7 enrichment)

- **D148** Shared `policy_decision` block on every policy event.
- **D149** Sensor-minted UUIDs + `originating_event_id` chain.
- **D150** `event_content` `tool_input` / `tool_output` columns;
  migration 000021.
- **D151** MCP policy enforcement on all six server-access paths.
- **D152** Session lifecycle operator-actionable enrichment +
  `close_reason` vocabulary + `mcp_server_name_changed` event.
- **D153** LLM family operator-actionable enrichment.
- **D154** Dashboard surface for operator-actionable enrichment.

### Removed (post-Phase-7 — single-tier auth + runtime token config)

- **Admin/viewer role distinction (D156 reverses D147).** The API's
  `auth.AdminRequired` middleware, `ValidationResult.IsAdmin` field,
  `adminGate` composer, `tok_admin_dev` dev shortcut, and
  `FLIGHTDECK_ADMIN_ACCESS_TOKEN` env var are gone. Every
  authenticated bearer token now has full access to every endpoint
  — both reads and mutations on MCP policies, plus
  `POST /v1/admin/reconcile-agents`. The dashboard's read-only
  banner, `useWhoamiStore`, `GET /v1/whoami` endpoint, and the
  `adminTokenError` helper are removed alongside.
- **Build-time token bake.** The hardcoded `ACCESS_TOKEN = "tok_dev"`
  constant in `dashboard/src/lib/api.ts` is gone. The dashboard now
  fetches its bearer token at runtime from `/runtime-config.json`
  via the new `lib/runtime-config.ts` bootstrap, with localStorage
  override (`flightdeck-access-token` key) for operator self-serve.
  `dashboard/public/runtime-config.json` ships with `tok_dev` for
  the dev stack; production deployers volume-mount their own file
  over `/usr/share/nginx/html/runtime-config.json`.

### Decisions (post-Phase-7)

- **D156** Single-tier auth + runtime token configuration.
  Reverses D147's read-open / mutation-admin split. Pre-v0.6 single-
  operator self-hosted deployments don't need a role tier — the
  mechanism failed its own bootstrap (fresh dashboard load → "read-
  only mode" → can't create a token without admin scope). Same
  PR adds runtime-config-driven token bootstrap so token rotation
  no longer requires a rebuild.

### Breaking changes (post-Phase-7)

- **`FLIGHTDECK_ADMIN_ACCESS_TOKEN` env var is no longer recognized.**
  Production deployers using it for emergency admin access lose that
  path. Use a regular bearer token configured via
  `/runtime-config.json` instead.
- **`tok_admin_dev` dev shortcut is gone.** Use `tok_dev` (the
  regular dev token) — every endpoint now accepts it, including the
  previously admin-gated MCP policy mutations and
  `/v1/admin/reconcile-agents`.
- **`GET /v1/whoami` endpoint removed.** Sole consumer was the
  dashboard's `useWhoamiStore` which is also removed. If a future
  identity probe is needed, it lands with a different shape designed
  for that need rather than retaining a vestigial endpoint.
- **Build-time `ACCESS_TOKEN` constant removed from
  `dashboard/src/lib/api.ts`.** Anything importing it (none in-tree
  pre-merge) needs to switch to `getAccessTokenSync()` from
  `lib/runtime-config.ts` instead.

### Fixed

- **Cold-boot 500 on `GET /v1/mcp-policies/global` after
  `make dev-reset`.** The empty-blocklist global policy row is
  now seeded by migration `000019_mcp_protection_policy_seed_global`
  per **D141**, not by the `EnsureGlobalMCPPolicy` boot hook. On a
  fresh stack postgres → workers + api came up in parallel, api's
  boot hook raced workers' migrator to a postgres without
  `mcp_policies`, the call failed silently with
  `relation "mcp_policies" does not exist`, and every subsequent
  `GET /v1/mcp-policies/global` returned 500 with
  `global policy missing; restart API to auto-create` until manual
  api restart. The migrator now owns the row; the boot hook stays
  as a defensive idempotent retry for install paths that may run
  api before the migrator (e.g. future operator-managed Helm
  charts).

## Unreleased — Sub-agent observability

First-class events, identity, and dashboard surfaces for sub-agent
spawn / hand-off / join across Claude Code Task subagents, CrewAI,
and LangGraph. Single PR covering sensor, plugin, ingestion,
workers, API, dashboard, integration tests, playground demos, and
docs. See **D126**. AutoGen support is on the Roadmap (LLM-call
interception is a prerequisite that does not exist yet).

### Added

- **Sensor:** conditional 6th-input identity derivation. `agent_role`
  joins the `agent_id` derivation when set; collapses to the
  existing 5-tuple when null / empty / whitespace. CrewAI Researcher
  and CrewAI Writer running on the same host land under distinct
  agent_ids; root and direct-SDK agent_ids are unchanged byte-for-
  byte from the D115 fixture vector.
- **Sensor:** two new framework interceptors —
  `interceptor/crewai.py` (context manager around
  `crewai.Agent.execute_task` / `aexecute_task`) and
  `interceptor/langgraph.py` (wraps the registered callable on
  `StateGraph.add_node`; default-on per node, narrowable via the
  opt-in regex `init(langgraph_agent_node_pattern=…)`).
  `Provider.CREWAI` / `Provider.LANGGRAPH` enum members extend
  the D125 enum.
- **Sensor:** cross-agent message capture. Child `session_start`
  carries the parent's input as `incoming_message`; child
  `session_end` carries the response back as `outgoing_message`.
  Gated by `capture_prompts`. Bodies route through the existing
  `event_content` table — small inline, large via the **D119**
  overflow path with a 2 MiB hard cap.
- **Sensor:** sub-agent emission failure surfacing. Exceptions
  inside the interceptor's context manager emit child
  `session_end` with `state=error` plus a structured error
  block following the `llm_error` taxonomy.
- **Plugin (Claude Code):** `SubagentStart` / `SubagentStop` hooks
  emit child `session_start` / `session_end` events stamped with
  `parent_session_id` and `agent_role` from hook payload.
  `SubagentStop` is the canonical child end-of-life signal;
  Task-tool `PostToolUseFailure` emits the parent's `tool_call`
  with error only and does NOT duplicate-emit a child
  `session_end` (D126 disambiguation). Crashes without a clean
  Stop fall through the existing state-revival path
  (D105 / D106).
- **Schema:** migration `000017` adds `sessions.parent_session_id`
  (uuid FK to `sessions(session_id)`) and `sessions.agent_role`
  (text). Both nullable, populated only on sub-agent sessions.
  Partial index on `parent_session_id WHERE NOT NULL`. Parallel
  migration in `helm/migrations/`.
- **Worker:** `UpsertParentStub` lazy-creates a parent stub row
  when a child arrives with an unknown `parent_session_id`,
  extending the **D106** lazy-create primitive. The FK stays
  enforced; `UpsertSession ON CONFLICT` fills in the stub's
  `"unknown"` sentinels when the real parent's `session_start`
  arrives later via the existing write-once-but-upgrade branch.
- **Ingestion / API:** new query parameters and response fields.
  `GET /v1/sessions` supports `?parent_session_id=`,
  `?agent_role=`, `?has_sub_agents=true`, `?is_sub_agent=true`
  filters; session listing rows carry `parent_session_id` and
  `agent_role` (omitempty when null).
- **Analytics:** new `agent_role` dimension joins
  `flavor` / `model` / `framework` / `host` / `agent_type` /
  `team` / `provider`. New metrics `parent_token_sum`,
  `child_token_sum`, `child_count`,
  `parent_to_first_child_latency_ms` operate over the parent /
  child relationship via recursive CTE on `parent_session_id`.
  New filters `filter_parent_session_id`, `filter_is_sub_agent`,
  `filter_has_sub_agents`. CLAUDE.md Rules 25 + 26 updated to
  match.
- **Dashboard (Fleet):** swimlane left panel renders a
  relationship pill — `→ N` for parents, `← {parent_name}` for
  children — always-on regardless of activity bucket. Click
  navigates between rows. Spawn-event Bezier connectors anchor
  per-child on the parent's spawn event circle (top / bottom by
  activity-bucket direction); 10% opacity default, 50% on hover.
  D3 stays math-only.
- **Dashboard (Fleet):** AgentTable gains ROLE column
  (agent_role pill or blank for root) and TOPOLOGY column
  (`spawns N` for parents, `child of {name}` for children).
- **Dashboard (Investigate):** TOPOLOGY facet (Has sub-agents /
  Is sub-agent), ROLE facet (auto-hides when all sessions are
  root), ROLE column between AGENT and HOSTNAME, PARENT column
  between SESSION and AGENT. URL-state round-trips.
- **Dashboard (SessionDrawer):** new SPAWNED FROM metadata field
  (children), SPAWNS metadata field (parents), role pill near
  the agent name. Conditional Sub-agents tab between Timeline
  and Prompts with two stacked sections — SPAWNED FROM
  (parent header + sibling list, top) and SUB-AGENTS (children
  list, bottom). MESSAGES sub-section per child entry rendering
  INPUT / OUTPUT preview with click-to-expand via
  `GET /v1/events/{id}/content`. Child drawer top metadata gains
  INCOMING MESSAGE / OUTGOING MESSAGE fields. Capture-off
  disabled state per Rule 21.
- **Dashboard (Analytics):** `DimensionPicker` gains `agent_role`
  option. New `ParentChildBreakdownChart` stacked-bar variant
  (one bar per parent, segments per child role). New "Sub-agent
  activity" facet on the Analytics sidebar (parity with
  Investigate TOPOLOGY).
- **Dashboard (L8 row-level failure cue):** red `AlertCircle`
  dot on Investigate session row, Fleet AgentTable row, and
  Fleet swimlane left panel when a sub-agent ends with
  `state=error`. Tooltip surfaces the exception class and first
  100 chars of the error message. Mirrors the existing
  `error_types` / `mcp_error_types` patterns.
- **Tests:** sensor unit (+30 to +50) covering identity
  derivation extension, session payload fields, two new
  interceptor modules, cross-agent message capture parity.
  Plugin Node tests (+8 to +12) covering SubagentStart /
  SubagentStop / Task prompt + response capture /
  PostToolUseFailure error path. Go tests (+30 to +55) across
  ingestion / workers / API including UpsertParentStub
  forward-reference race ordering and recursive-CTE
  correctness. Vitest (+40 to +60) covering relationship pill,
  Sub-agents tab MESSAGES sub-section, Analytics dimension
  picker, ParentChildBreakdownChart, and
  `L8-row-failure-cue.test.tsx` cross-cutting test. Integration
  (+8 to +14): `test_subagent_landing.py`,
  `test_cross_agent_messages.py`, `test_subagent_analytics.py`.
  Playwright (+11 specs × 2 themes = 22 runs): T28 to T40
  excluding the AutoGen-only T31a / T31b, T38 cross-agent
  messages, T39 analytics dimensions, T40 failure-cue.
- **Playground (Rule 40d):** extended
  `playground/14_claude_code_plugin.py` (Task subagent path +
  cross-agent message capture round-trip);
  `playground/16_subagents_crewai.py`,
  `playground/17_subagents_langgraph.py` (new). Each
  self-skips when its framework / API key is missing per the
  existing playground convention. New Make targets:
  `playground-subagents-crewai`,
  `playground-subagents-langgraph`.

### Changed

- **D100 bullet on the SubagentStart / SubagentStop hooks
  (DECISIONS.md L2616-2618)** rewritten to reflect the actual
  pre-D126 wire shape (informational `is_subagent_call=true`
  flag on the parent's `tool_call`; no child session row, no
  parent linkage). The full hook bracketing, child-session
  emission, and `parent_session_id` column land in D126, not
  D100.
- **ARCHITECTURE.md drift fixes:** repository structure tree
  hooks.json comment now lists the real seven-hook surface plus
  the two new SubagentStart / SubagentStop entries; `tests/smoke/`
  reference replaced with `tests/e2e-fixtures/` (smoke retired
  in **D124**); `is_subagent_call` description updated from
  "informational only" to describe the new
  `parent_session_id` consumption path.
- **METHODOLOGY.md** gains a "Post-implementation review" section
  codifying the five-hat audit (Python principal / Go principal /
  TypeScript & UI / Architect / QA Validation & Automation) with
  Block / Recommend / Defer categorization.
- **CLAUDE.md** gains an "Always start from latest main" rule
  under Git Discipline. CLAUDE.md Rules 25 + 26 (locked
  dimension / metric lists) extended with `agent_role` and the
  four sub-agent-aware metrics.
- **Swimlane β-grouping (D126 UX revision 2026-05-03):** child
  rows now group immediately under their parent in the Fleet
  swimlane sort, indented 28 px on the left panel and tinted via
  the new `--swimlane-row-child-bg` CSS variable (declared on
  both `.dark` and `.light` themes per Rule 15). The
  ``data-topology="child"`` attribute on the row container drives
  both the indent and a subtle 2 px `--accent` left-border accent
  via globals.css. The connector overlay (D126 § 4.3),
  relationship pills, and L8 red dot all continue to render
  unchanged. Lone agents and parents whose parent isn't visible
  keep their natural activity-bucket position.
- **Investigate parents-only default (D126 UX revision
  2026-05-03):** the Investigate listing's default scope hides
  pure children (sessions whose `parent_session_id` is set AND
  that themselves have no descendants), leaving
  parents-with-children + lone sessions in the table. Parent
  rows render a `→ N` pill in the PARENT column and expand
  inline downward on click — each child sub-row carries the full
  column set (SESSION / AGENT / ROLE / MODEL / STARTED / LAST
  SEEN / DURATION / TOKENS / STATE) at one indent level with
  the same `data-topology="child"` styling. Click on a child
  sub-row rebinds the SessionDrawer to the child's session via
  the existing `onSwitchSession` path. The TOPOLOGY facet's
  "Is sub-agent" checkbox remains the explicit override that
  flips the listing scope to children-only for cross-tree
  search; "Has sub-agents" is the implicit default state.
- **API extensions (D126 UX revision 2026-05-03):** every
  `GET /v1/sessions` row now carries a derived `child_count`
  integer field (zero on lone agents and pure children); a new
  `include_pure_children` boolean filter excludes pure children
  when explicitly false (default scope of the Investigate page),
  preserves existing behaviour when omitted. Both surfaced via
  the existing `sessions_parent_session_id_idx` partial index.
  See ARCHITECTURE.md "Sub-agent sessions" section.

### Decisions

- **D126** sub-agent observability — identity, parent linkage,
  message capture, analytics. Documents the conditional 6th-input
  identity derivation, paired `parent_session_id` / `agent_role`
  columns, the lazy-create-parent-stub forward-reference contract
  (extends D106), the per-framework attribution matrix
  (Claude Code Task plugin path + CrewAI + LangGraph; AutoGen
  on the Roadmap), the SubagentStop disambiguation, cross-agent
  message capture via the D119 overflow path, the sub-agent-aware
  analytics dimension + metrics, and the accepted properties
  (renaming creates new identity; recursive CTE cost on large
  datasets; forward-reference stub orphans).

## Unreleased — Phase 5 MCP first-class observability

Treats Model Context Protocol calls as a first-class event surface
alongside chat and embeddings. Single PR covering sensor, worker,
API, dashboard, plugin, integration tests, playground demos, and docs.

### Changed

- **Project layout:** ``tests/smoke/`` retired in favor of
  ``playground/`` as the single canonical Rule 40d manual-exercise
  surface (D124). Coverage unique to smoke migrated into the
  corresponding playground script as inline print + assert. New
  ``playground/14_claude_code_plugin.py`` and
  ``playground/15_bifrost.py`` cover the previously smoke-only paths.
  The reference MCP server moved to
  ``playground/_mcp_reference_server.py``; helpers consolidated to
  ``playground/_helpers.py``.
- **Make targets:** every ``smoke-*`` target removed.
  ``make playground-anthropic`` / ``-openai`` / ``-langchain`` /
  ``-langgraph`` / ``-llamaindex`` / ``-crewai`` / ``-litellm`` /
  ``-mcp`` / ``-claude-code`` / ``-bifrost`` / ``-policies`` /
  ``-all`` are the replacements.
- **Python bound:** ``sensor/pyproject.toml``
  ``requires-python = ">=3.10,<3.14"`` (was ``>=3.9``); classifier
  list dropped 3.9. The ``python_version < '3.14'`` marker on the
  ``crewai`` dev dep was redundant with the project-level bar and
  was removed. ``playground/run_all.py`` adds a top-of-file gate
  refusing to run on the wrong interpreter.
- **Single venv:** every Make target that runs Python resolves
  through ``$(PYTHON)`` (defaults to ``./sensor/.venv/bin/python``);
  CI overrides via env where ``actions/setup-python`` already pinned
  the right interpreter.
- **Sensor public API:** ``flightdeck_sensor.Provider`` enum is the
  canonical way to specify ``patch()`` targets (D125). Each member
  IS a string (``(str, Enum)`` mixin), so existing raw-string call
  shapes (``patch(providers=["anthropic"])``) keep working unchanged
  and mixed lists (``[Provider.ANTHROPIC, "openai"]``) work for
  callers mid-migration. Playground demos migrated to the enum
  form; unit / integration tests stay on raw strings as the
  backward-compat contract proof.

### Added

- **Sensor:** six MCP event types — ``mcp_tool_list``,
  ``mcp_tool_call``, ``mcp_resource_list``, ``mcp_resource_read``,
  ``mcp_prompt_list``, ``mcp_prompt_get``. The interceptor patches
  ``mcp.client.session.ClientSession`` directly, so every framework
  that mediates MCP through the official SDK (LangChain, LangGraph,
  LlamaIndex, CrewAI via mcpadapt, plus the raw mcp SDK) routes
  through one patch surface. Lean payload (D2) drops the LLM-baseline
  fields and carries only MCP-specific shape.
- **Sensor:** ``MCPServerFingerprint`` dataclass.
  ``ClientSession.initialize()`` is patched silently to capture
  name / transport / protocol_version (str | int preserved verbatim
  per Override 5) / version / capabilities / instructions and stamp
  them on the session. When session_start ships AFTER MCP init,
  ``context.mcp_servers`` carries the full fingerprint list.
- **Sensor:** structured MCP error taxonomy
  (``invalid_params`` / ``connection_closed`` / ``timeout`` /
  ``api_error`` / ``other``) populated on every failure path.
- **Sensor:** capture_prompts gates per-field MCP content with an
  8 KiB inline / 2 MiB hard-cap overflow path that reuses the
  existing event_content table for resource_read bodies.
- **Worker:** ``isMCPEventType()`` routing branch in ``Process``;
  MCP-specific extras projection in ``BuildEventExtra`` covering
  ``server_name``, ``transport``, ``count``, ``tool_name``,
  ``arguments``, ``result``, ``resource_uri``, ``content_bytes``,
  ``mime_type``, ``prompt_name``, ``rendered``, ``error``.
- **Worker:** MCP_RESOURCE_READ inline-content projection into
  ``events.payload.content`` (small bodies); has_content=true bodies
  route through the existing event_content table path.
- **API:** ``GET /v1/sessions?mcp_server=<name>`` filter (repeatable)
  backed by the JSONB EXISTS subquery on
  ``sessions.context->'mcp_servers'``. Each session row carries
  ``mcp_server_names: []string`` derived at query time.
- **Plugin (Claude Code):** ``mcp_tool_call`` emission only (D1 — the
  hook surface only sees ``mcp__<server>__<tool>`` invocations).
  ``PostToolUseFailure`` routes to ``mcp_tool_call`` with structured
  error block (``error_class=PluginToolError``). Server fingerprints
  loaded from ``.mcp.json`` + ``~/.claude.json`` and stamped on
  session_start. Sanitiser bypass for MCP arguments (D4).
- **Dashboard:** ``MCPEventDetails`` panel in the session drawer
  with accordion sections for arguments / result / rendered,
  capture-on / capture-off branches, and lazy "Load full response"
  via ``GET /v1/events/{id}/content``.
- **Dashboard:** Fleet swimlane MCP family rendering — hexagon
  clip-path circles, three colour families (cyan/green/purple)
  × two glyph variants (filled = invoked, outline = list).
- **Dashboard:** TYPE pill labels for MCP events
  (``MCP TOOL CALL`` / ``MCP TOOLS DISCOVERED`` /
  ``MCP RESOURCE READ`` / ``MCP RESOURCES DISCOVERED`` /
  ``MCP PROMPT FETCHED`` / ``MCP PROMPTS DISCOVERED``). Verbs
  (CALL / READ / FETCHED / DISCOVERED) distinguish "agent invoked"
  from "agent discovered" without the bare singular/plural-s
  ambiguity considered earlier (``MCP TOOL`` vs ``MCP TOOLS``).
  The ``MCP `` prefix carries category in the Fleet live feed
  table (D123), where badges render without the swimlane hexagon
  shape and would otherwise sit next to the non-MCP ``TOOL`` badge
  with only verb-tense disambiguation.
- **Dashboard:** inline ``MCPErrorIndicator`` (red AlertCircle, 12px,
  ``var(--event-error)``) on session-drawer event-feed rows whose
  ``event_type`` matches ``mcp_*`` AND ``payload.error`` is
  populated. aria-label format
  ``MCP call failed: <message>`` and tooltip ``Failed: <message>``
  give an operator the failure reason without expanding the row.
  See **D121** for the complete rationale + scope boundary.
- **Dashboard:** Investigate session-row red MCP error indicator —
  parallel to the existing ``error_types`` (``llm_error``) red dot
  and the cyan ``mcp_server_names`` dot. Renders when the
  session listing's new ``mcp_error_types[]`` rollup is non-empty;
  the tooltip lists every distinct ``error_type`` observed across
  the session's MCP events. Drives at-a-glance triage without
  per-session drawer opens. See **D121**.
- **API:** ``mcp_error_types: string[]`` field on every session
  listing row (correlated subquery, same shape as the existing
  ``error_types`` and ``policy_event_types`` rollups). Always
  present on the wire (empty array when no MCP event in the
  session failed). Swagger spec regenerated.
- **Dashboard:** Investigate ``MCP_SERVER`` facet (sticky position 7,
  above scalar context) sourced from
  ``sessions.context.mcp_servers`` and per-row indicator dot.
- **Dashboard:** session-drawer ``MCP SERVERS`` panel listing every
  fingerprint (name / transport / protocol_version / version /
  capabilities / instructions).
- **Tests:** ``tests/integration/test_mcp_events.py`` — 6 IT-MCP
  cases covering all six event types' wire shape, fingerprint
  persistence + ``mcp_server`` filter, content overflow round-trip,
  structured error taxonomy, MCP-only session last-seen advancement,
  and (IT-MCP-6) the new ``mcp_error_types`` listing rollup
  (deduplicated, scoped to ``mcp_*`` events, empty array on
  unaffected sessions).
- **Tests (E2E):** T25-16 (MCPErrorIndicator on the failed
  mcp_tool_call row) and T25-17 (session-row MCP error indicator)
  in ``T25-mcp-observability.spec.ts``, both running under both
  themes per Rule 40c.3. Anchored by the new
  ``mcp_tool_call_failed`` extras tag in
  ``tests/e2e-fixtures/canonical.json`` + ``seed.py``.
- **Tests (E2E):** T26 theme matrix canary
  (``T26-theme-matrix-canary.spec.ts``) — fails LOUDLY if the
  Playwright per-project ``storageState`` ever drifts out of
  agreement with ``useTheme``'s accepted values, locking in the
  fix that re-enabled actual dual-theme coverage.
- **Playground (Rule 40d):** every framework demonstrates every
  event Flightdeck emits for it — chat (sync/async/sync-stream/async-stream),
  embeddings (event emission + capture round-trip), MCP (all six
  event types + ``transport`` + ``server_name`` + arguments
  round-trip), policy (WARN/DEGRADE/BLOCK with payload-shape
  asserts), and error classification (auth-error, invalid-model).
  ``13_mcp.py`` covers the bare ``mcp`` SDK against the in-tree
  reference server (``playground/_mcp_reference_server.py``) plus
  a multi-server attribution scenario via
  ``playground/_secondary_mcp_server.py``.
  ``14_claude_code_plugin.py`` exercises the plugin's MCP-emission
  paths via synthetic ``PostToolUse`` JSON. ``15_bifrost.py``
  covers the optional bifrost gateway. Framework MCP coverage
  rides as a section inside each per-provider playground file
  (``03_langchain.py``, ``04_langgraph.py``, ``05_llamaindex.py``,
  ``06_crewai.py``); each block skips cleanly when its adapter
  isn't installed.
- **Make:** Per-script playground targets (``playground-anthropic``,
  ``-openai``, ``-langchain``, ``-langgraph``, ``-llamaindex``,
  ``-crewai``, ``-litellm``, ``-mcp``, ``-claude-code``,
  ``-bifrost``, ``-policies``) plus ``playground-all`` driving
  every script through ``run_all.py``.
- **Dashboard:** Live feed hides MCP discovery events
  (``mcp_tool_list`` / ``mcp_resource_list`` /
  ``mcp_prompt_list``) by default. A "Discovery events" toggle in
  the filter bar restores them; preference persists in
  ``localStorage`` under ``flightdeck.feed.showDiscoveryEvents``.
  The session drawer event timeline is unaffected and always shows
  the full event history. The Fleet swimlane dims discovery
  hexagons when the toggle is off (mirroring how it dims
  filter-mismatched events). See **D122**.
- **Fleet sidebar POLICY EVENTS panel** wired to live ``policy_warn``
  / ``policy_block`` / ``policy_degrade`` events from the live feed,
  mirroring the DIRECTIVE ACTIVITY section directly below it.
  Replaces the prior ``No policy events yet.`` stub that rendered
  unconditionally even though policy events have flowed through every
  other Flightdeck surface (swimlane badge, Investigate POLICY facet,
  drawer detail row) since Phase 4. Header and body hide together
  when no recent enforcement activity is in window. Each row uses
  ``getEventDetail`` for the top-line (``warn at 80% · 8,000 of
  10,000 tokens`` etc.) and the shared ``eventBadgeConfig`` cssVar
  + label for the WARN / BLOCK / DEGRADE badge — one colour family
  across every surface.

### Fixed

- **Dashboard E2E:** Playwright's per-project ``storageState`` was
  seeding ``localStorage`` with values the dashboard's ``useTheme``
  hook rejects (project labels ``neon-dark`` / ``clean-light``
  rather than the accepted ``dark`` / ``light``) AND under a key
  that didn't match ``constants.ts::THEME_STORAGE_KEY``
  (``flightdeck:theme`` with a colon vs. ``flightdeck-theme`` with
  a hyphen). Consequence: the ``clean-light`` project ran a second
  copy of the dark-theme suite for an unknown number of phases,
  silently degrading Rule 40c.3 (theme coverage). Both fixes
  shipped together; the new T26 canary makes future drift visible
  on first failed run.
- **E2E seeder (Tests):** ``tests/e2e-fixtures/seed.py`` now re-emits
  the canonical ``policy-active`` session's three enforcement events
  (``policy_warn`` / ``policy_degrade`` / ``policy_block``) at NOW-30
  / -20 / -10 s on every ``make seed-e2e`` run, parallel to the
  existing ``fresh-active`` and ``mcp-active`` re-emit branches.
  Without this, the per-session ``_session_is_complete`` idempotency
  check skipped policy_* re-emission on repeat seeds and the events
  aged out of every Fleet time-range button (max 1h) within hours of
  the first seed — leaving the new POLICY EVENTS panel without
  in-window data for T27 to assert against. The first-seed payload
  shape is unchanged, so T17's existing Investigate POLICY assertions
  cannot regress.

### Decisions

- **D117** ``ClientSession``-level patching is the canonical MCP
  patch surface across every framework adapter (the official SDK is
  the single contract that doesn't drift).
- **D118** Asymmetric coverage — Python sensor emits all six MCP
  event types; Claude Code plugin emits ``mcp_tool_call`` only
  (the hook surface is the constraint, not a design choice).
- **D119** Lean MCP wire payload — drop LLM-baseline fields from
  the wire envelope. The dashboard's MCPEventDetails component
  reads MCP-specific extras from ``events.payload`` directly.
- **D120** ``mcpadapt`` pinned in the sensor's optional
  ``[mcp-crewai]`` extras — the upstream is small and fast-moving;
  pinning lets a future upgrade be a deliberate change.
- **D121** MCP failure surfacing on event-feed rows + session-row
  rollup — deliberate two-tier surface (red AlertCircle inline
  after the badge, plus a session-listing red dot driven by the
  new ``mcp_error_types[]`` rollup). Boundaries: row-level + table-
  level only; no fleet-swimlane red hexagons (rejected for
  over-claiming at the cross-session view).
- **D122** MCP discovery event visibility — hide the three
  ``_list`` event types from Fleet's live feed and dim them in
  the swimlane by default. Toggle restores. Drawer is unaffected.
  Operational density problem solved without retracting D118
  (six-event audit-trail granularity stands).
- **Override 2** has_content=true overflow routing for
  ``MCP_RESOURCE_READ`` reuses the LLM event_content table path;
  no schema change needed.
- **Override 5** ``protocol_version`` preserved verbatim as
  ``str | int`` — the dashboard handles both at render time
  rather than coercing at the wire boundary.

## v0.5.0 — Agent communication coverage hardening (2026-04-25)

Closes the "we observe what we claim to observe" gap before launch.
Covers embeddings, comprehensive streaming semantics, structured LLM
errors, session-lifecycle edge cases, and the polish stack accumulated
since v0.4.0 Phase 1 (Phase 2 agents API, Phase 3 E2E foundation,
admin reconciler, fleet/investigate polish, Phase 4 + Phase 4 polish).

### Added

- **Sensor:** ``embeddings`` event type. OpenAI ``client.embeddings.create``,
  litellm ``embedding`` / ``aembedding``, LangChain ``OpenAIEmbeddings``
  transitively. Token accounting carries input tokens only; the dashboard
  renders distinctly from ``post_call`` via the EMBED badge + Database glyph.
- **Sensor:** structured ``llm_error`` events with a 14-entry taxonomy
  (``rate_limit``, ``quota_exceeded``, ``context_overflow``,
  ``content_filter``, ``invalid_request``, ``authentication``,
  ``permission``, ``not_found``, ``request_too_large``, ``api_error``,
  ``overloaded``, ``timeout``, ``stream_error``, ``other``) plus
  ``provider`` / ``http_status`` / ``provider_error_code`` / ``request_id``
  / ``retry_after`` / ``is_retryable``. Mid-stream aborts emit
  ``error_type=stream_error`` with ``partial_chunks`` / ``partial_tokens_*``.
- **Sensor:** comprehensive streaming semantics on ``post_call`` events.
  ``payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms: {p50, p95,
  max}, final_outcome, abort_reason}``. Async streaming support for
  Anthropic + OpenAI (lifts the prior ``NotImplementedError``).
- **Sensor:** embeddings content capture per-framework. ``PromptContent.input``
  captures the request's ``input`` parameter (string or list of strings) when
  ``capture_prompts=True``. Round-trips through ``payload.content.input`` →
  ``event_content.input`` → ``GET /v1/events/:id/content``.
- **Sensor:** framework attribution wired at ``init()`` from
  ``FrameworkCollector``. Every event carries a bare-name ``framework``
  field (``langchain``, ``crewai``, ...). Higher-level framework wins over
  SDK transport — a LangChain pipeline routing through litellm routing
  through OpenAI reports ``framework=langchain``.
- **Sensor:** LangChain classifier accepts ``langchain_core`` alias for
  modern split-package installs (``langchain_openai`` / ``langchain_anthropic``).
- **Sensor:** ``SensorLitellm`` covers the litellm Anthropic provider path
  that previously bypassed SDK-level interception (KI21 closed).
- **Ingestion:** Phase 4 validation rules. Rejects orphan ``session_end``
  (logged + counted), ``occurred_at`` > 48h past or > 5m future,
  malformed ``session_id``, negative ``tokens_*`` (D2 / D7 / D8 / D10 / D15).
- **Ingestion:** ``dropped_events_total{reason}`` Prometheus counter
  exposed via ``/metrics`` (D14).
- **Worker:** ``event_content.input`` JSONB column (migration 000016)
  for embedding-content roundtrip.
- **Worker:** session-lifecycle hardening — ``handleSessionGuard`` revives
  stale / lost sessions on every non-``session_start`` event (D105) and
  lazy-creates session rows on first sight of an unknown ``session_id``
  (D106). 30-min lost-threshold accommodates Claude Code think-time windows.
- **API:** ``GET /v1/sessions?framework=<bare>`` matches bare-name
  attribution OR ``context.frameworks[]`` versioned strings.
- **API:** ``GET /v1/sessions`` returns ``error_types[]`` per session
  via correlated subquery; ``?error_type=<value>`` filter (repeatable).
- **API:** ``POST /v1/admin/reconcile-agents`` admin endpoint
  recomputes ``agents.total_sessions`` / ``total_tokens`` /
  ``first_seen_at`` / ``last_seen_at`` from sessions ground truth.
- **API:** ``GET /v1/agents/{id}`` endpoint backing the Investigate
  AGENT facet's identity-cache resolver chain.
- **Dashboard (Fleet):** swimlane expanded drawer covers full session
  history. ``loadExpandedSessions`` passes ``from = new Date(0).toISOString()``
  with ``EXPANDED_DRAWER_PAGE_SIZE = 25``; "Show older sessions" load-more
  button paginates; "View in Investigate →" footer deep-links to
  ``/investigate?agent_id=<uuid>``.
- **Dashboard (Fleet):** rich event rendering for ``embeddings`` (cyan
  ``--event-embeddings`` + Database glyph) and ``llm_error`` (red
  ``--event-error`` + CircleAlert glyph). Per-theme tokens.
- **Dashboard (Fleet):** orphan agents with ``total_sessions=0`` filtered
  out of the swimlane.
- **Dashboard (Investigate):** ERROR TYPE facet, URL-state
  ``?error_type=<value>``, session-row red-dot indicator on rows with
  any ``llm_error``.
- **Dashboard (Investigate):** ``<EmbeddingsContentViewer>`` distinct
  from ``PromptViewer`` — three render branches (single string, list,
  no-content); EMBED badge in event row.
- **Dashboard (Investigate):** ``llm_error`` event rendering with the
  ``<ErrorEventDetails>`` accordion (request_id, retry_after,
  is_retryable, abort_reason, partial_chunks / partial_tokens for
  stream errors).
- **Dashboard (Investigate):** streaming indicators on ``post_call``
  events — TTFT segment in detail string, ``<StreamingPill>``
  (``STREAM`` / ``ABORTED``), expanded grid with TTFT / Chunks /
  Inter-chunk / Outcome rows.
- **Dashboard (Investigate):** AGENT facet keyed on ``agent_id`` with
  ``agent_name`` display labels; ``?agent_id=<uuid>`` round-trips.
- **Tests:** Playwright E2E foundation under ``dashboard/tests/e2e/``
  with neon-dark + clean-light theme projects. Virtualized-swimlane
  resilience helpers (``bringSwimlaneRowIntoView``,
  ``bringTableRowIntoView``).
- **Tests:** new E2E specs — T14 (embeddings content capture), T15
  (streaming indicators), T16 (``llm_error`` drawer), T5b (ancient-agent
  drawer regression guard).
- **Tests:** per-framework smoke targets under ``tests/smoke/``
  (Anthropic, OpenAI, litellm, LangChain, claude-code, optional
  bifrost). Driven by ``make smoke-<framework>`` and ``make smoke-all``;
  pytest-skip when API-key env vars are missing.
- **Tests:** integration coverage for Phase 4 event shapes
  (``BuildEventExtra``, embedding promotion, framework attribution
  roundtrip, ``error_types`` listing, framework filter).

### Changed

- **Sensor:** ``extract_content`` signature gains an ``event_type``
  kwarg so providers branch on ``EMBEDDINGS`` vs ``POST_CALL``.
- **Sensor:** ``BaseClassifier.module`` accepts a tuple of aliases
  (``("langchain", "langchain_core")``).
- **Ingestion:** ``maxClockSkewPast`` widened from 24h to 48h to
  accommodate realistic retry-after-long-outage windows and the E2E
  ``aged-closed`` fixture (Q-CLOCK-SKEW decision).
- **Workers:** ``InsertEventContent`` parses ``Input json.RawMessage``;
  missing ``Messages`` defaults to ``"[]"::jsonb``.
- **API:** Swagger regenerated for the ``error_type`` filter and
  per-session ``error_types[]`` field.
- **Dashboard (theme):** font-mono consumers audited; removed global
  12px override (KI22 closed).
- **CI:** all workflow jobs opted into Node 24 (KI24 closed).

### Fixed

- **Sensor:** ``await AsyncOpenAI.chat.completions.create(stream=True)``
  raised ``TypeError: GuardedAsyncStream object can't be awaited``.
  Inline ``async def`` wrap in ``SensorCompletions.create``;
  ``GuardedAsyncStream.__aenter__`` awaits a coroutine ``_real_fn``
  return. Caught by Rule 40d smoke matrix, not unit tests.
- **Sensor:** ``capture_prompts=True`` + streaming silently dropped
  ``post_call`` events with ``Object of type AsyncStream is not JSON
  serializable``. Anthropic now calls ``response.get_final_message()``;
  ``__dict__`` fallback per-field-filters via ``json.dumps``. Caught
  by Rule 40d smoke matrix.
- **Sensor:** ``Session.record_framework`` had zero callers, so every
  event emitted ``framework=null``. Wired at ``init()`` from
  ``FrameworkCollector``. Surfaced when the embeddings work made
  attribution parity load-bearing.
- **Sensor:** mypy ``--strict`` clean.
- **Sensor:** ruff ``isort`` + dropped unused ``dataclasses.field``
  import.
- **Dashboard (Fleet):** ``buildSearchResultHref`` for agent-level
  search now routes to ``?agent_id=<uuid>`` instead of
  ``?flavor=<agent_name>`` (KI follow-up; routing path moved to
  the agent-id resolver chain).

### Removed

- **Dashboard:** Bars view mode (D075). Single-mode swimlane only.

### Breaking changes

None for sensor users on v0.4.0 Phase 1.

## v0.4.0 Phase 1 -- Agent identity model foundation (2026-04-22)

### Added

- **Agent identity model (D115).** Every event carries a deterministic
  ``agent_id`` UUID derived from
  ``(agent_type, user, hostname, client_type, agent_name)``. A new
  ``agents`` table keys on ``agent_id``; sessions link to it via a
  new ``agent_id`` FK plus denormalized ``client_type`` /
  ``agent_name`` columns. See DECISIONS.md D115.
- **Fleet API shape (S9).** ``GET /v1/fleet`` now returns
  ``{agents: AgentSummary[], total, page, per_page, context_facets}``
  with a state rollup computed from each agent's sessions.
- **Sessions filter (S11).** ``GET /v1/sessions`` accepts
  ``?agent_id=<uuid>`` and returns ``agent_name`` / ``client_type``
  on every row.
- **Fleet view toggle.** The dashboard Fleet page gains a swimlane /
  table toggle (URL-driven via ``?view=``). Swimlane is the default
  live-activity view, relabelled to show ``agent_name`` plus a
  ``client_type`` pill.
- **Investigate AGENT facet.** The Investigate sidebar gains an
  AGENT facet keyed on ``agent_id`` with ``agent_name`` display
  labels. URL param ``?agent_id=<uuid>`` round-trips the selection.
- **Ingestion validation (D116).** ``POST /v1/events`` rejects
  events missing ``agent_id`` or with out-of-vocabulary
  ``agent_type`` / ``client_type``.

### Changed

- **D115 semantic narrowing versus D113.** Plugin ``session_id`` is
  now a uuid4 per Claude Code invocation (cached in the existing
  marker file), not a uuid5 derivation from
  ``(user, host, repo, branch)``. Stability lives in ``agent_id``.
  Same laptop across multiple repos converges to ONE agent.
- ``FlavorSummary`` (dashboard) retained but repurposed: each row
  now represents an agent (keyed on ``agent_id``) rather than a
  flavor string. The swimlane renders ``agent_name`` with a
  ``client_type`` pill instead of the raw flavor.

### Removed

- D113 ``deriveStableSessionId`` in the Claude Code plugin.
- Legacy flavor-keyed ``agents`` table; migration ``000015`` drops
  and recreates with the agent_id-keyed schema.

### Breaking changes

- **Sensor AGENT_TYPE vocabulary narrowed to
  ``{coding, production}``.** Any other value
  (``autonomous``, ``supervised``, ``batch``, ``developer``)
  raises ``ConfigurationError`` at ``flightdeck_sensor.init()``
  call time. Deployments that set ``AGENT_TYPE=supervised`` or
  ``batch`` must migrate to ``production`` (or ``coding`` for
  developer-driven smoke runs) before upgrading.
- **Plugin emits ``agent_type="coding"`` hardcoded** instead of the
  legacy ``developer``. Historical rows were normalized by
  migration ``000014``; migration ``000015`` TRUNCATEs sessions on
  upgrade so pre-v0.4.0 data is not preserved.
- **Fleet API response shape.** ``GET /v1/fleet`` no longer returns
  ``{flavors: [...]}`` with sessions nested; it returns
  ``{agents: [...]}`` with an aggregated state rollup.
- **Ingestion rejects events without the new identity fields.** Any
  third-party emitter POSTing bare ``session_id`` + ``event_type``
  payloads must start emitting ``agent_id``, ``agent_type``, and
  ``client_type``. The Python sensor and Claude Code plugin do
  this automatically.

## v0.1.0a1 (2026-04-07)

### Added

- Initial sensor package: init(), wrap(), patch(), session lifecycle,
  Anthropic and OpenAI provider support
- Ingestion API: event receipt, NATS publish, directive envelope
- Go workers: session state machine, token policy evaluation
- Query API: fleet endpoint, WebSocket stream
- Docker Compose dev environment
