# Changelog

All notable changes to Flightdeck are documented here.

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
