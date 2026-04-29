# Changelog

All notable changes to Flightdeck are documented here.

## Unreleased — Phase 5 MCP first-class observability

Treats Model Context Protocol calls as a first-class event surface
alongside chat and embeddings. Single PR covering sensor, worker,
API, dashboard, plugin, integration tests, smoke matrix, playground,
and docs.

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
  (``TOOL CALL`` / ``TOOLS DISCOVERED`` / ``RESOURCE READ`` /
  ``RESOURCES DISCOVERED`` / ``PROMPT FETCHED`` /
  ``PROMPTS DISCOVERED``). Verb-based labels distinguish "agent
  invoked" from "agent discovered" without the bare singular/plural-s
  ambiguity of pre-B-4 labels (``MCP TOOL`` vs ``MCP TOOLS``).
  Family attribution comes from the cyan/green/purple colour family
  + the swimlane hexagon shape (B-5b) + the row's adjacent server
  name in the detail text — repeating an "MCP" prefix on every
  badge would consume drawer width without adding signal.
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
- **Tests (smoke):** Phase 5 MCP coverage folded into the existing
  per-framework smoke files
  (``test_smoke_langchain.py``, ``test_smoke_claude_code.py``) plus
  three new per-framework files
  (``test_smoke_langgraph.py``, ``test_smoke_llamaindex.py``,
  ``test_smoke_crewai.py``) that gain chat smokes alongside their
  MCP coverage. Bare-``mcp``-SDK coverage lives in
  ``test_smoke_mcp.py``. Shared in-tree reference server at
  ``tests/smoke/fixtures/mcp_reference_server.py``; the bare-SDK
  smoke's multi-server attribution test uses a sibling
  ``tests/smoke/fixtures/mcp_secondary_server.py`` fixture.
  Framework smokes pytest-skip when the relevant adapter package
  isn't installed.
- **Playground:** ``13_mcp.py`` covers the bare ``mcp`` SDK against
  the in-tree reference server and a multi-server attribution
  scenario via a sibling ``_secondary_mcp_server.py`` utility module.
  Framework MCP coverage rides as an additional section inside the
  existing per-provider playground files (``03_langchain.py``,
  ``04_langgraph.py``, ``05_llamaindex.py``, ``06_crewai.py``);
  each MCP block skips cleanly when its adapter isn't installed.
- **Make:** Per-framework smoke targets
  (``smoke-langgraph``, ``smoke-llamaindex``, ``smoke-crewai``)
  cover both chat and MCP for their framework. ``smoke-langchain``
  and ``smoke-claude-code`` extend their existing scope with MCP
  coverage. ``smoke-mcp`` runs the bare-SDK target. ``smoke-all``
  enumerates every per-framework target plus ``smoke-mcp``; the
  prior ``smoke-mcp-*`` per-framework targets are removed in favour
  of the unified per-framework convention.
- **Dashboard:** Live feed hides MCP discovery events
  (``mcp_tool_list`` / ``mcp_resource_list`` /
  ``mcp_prompt_list``) by default. A "Discovery events" toggle in
  the filter bar restores them; preference persists in
  ``localStorage`` under ``flightdeck.feed.showDiscoveryEvents``.
  The session drawer event timeline is unaffected and always shows
  the full event history. The Fleet swimlane dims discovery
  hexagons when the toggle is off (mirroring how it dims
  filter-mismatched events). See **D122**.

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
