# Changelog

All notable changes to Flightdeck are documented here.

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
