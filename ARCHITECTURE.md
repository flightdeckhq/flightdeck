# Flightdeck Architecture

> **For Claude Code:** Read this entire document before writing any code. This
> is the single source of truth for all architectural decisions. When in
> doubt, refer back here. Every component has a Makefile. If you are writing
> a component that does not have one, stop and create it first.
>
> **This is a living document.** When implementation reveals that a design
> here is wrong or has drifted from reality, update this document before
> merging code. Record the reason in the PR, and in DECISIONS.md when it
> changes a contract, the schema or a trust boundary. ARCHITECTURE describes
> what the system IS today; phase ancestry, change history, and forward-
> looking plans live in CHANGELOG.md, PR descriptions, and README.md
> respectively.

---

## Executive Summary

Flightdeck is an open source agent control platform. It gives engineering
teams real-time visibility into every AI agent running across their
organization — what it is, what it is doing, what it has done, and how many
tokens it has consumed. It also provides runtime enforcement: token budget
policy applied centrally and enforced at call time, plus a kill switch that
can stop any agent or an entire fleet of agents of a given type from a
single dashboard action.

Flightdeck is not a proxy. It does not sit in the path of LLM traffic. It
uses a sensor-and-control-plane architecture. The sensor
(`flightdeck-sensor`) runs in-process inside the agent, reports out-of-band
over HTTP, and receives directives back in HTTP response envelopes. There is
no single point of failure introduced into the agent's execution path.

---

## What Flightdeck IS and IS NOT

**IS:**

- A sensor library that integrates into any Python AI agent with two lines
  of code (`init` + `patch`).
- A central control plane (ingestion + workers + Postgres + API + dashboard)
  that aggregates every event into a fleet view.
- A token budget enforcer: warn, degrade, block — applied at call time
  inside the agent, configured centrally.
- A kill switch: stop one run, or every live run of an agent, from a
  dashboard click; the API can also stop every run of a flavor.
- A prompt and embedding-input recorder, gated by `capture_prompts` (off by
  default in the sensor, on by default in the Claude Code plugin).
- A Claude Code observer via a hook plugin. It reports every hook event
  and denies MCP tool calls that the flavor's MCP policy blocks; it has no
  kill switch and no token-budget enforcement.
- An analytics surface across tokens, sessions, latency, policy events, and
  estimated cost — flexible group-by across `flavor`, `model`, `framework`,
  `host`, `agent_type`, `team`, `provider`, `agent_role`,
  `parent_session_id`.

**IS NOT:**

- Not a proxy. Never intercepts LLM traffic on the network.
- Not a content inspector by default. The sensor ships with prompt capture
  off (`capture_prompts=False`); the Claude Code plugin, which observes a
  developer's own session, ships with it on, and
  `FLIGHTDECK_CAPTURE_PROMPTS=false` turns it off.
- Not an orchestrator. Never tells agents what to do.
- Not a billing system. `estimated_cost` estimates per-token spend from
  list prices, or uses the cost a gateway or client reported; actual
  invoices differ. Usage covered by a flat-rate subscription is not
  priced.
- Not a notification platform. No Slack, email, or PagerDuty.
- Not multi-tenant SaaS. Self-hosted only.
- Not an LLM gateway. No model substitution, no caching, no retries
  injected by Flightdeck.

---

## System Architecture

```
┌─────────────────────┐ ┌──────────────────────────┐
│   Agent Process     │          │   React Dashboard :3000  │
│                     │          │                          │
│  flightdeck-sensor  │          │  Fleet, Events,          │
│  Session + Policy   │          │  Session drawer,         │
│  Interceptor        │          │  Analytics, Search       │
└────────┬────────────┘          └────────┬─────────────────┘
         │                                │
         │ POST /ingest/v1/events         │ REST  /api/*
         │ GET  /api/v1/policy            │ WS    /api/v1/stream
         │                                │ GET   / (SPA static)
         ▼ ▼
┌──────────────────────────────────────────────────────────┐
│          flightdeck :4000 (one process; router)          │
│                                                          │
│  /ingest/*  → ingestion mux   (path as sent)             │
│  /api/*     → query API mux   (path as sent)             │
│  /          → embedded dashboard + /runtime-config.json  │
│  /api/v1/stream  → query API  (WebSocket upgrade)        │
└───────┬──────────────────────────────┬───────────────────┘
        │                              │
        ▼ ▼
┌──────────────────────┐ ┌──────────────────────────────┐
│ Ingestion API :8080  │    │     Query API :8081          │
│                      │    │                              │
│ POST /v1/events      │    │ GET /v1/fleet                │
│ POST /v1/heartbeat   │    │ GET /v1/sessions(/:id)       │
│ POST /v1/logs        │    │ GET /v1/agents(/:id/summary) │
│ POST /v1/traces      │    │ GET /v1/events               │
│ POST /v1/metrics     │    │ GET /v1/events/:id/content   │
│ GET  /health         │    │ GET /v1/policy               │
│ GET  /docs/          │    │ GET/POST/PUT/DELETE          │
│                      │    │   /v1/policies               │
│ Auth: validates      │    │ POST /v1/directives          │
│   bearer token       │    │ GET /v1/directives/custom    │
│   (access_tokens)    │    │ POST /v1/directives/sync     │
│                      │    │ POST /v1/directives/register │
│ Directive: reads +   │    │ GET /v1/analytics            │
│   marks delivered    │    │ GET /v1/search               │
│                      │    │ POST /v1/admin/*             │
│                      │    │ WS  /v1/stream               │
│                      │    │ GET /docs/                   │
│                      │    │                              │
│                      │    │ LISTEN flightdeck_fleet      │
│                      │    │   → broadcasts to WS clients │
└──────────┬───────────┘    └──────────┬───────────────────┘
           │                           │
           │ PUBLISH                   │ SQL
           │ FLIGHTDECK.events.*       │
           ▼                           │
┌──────────────────────┐               │
│  NATS JetStream      │               │
│  :4222               │               │
│                      │               │
│  Stream: FLIGHTDECK  │               │
│  Subjects: events.>  │               │
│  Storage: file       │               │
│  Limits: 72 h, 5 GiB │               │
│  Discard: old        │               │
│  Durable: flightdeck │               │
│    -workers          │               │
└──────────┬───────────┘               │
           │                           │
           │ PULL events.>             │
           │ Ack/Nak/Term              │
           ▼                           │
┌──────────────────────┐               │
│  Workers             │               │
│  (no HTTP port)      │               │
│                      │               │
│  Consumer pool       │               │
│  Session processor   │               │
│  Policy evaluator    │               │
│  Background          │               │
│    reconciler        │               │
└──────────┬───────────┘               │
           │                           │
           │ SQL writes + NOTIFY       │
           │                           │
           ▼ ▼
┌──────────────────────────────────────────────────────────┐
│                PostgreSQL :5432                          │
│                                                          │
│  Written by Workers:                                     │
│    agents          sessions        events                │
│    event_content   directives                            │
│                                                          │
│  Written by Query API:                                   │
│    token_policies  custom_directives  access_tokens      │
│                                                          │
│  NOTIFY channel: flightdeck_fleet                        │
│    Workers send NOTIFY after every event write and       │
│    every session state change                            │
│    Query API hub receives via LISTEN                     │
└──────────────────────────────────────────────────────────┘
```

**Data flows:**

  Ingestion API → Postgres:
    READ  access_tokens   (auth on every request)
    READ  sessions        (directive flavor lookup)
    READ+WRITE directives (lookup pending + mark delivered)

  Workers → Postgres:
    WRITE agents, sessions, events, event_content, directives
    READ  sessions        (terminal check, token count)
    READ  token_policies  (policy evaluation)
    READ  directives      (shutdown dedup check)
    NOTIFY flightdeck_fleet (after every event write and every
                            session state change)

  Query API → Postgres:
    READ  sessions, events, event_content, agents, custom_directives
    READ  directives (pending directive check)
    READ+WRITE token_policies, custom_directives, access_tokens (CRUD)
    WRITE directives (POST /v1/directives)
    LISTEN flightdeck_fleet (real-time push to dashboard)

---

## Repository Structure

```
flightdeck/
├── ARCHITECTURE.md             # This file -- read before writing any code
├── DECISIONS.md                # Contract, schema and trust-boundary decisions and the alternatives rejected
├── DECISIONS-ARCHIVE.md        # Frozen archive of earlier decision records
├── CLAUDE.md                   # Standing rules for Claude Code sessions
├── CONTRIBUTING.md             # Contributor guide: setup, tests, PR process
├── RELEASING.md                # How to cut a release: version bump, tag, verify
├── CHANGELOG.md                # Version history (Keep-a-Changelog)
├── README.md                   # User-facing documentation
├── SECURITY.md                 # Security policy: supported versions, reporting, capture posture
├── CODE_OF_CONDUCT.md
├── LICENSE                     # Apache-2.0
├── Makefile                    # Root Makefile -- orchestrates all components; builds the flightdeck binary
├── go.work                     # Go workspace: the root module, the storage module and the three service modules
├── go.mod                      # Root module github.com/flightdeckhq/flightdeck: the one `flightdeck` binary (migrates from the storage module's embedded files)
├── cmd/flightdeck/main.go      # The binary: flags, data dir, Postgres, embedded NATS, the three services, the router
├── internal/                   # The binary's packages: cli (flags + env), datadir (dir, secrets), bootstrap (token mode),
│                               # natsembed (in-process nats-server), router (dashboard, /api, /ingest, runtime-config)
├── webui/                      # go:embed of the dashboard bundle; dist/ is filled by `make build-webui` (gitignored)
├── pricing.yaml                # Price overrides, model-id aliases and cost multipliers layered over the vendored catalogue
├── .claude-plugin/marketplace.json  # Claude Code plugin marketplace manifest (points at plugin/ by release tag)
├── .claude/                    # Repo-local Claude Code config: review-pipeline agents + guidelines, /audit-repo command, settings
├── assets/                     # Demo GIFs embedded in README.md
├── VERSION                     # The release version; scripts/version.py writes it into every file that carries it
├── scripts/release.sh          # Release script: `make release-prep` / `make release-tag VERSION=vX.Y.Z`
├── scripts/version.py          # Version source tool: set / check / check --tag / changelog
├── scripts/pricing_refresh.py  # `make pricing-refresh`: regenerates the vendored pricing catalogue from litellm's price list
├── docs/                       # GitHub Pages landing site (index.html, 404.html, CNAME, assets/)
│
├── sensor/                     # flightdeck-sensor Python package (PyPI)
│   ├── Makefile
│   ├── pyproject.toml
│   ├── README.md               # Package-level user docs
│   ├── CLAUDE.md               # Sensor + framework-coverage rules for Claude Code sessions
│   ├── flightdeck_sensor/
│   │   ├── __init__.py         # Public API: init, wrap, patch, get_status, teardown, directive
│   │   ├── py.typed            # PEP 561 marker
│   │   ├── config.py           # Single source of truth for FLIGHTDECK_* env var names
│   │   ├── provider.py         # Provider enum: canonical interceptor target names accepted by patch()
│   │   ├── core/
│   │   │   ├── types.py        # SessionState, EventType, DirectiveAction, SensorConfig, PromptContent
│   │   │   ├── session.py      # Session: lifecycle, identity, atexit/signal handlers, runtime context
│   │   │   ├── policy.py       # PolicyCache: local token enforcement, threshold evaluation
│   │   │   ├── mcp_policy.py   # MCP Protection Policy cache + per-server resolution (preflight fetch, hot-path evaluation)
│   │   │   ├── context.py      # Pluggable runtime context collectors + framework classifiers
│   │   │   ├── schemas.py      # Pydantic v2 control-plane envelope validation
│   │   │   ├── agent_id.py     # 5-tuple → deterministic agent_id derivation
│   │   │   ├── errors.py       # Provider exception or non-success stop reason → structured llm_error taxonomy + payload wrapper
│   │   │   ├── exceptions.py   # BudgetExceededError, DirectiveError, ConfigurationError
│   │   │   ├── tool_capture.py # event_content envelope for a captured tool call (MCP, LLM-side, Agent SDK)
│   │   │   └── import_hook.py  # sys.meta_path finder: runs patch() for an SDK as the application imports it
│   │   ├── transport/
│   │   │   ├── client.py       # ControlPlaneClient + EventQueue (drain + directive threads; the drain thread ends the session for a signal)
│   │   │   ├── body_limit.py   # Event serialisation within the ingestion body limit
│   │   │   └── retry.py        # Exponential backoff, unavailability policy enforcement
│   │   ├── interceptor/
│   │   │   ├── base.py         # call, call_async, call_stream, call_stream_async, the stream guards + the outer-call mark
│   │   │   ├── platform.py     # Endpoint attribution: host → platform label, loopback → local billing
│   │   │   ├── raw_views.py    # Deferred metering of the SDKs' raw and streaming response views
│   │   │   ├── anthropic.py    # SensorAnthropic + resource-level patch of the SDK's Messages classes
│   │   │   ├── openai.py       # SensorOpenAI + chat / responses / embeddings descriptors
│   │   │   ├── litellm.py      # SensorLitellm: module-level completion / embedding patch
│   │   │   ├── mcp.py          # mcp.client.session.ClientSession patch: every MCP operation, every transport
│   │   │   ├── mcp_identity.py # MCP server identity: canonical URL form + SHA-256 fingerprint
│   │   │   ├── crewai.py       # CrewAI Agent.execute_task patch → one child session per agent turn
│   │   │   ├── langgraph.py    # LangGraph StateGraph.add_node patch → one child session per node invocation
│   │   │   ├── llama_index.py  # LlamaIndex instrumentation span handler → one child session per agent of an agent workflow run
│   │   │   └── claude_agent_sdk.py # Claude Agent SDK query() / ClaudeSDKClient patch → one session per run
│   │   ├── providers/
│   │   │   ├── protocol.py     # Provider Protocol: token estimation, usage extraction (incl. in-stream usage), call details, endpoint vendor / locality, content extraction
│   │   │   ├── anthropic.py    # AnthropicProvider: handles system, messages, tools, response
│   │   │   ├── openai.py       # OpenAIProvider: handles messages, tools, response, embeddings input
│   │   │   └── litellm.py      # LitellmProvider: ModelResponse usage / tool-invocation extraction
│   │   └── compat/
│   │       └── crewai_mcp.py   # Opt-in fixup for the mcpadapt → CrewAI args_schema JSON Schema bug
│   └── tests/
│       ├── conftest.py         # Mock control plane + provider fixtures
│       └── unit/               # 50 test files, plus the child-process helpers some of them run
│           ├── _child_process.py
│           ├── _lazy_patch_child.py
│           ├── _signal_child.py
│           ├── test_agent_id.py
│           ├── test_agent_type_validation.py
│           ├── test_anthropic_resource_patch.py
│           ├── test_body_limit.py
│           ├── test_compat_crewai_mcp.py
│           ├── test_context.py
│           ├── test_cross_agent_messages.py
│           ├── test_custom_directives.py
│           ├── test_deferred_stream_unread.py
│           ├── test_egress_url_validation.py
│           ├── test_errors.py
│           ├── test_framework_attribution.py
│           ├── test_identity_vectors.py
│           ├── test_import_hook.py
│           ├── test_interceptor.py
│           ├── test_interceptor_claude_agent_sdk.py
│           ├── test_interceptor_crewai.py
│           ├── test_interceptor_langgraph.py
│           ├── test_interceptor_litellm.py
│           ├── test_interceptor_litellm_routes.py
│           ├── test_lazy_patch.py
│           ├── test_llm_event_enrichment.py
│           ├── test_mcp_2x_paths.py
│           ├── test_mcp_availability.py
│           ├── test_mcp_identity.py
│           ├── test_mcp_interceptor.py
│           ├── test_mcp_policy_emission_enriched.py
│           ├── test_mcp_policy_enforcement.py
│           ├── test_mcp_policy_enforcement_all_paths.py
│           ├── test_openai_beta_chat.py
│           ├── test_openai_parse_responses.py
│           ├── test_originating_event_id.py
│           ├── test_patch.py
│           ├── test_policy.py
│           ├── test_policy_decision_summary.py
│           ├── test_policy_directive_events.py
│           ├── test_policy_emission_enriched.py
│           ├── test_policy_events.py
│           ├── test_prompt_capture.py
│           ├── test_provider_enum.py
│           ├── test_providers.py
│           ├── test_raw_stream_capture.py
│           ├── test_session.py
│           ├── test_session_lifecycle_enrichment.py
│           ├── test_signal_shutdown.py
│           ├── test_stop_reason_errors.py
│           ├── test_streaming_usage.py
│           ├── test_token_cost_fields.py
│           ├── test_tool_capture_destination.py
│           └── test_transport.py
│
├── ingestion/                  # Ingestion API (Go)
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/main.go             # Entry: environment to app.Config, app.Run
│   ├── app/app.go              # The service as a library: Config, Deps (storage DB, pgx pool, NATS), New, Run, Handler (the binary composes it)
│   ├── docs/                   # Generated by swaggo/swag
│   ├── internal/
│   │   ├── config/config.go    # Config struct: env-driven
│   │   ├── server/server.go    # HTTP server, routes, recovery middleware, request logging
│   │   ├── metrics/metrics.go  # Request-latency histogram, the middleware that times each request by route pattern, and the /metrics listener
│   │   ├── handlers/
│   │   │   ├── events.go       # POST /v1/events: validate, publish NATS, return directive
│   │   │   ├── event_fields.go # Exact-case field-name check on every event key (the worker's decoder ignores case)
│   │   │   ├── streaming_fields.go # Streaming and llm_error sub-object validation; out-of-vocabulary diagnostic values kept as a catch-all
│   │   │   ├── token_cost.go   # Validation of the token, model and cost fields
│   │   │   ├── heartbeat.go    # POST /v1/heartbeat
│   │   │   ├── health.go       # GET /health
│   │   │   ├── otlp.go         # POST /v1/logs, /v1/traces, /v1/metrics: OTLP/HTTP transport, limits, export responses
│   │   │   ├── otlp_decode.go  # OTLP limits: exact gzip inflate, decode-cost estimate, decode slots
│   │   │   ├── otlp_json.go    # OTLP JSON decoding (streaming in-place hex id rewrite)
│   │   │   ├── otlp_dialect.go # OTLPDialect: decoded export request → events to publish + rejected count
│   │   │   ├── otlp_attrs.go   # OTLP attribute reads whatever the value's sent type
│   │   │   ├── otlp_claude_code.go # Claude Code dialect: log records → events, content bounds, event ids
│   │   │   ├── otlp_claude_code_session.go # Session reads the Claude Code dialect makes before it publishes
│   │   │   ├── otlp_publish.go # The receiver's publish path (token stamp, attachment check, start sequence), shared with the GenAI assembler
│   │   │   ├── otlp_router.go  # OTLPRouter: each resource to its dialect by scope (Claude Code, GenAI staging), everything else rejected with its scope named
│   │   │   ├── otlp_genai_stage.go # A request's GenAI records grouped by trace for the staging write; the units it is charged
│   │   │   ├── ratelimit.go    # Per-token sliding-window rate limiter (in-memory, keyed by token hash; auth runs first)
│   │   │   └── (Swagger UI route)
│   │   ├── auth/token.go       # Bearer token validation against access_tokens
│   │   ├── auth/revocation.go  # Subscribes to revoked tokens on the storage Bus: evicts them from the validation cache
│   │   ├── nats/publisher.go   # JetStream publisher (event_type → subject routing)
│   │   ├── nats/stream.go      # Creates the FLIGHTDECK stream or updates its limits and replicas in place
│   │   ├── session/store.go    # Synchronous attach-on-session_start and the start-sequence stamp (writer)
│   │   ├── otlpstage/store.go  # OTLP GenAI staging: stage records, claim due traces under a lease, load, mark assembled, sweeps
│   │   ├── genai/              # OTLP GenAI mapping, pure (no I/O): scope table, span/log record → content-free fact, trace index, identity, Resolve (trace → events)
│   │   ├── pgtext/pgtext.go    # Text and JSON Postgres can store (U+0000 and lone surrogates → U+FFFD); database errors described without their data
│   │   ├── assembler/assembler.go # OTLP GenAI assembler: claim due traces, completeness, chunked publish under lease renewal, mark, sweeps
│   │   └── directive/store.go  # Pending directive lookup (atomic UPDATE...RETURNING)
│   └── tests/
│       ├── handler_test.go
│       ├── otlp_handler_test.go # OTLP receiver: recorded fixtures replayed, every error path
│       └── token_cost_test.go  # Token, model and cost field validation
│
├── workers/                    # Go event processing workers (HTTP only for /metrics)
│   ├── Makefile
│   ├── Dockerfile
│   ├── cmd/main.go             # Entry: environment to app.Config, app.Run
│   ├── app/app.go              # The service as a library: Config, Deps (pool, NATS, migrations FS), Migrate, Run
│   ├── internal/
│   │   ├── config/config.go
│   │   ├── consumer/nats.go    # JetStream consumer: waits for the stream, fetch loop, session_id check, ack handling
│   │   ├── consumer/lanes.go   # Per-session lanes, keepalive, processing deadline
│   │   ├── logcap/logcap.go    # Named caps for payload strings written to log lines
│   │   ├── migrate/migrate.go  # golang-migrate runner: applies storage/migrations/postgres at boot, from a directory (mounted at /migrations) or an embedded fs.FS
│   │   ├── metrics/metrics.go  # Atomic, reason-labelled dropped / closed / revived counters + Snapshot + Prometheus-text Handler + NewServer (the /metrics listener)
│   │   ├── modelid/canonical.go  # Model-id canonicalisation and provider derivation (pure; test-vector table)
│   │   ├── billing/billing.go    # Billing-mode defaults for LLM events
│   │   ├── processor/
│   │   │   ├── event.go        # Route incoming event to session, writer, policy evaluator
│   │   │   ├── model_fields.go # Write-path model rules: billing-mode default, model_requested / model_served, canonical id
│   │   │   ├── failed_stream.go # A failed stream's delivered and billed tokens on its llm_error, counted like a post_call
│   │   │   ├── session.go      # State machine: active/idle/stale/closed/lost + reconciler
│   │   │   └── policy.go       # Threshold evaluation, directive emission
│   │   ├── writer/
│   │   │   ├── postgres.go     # Upsert agents, sessions, events, event_content via pgx
│   │   │   ├── pool.go         # pgx pool: statement lock timeout under the processing deadline
│   │   │   ├── backfill.go     # Batched model-id backfill of events stored with raw ids
│   │   │   └── notify.go       # Postgres NOTIFY after each event write and session state change (real-time dashboard push)
│   │   └── models/             # Go structs mirroring all Postgres tables
│   └── tests/
│       ├── processor_test.go
│       ├── build_event_extra_test.go           # events.payload projection: llm_error + streaming sub-objects, plugin tool_use_id / mcp_server / end_reason
│       ├── build_event_extra_mcp_test.go       # events.payload projection: MCP event fields
│       ├── build_event_extra_subagent_test.go  # events.payload projection: sub-agent fields
│       └── build_event_extra_token_cost_test.go  # events.payload projection: token and cost fields
│
├── api/                        # Query API (Go)
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/main.go             # Entry: environment to app.Config, app.Run
│   ├── app/app.go              # The service as a library: Config, Deps, New, Run, Handler, the bootstrap-token helpers
│   ├── docs/                   # Generated by swaggo/swag
│   ├── internal/
│   │   ├── config/config.go
│   │   ├── server/server.go    # Router, CORS, auth middleware, withRESTTimeout
│   │   ├── metrics/metrics.go  # Request-latency histogram and /metrics listener (twin of ingestion/internal/metrics)
│   │   ├── auth/token.go       # Bearer token validation against access_tokens (same rules as ingestion's)
│   │   ├── auth/revocation.go  # LISTEN for revoked tokens: evicts them from the validation cache
│   │   ├── mcp_identity/identity.go  # MCP server identity canonicalisation + fingerprint (Go twin of the sensor / plugin helpers)
│   │   ├── modelid/canonical.go  # Model-id canonicalisation (twin of workers/internal/modelid, same test vectors)
│   │   ├── handlers/
│   │   │   ├── fleet.go            # GET /v1/fleet
│   │   │   ├── sessions.go         # GET /v1/sessions/:id
│   │   │   ├── sessions_list.go    # GET /v1/sessions (filters, sort, pagination)
│   │   │   ├── agents.go           # GET /v1/agents, /v1/agents/:id/summary
│   │   │   ├── content.go          # GET /v1/events/:id/content
│   │   │   ├── search.go           # GET /v1/search
│   │   │   ├── directives.go       # POST /v1/directives
│   │   │   ├── custom_directives.go# POST /v1/directives/sync, /register; GET + DELETE /v1/directives/custom
│   │   │   ├── policies.go         # GET/POST /v1/policies, PUT/DELETE /v1/policies/:id, GET /v1/policy
│   │   │   ├── mcp_policy.go       # /v1/mcp-policies/global + /v1/mcp-policies/:flavor CRUD
│   │   │   ├── mcp_policy_resolve.go    # GET /v1/mcp-policies/resolve (sensor / plugin preflight)
│   │   │   ├── mcp_policy_audit_log.go  # GET /v1/mcp-policies/{global,:flavor}/audit-log + shared scope path parsing
│   │   │   ├── mcp_policy_metrics.go    # GET /v1/mcp-policies/:flavor/metrics
│   │   │   ├── mcp_policy_templates.go  # GET /v1/mcp-policies/templates, POST /v1/mcp-policies/:flavor/apply_template
│   │   │   ├── mcp_policy_templates/    # Embedded YAML templates: strict-baseline, permissive-dev, strict-with-common-allows
│   │   │   ├── analytics.go        # GET /v1/analytics
│   │   │   ├── events_list.go      # GET /v1/events (bulk, paginated)
│   │   │   ├── access_tokens.go    # /v1/access-tokens CRUD
│   │   │   ├── admin_reconcile.go  # POST /v1/admin/reconcile-agents
│   │   │   ├── stream.go           # WS /v1/stream
│   │   │   ├── uuid.go             # Shared UUID path / query param validator
│   │   │   └── health.go
│   │   ├── store/
│   │   │   ├── postgres.go         # Store + pool; fleet, session detail, session events, token policies,
│   │   │   │                       # directives, custom directives, event content, context facets via pgx
│   │   │   ├── sessions.go         # Listing + filters (framework, error_type)
│   │   │   ├── events.go           # Bulk events query + event facets
│   │   │   ├── agents.go           # Agents listing: filters, sort, search, pagination; agent by id
│   │   │   ├── agent_summary.go    # Per-agent windowed activity summary
│   │   │   ├── agents_reconcile.go # Recompute agents.total_sessions / total_tokens rollups
│   │   │   ├── analytics.go        # GROUP BY queries across all dimensions
│   │   │   ├── pricing.go          # Cost SQL: joins events to model_pricing, applies the billing-mode rules and multipliers
│   │   │   ├── pricing_loader.go   # Merges the catalogue with pricing.yaml (FLIGHTDECK_PRICING_PATH → /etc/flightdeck → ./) and rebuilds model_pricing at startup
│   │   │   ├── pricing_catalogue.json  # Vendored, pruned litellm price list, embedded in the binary
│   │   │   ├── pricing_catalogue.go    # Maps the catalogue onto model_pricing rows (canonical id × platform family)
│   │   │   ├── mcp_policy_store.go # MCP Protection Policy SQL (transactional entries replace + audit row)
│   │   │   ├── mcp_policy_types.go # Go structs for mcp_policies / mcp_policy_entries rows and API DTOs
│   │   │   ├── access_tokens.go
│   │   │   └── search.go
│   │   └── ws/hub.go               # WebSocket hub: client registry, broadcast on PG NOTIFY
│   └── tests/handler_test.go
│
├── dashboard/                  # React + TypeScript + Vite + Zustand
│   ├── Makefile
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── index.html              # Theme class on html element
│   ├── vite.config.ts          # React and Tailwind CSS 4 (@tailwindcss/vite) plugins
│   ├── tsconfig.json
│   ├── package.json
│   ├── eslint.config.js
│   ├── vitest.config.ts
│   ├── playwright.config.ts
│   ├── CLAUDE.md               # Frontend + E2E discipline rules for Claude Code sessions
│   ├── public/                 # runtime-config.json (access-token bootstrap), favicons, brand lockups
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/              # Fleet.tsx, Agents.tsx, Investigate.tsx (Events), Analytics.tsx,
│   │   │                       # Policies.tsx, Directives.tsx, Settings.tsx, NotFound.tsx
│   │   ├── components/
│   │   │   ├── timeline/       # Timeline, SwimLane, VirtualizedSwimLane, EventNode, TimeAxis,
│   │   │   │                   # RunBracket, AgentStatusBadge, SubAgentConnector
│   │   │   ├── fleet/          # FleetPanel, SessionStateBar, LiveFeed,
│   │   │   │                   # EventDetailDrawer, EventFilterBar, TopologyCell
│   │   │   ├── agents/         # AgentTable, AgentTableRow, AgentFacetSidebar, AgentSparkline,
│   │   │   │                   # AgentDrawer, AgentDrawerEventsTab, AgentDrawerRunsTab, PerAgentSwimlaneModal
│   │   │   ├── events/         # EnrichmentSummary, SurroundingEventsList
│   │   │   ├── session/        # SessionDrawer, EventRow, PromptViewer,
│   │   │   │                   # EmbeddingsContentViewer, ErrorEventDetails, MCPEventDetails,
│   │   │   │                   # PolicyEventDetails, SubAgentsTab, TokenUsageBar, AccordionHeader
│   │   │   ├── analytics/      # SummaryCards, ChartCard, DimensionChart, DimensionPicker, TimeSeriesChart,
│   │   │   │                   # StackedSeriesChart, TokenUsageOverTime, RankingChart, DonutChart, CostChart,
│   │   │   │                   # LatencyDistribution, ModelBarChart, ProviderBarChart, ParentChildBreakdownChart
│   │   │   ├── facets/         # AgentTypeBadge, ClientTypePill, EventTypePill, FrameworkPill,
│   │   │   │                   # RelationshipPill, SubAgentRolePill, FacetIcon
│   │   │   ├── search/         # CommandPalette, SearchResults, RecentAgents, Highlight, StateChip
│   │   │   ├── policy/         # PolicyEditor, PolicyTable, MCPProtectionTab, MCPPolicyHeader,
│   │   │   │                   # MCPPolicyEntryTable, MCPPolicyEntryDialog, MCPPolicyResolvePanel,
│   │   │   │                   # MCPPolicyAuditPanel, MCPQuickStartTemplates, MCPServerDecisionText
│   │   │   ├── directives/     # DirectiveCard
│   │   │   └── ui/             # shadcn/ui primitives (owned, copied into project) plus DateRangePicker,
│   │   │                       # Pagination, TruncatedText, OSIcon, OrchestrationIcon, provider icons / logos
│   │   ├── hooks/              # useFleet, useSession, useSessionEvents, useAnalytics, useSearch, useWebSocket,
│   │   │                       # useHistoricalEvents, useAgentSummary, useAgentEvents, useAgentRuns,
│   │   │                       # useDebouncedValue, useTheme
│   │   ├── store/
│   │   │   ├── fleet.ts        # Zustand: fleet state, session map, WebSocket stream
│   │   │   └── quickStart.ts   # Zustand: per-scope dismissal of the MCP quick-start template link (not persisted)
│   │   ├── lib/                # api, time, types, utils, events, models, constants, directives, runtime-config,
│   │   │                       # agent-identity, agent-status, agents-filter, agents-format, agents-sort,
│   │   │                       # fleet-ordering, relationship, policy-scope-labels, swimlane-lost-sub-agent,
│   │   │                       # swimlane-lanes, events-cache-epoch, useSwimlaneScroll, allRowCollapsed,
│   │   │                       # discoveryEventsPref, leftPanelWidth, investigate-sidebar-width
│   │   ├── types/context.ts    # Runtime-context types shared by the CONTEXT sidebar and the session drawer
│   │   └── styles/             # globals.css (Tailwind import, @theme colour tokens), themes.css
│   └── tests/                  # unit (Vitest + RTL), e2e (Playwright), setup.ts
│
├── plugin/                     # Claude Code hook plugin
│   ├── README.md               # Install, configuration, what gets reported
│   ├── package.json            # Zero runtime dependencies
│   ├── .claude-plugin/plugin.json  # Plugin manifest (name, version, author)
│   ├── hooks/
│   │   ├── hooks.json          # SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
│   │   │                       # PostToolUseFailure, Stop, StopFailure, SessionEnd,
│   │   │                       # PreCompact, PostCompact, PostModelSwitch, Notification,
│   │   │                       # PermissionRequest, PermissionDenied, SubagentStart,
│   │   │                       # SubagentStop -- every hook runs observe_cli.mjs
│   │   └── scripts/
│   │       ├── observe_cli.mjs           # Hook entry: reads + parses stdin, hands the event to claude_code/dispatch.mjs;
│   │       │                             # re-invoked with --session-end-worker as the detached SessionEnd worker
│   │       ├── core/                     # Client-agnostic hook-adapter pieces
│   │       │   ├── config.mjs            # FLIGHTDECK_* resolution, value bounds, plugin version
│   │       │   ├── poster.mjs            # Event POST with timeout + one-line failure logging
│   │       │   ├── state.mjs             # The state directory: every on-disk marker and cache, pruning
│   │       │   └── events.mjs            # Hook-name -> event_type alias table a binding supplies
│   │       ├── claude_code/              # Claude Code binding
│   │       │   ├── dispatch.mjs          # Routes one hook event to its emission
│   │       │   ├── events.mjs            # Claude Code hook -> event_type table (EVENT_MAP)
│   │       │   ├── session.mjs           # Native + Flightdeck session id, marker clearing, session_start backstop
│   │       │   ├── context.mjs           # Runtime context and Claude Code run-mode signals (entrypoint, CI, remote)
│   │       │   ├── transcript.mjs        # Transcript JSONL reader: per-call turns, tokens, latency
│   │       │   ├── post_call.mjs         # Session billing endpoint, cost fields, deduplicated post_call flush
│   │       │   ├── stop_failure.mjs      # StopFailure -> llm_error: Claude Code's API-error codes in the shared taxonomy
│   │       │   ├── signals.mjs           # Compaction, model-switch, notification, permission, command, task, teammate, cwd, config and elicitation hooks -> session_signal
│   │       │   ├── tools.mjs             # Tool-input sanitiser, tool duration, tool error block
│   │       │   ├── tool_events.mjs       # Tool event delivery: owed record kept until the POST is answered, rebuild of a failed POST
│   │       │   ├── mcp.mjs               # MCP tool-name parsing, server fingerprints, mcp_tool_call emission
│   │       │   ├── mcp_policy_dispatch.mjs  # MCP policy at SessionStart, PreToolUse decision, PostToolUse approval
│   │       │   ├── control.mjs           # Enforcement: directive control state, PreToolUse / UserPromptSubmit gates, budget notices
│   │       │   ├── subagent.mjs          # SubagentStart/Stop child sessions, interior-hook routing
│   │       │   └── session_end.mjs       # SessionEnd hand-off to the detached worker, worker log
│   │       ├── agent_id.mjs              # agent_id derivation (Node twin of sensor core/agent_id.py)
│   │       ├── billing.mjs               # Billing mode + platform detection (`claude auth status`, provider env), usage detail fields
│   │       ├── uuid5.mjs                 # RFC 4122 v5 UUID, no npm dependency
│   │       ├── mcp_identity.mjs          # MCP server identity (Node twin of sensor interceptor/mcp_identity.py)
│   │       ├── mcp_policy.mjs            # MCP policy fetch, per-session policy cache, per-server classification
│   │       └── remembered_decisions.mjs  # Per-token cache of operator approvals for unknown MCP servers
│   ├── skills/flightdeck/SKILL.md  # /flightdeck skill
│   └── tests/                  # node --test: observe_cli, dispatchers, hook_contract (recorded
│       │                       # Claude Code hooks replayed against the ingestion contract),
│       │                       # agent_id, uuid5, mcp_identity, mcp_policy, remembered_decisions
│       └── fixtures/           # hook payloads recorded from Claude Code 2.1.306
│
├── playground/                 # Working examples per supported framework
│   ├── _helpers.py             # init_sensor with required flavor + capture defaults
│   └── *.py                    # one script per framework / scenario
│
├── storage/                    # Go module: the one database boundary (Storage section below)
│   ├── storage.go              # Open(ctx, url): sqlite:// or postgres://, *sql.DB + Dialect, SQLite read/write split
│   ├── dialect.go              # Dialect: the SQL constructs that differ between the backends
│   ├── sqlite_driver.go        # modernc wrapper: time.Time arguments written as RFC 3339 UTC text
│   ├── time.go                 # Time: scans a timestamp from either backend, column or expression
│   ├── bus.go, bus_postgres.go # Bus: in-process channels (SQLite) or LISTEN/NOTIFY (Postgres)
│   ├── migrate.go              # golang-migrate runner over the embedded migrations of both backends
│   ├── migrations/postgres/    # The Postgres migrations (canonical; compose and Helm mount copies)
│   ├── migrations/sqlite/      # 000001_baseline, then one pair per Postgres migration after it
│   └── storagetest/            # Opens migrated databases for Go tests on every backend the run covers
├── helm/                       # Kubernetes Helm chart
│   ├── Makefile                # lint / template / install / upgrade — each gates on sync-migrations
│   ├── templates/              # ConfigMap consumes migrations/ via .Files.Glob at chart-render time
│   └── migrations/             # Build artifact (gitignored); populated by `make sync-migrations`
│                               # from storage/migrations/postgres/. Single source of truth lives there.
├── docker/                     # docker-compose.{yml,dev.yml,prod.yml}, nginx, postgres/init.sql (seed only)
├── tests/
│   ├── integration/            # Full-pipeline pytest suite (real NATS + Postgres)
│   ├── e2e-fixtures/           # Canonical seed dataset for Playwright dev-stack runs
│   ├── fixtures/               # mcp_identity_vectors.json: cross-language MCP identity vectors (sensor, plugin, api)
│   └── shared/                 # fixtures.py: pytest-free helpers shared by the integration conftest and the e2e seeder
└── .github/workflows/          # ci.yml, release.yml
```

---

## Sensor

The sensor is a Python library that runs in-process inside the agent. `init`
resolves configuration; `patch` installs sensor methods on the Anthropic
SDK's `Messages` resource classes and sensor descriptors on the OpenAI
client classes, on each SDK as the application imports it (see "When
patching happens"); every LLM call passes through the sensor synchronously.
The event POST itself is offloaded onto a background queue drain thread
so it does not sit in the hot path, but the LLM call waits for the
sensor's response-envelope parsing before returning control to
user code.

Because the sensor sits in the call path, it can act on directives returned
in the response envelope. Shutdown, warn, degrade, custom handlers, and
token-budget enforcement all depend on this interception loop. The sensor
reads the directive from the POST response and applies it before the next
LLM call returns: the kill switch works because the sensor decides whether
the next `client.messages.create` call raises `BudgetExceededError` or
proceeds.

### Design principles

The sensor is a library wrapper, not an OS agent. It has no polling loops and
no network activity independent of LLM calls. It runs when called and
returns when done; the application is fully in control of when the sensor
does anything.

Two background daemon threads run: `flightdeck-event-queue` drains events to
the control plane, and `flightdeck-directive-queue` processes directives
received in event responses (kill, custom handlers, model swap, policy
updates). The queues are decoupled so a slow directive handler cannot block
event throughput. The drain thread also ends the session when the process
receives SIGTERM or SIGINT (see "Shutdown and signals"), so a signal
handler never does that work on the thread the signal interrupted.

Heartbeats, polling loops, and additional daemon threads do not belong in
the sensor. Features that require independent background activity belong in
a sidecar container or system service.

### Public API

```python
def init(
    server: str,
    token: str,
    api_url: str | None = None,      # control-plane base URL
    capture_prompts: bool = False,   # opt-in
    quiet: bool = False,
    limit: int | None = None,        # local WARN-only token threshold
    warn_at: float = 0.8,
    session_id: str | None = None,   # optional session-id hint
    billing_mode: str | None = None, # metered / subscription / local; default per endpoint
) -> None:
    """
    Initialize the sensor.

    api_url is the base URL for control-plane calls (directive registration,
    sync, policy prefetch). Derived from server by replacing "/ingest" with
    "/api" when None. Override via FLIGHTDECK_API_URL.

    limit sets a local WARN-only token threshold. Never blocks. Never
    degrades. Most restrictive threshold wins when both local and server
    policies are active.

    session_id is an optional caller-supplied identifier. When set (or when
    FLIGHTDECK_SESSION_ID is exported, which takes precedence), the sensor
    uses the caller's value verbatim instead of generating a UUID. If a
    session with that ID already exists, the backend attaches this execution
    to the prior row.

    Reads from environment (override init params):
        FLIGHTDECK_API_URL            -- control-plane base URL
        FLIGHTDECK_SESSION_ID         -- session-id hint
        AGENT_FLAVOR / FLIGHTDECK_AGENT_NAME -- persistent agent label
        AGENT_TYPE / FLIGHTDECK_AGENT_TYPE   -- "coding" or "production"
        FLIGHTDECK_HOSTNAME           -- override socket.gethostname
        FLIGHTDECK_UNAVAILABLE_POLICY -- "continue" (default) or "halt"
        FLIGHTDECK_CAPTURE_PROMPTS    -- "true" to enable
        FLIGHTDECK_BILLING_MODE       -- "metered" / "subscription" / "local"

    When capture_prompts=False (default):
        Event payloads contain token counts, model, latency, tool names only.
        No message content, no system prompts, no tool inputs/outputs.

    When capture_prompts=True:
        Event payloads include full messages array, system prompt, tool
        definitions, completion response, and embedding input. Content is
        stored in event_content table, NOT inline in events.
    """

def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap a single Anthropic SDK client (any anthropic client class:
    first-party, Bedrock, Vertex, Foundry, AWS, Mantle; sync or async) or
    OpenAI client. init must be called first."""

def patch(
    quiet: bool = False,
    providers: list[str] | None = None,
) -> None:
    """Patch the Anthropic and OpenAI SDKs in place. For Anthropic,
    replaces create / stream / parse on the SDK's Messages / AsyncMessages
    resource classes (top level, beta, and the Bedrock / Vertex beta
    resources), which every anthropic client class hands out, so every
    client is intercepted, the raw and streaming views included; a
    client built before patch() is metered from its next call, while a
    raw or streaming view first touched before patch() keeps the
    unpatched method and is not. For OpenAI, replaces the chat /
    responses / embeddings cached_property descriptors on OpenAI and
    AsyncOpenAI (on openai before 1.78, which builds them in the client
    constructor, a data descriptor per resource instead; openai below
    1.26 is left unpatched with a warning). Works with frameworks that
    build their own clients internally; isinstance checks and captured
    class references keep working. Never imports an SDK: one the application has imported is
    patched at once, one it imports later is patched as it is imported.
    Idempotent."""

def unpatch -> None:...  # also stops patching SDKs as they are imported
def get_status -> StatusResponse:...
def teardown -> None:...

def directive(
    name: str,
    description: str,
    parameters: list[Parameter] | None = None,
) -> Callable:
    """Decorator that registers a custom directive handler at module load
    time. The function registers with the control plane on init and is
    callable from the dashboard."""

# `Parameter` is an alias of `DirectiveParameter` exposed in __all__.
```

`AGENT_TYPE` accepts only `coding` or `production`. Any other value raises
`ConfigurationError` at `init`. The Claude Code plugin emits
`coding`; production agents emit `production`.

### Provider Protocol

```python
class Provider(Protocol):

    name: str   # wire name: "anthropic", "openai" or "litellm"

    def estimate_tokens(self, request_kwargs: dict) -> tuple[int, str]:
        """Estimate tokens before the call; returns (tokens, source) where
        source is "tiktoken", "heuristic" or "none". Never raises."""

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from response. Never raises."""

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Usage carried by one streamed chunk or event, or None. The stream
        guard merges successive results field by field, the larger value
        winning (the counters are cumulative). Never raises."""

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """Usage the SDK stream object holds when the guard settles
        (Anthropic's helper snapshot), or None for raw streams. Called on
        every settle path, early exit included, so it must never read
        further from the stream. Never raises."""

    def stream_completed(self, stream: Any) -> bool | None:
        """Whether the stream object knows its message is complete; None
        when it cannot tell. Never reads from the stream. Never raises."""

    def final_message(self, stream: Any) -> Any | None:
        """The complete message of a helper stream (Anthropic's accumulated
        snapshot once stop_reason is set), or None; may be an awaitable.
        Only called once stream_completed is true and never reads further.
        Never raises."""

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """Text carried by one streamed event, for the guard's text_stream
        (Anthropic content_block_delta / text_delta), or None. Never
        raises."""

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """Whether this streamed event ends the response (Anthropic
        message_stop or a message_delta with stop_reason; an OpenAI chat
        chunk carrying usage; a Responses terminal event), so
        a consumer that stops at it has read the whole response. Never
        raises."""

    def response_stop_reason(self, response: Any) -> str | None:
        """The provider's stop reason on a complete response: Anthropic
        stop_reason (a Message, a raw-response wrapper or a helper
        stream's accumulated snapshot); OpenAI chat and litellm
        finish_reason, "refusal" for a structured-output message.refusal,
        the incomplete_details.reason of a Responses call whose status is
        incomplete. None when the response carries none. Never raises."""

    def stop_reason_from_stream_chunk(self, chunk: Any) -> str | None:
        """The stop reason carried by one streamed event (Anthropic
        message_delta; an OpenAI chat chunk carrying finish_reason; an
        OpenAI response.incomplete event), or None for
        every other event, so a raw stream, which has no final message
        object, reports the same outcome as a complete response. Never
        raises."""

    def extract_response_metadata(self, response: Any) -> dict | None:
        """Rate-limit headers, request id and processing time, normalised
        across providers; None when nothing is reachable. Never raises."""

    def extract_output_dimensions(self, response: Any) -> dict | None:
        """{"count", "dimension"} for embeddings responses, else None."""

    def extract_tool_invocations(self, response: Any) -> list[ToolInvocation]:
        """Tool calls the model emitted in the response; empty when none."""

    def extract_content(
        self,
        request_kwargs: dict,
        response: Any,
        event_type: EventType | None = None,
    ) -> PromptContent | None:
        """
        Extract prompt content for storage when capture_prompts=True.
        Returns None when capture_prompts=False. Never raises.

        For Anthropic: extracts system, messages array, tools list, response
        message.
        For OpenAI: extracts messages array (all roles), tools list, response
        choice.
        For EMBEDDINGS event_type: extracts request_kwargs["input"] (string
        or list of strings).
        Provider terminology is preserved exactly — no normalization between
        Anthropic and OpenAI shapes.
        """

    def get_model(self, request_kwargs: dict) -> str:
        """Extract model name from request kwargs. Returns "" on failure."""
```

### `PromptContent` dataclass

```python
@dataclass
class PromptContent:
    """Raw content extracted from a single LLM call or embeddings request."""
    system: str | None              # Anthropic system; OpenAI Responses instructions
    messages: list[dict]            # Full messages array verbatim (empty for Responses)
    tools: list[dict] | None        # Tool definitions if provided
    response: dict                  # Full response as dict
    provider: str                   # "anthropic" or "openai"
    model: str
    session_id: str
    event_id: str
    captured_at: str                # ISO 8601 UTC
    input: str | list | None = None                    # Embeddings or Responses input (None for chat)
    embedding_output: list[list[float]] | None = None  # Embedding vectors when captured
```

`AnthropicProvider.estimate_tokens` uses the Anthropic SDK
`count_tokens` if available, falls back to `char // 4`. A request that
names no `model` is counted against `claude-sonnet-4-6`
(`DEFAULT_COUNT_TOKENS_MODEL` in `providers/anthropic.py`): the endpoint
answers 404 for a retired id and the estimator then falls back to the
heuristic without a word, so a unit test pins the default to an id that
the pricing catalogue prices without a deprecation date that has passed and that the
installed SDK lists as a model.
`OpenAIProvider.estimate_tokens` uses `tiktoken` when installed, falls back to
`char // 4`. It counts the chat `messages`; for a Responses request it
counts `instructions` and `input` (a string, or a list of input items) as
chat-shaped messages, and for an embeddings request the `input`, so every
OpenAI call path gets a real pre-call estimate. An inline binary payload
(a `data:` URL, a `file_data` body) is dropped from the text count and
priced at a fixed allowance of 1,000 tokens each, the order of what the
provider charges for an image input, so a multi-megabyte image cannot
estimate as hundreds of thousands of tokens and trip a policy limit
before the call. Token reconciliation in
`_post_call` prefers provider-reported
usage over the pre-call estimate: `extract_usage(response)` for a
non-streamed call, the usage the stream guard read from the stream for a
streamed call (see Streaming metering). The estimate, with zero output
tokens, is used only when neither reports any tokens.

### SDK class patching

`patch` mutates a fixed set of SDK classes in place, so any code path that
reaches them is intercepted, including code paths inside agent frameworks
that build their own SDK clients internally, and captured references
(`from anthropic import Anthropic` BEFORE `patch`) keep working because
the class objects keep their identity. The two SDKs are patched at
different levels:

- **Anthropic** — the resource classes every client hands out: `create`,
  `stream` and `parse` on `anthropic.resources.messages.messages.Messages`
  / `AsyncMessages`, on the beta `Messages` / `AsyncMessages` under
  `anthropic.resources.beta.messages`, and on the Bedrock and Vertex beta
  resources (`anthropic.lib.bedrock._beta_messages`,
  `anthropic.lib.vertex._beta_messages`), which are separate classes that
  copy the first-party functions at import time and carry only the
  methods their platform supports (Bedrock `create`; Vertex `create` and
  `stream`). Because the patch lives on the resource rather than the
  client, every client class is covered: `Anthropic` / `AsyncAnthropic`,
  which build the resource through a class-level `cached_property`;
  `AnthropicBedrock`, `AnthropicVertex`, `AnthropicBedrockMantle` and
  their async forms, which assign `self.messages = Messages(self)` as an
  instance attribute; `AnthropicFoundry`, which hands out a `Messages`
  subclass; `AnthropicAWS`. Clients and resources that already existed
  before `patch` are covered from their next call on. The SDK's raw view
  (`with_raw_response`) and streaming view (`with_streaming_response`)
  bind the resource's `create` / `parse` when they are built, so a view
  first touched after `patch` is intercepted too, while a view first
  touched before `patch` keeps the unpatched method and is not metered
  (a strict `xfail` test pins it; the other unmetered case is a call
  made under litellm's outer-call mark, described with the litellm
  patch below). The patch imports the SDK's private module
  layout; the floor is `anthropic>=0.86`, the lowest release carrying
  it, and CI's `SDK floors` lane runs the unit suite against 0.86.0. An
  installed SDK below the
  floor is reported once, when the sensor first patches it, with a
  warning rather than silently left unmetered. The raw view returns a response whose body is
  already read, and is metered like a plain call. Its `parse()` is
  synchronous on both client kinds up to the 0.x SDKs; from 2.x the async
  client's raw view returns an `AsyncAPIResponse` whose `parse()` is a
  coroutine, so the sensor awaits it (no network, and the SDK caches the
  result for the caller's own `parse()`), meters the parsed message and
  hands the caller the response. The view marks its requests with
  `X-Stainless-Raw-Response: true` up to 0.x and `raw` from 2.x; the
  sensor reads both. The streaming view hands the caller an
  unread response, so the sensor returns a proxy that meters at the
  caller's `parse()` (`await parse()` on the async client) and never
  reads the body itself: a response closed after being read some other
  way is parsed from the bytes already read, a response never read
  reports the pre-call estimate, and a parsed event stream
  (`create(stream=True)` through either view) is handed to the stream
  guard, whose latency then runs from the `parse()` call rather than
  from the request. The guard is entered as `parse()` hands it over, on
  the async client as on the sync one, so a stream the caller never
  iterates is still settled -- at the view's close, the stream's
  collection or the session's end -- as an aborted stream with no
  chunks, on the pre-call estimate. A `create(stream=True)` response
  whose body was never consumed (closed, dropped or still open at the
  session's end before `parse()`) is reported the same way, with that
  zero-chunk `streaming` block. One whose body the caller consumed some
  other way (`iter_lines()`, `read()`, the raw `http_response`) reports
  the pre-call estimate with no `streaming` block: the transport cannot
  tell a full read from a partial one, so neither outcome is claimed.
  A streaming-view response dropped without `parse()`
  or `close()` is reported with the pre-call estimate the way an
  abandoned stream is: its finalizer queues the settle (never settling
  inline) and the next intercepted call, or the session's end, runs it;
  a response still referenced when the session ends is settled then.
  With no session active, or once the class has been unpatched, the
  patched methods pass straight through to the SDK, so nothing is ever
  cached in an unmetered state and a view built while patched stops
  metering with `unpatch`.
- **OpenAI** — the `cached_property` descriptors `OpenAI.chat`,
  `AsyncOpenAI.chat`, `OpenAI.responses`, `AsyncOpenAI.responses`,
  `OpenAI.embeddings`, `AsyncOpenAI.embeddings` on the client classes,
  replaced with sensor descriptors that wrap the resource on first
  access, and the `chat` `cached_property` of the SDK's beta resource
  (`openai.resources.beta.Beta` / `AsyncBeta`, behind `client.beta`),
  replaced the same way so `client.beta.chat.completions.parse()` and
  `.stream()` -- the structured-output path on the SDK's beta resource
  -- are intercepted as `client.chat.completions` is, with the
  provider attributed to the client the beta resource holds. From
  openai 1.92 `beta.chat` hands out the same `Chat` class as
  `client.chat`; from 1.40 to 1.91 it is a beta `Chat` whose
  `completions` carry only `parse` and `stream` (that `stream` builds its
  request through `client.chat.completions.create`, which the client
  patch meters). An SDK without the beta module, or whose `Beta` has no
  `chat`, is left alone. A `wrap()`-built client's `beta` is a proxy
  whose `chat` is wrapped the same way (the 1.40 to 1.91 `stream`
  helper, which builds its request through
  `self._client.chat.completions.create`, is handed a client whose chat
  `create` the sensor meters, so it is metered on a wrapped client too),
  unless the class patch already
  wrapped it. The intercepted call paths are `chat.completions.create()`,
  `.parse()` and `.stream()`, `responses.create()`, `.parse()` and
  `.stream()`, `embeddings.create()`, and the raw and streaming views of
  those resources (`with_raw_response` / `with_streaming_response`, on
  the resource or on the client). `create(stream=True)` on chat and
  Responses is metered from the stream. The `.stream()` helpers build
  their request by calling `self.create(..., stream=True)`, so the sensor
  runs the SDK's own helper with the sensor's resource proxy as `self`:
  the request takes the stream guard, the helper reads its raw events
  through the guard, and the caller gets the SDK's own manager and
  `ChatCompletionStream` / `ResponseStream`. The helper keeps the SDK's
  stream state for the events it reads, so the guard takes the helper's
  assembly (a chat helper's `current_completion_snapshot`, a Responses
  helper's terminal `Response` or the snapshot its state folded) rather
  than assembling the stream a second time; the chat helper's request
  carries its `X-Stainless-Helper-Method` header, and the provider builds
  no accumulator for it. The manager's exit also settles the guard, so a
  helper left early reports at once. The
  helpers' unset parameters (`NOT_GIVEN` / `omit`) are dropped before the
  request reaches the sensor; the request is the same without them.
  `responses.stream(response_id=...)` re-reads a stored response through
  `retrieve` and is not a new call, so it passes through. The views mark
  their requests with `X-Stainless-Raw-Response` (`true`, `stream`); the
  sensor reads the header in the resource proxies, so a view on the
  resource, on a class-patched client and on a `wrap()`-built client
  (whose `with_raw_response` / `with_streaming_response` are the SDK's own
  client views built over the sensor proxy) are metered the same way. A
  raw-view call returns the SDK's `LegacyAPIResponse` with its headers and
  its body read, and is metered like a plain call; a raw-view
  `parse()` through the client view hands back the raw response, as the
  resource's own `with_raw_response.parse()` does. A view call whose body
  is unread when the caller gets it (every streaming-view call, and a
  raw-view call with `stream=True`) is metered when the caller parses
  it, by the same proxy the Anthropic views use
  (`interceptor/raw_views.py`): a parsed event stream goes to the stream
  guard, with `stream_options.include_usage` added to a chat request as
  on `create(stream=True)`. A later `parse()` of the same response gets
  the same guard (the SDK caches the parsed stream, and handing that back
  would let its chunks bypass the guard), and the view's `close()` -- the
  streaming view's context-manager exit -- settles the guard, so a stream
  left early inside the view's `with` block is reported as the block
  exits. langchain-openai takes the chat raw-view path
  with `include_response_headers=True`. `parse()` is the structured-output
  path: it never streams, and its `ParsedChatCompletion` /
  `ParsedResponse` carries the usual `usage`. `responses` is OpenAI's
  recommended API for new projects; `embeddings` is common in RAG-heavy
  pipelines.

  The floor is `openai>=1.26`, the first release whose chat `create`
  takes the `stream_options` the sensor adds to every streamed chat call;
  on an older SDK that call would raise `TypeError` in the caller's code,
  so the interceptor detects the parameter at import and leaves such an
  SDK unpatched, with one warning, rather than break streaming. Before
  1.78 the client has no `cached_property` to replace: its constructor
  assigns each resource (`self.chat = resources.Chat(self)`) and the
  client class only annotates it. For each resource the class annotates,
  the patch installs `_OpenAIConstructedResourceDescriptor`, a data
  descriptor (it defines `__set__`, so Python consults it before the
  instance `__dict__`): `__set__` stores the SDK's resource in the
  instance `__dict__` as the constructor intended, and `__get__` hands
  out the sensor proxy over it while a session is active, kept per
  instance and reused while the resource and the session are unchanged,
  so `client.chat is client.chat` holds; with no session it returns the
  resource itself. Because the resource stays in the instance `__dict__`,
  a client built before `patch` is metered from its next resource
  access, and `unpatch` deletes the descriptor (its sentinel holds a
  marker, not an original) so every client reads its own resource again.
  The one exception is that SDK's client-level `with_raw_response` /
  `with_streaming_response` view, which the constructor builds over
  whatever `client.chat` (and its siblings) returned at that moment. On
  a client built before `patch`, or built with no session active, the
  view holds the SDK's own resources and is not metered. On a client
  built while a session was active, the view holds proxies bound to that
  session, so its calls are reported to that session even after another
  one starts. A resource the
  client class has neither as a descriptor nor as an annotation
  (`responses` before 1.66)
  is left alone. CI's `openai floor` lane runs the OpenAI tests against
  openai 1.26.0, the framework and SDK-majors lanes against the
  `cached_property` layout.

Three descriptor types on the OpenAI side (`_OpenAIChatDescriptor`,
`_OpenAIResponsesDescriptor`, `_OpenAIEmbeddingsDescriptor`), driven by an
`_OPENAI_PATCH_RESOURCES` table and a shared `_patch_one_resource` helper
so all three resources use the same code path, with per-resource
idempotency sentinels `_flightdeck_patched` (chat),
`_flightdeck_patched_responses` and `_flightdeck_patched_embeddings`. A
fourth, `_OpenAIBetaChatDescriptor`, replaces `chat` on `Beta` /
`AsyncBeta` through the same helper, with the sentinel
`_flightdeck_patched_beta_chat` on those classes. On
the Anthropic side a `_flightdeck_patched` sentinel on each resource class
holds the original methods, which `unpatch` restores and which the `wrap`
proxy calls directly, so a client that is both wrapped and patched is
metered once. When its resource class overrides a patched method and
calls `super()`, the proxy resolves the override and runs it under the
outer-call mark, so the patched base method it re-enters passes through
instead of reporting the request a second time. An override that defers
its `super()` call into an object it returns (a context manager's
`__enter__`) runs outside the mark and is still reported twice.

Idempotency: a class carrying its sentinel is skipped. Safe across
multiple `patch` / `unpatch` cycles.

Pre-existing instance limitation (OpenAI, 1.78 and later): instances
that accessed `.chat` / `.responses` / `.embeddings` BEFORE `patch` have
the raw resource cached in `instance.__dict__` and bypass the descriptor
permanently. New instances and new accesses are wrapped correctly. On
openai before 1.78 such instances are metered from their next access,
except through their client-level raw and streaming views (see the
OpenAI floor paragraph above).
Anthropic clients have no such limitation beyond the raw and streaming
views described above. The practical advice is the same for both: call
`init` + `patch` at the top of the entrypoint, before any framework or
user code constructs a client.

### When patching happens

`patch` never imports an SDK. It patches at once each SDK the
application has already imported, and the rest as the application
imports them: `core/import_hook.py` puts a finder at the front of
`sys.meta_path` that, for the seven modules `patch` covers (`anthropic`,
`openai`, `litellm`, `mcp`, `crewai`, `langgraph.graph`,
`claude_agent_sdk`), finds the module's spec through the finders after it
and wraps its loader. The wrapper puts the module's own loader back on
`__loader__` and `__spec__.loader`, executes the module with it, then
patches the SDK, in the importing thread, before the `import` statement
returns. Every other import passes the finder after one dictionary
lookup. So an application loads only the SDKs it uses: `import
flightdeck_sensor`, `init` and `patch` import none of them, and litellm's
download of its price list from GitHub, which runs when litellm is
imported, happens only when the application imports litellm. An SDK's
interceptor module imports the SDK, so it is loaded only once the SDK is,
and code shared across interceptors (the captured-arguments envelope of
every `tool_call`, in `core/tool_capture.py`) lives outside them, so an
LLM call never imports another SDK. When importing an interceptor module
is nonetheless what first imports its SDK (the application reads a
`patch_*` name before importing the SDK, say), the SDK finishes importing
while that module is still executing: the finder watches each
interceptor module too, and the SDK is patched as that module's code
ends, never earlier. An interceptor module another thread started
importing before `patch` installed the finder is waited for by `patch`,
which then patches the SDK that import brought in. `wrap` looks for a
client's SDK classes only when that SDK is imported (a client cannot
exist before), and the interceptor names `flightdeck_sensor` re-exports
(`SensorLitellm`, the `patch_*` / `unpatch_*` functions) resolve on
first access. LangGraph is watched as `langgraph.graph`, where
`StateGraph` lives: `langgraph` itself is a namespace package shared with
LangGraph's other distributions, and a namespace package runs no code to
hook.

A reload of a patched SDK runs through the finder again and is patched
again. The litellm patch checks each entry point for its own wrapper
rather than trusting the module's `_flightdeck_patched` flag, because a
reload re-runs litellm's module code in the existing namespace, which
rebinds every entry point and leaves the flag set. An exception while
patching on import is logged and the import goes on (the SDK is then
unmetered); a failed import patches nothing. `unpatch` takes the finder
out of `sys.meta_path` and unpatches only SDKs that are imported.

Every patch and unpatch runs under the sensor's patch lock. A patch on
import runs inside the import, holding that module's import lock, and
`patch` can hold the patch lock while it waits for that same import (an
SDK another thread is still importing when `patch` runs is waited for, so
it is patched whole; one the calling thread is importing is left to the
finder), so the import hook never waits for the patch lock: it queues the
SDK and patches it only if it takes the lock without waiting, and a
thread holding the lock patches what was queued as it releases it.
Patching is idempotent, so an SDK queued twice is patched once.

### Module-level patching: litellm

`SensorLitellm` (in `interceptor/litellm.py`) covers `litellm.completion`,
`litellm.acompletion`, `litellm.text_completion`,
`litellm.atext_completion`, `litellm.responses`, `litellm.aresponses`,
`litellm.embedding` and `litellm.aembedding`, streaming included. litellm
exposes its API as module-level functions, so the SDK class patching
above does not apply; the interceptor wraps the module functions directly,
stashing each original on the module object and marking each wrapper, which
is what makes patching idempotent (see "When patching happens" for why the
mark rather than a module flag). Each wrapper keeps the
entry point's signature and takes its arguments as litellm does,
positional ones included: they are bound to the entry point's parameter
names (`atext_completion` and `aembedding` take `*args` and forward them
to `text_completion` and `embedding`, whose signatures name them), and
arguments litellm would reject reach litellm untouched and raise there.
With no active session the call passes through to litellm untouched.

Each entry point has its own provider adapter. `LitellmProvider` reads
`completion` and `embedding` (the OpenAI chat shape litellm normalises
every provider to). `LitellmTextCompletionProvider` reads
`text_completion`: the request's `prompt` (a string, a list of strings or
token ids) instead of `messages`, and a `TextCompletionResponse` whose
`choices[0]` carries `text`. `LitellmResponsesProvider` reads `responses`,
which returns the Responses API shape on every route, native or bridged:
`instructions` and `input`, `usage.input_tokens` / `output_tokens` with
`input_tokens_details.cached_tokens` and
`output_tokens_details.reasoning_tokens`, `function_call` output items as
the tool calls, and `incomplete_details.reason` as the stop reason. With
`capture_prompts` on, a `text_completion` call stores its `prompt`
verbatim in the content's `input` (the request has no `messages`), and a
`responses` call stores its `instructions` in `system` and its `input` in
`input`, as an OpenAI Responses call does.

While serving a call litellm makes calls the sensor also intercepts: its
OpenAI route constructs `openai.OpenAI` and calls `chat.completions`;
`text_completion` builds a chat request and calls `completion` (through
the name bound in `litellm.main`, which is not patched); `responses` on a
provider without a native Responses API (Anthropic) bridges through the
package-level `litellm.completion` / `acompletion`, and `completion` on a
Responses-only model (`openai/responses/...`) bridges through the
package-level `litellm.responses` / `aresponses` -- both patched
wrappers; and a call with `fallbacks` runs every attempt, the caller's
own model first, through the package-level `litellm.acompletion`. (The
global `litellm.model_fallbacks` reaches the same loop, but in litellm
1.83.0 and 1.104.2 every attempt re-reads it and opens a new loop, so a
call with it set never returns, with or without the sensor.) The interceptors
coordinate through an outer-call mark in `interceptor/base.py`: each
litellm wrapper runs the underlying litellm call inside
`outer_intercept()`. An SDK interceptor that finds
`outer_intercept_active()` true hands the call through untouched (no
`pre_call`, policy check, stream guard or `post_call`). A litellm wrapper
does so only when the mark is active and its caller is one of litellm's
re-issue modules -- the two bridges and the fallback loop
(`_REISSUE_MODULES` in `interceptor/litellm.py`, matched on the calling
frame's module name, which is read only while the mark is active; for an
async entry point, the frame that awaits it): each re-issues the
caller's own call, which the outer wrapper reports. So a litellm call
lands as one `pre_call`, one policy check and one `post_call`, reported
by the wrapper of the entry point the caller used, in that entry point's
shape. A call a fallback answered is reported with the response that
came back, so its `model_served` (and the canonical `model` pricing and
the model dimension use) is the model that answered, while
`model_requested` keeps the caller's model; an attempt that failed
before a fallback answered is not reported on its own (no `llm_error`
for it), and a call every attempt failed lands as one `llm_error`. A
non-streamed attempt that fails after the provider billed it (a client
timeout the provider finished anyway, or litellm's `post_call_rules`
rejecting the response) is swallowed by the loop the same way, so its
tokens go unreported; a stream that fails mid-way is not, because the
loop has already returned its stream object. Under a DEGRADE policy the
pre-call check swaps `model` to the degrade target and drops the call's
`fallbacks` and `context_window_fallback_dict` (the litellm adapters'
`model_alternative_params`; the second is the bigger model litellm's
call wrapper retries on a context-window error), on every litellm entry
point: `completion` honours both, and `text_completion` and a
`responses` call litellm bridges through `completion` (a provider
without a native Responses API) hand the caller's arguments on to it.
So no attempt runs a model the policy did not choose and a failure of
the degraded attempt is the call's `llm_error`; a Router runs each deployment attempt through
the patched entry points as a call of its own, so each attempt is
degraded. Any
other litellm call made while one is in flight -- from a callback,
guardrail or custom provider, or one litellm makes itself (an agentic or
MCP follow-up, a semantic-cache embedding, an LLM judge) -- is a call of
its own and is policed and metered. A litellm release that moves a
re-issue shows as a double count of it, which the re-issue tests catch,
never as a missed call. Three cases are reported more than once rather than risk
hiding a billed call: a chat call routed through litellm's MCP gateway
(tools that name it), which re-issues the call from the same function
that makes the follow-up calls after its tools run, so the re-issue
cannot be told apart; a sync call with `fallbacks` made while an event
loop is running in its thread (a notebook, a sync call inside async
code), whose attempts litellm runs in a worker thread it starts without
copying the context, so the mark does not reach them and every attempt is reported as a call of its own beside the outer call (for a failed primary and one fallback: three `pre_call`s, two `post_call`s and one `llm_error`)
(pinned by a strict `xfail` test); and every re-issued call when an instrumentation library
replaces a litellm entry point after `flightdeck_sensor.patch()`, which
puts its own frame where the re-issue check looks. The mark is a per-call flag held in a context variable:
another thread, or a task created before the call, never sees it, so an SDK
call they make at the same time is still reported; a task created inside
the call inherits a copy of the context and reads the mark active while the
call is in flight and inactive once it has ended, because the flag is
cleared when the call ends; litellm's executor hop for sync-only providers
copies the context, so the mark follows it. The mark covers the whole
litellm call, which is a stated limitation: an SDK call made from inside
it while it is in flight -- by a litellm callback, guardrail or custom
provider, or by a task created inside the call -- is neither policed nor
metered. The OpenAI interceptor checks the mark where
`client.chat.completions` is resolved (which covers `create` and
`with_raw_response.create`, streaming or not) and at `embeddings.create`,
and the Anthropic patch in its patched resource methods (`create`,
`stream`, `parse`, on every client class and both views) and, for a
`wrap()`-built client, in the same three proxy methods.

`litellm.completion(stream=True)` and `litellm.acompletion(stream=True)`
return the shared stream guard (`GuardedStream` / `GuardedAsyncStream`)
around litellm's `CustomStreamWrapper`. The sensor asks litellm for
`stream_options={"include_usage": True}`, so litellm appends one chunk
carrying the provider's usage after the `finish_reason` chunk (one choice
with an empty delta, where OpenAI sends empty `choices`). The guard meters
that chunk and hides it from a caller who did not ask for usage, so their
loop sees the chunks it would see without the sensor.
`text_completion(stream=True)` returns the guard around litellm's
`TextCompletionStreamWrapper`, with `include_usage` requested the same
way; every chunk of that stream is a `TextCompletionResponse` carrying a
`Usage`, zeros on all but litellm's trailing usage chunk, so the chunk
that ends the stream, and the one the guard hides, is the one whose usage
is not zero. `responses(stream=True)` returns the guard around litellm's
Responses streaming iterator; the terminal event (`response.completed` /
`.incomplete` / `.failed`) carries the whole response and its usage, so
nothing is added to the request and nothing is hidden, and the guard
keeps that response for content capture and the tool calls. Until it
arrives the guard keeps the latest response a `response.created` /
`response.in_progress` event carries, so a stream left before its
terminal event stores that in-progress response (`object: "response"`,
`status: "in_progress"`, no output) as its content only; its usage,
model and stop reason still come from the events, and it emits no tool
call. litellm's
stream wrappers are not context managers and have no `close()`, so the
guard is used as a plain iterator; a loop left early is reported once the
guard is collected.
`LitellmProvider` surfaces the cache breakdown litellm exposes
(`usage.prompt_tokens_details.cached_tokens` / `cache_creation_tokens`, or
the Anthropic-named `cache_read_input_tokens` /
`cache_creation_input_tokens`) as `tokens_cache_read` /
`tokens_cache_creation`; `tokens_input` already includes the cache counts,
as the cost formula assumes (litellm's `prompt_tokens` is that sum). Only
real integers are accepted as cache counts. With `capture_prompts` on, a
streamed litellm call stores the request and, as the response, the message
litellm's `stream_chunk_builder` assembles from the chunks the wrapper kept
(the assistant message, `model` and `usage`, the shape a non-streamed litellm
response has) -- never the wrapper's own state, which carries the request
messages again, `_hidden_params` with the caller's `api_base` verbatim and
the provider's response headers.

### Patch surface — out of scope

The SDK class patches and the litellm patch deliberately do NOT intercept:

| Code path | Why not |
|---|---|
| `OpenAI.responses.stream(response_id=...)` | Resumes reading a response that was already generated, through `retrieve`; it is not a new call. |
| `OpenAI.audio.*`, `images.*`, `moderations.*`, `files.*`, `fine_tuning.*`, `completions.*` (legacy) | Utility resources unrelated to LLM inference events. |
| `Anthropic.completions.*` | Legacy completions API; superseded by `messages` / `beta.messages`. |
| Anthropic `messages.batches.*`, `messages.count_tokens` | Batches are offline work with their own billing and run outside the kill switch and the token budget; `count_tokens` is the sensor's own estimator and makes no inference call. |
| A raw-view `create(stream=True)` (Anthropic or OpenAI) whose response is never parsed | The event stream is metered once `parse()` hands it to the stream guard. A raw response is not a context manager and has no close hook, so a call whose response is never parsed is reported on the pre-call estimate (as an aborted stream with no chunks when its body was never read) only when the response is collected or the session ends. The streaming view (`with_streaming_response`) always settles at close. |
| Frameworks that call a provider over raw HTTP (httpx, requests) | No SDK class to patch. |
| The OpenAI Agents SDK's Responses WebSocket transport (`use_responses_websocket`, `responses_websocket_session`) | Its model calls go over a WebSocket, not through `responses.create`, so they are not metered; the run's child sessions, hand-offs and guardrails are still reported. |
| boto3 `bedrock-runtime` (Converse, ConverseStream) | Not supported yet. botocore's event system gives a seam for it ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)); until then, Strands on its default Bedrock model and any framework on Bedrock through boto3 are not metered. |
| `google-genai` (Gemini API and Vertex AI) | Not supported yet. One class-level patch on its `Models` / `AsyncModels` would cover it ([#276](https://github.com/flightdeckhq/flightdeck/issues/276)); until then, Gemini calls, Google ADK's default model included, are not metered. |

Extending the patch surface to a new resource is one descriptor + one entry
in the OpenAI resource table, or one entry in `_resource_targets()` in the
Anthropic interceptor.

### Framework support

Flightdeck reaches an agent framework two ways.

- **Native sensor** (`init` + `patch`). Every LLM call the framework
  makes through a patched SDK (Anthropic, OpenAI, litellm) is metered
  and enforced as it happens, with no per-framework setup. Where the
  sensor also wraps the framework, each sub-agent run opens a child
  session (see Sub-agent framework coverage). Enforcement (kill switch,
  token budget, MCP policy, directives) acts inside the run, and the
  run is a `flightdeck_sensor` session of the sensor's agent. The model,
  tool and MCP events of every wrapped framework stay on that session,
  not on the child sessions, so enforcement is per session: a Stop or a
  budget applies to the whole run.
- **OTLP GenAI.** The ingestion API maps the OpenTelemetry GenAI spans
  of the frameworks its GenAI dialect names (see OTLP ingest > GenAI
  dialect): agents as child sessions, model calls with tokens and
  content, tool calls and hand-offs, from any runtime, Python or not.
  The sessions observe only (no Stop, no budget), belong to a separate
  `otlp` agent, need the framework's OpenTelemetry exporter configured,
  and reach the dashboard 3 to 30 seconds after the run's root span
  ends, already closed.

A framework gets a native wrap where it adds what the OTLP path cannot:
enforcement inside the run, live events and no exporter setup, or
structure no mapped dialect reports. Where OTLP already reports a
framework's structure and the wrap would add little, the sensor meters
its calls and OTLP carries its structure. An agent reports one way: a
run reported by both the sensor and an OTLP exporter is counted twice,
and nothing removes the duplicate
([#279](https://github.com/flightdeckhq/flightdeck/issues/279)). The
OpenAI Agents SDK wrap logs a warning when it can see the run going to
both (see Sub-agent framework coverage).

"Planned" below is work in [#185](https://github.com/flightdeckhq/flightdeck/issues/185).

| Framework | Native: LLM calls | Native: structure | OTLP GenAI | What each path gives |
|---|---|---|---|---|
| LangChain | yes | no | no | Native: the `ChatAnthropic`, `ChatOpenAI` and `OpenAIEmbeddings` calls (see LLM call paths below). An agent built with `create_agent` runs on LangGraph but opens no child sessions: its nodes are Runnables and a `ToolNode`, which the LangGraph wrap leaves alone |
| LangGraph | yes | yes, for plain-callable nodes | no | Native: a child session per agent-bearing node whose action is a plain callable, role from the node name; Runnable, `ToolNode` and compiled-subgraph nodes are not wrapped |
| CrewAI 1.14+ | yes on its OpenAI and Anthropic providers and the litellm fallback; no on its Gemini (`google.genai`), Azure (`azure-ai-inference`) and Bedrock (boto3) providers | yes | no | Native: a child session per `Agent.execute_task`, role from `Agent.role` |
| Claude Agent SDK (Python) | yes | its own session per run | no | Native: a `claude_agent_sdk` session per run, read from the SDK's message stream, with directives and the MCP policy applied through its hooks (see Claude Agent SDK). The TypeScript SDK reports through Claude Code's own OpenTelemetry (OTLP ingest > Dialects) |
| Google ADK | yes on `LiteLlm` and on its `Claude` / `AnthropicLlm` models (Anthropic SDK); no on its default Gemini model | planned | yes | OTLP: agents, model calls and tool calls, observe only. Native (planned): a child session per agent, tool calls and hand-offs, enforced per session; its Gemini calls stay unmetered while Gemini is not supported (see Providers) |
| OpenAI Agents SDK 0.6+ | yes (Responses tool items become `tool_call` events); not over the Responses WebSocket transport | yes | yes, through `opentelemetry-instrumentation-openai-agents-v2` | Native: a child session per agent and per agent used as a tool, hand-offs and guardrail tripwires, enforced per session (see Sub-agent framework coverage). OTLP: agents, hand-offs, model and tool calls, observe only |
| Microsoft Agent Framework | yes through its OpenAI and Azure OpenAI chat clients (`agent-framework-openai`), its Foundry chat clients (`FoundryChatClient`, `FoundryAgentChatClient`, `AzureAIClient`, on the OpenAI client `azure-ai-projects` returns) and its Anthropic client (`agent-framework-anthropic`); not on `AzureAIAgentClient`, whose model calls the Azure AI Agent Service makes server-side, or on the `azure-ai-inference` embedding clients | planned | no: its GenAI spans are not mapped | Native (planned): a child session per agent run and workflow hand-off |
| LlamaIndex | yes (`llama-index-llms-anthropic`, `llama-index-llms-openai`) | yes, on llama-index-core 0.14+ | no | Native: a child session per agent of an agent workflow run (`FunctionAgent`, `ReActAgent`, `CodeActAgent`, `AgentWorkflow`), role from the agent's name, with its hand-offs; its LLM and tool calls stay on the sensor's session, as for CrewAI and LangGraph (see LlamaIndex agent workflows) |
| Deep Agents | yes through LangChain | planned | no | Native: none (it is built on `create_agent`, whose nodes the LangGraph wrap leaves alone). Planned: a child session per agent and per sub-agent its `task` tool starts |
| Pydantic AI | yes on Anthropic and OpenAI models; no on `GoogleModel` or `BedrockConverseModel` | no | yes | Native: metering and enforcement of its calls. OTLP: its agents, nested agents and tool calls, observe only |
| Strands Agents | yes on its OpenAI, Anthropic and LiteLLM model providers; no on its default Bedrock model or on Gemini | no | yes | Native: metering and enforcement of those calls. OTLP: its agents, agents used as tools and tool calls, observe only |
| Agno, Haystack, smolagents | yes when they call a model through the Anthropic or OpenAI SDK or litellm | no ([#278](https://github.com/flightdeckhq/flightdeck/issues/278)) | no | Native: the framework label and metering and enforcement of those calls; a multi-agent run is one session |
| Semantic Kernel | yes when it calls a model through the Anthropic or OpenAI SDK | no | no | Native: the framework label and those calls |
| AutoGen, AG2 | yes when they call a model through the Anthropic or OpenAI SDK | not planned | no | Native: the framework label and those calls; Microsoft Agent Framework is AutoGen's successor |
| DSPy | yes on its litellm engine; no on its default engine, which has its own HTTP transport | n/a | no | Planned: a DSPy callback adapter that meters the default engine |

**Providers.**

| Provider SDK | Native sensor | OTLP GenAI |
|---|---|---|
| Anthropic (every client class, including Bedrock, Vertex AI and Foundry) | yes | only as a mapped framework's model calls |
| OpenAI (including Azure OpenAI and any OpenAI-compatible endpoint the SDK is pointed at) | yes | only as a mapped framework's model calls |
| litellm | yes | only as a mapped framework's model calls |
| Google Gemini (`google-genai`, Gemini API and Vertex AI) | no: not supported ([#276](https://github.com/flightdeckhq/flightdeck/issues/276)); Gemini reached through litellm is metered as a litellm call | only as a mapped framework's model calls; no Gemini run has been recorded |
| boto3 `bedrock-runtime` (Converse, ConverseStream) | no: not supported ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)) | only as a mapped framework's model calls; no Bedrock run has been recorded |
| Voyage, Mistral, Cohere and other native SDKs | no, and not planned: their OpenAI-compatible endpoints go through the OpenAI SDK, and litellm reaches many of them | no |

**Not supported.** The sensor has no in-process seam, or no realistic
user base on current SDK majors, for these:

- BAML: its Rust runtime makes the model calls.
- Letta: agents run in the Letta server, out of the application's
  process.
- MetaGPT: unmaintained, and pins SDK majors long superseded.
- CAMEL: its pins conflict with current SDK majors.
- DSPy's default engine, until the callback adapter lands (above).

Frameworks not listed whose calls go through the Anthropic or OpenAI SDK
or litellm are metered and enforced, with `framework=null` unless a
classifier names them (see Framework attribution).

#### LLM call paths

After `init` + `patch`, frameworks that build Anthropic or OpenAI
clients internally are intercepted without user-side wrapping.

| Framework | Path covered |
|---|---|
| LangChain | `ChatAnthropic.invoke` (langchain-anthropic); `ChatOpenAI.invoke` (langchain-openai 0.3+ sends it through `chat.completions.with_raw_response.create`, which is intercepted as a non-streaming chat call); `OpenAIEmbeddings.embed_*` (transitive). `ChatOpenAI.stream` calls `chat.completions.create(stream=True)` and is metered from the stream; with `include_response_headers=True` it goes through the raw-response wrapper and records the pre-call estimate (see "Patch surface — out of scope"). `chat.completions.parse()`, `responses.parse()` and `responses.with_raw_response.create()` / `.parse()` are intercepted when a framework uses them |
| LangGraph | Transitive via LangChain — graphs routing through `ChatAnthropic` / `ChatOpenAI`, including tool loops built from a model node and `ToolNode`, and LangChain's `create_agent` (built on LangGraph) |
| LlamaIndex | `llama-index-llms-anthropic.complete`, `llama-index-llms-openai.complete`. llama-index-llms-anthropic (through 0.12.3) always sends `temperature`, which anthropic 1.x's `Messages.create` rejects, so that pairing fails inside the SDK with or without the sensor |
| CrewAI 1.14+ | `LLM(model=...).call` via the native Anthropic and OpenAI provider classes. Model strings without a native-provider prefix (e.g. `openrouter/`, `deepseek/`) fall through to litellm |
| litellm | `litellm.completion` / `acompletion`, `text_completion` / `atext_completion` and `responses` / `aresponses`, `stream=True` included (sync and async; chat and text streams metered from litellm's trailing usage chunk, Responses streams from the terminal event); each call is reported once, by the wrapper of the entry point used, also where litellm serves it through the OpenAI SDK or its own `completion`; `embedding` / `aembedding` |
| Claude Code plugin | Observational hook-based path; emits the same event shape as the sensor |
| bifrost | Multi-protocol gateway. Point the openai SDK at bifrost's `base_url` and the OpenAI interceptor fires; point the anthropic SDK at bifrost and the Anthropic interceptor fires. Both protocols are supported as deployment topologies. Events are attributed to the SDK protocol in use (`provider` reads openai or anthropic); on Anthropic calls the gateway's host is recorded as `provider_metadata.platform`, on OpenAI calls the gateway is not recorded |

### Framework attribution

Every event carries a bare-name `framework` field (`langchain`, `crewai`,
`langgraph`,...). The value is populated at sensor `init` from
`FrameworkCollector` via `Session.record_framework`, then propagated to
every emitted event.

Higher-level framework wins over SDK transport: a LangChain pipeline
routing through litellm routing through OpenAI reports
`framework=langchain` because that's the user's mental model. The
versioned form (`langchain/0.3.27`) lives in `context.frameworks[]` for
diagnostic detail; the bare name lives on the per-event `framework` field.

The labels are one vocabulary with the OTLP receiver's GenAI dialect
(`google_adk`, `openai_agents`, `strands`, `pydantic_ai`), so the analytics
`framework` dimension counts a framework's sensor and OTLP sessions
together. `claude-code` is the Claude Code client's label (the plugin's
and the OTLP receiver's), outside this classifier vocabulary. The
classifiers, in the order the per-event label is taken (the first match
wins, and a framework comes before the ones it is built on or commonly
embeds):

| Label | Detected from (`sys.modules`) | Version from |
|---|---|---|
| `deepagents` | `deepagents` | `__version__`, else the `deepagents` distribution |
| `crewai` | `crewai` | `__version__`, else `crewai` |
| `google_adk` | `google.adk` | `__version__`, else `google-adk` |
| `openai_agents` | `agents`, only when the `openai-agents` distribution is installed (the import name is generic) | `__version__`, else `openai-agents` |
| `agent_framework` | `agent_framework` (Microsoft Agent Framework) | `__version__`, else `agent-framework-core`, `agent-framework` |
| `semantic_kernel` | `semantic_kernel` | `__version__`, else `semantic-kernel` |
| `autogen` | `autogen_agentchat`, `autogen_core` (Microsoft AutoGen 0.4+) | `__version__`, else `autogen-agentchat`, `autogen-core` |
| `ag2` | `autogen` (AG2 owns the import name; Microsoft's AutoGen 0.2 reports `autogen`, see below) | `__version__`, else `ag2`, `pyautogen`, `autogen` |
| `agno` | `agno` | `__version__`, else `agno` |
| `strands` | `strands` | `__version__`, else `strands-agents` |
| `pydantic_ai` | `pydantic_ai` | `__version__`, else `pydantic-ai-slim`, `pydantic-ai` |
| `smolagents` | `smolagents` | `__version__`, else `smolagents` |
| `claude_agent_sdk` | `claude_agent_sdk` | `__version__`, else `claude-agent-sdk` |
| `llama_index` | `llama_index` | `__version__`, else `llama-index-core` |
| `haystack` | `haystack` | `__version__`, else `haystack-ai` |
| `dspy` | `dspy` | `__version__`, else `dspy` |
| `langgraph` | `langgraph` | `__version__`, else `langgraph` |
| `langchain` | `langchain`, `langchain_core` | `__version__`, else `langchain`, `langchain-core` |

`BaseClassifier.module` accepts a tuple of aliases. `LangChainClassifier`
lists `("langchain", "langchain_core")` so split-package installs
(`langchain_openai`, `langchain_anthropic` without the umbrella) are still
detected via the always-present core package. A classifier reads the
version from the installed distribution's metadata
(`importlib.metadata`) when the module has no `__version__`; the lookup
is cached for the process and a missing distribution leaves the bare
label.

The `autogen` import name is AG2's: the `ag2`, `pyautogen` (from 0.3)
and `autogen` distributions all install AG2 under it, so a loaded
`autogen` reports `ag2`. The exception is Microsoft's AutoGen 0.2, which
installed `autogen` too, as `pyautogen` below 0.3 (before AG2 took the
name over) and as its 0.2 maintenance line `autogen-agentchat` below
0.4: the first AG2 distribution found being `pyautogen` below 0.3, or no
AG2 distribution and `autogen-agentchat` below 0.4, reports `autogen`.
Microsoft's current AutoGen (`autogen_agentchat`, `autogen_core`)
reports `autogen`.

**A framework imported after `init`.** `patch()` imports no SDK and
`init` imports no framework, so an application that imports its
framework after `init` has none loaded when the classifiers first run.
While the session's framework is still unknown, the sensor runs the
classifiers again whenever it builds an event and `sys.modules` has
grown since the last run; once a label resolves it is kept and no event
scans again. The label then rides on every later event, the
`context.frameworks[]` that a later sub-agent `session_start` inherits
gains the versioned entry, and the worker records it on the session
row: a later call, tool call, error or signal carrying a `framework`
fills a null `sessions.framework` and appends that bare label to
`context.frameworks[]` (see the `sessions` table). The scan is skipped
on a signal's shutdown path, which imports nothing.

`MCP calls routed through any framework attribute to the framework, not
"mcp" as a framework itself` — every event the MCP interceptor emits
carries the surrounding framework's bare-name `framework` field
(`langchain`, `langgraph`, etc.); the `mcp_*` event_type itself
identifies the protocol axis. The MCP server name lives on the
event payload (`server_name`) and on `context.mcp_servers`.

### Sub-agent framework coverage

The sensor opens a child session for every framework-recognised
sub-agent execution. Each child session carries
`parent_session_id` pointing back to the outer session and
`agent_role` set to the framework-supplied role label
(see Identity model above). Four mechanisms are covered:

| Mechanism | parent_session_id source | agent_role source | Interceptor |
|---|---|---|---|
| Claude Code Task subagent | the outer Flightdeck session id, which the hook payload's `session_id` resolves to (see Plugin, Session identity) | hook payload `agent_type` (e.g. `"Explore"`) | `plugin/hooks/scripts/claude_code/subagent.mjs` (`SubagentStart` / `SubagentStop`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute | `sensor/.../interceptor/crewai.py` (context manager around `Agent.execute`) |
| LangGraph node execution | parent runner's session | node name | `sensor/.../interceptor/langgraph.py` (every node whose action is a plain callable is wrapped, unless `init(langgraph_agent_node_pattern=...)` narrows it to matching node names; Runnable, `ToolNode` and compiled-subgraph nodes, and with them `create_agent` and Deep Agents, open no child sessions) |
| LlamaIndex agent workflow run | the sensor's session | the agent's `name` | `sensor/.../interceptor/llama_index.py` (a span handler on LlamaIndex's root instrumentation dispatcher; see LlamaIndex agent workflows) |
| OpenAI Agents SDK agent run | the sensor's session; for an agent used as a tool, the child session of the agent that called the tool | `Agent.name` | `sensor/.../interceptor/openai_agents.py` (`AgentRunner.run` / `run_streamed`, run hooks, and the four guardrail classes' `run`) |

Direct Anthropic / OpenAI SDK calls and litellm calls outside a
multi-agent framework emit root sessions with
`parent_session_id=null` and `agent_role=null`; the existing 5-tuple
identity is unchanged for those paths.

Sub-agent coverage tracks the LLM-interception coverage in Framework
support above — a framework lands here only after Flightdeck observes
its plain LLM calls. The "Native: structure" column there says which
frameworks are wrapped, planned or left to the OTLP GenAI path.
AutoGen (`autogen`) and AG2 (`ag2`) runs are labelled (see Framework
attribution) and their LLM calls are metered through the SDK patches,
with no sub-agent structure; that structure is planned for Microsoft
Agent Framework, AutoGen's successor
([#185](https://github.com/flightdeckhq/flightdeck/issues/185)), not for
AutoGen or AG2.

Cross-agent message capture rides on the same
`capture_prompts` gate as LLM prompt content. Each
interceptor extracts the parent's input to the child at child
context entry and stamps it on the child `session_start` payload as
`incoming_message`; the child's response back lands on the child
`session_end` payload as `outgoing_message`. Bodies route through
the existing `event_content` table — small bodies inline, large
bodies through the overflow path (8 KiB inline / 2 MiB hard
cap). `capture_prompts=false` produces neither field. A body is
stored in its JSON form: framework state that the json module cannot
encode is converted first (pydantic models such as LangChain messages
dumped in JSON mode, dataclasses as objects, sets and tuples as lists,
dates as ISO strings, anything else as its string form); a body that
still cannot be encoded is dropped with a warning while the session
events go out.

The LangGraph wrapper keeps the node's signature (through
`__wrapped__`): LangGraph injects `config`, `runtime`, `store` and
`writer` by parameter name and type, so a node that declares one still
receives it once wrapped. The CrewAI wrappers keep `execute_task` /
`aexecute_task`'s name and signature the same way.

Sub-agent emission failure (the framework's `Agent.execute` or
equivalent raises an exception inside the interceptor's context
manager) emits child `session_end` with `state=error` plus a
structured error block following the `llm_error` taxonomy: the
exception's `type`, and its `message` only while `capture_prompts` is
on, because an exception's text can quote a tool's arguments or a
model's reply (`Session.emit_subagent_session_end` drops the message
otherwise, for every wrap). The
dashboard surfaces failures via the row-level red-dot pattern on
the child session row on the Events page and the child agent's
swimlane row left panel on Fleet —
mirroring the existing `error_types` (`llm_error`) and
`mcp_error_types` indicators.

A framework hand-off, one agent passing the conversation to another,
is reported with `Session.emit_agent_handoff(from_agent=, to_agent=)`,
which the LlamaIndex and OpenAI Agents SDK wraps call and the planned
Google ADK wrap will. It
emits the `agent_handoff`
`session_signal` the GenAI dialect emits (see Event Types >
`session_signal`), so a hand-off reads the same whether the sensor or
an OpenTelemetry exporter reported it: `signal_data` holds `from` and
`to`, the two agents' names, each trimmed of white space, cut to 256
bytes at a UTF-8 boundary (a lone surrogate becomes `?`) and left out
when empty or not given. The
event carries no `model`, no token counts and no content. The names
are metadata and are sent whatever `capture_prompts` says; what was
handed over (the transfer tool's arguments, the conversation) is
content, is never read for the signal, and is captured only on the
events that already carry it (the transfer's `tool_call`, the
next model call). The signal goes on the session of the agent handing
off: the sensor's own session, or, when the wrap passes
`child_session_id`, `child_agent_id`, `child_agent_name` and
`agent_role` as it does for `emit_subagent_session_start`, that child
session, with `parent_session_id` set to the sensor's session (or to
the `parent_session_id` the wrap gave the child, for a grandchild). A
child identity given in part is a wrap bug: the signal is dropped with a
warning rather than sent on the wrong session. The event is posted
synchronously, as the child `session_start` and `session_end` are, so
it reaches ingestion before the child's `session_end`, after which the
worker would drop it as a straggler on a closed session. The post is
one attempt with a 2-second timeout, because a hand-off happens mid-run
and the transport's own 10-second timeout and retries would hold the
agent between two turns; a failed post then follows the
unavailability policy (`halt` raises `DirectiveError`, `continue` drops
the signal). A directive in the response is applied on the sensor's own
session and discarded on a child's, as the child `session_start` and
`session_end` discard theirs. Nothing is sent once the session has
ended or is shutting down (`end()`, a SIGTERM / SIGINT shutdown, or a
shutdown directive).

A guardrail that fires is reported the same way with
`Session.emit_guardrail_tripwire(guardrail=, kind=, agent=)`: the
`guardrail_tripwire` `session_signal`, whose `signal_data` holds
`guardrail` (its name), `kind` (`input`, `output`, `tool_input` or
`tool_output`; any other value is left out) and `agent` (the guarded
agent's name), each bounded and left out as a hand-off's names are. It
carries names only, whatever `capture_prompts` says: never the
guardrail's verdict, its output info or the text it checked. It goes on
the guarded agent's session, child identity and `parent_session_id`
given as for a hand-off, and is posted, bounded and skipped after the
end exactly as a hand-off is.

**Which session a sub-agent's calls land on.** A wrap's child
sessions carry the run's structure: their `session_start`, their
`session_end` and the hand-off signals. The model calls, `tool_call`,
`llm_error`, MCP and `policy_*` events made during a child's turn stay
on the sensor's own session, for the CrewAI, LangGraph, LlamaIndex
and OpenAI Agents SDK wraps alike, so that session's row counts every token of the run.
Enforcement is therefore per session: the sensor's session's token
policy, and a Stop on that session, act on every agent of the run (the
next model call raises `DirectiveError`). A child session posts only its
start, end and framework signals (hand-off, guardrail) synchronously and drops a directive returned for
it, so a directive addressed to a child is not acted on. Attributing
each agent's calls to its child, with a Stop on a child halting that
child only, is planned for every wrap together
([#185](https://github.com/flightdeckhq/flightdeck/issues/185)).

A wrap may also enter a child's scope around the child's work
(`Session.enter_subagent_scope`, a context variable, so it follows the
child's asyncio tasks and threads started with a copied context and
nothing else). The scope changes no event: it records the call ids of
the tool calls a model response made during the child's work, so a wrap
that also sees the tool run can tell whether it is already reported. The
LlamaIndex wrap uses it.

#### LlamaIndex agent workflows

`patch()` (`Provider.LLAMA_INDEX`) adds a span handler to LlamaIndex's
root instrumentation dispatcher (`llama_index.core.instrumentation`); no
LlamaIndex class or method is replaced. An agent workflow run
(`FunctionAgent`, `ReActAgent`, `CodeActAgent` or a multi-agent
`AgentWorkflow`, run with `.run()`) opens a run span whose instance is
the agent or workflow, and each of its steps opens a span parented on
it, in the step's own task, with the step's input event in its
arguments. The handler reads the current agent's name from the events
that carry it (`AgentInput`, `AgentSetup`, `AgentOutput`):

- The first step that names an agent opens that agent's child session
  (`agent_role` and the `agent_name` suffix are the agent's `name`),
  with the run's `user_msg` as `incoming_message`.
- A step that names another agent is a hand-off (`AgentWorkflow`'s
  `handoff` tool): the handler emits `agent_handoff` on the agent
  handing off, ends its child with its last response as
  `outgoing_message`, and opens the next agent's child with the
  hand-off's `reason` as `incoming_message`. An agent handed back to
  opens a new child session.
- The run span's exit ends the open child; its drop (the run raised)
  ends it with `state=error` and the exception's type (and message,
  with capture on). A run whose last failed step no later step
  followed also ends in error, with that step's exception: early
  llama-index-workflows 2 releases exit the run span of a failed run
  instead of dropping it. Cancelling
  the run's task (`handler.cancel()`) drops the run span, so its child
  ends with `state=error`; `handler.cancel_run()` stops the run with
  LlamaIndex's own `WorkflowCancelledByUser`, so its child ends with
  `state=closed` (early llama-index-workflows 2 releases implement
  `cancel_run()` by cancelling the run's task, and the child ends with
  `state=error`). Either way the steps still in flight are forgotten.
  `unpatch()` ends a run's open child with `state=closed`.
- The agent's model calls, the tools it runs and the model and MCP
  calls a tool makes are reported on the sensor's session, as for the
  other wraps. An agent run started inside a tool opens its own child,
  also parented on the sensor's session.

Tool calls: a tool the model asked for in a structured tool call is
already a `tool_call` event from the model's response (see LLM call
paths). Each step of a run runs inside the open child's scope, so the
handler knows which call ids the agent's responses reported, and adds a
`tool_call`, on the sensor's session, only for a tool whose call id no
response of that agent reported, as `ReActAgent` and `CodeActAgent`
parse their tool calls from the model's text; it carries `tool_name` and
the run's `latency_ms`, and under `capture_prompts` the tool's arguments
and output as `tool_input` / `tool_output`. A tool call is never
reported twice.

Enforcement acts on the sensor's session and stops a run at its next
model call: the `DirectiveError` or `BudgetExceededError` the patched
SDK raises fails the agent's step,
LlamaIndex ends the run with it (awaiting the handler raises it), and
the open child ends with `state=error`. The dispatcher discards anything
a span handler raises, so the handler never stops a run itself. A run
that never ends (its handler is dropped unawaited) leaves its child
open until the worker's orphan detection closes it.

The wrap needs llama-index-core 0.14 or later (llama-index-workflows 2),
the release line whose step spans it reads; on an older release `patch()`
logs a warning and leaves LlamaIndex unwrapped, and its model calls are
still metered on the sensor's session. A query or chat engine, or a
workflow that is not an agent workflow, opens no child session.

#### OpenAI Agents SDK

`patch()` (`Provider.OPENAI_AGENTS`) wraps the OpenAI Agents SDK 0.6 and
later when its `agents` module comes from the `openai-agents`
distribution (the import name is generic, so another `agents` package
is left alone). It patches `AgentRunner.run` and `AgentRunner.run_streamed`
on the class (`Runner.run`, `Runner.run_streamed` and `Runner.run_sync`
go through them), and the `run` method of `InputGuardrail`,
`OutputGuardrail`, `ToolInputGuardrail` and `ToolOutputGuardrail`.

- **Child sessions.** Each agent that runs opens a child session when it
  starts (the SDK's `on_agent_start` run hook): `agent_role` is
  `Agent.name`, `agent_name` is `<sensor agent name>/<Agent.name>`, the
  agent id is derived from the role. It closes when the agent hands off
  or when the run ends; it ends with `state=error` and the exception's
  type (and message, with capture on) when the run raises (an
  exception, a cancellation, `MaxTurnsExceeded`, a guardrail tripwire,
  a `DirectiveError`) or a guardrail tripwire stops it. With capture on, the first agent's
  `incoming_message` is the run's input (a string or a list of input
  items) and the final agent's `outgoing_message` its final output.
- **Hand-offs.** The agent handing off posts `agent_handoff` on its
  child and closes it; the agent handed to opens its own child when it
  starts, so the two are siblings, as the GenAI dialect stores them.
- **Agents used as tools.** `Agent.as_tool` runs a nested run, whose
  agents open children with `parent_session_id` set to the child of the
  agent that called the tool.
- **Guardrails.** An input or output guardrail whose tripwire triggered,
  and a tool guardrail whose behaviour is `reject_content` or
  `raise_exception`, post `guardrail_tripwire` on the guarded agent's
  child. A `reject_content` lets the run go on, so the child closes
  normally.
- **Conversation id.** The child's `session_start` `context` carries
  `gen_ai_conversation_id`, the key the GenAI dialect uses: the run's
  `conversation_id`, else its SDK memory session's `session_id`, else
  `run_config.group_id`, else that of the run it is nested in.
- **Model, tool and MCP calls** go through the patched OpenAI client and
  the MCP patch and stay on the sensor's own session, as the CrewAI and
  LangGraph wraps leave them. A function tool adds no event of its own:
  the model's `function_call` item is already its `tool_call`.
- **Enforcement** is per session. A model call's `pre_call` raises
  `DirectiveError` or `BudgetExceededError` out of `Runner.run` (or out
  of a streamed result's `stream_events()`). Once a shutdown directive
  has arrived, the wrap also raises `DirectiveError` when an agent
  starts or hands off. Inside an agent used as a tool the SDK turns the
  exception into the tool's error for the model; the shutdown stays set,
  so the calling agent's next model call raises. A `retry_policy` that
  retries every exception retries a `DirectiveError` too.

The SDK runs its hooks in tasks of their own, so the wrap keeps a run's
state in an object a context variable points to, set before the run;
the run's tasks and nested runs inherit it. The caller's own run hooks
still run, each after the sensor's work, and their exceptions propagate.
The posts the hooks and guardrails make run in a worker thread
(`asyncio.to_thread`), so the event loop is not held. A streamed run's
open children are closed from the done callback of the task its loop
runs in (`run_loop_task`, or `_run_impl_task` in older releases such
as 0.6). The callback cannot await, so it hands the closing posts to
the loop's executor and registers them with the session, whose `end()`
waits for them (up to 2 seconds) before its own `session_end`; only
when the loop can no longer run them does it post in place.

The first run whose traces also go to the OpenTelemetry instrumentation's
processor (`opentelemetry.instrumentation.openai_agents`, with tracing
on) logs one warning that the run may be counted twice, naming
[#279](https://github.com/flightdeckhq/flightdeck/issues/279), when the
exporter's endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else
`OTEL_EXPORTER_OTLP_ENDPOINT`) is this sensor's server host and port or
is not set; an endpoint on another host logs at debug level. Nothing is
deduplicated.

### Claude Agent SDK

`patch()` (`Provider.CLAUDE_AGENT_SDK`) wraps the Python Claude Agent
SDK's `query()` and `ClaudeSDKClient`. The SDK runs the Claude Code CLI
as a subprocess that calls the model itself, so the anthropic patch sees
none of its calls; the interceptor reports them from the SDK's message
stream instead. The `query()` wrap sits on the SDK's internal
`InternalClient.process_query`, which every `query()` call goes through,
so a caller that imported `query` before `patch()` ran is still
observed; the SDK version is pinned below 0.3 for that reason.

Each `query()` call, and each `ClaudeSDKClient` connection, is one
Flightdeck session. Its id is the Claude Code session id the SDK's
`init` message reports, and it belongs to a separate agent:
`client_type=claude_agent_sdk`, with the sensor's `agent_type`,
`agent_name`, `user`, `hostname` and flavor (the agent id differs from
the sensor session's because `client_type` is part of its derivation).
From the stream:

| SDK message | Event |
|---|---|
| `SystemMessage` with subtype `init` | `session_start`: `context` carries the Claude Code version, the model, the permission mode, the working directory, the API key source and the configured MCP servers' names |
| `AssistantMessage` | one `post_call` per message id: the model, token counts from its `usage` (the cache split included), `stop_reason`, the billing mode, `provider_metadata.platform`, and its content under `capture_prompts` (the turn's prompt as the first call's messages, the message's blocks as the response); plus one `tool_call` per `tool_use` block, its input under `capture_prompts`. Claude Code's own `<synthetic>` messages (an API error, an interrupt) are not model calls and are skipped |
| end of the run | `session_end` (`close_reason=normal_exit`, or `state=error` with the error of the run's last `ResultMessage` when it failed) |

Every event of the run carries the bare `framework=claude_agent_sdk`;
the `session_start`'s `context.frameworks[]` lists `claude_agent_sdk/<version>`
first, then the process's other frameworks.

A `ResultMessage` ends one turn; a run can have several (a prompt
stream, or a background task waking the run). The session ends when
the run does: the `query()` stream is exhausted or closed, or the
`ClaudeSDKClient` disconnects.

The CLI streams an assistant message as one `AssistantMessage` per
content block under one message id. A subagent's messages (those with a
`parent_tool_use_id`) count toward the run's session and can interleave
with the run's own, so blocks are collected per chain (the run's own,
and each `parent_tool_use_id`): a message is reported when its chain
moves to another message id, at a result, or at the end of the run, and
each message id once. A tool result does not complete a message, since
the CLI runs tools while the message is still streaming.

The billing mode follows the plugin's precedence, over the CLI's
environment (the process's, overlaid by the options' `env`): an explicit
`FLIGHTDECK_BILLING_MODE`; `metered` on a cloud provider
(`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX` or `_FOUNDRY`) or with
`ANTHROPIC_AUTH_TOKEN`; `subscription` when the init message's API key
source is `none` (a Claude login); `metered` otherwise. The platform is
the cloud provider, else the host of `ANTHROPIC_BASE_URL`, else
`anthropic`.

The interceptor adds `FLIGHTDECK_SDK_OBSERVED=1` to the CLI's
environment (the options' `env`, the caller's own entries kept), so a
Claude Code plugin the CLI loads does nothing for the run (see
"Claude Agent SDK and Claude Code" under Client type registry). A run
started with a custom `transport` is reported too, but the options'
`env` never reaches a transport built before them, so the interceptor
logs a warning that a plugin in that run may report it again. It never
replaces a caller's `can_use_tool` or hooks, and an error while setting
up the observation leaves the run to the SDK unobserved.

**Control.** An SDK run takes directives and the MCP Protection Policy:
its `session_start` sets `context.supports_directives=true`, so the
dashboard offers Stop for it and fleet-wide stops and token-budget
policies reach it. The interceptor adds two hook callbacks to the
options' `hooks`, after the caller's own: `PreToolUse` and
`UserPromptSubmit`. The CLI waits for them, and a deny from either the
caller's hooks or these wins.

A directive for the run arrives in the response to any of its events,
or to `POST /v1/heartbeat`, which the `PreToolUse` callback sends for
the run when it has sent nothing for 5 seconds (one attempt with a
2-second timeout; a failed poll is skipped and the gates still run). The sensor's event
queue hands a directive to the run its event belongs to, and one for the
process's own session (or its sub-agent children) to the sensor's
directive handler. A run's directives are never applied to the sensor's
session, nor the other way round. The effects are the plugin's (see
Claude Code > Enforcement), applied by the callbacks:

| Directive | Effect |
|---|---|
| `shutdown`, `shutdown_flavor` | The run is stopped: every later tool call is denied with `continue: false`, which ends the turn, and every prompt is blocked. The sensor sends `directive_result` (`acknowledged`), plus `policy_block` when the reason is `token_budget_exceeded`; the run's `session_end` has `close_reason=directive_shutdown`. |
| `warn` | The next callback tells the run it crossed the token policy's warn threshold, as a `systemMessage` for whoever watches the run and as `additionalContext` for the model; `policy_warn` is sent. |
| `degrade` | Advisory, as for Claude Code: a hook cannot change the run's model, so the notice (delivered as for `warn`) names the degrade target; `policy_degrade` and an `acknowledged` `directive_result` are sent. |
| any other | `directive_result` with `directive_status=error`. |

For an `mcp__<server>__<tool>` call the `PreToolUse` callback evaluates
the MCP policy the sensor loaded for its flavor. The server is resolved
as the Claude Code plugin resolves it: the hook input's `mcp_server`
name when present, else the longest known server name whose tool-name
form (characters outside `[A-Za-z0-9_-]` become `_`) prefixes the call.
Known servers are the options' `mcp_servers`, then those Claude Code's
config declares for the working directory (the nearest `.mcp.json`, and
`~/.claude.json`'s user-wide and per-project `mcpServers`). The policy
identity is the server's name and its `url`, or its `command` and
`args` joined by spaces, the same identity the plugin and the sensor's
MCP interceptor use. `warn` sends `policy_mcp_warn` and allows the call;
`block` sends `policy_mcp_block` and denies it with the policy's reason.
An in-process server (`type: "sdk"`) is the caller's own code, not an
external MCP server, and is not gated; nor is a server with no
definition the sensor can read (a plugin's), as the plugin's own gate
does not gate a server it cannot identify.

Enforcement fails open: a callback that raises allows the call, and a
stop already received stays in force until the run ends.

### Runtime context auto-collection

`sensor/flightdeck_sensor/core/context.py` runs a pluggable collector chain
on `init` and attaches the resulting dict to the `session_start` event
payload via `Session.set_context`.

`ContextCollector` Protocol: `applies -> bool`, `collect ->
dict[str, Any]`. Both must never raise. `BaseCollector` wraps `_gather`
in a try/except; the top-level `collect` orchestrator wraps each
collector call in a *second* try/except. Two layers of protection mean a
single broken collector cannot crash the sensor or block `init`.

Three collector phases:

1. **`PROCESS_COLLECTORS`** — `ProcessCollector` (pid, process_name),
   `OSCollector` (os, arch, hostname), `UserCollector`, `PythonCollector`,
   `GitCollector`. All run; results merge.
2. **`ORCHESTRATION_COLLECTORS`** — `KubernetesCollector`,
   `DockerComposeCollector`, `DockerCollector`, `AWSECSCollector`,
   `CloudRunCollector`. Run in priority order, **first match wins** (the
   loop breaks). This avoids ambiguous "kubernetes AND docker" results
   inside k8s pods that also have `/.dockerenv`.
3. **`OTHER_COLLECTORS`** — `FrameworkCollector`. Inspects `sys.modules`
   for the known AI frameworks listed under Framework attribution
   (deepagents, crewai, google_adk, openai_agents, agent_framework,
   semantic_kernel, autogen, ag2, agno, strands, pydantic_ai,
   smolagents, claude_agent_sdk, llama_index, haystack, dspy, langgraph,
   langchain). Never imports anything new — a framework not loaded when
   it runs is not claimed; one loaded after `init` is picked up by the
   late detection described there.

`GitCollector` shells out to `git` with a 500 ms `subprocess` timeout,
strips embedded credentials from the remote URL via
`re.sub(r"https?://[^@]+@", "https://", remote)`, and falls back silently
when git is missing or the cwd is not a repo.

The context dict is set-once: it ships on `session_start` only; subsequent
events do not carry context. The worker's `UpsertSession ON CONFLICT`
deliberately omits `context` so whatever the agent saw at startup is the
canonical record for that session.

### Custom directives

Sensor-side: the `@flightdeck_sensor.directive(...)` decorator registers a
handler at module load time into the module-global `_directive_registry:
dict[str, DirectiveRegistration]`. `_compute_fingerprint(name, description,
parameters)` is the SHA-256 digest of the canonical JSON of the directive
schema, base64-encoded; it changes when the handler signature changes.

`Session.start` calls `_sync_directives(registry)`: POST every registered
fingerprint to `{api_url}/v1/directives/sync`. For each unknown fingerprint
returned, POST the full schema to `{api_url}/v1/directives/register`.

`Session._execute_custom_directive(directive)` validates payload via
`DirectivePayloadSchema`, looks up the handler in `_directive_registry`,
verifies fingerprint match, runs the handler with a 5-second timeout via
`_run_handler_with_timeout`, and enqueues a `directive_result` event with
`directive_status` (`"success"` or `"error"`), `result`, and `error`.
Never raises — always fails open.

`_run_handler_with_timeout(handler, ctx, params)` uses SIGALRM on Unix when
running on the main thread. On Windows OR on any non-main thread the SIGALRM
path is bypassed and the handler runs without a timeout. Custom directive
handlers always run on the `flightdeck-directive-queue` daemon thread (never
the main thread), so the SIGALRM timeout effectively never applies in
practice. A badly written or hung handler stalls the directive queue
indefinitely. It cannot affect event throughput because the drain thread is
independent (the entire point of the two-queue pattern), so `post_call`
events keep flowing to ingestion regardless of how slow the handler is.

Acknowledgement events: in `_apply_directive`, before acting on
`SHUTDOWN`, `SHUTDOWN_FLAVOR`, or `DEGRADE`, the sensor enqueues a
`directive_result` event with `directive_status="acknowledged"` and an
action-specific result dict (e.g. `from_model` / `to_model` for degrade,
`reason` for shutdown). For shutdown variants the sensor calls
`EventQueue.flush` synchronously before raising the shutdown flag so the
acknowledgement is not lost when the process exits. The synchronous flush
is safe because `_apply_directive` runs on the dedicated directive handler
thread, not the drain thread; `Queue.join` on the event queue makes
progress without self-deadlock.

`EventQueue.flush(timeout=3.0)` synchronously drains pending events up to a
deadline (event queue only). Used by `Session.end` and the shutdown /
shutdown_flavor branches. The directive queue is intentionally NOT waited
on: `flush` is typically called from inside `_apply_directive` running on
the directive handler thread, and `Queue.join` on the directive queue
would self-deadlock because the current item has not had `task_done`
called on it. The directive queue is internal control flow; the event
queue is the externally observable state operators care about flushing
before shutdown.

### Token race / forced degrade

`Session.record_usage` returns the post-increment `_tokens_used` total
atomically (return type is `int`). The increment AND the read happen inside
the same `with self._lock:` critical section so a concurrent caller cannot
read the value after another thread's increment has bled into it.

`_post_call` order of operations: (1) `record_usage` returns the
post-increment total atomically, (2) `record_model`, (3)
`_build_payload(..., tokens_used_session=session_total,...)` with the
captured value passed explicitly. This guarantees `tokens_used_session`
reports the correct total under both single-threaded and concurrent use
.

`PolicyCache._forced_degrade` is a boolean flag that arms a forced DEGRADE
decision in `check`. Set by `set_degrade_model(model)` when the sensor
receives a DEGRADE directive from the server. Cleared by
`update(policy_dict)` (called for `POLICY_UPDATE` directives) so a fresh
policy can un-stick the forced state if the server retracts the degrade.

`check` short-circuits at the top of the locked block: if
`_forced_degrade and degrade_to`, returns `PolicyResult(DEGRADE,
source="server")` regardless of token thresholds. Required because the
worker's policy evaluator may issue a DEGRADE directive based on its own
cumulative count without populating the sensor's local `degrade_at_pct`
cache (preflight policy fetch can fail silently).

On a DEGRADE decision `_pre_call` sends the call to `degrade_to`: it
swaps `model` and drops the request parameters the provider names as
other models the call could run in its place (`model_alternative_params`;
on the litellm adapters, `fallbacks` and `context_window_fallback_dict`),
so the degrade target is the only model the client side can run. A
provider that picks a model on its own servers is outside that: when the
degrade target is itself an OpenRouter or SAP model, request parameters
such as OpenRouter's `models` / `route` (in `extra_body`) or SAP's
`fallback_sap_modules` pass through unchanged, and that provider may
serve another model.

### Pydantic schemas

`sensor/flightdeck_sensor/core/schemas.py` carries Pydantic v2 models for
control plane envelopes. All use `model_validate` and fail open on
`ValidationError`:

- `DirectivePayloadSchema`: validates the `payload` field of a custom
  directive received in a response envelope. Fields: `directive_name: str`,
  `fingerprint: str`, `parameters: dict`.
- `PolicyResponseSchema`: validates `GET /v1/policy`. Fields:
  `token_limit`, `warn_at_pct`, `degrade_at_pct`, `degrade_to`,
  `block_at_pct`, `unavailable_policy`.
- `DirectiveResponseSchema`: validates the `directive` object inside an
  ingestion response envelope. Fields: `action`, `reason`, `grace_period_ms`,
  `degrade_to`, `payload`.
- `SyncResponseSchema`: validates `POST /v1/directives/sync` response.
  Fields: `unknown_fingerprints: list[str]`.

Pydantic v2 is sensor-only; Go API handlers keep manual validation.

### Sensor singleton

The `_session` and `_directive_registry` module-level globals make the
sensor a process-wide singleton. The second `init` call in any thread is
a no-op with a warning. Pattern B (one init per thread, isolated Sessions)
and Pattern C (multiple agents in one process, each with its own Session)
are not supported in the current model.

### Shutdown and signals

`Session.start` registers `Session.end` with `atexit` and, when `init` runs
on the main thread, a SIGTERM handler and (except on Windows) a SIGINT
handler. `end` settles the streams still open, flushes the event queue,
posts `session_end` (`close_reason=normal_exit`, or `directive_shutdown`
after a shutdown directive), flushes again and closes the queue; a second
call does nothing. `teardown()` calls it too.

A signal handler runs on the main thread on top of whatever the signal
interrupted, which can be inside the session's, the policy cache's or the
event queue's lock, none of them re-entrant. So the handler takes no lock
and waits on none:

1. It claims the end of the session with a non-blocking lock acquire, so
   it and `end` never both run it, and hands the work to the event queue's
   drain thread: a plain attribute the drain loop checks before each wait
   for an event, plus a wake-up item put on the queue only when the
   queue's lock is free (otherwise the drain thread notices the request
   within its one-second wait). The drain thread posts the events already
   queued, settles the open streams, posts the events that queues, then
   posts `session_end`, so `session_end` is the session's last event.
   Directives that arrive from then on are dropped, and the directive
   thread is stopped.
2. The handler polls for that to finish, for up to 2 seconds, then passes
   the signal on to the handler it replaced: it calls a Python handler
   (Python's own SIGINT handler raises `KeyboardInterrupt`), or, for the
   default action, restores it and raises the signal again, so the process
   ends as it would have without the sensor. Past the 2 seconds the drain
   thread is still finishing an event's POST that was under way, or
   waiting for a slow control plane, or briefly for a lock the signal
   interrupted: a Python handler is called anyway (the `end` that
   `atexit` runs then waits for the drain thread), while for the default
   action the handler returns and the drain thread delivers the signal to
   the main thread again once `session_end` is out. That delivery is
   cooperative: Python runs a handler only between the main thread's
   bytecodes, so a main thread inside a long call into native code holds
   the exit until the call returns.
3. A second signal while that shutdown runs, or after it, is passed on at
   once, so it forces the exit. A signal that interrupts `end` itself is
   passed on at once too; one that arrives while `end` runs on another
   thread waits for it (2 seconds at most).

The drain thread's shutdown has one deadline, 8 seconds from the signal
(`SHUTDOWN_TIMEOUT_SECS`). The queued events get the first 3 seconds and
`session_end` the rest. Each POST the shutdown makes is one attempt, with
its timeout capped by the time left, and the events still queued when
their 3 seconds run out are dropped, so a control plane that is down or
never answers holds the exit for at most the deadline, not for a retry
cycle per event. An event's POST already under way when the signal
arrives, the usual case while events flow, cannot be cut short: its
attempt runs to the transport's 10-second request timeout, its retry is
skipped, and `session_end` still gets one half-second attempt after it.
So the shutdown ends within about 10.5 seconds of the signal
(`SHUTDOWN_LIMIT_SECS`), well inside the 30 seconds Kubernetes gives a pod
between SIGTERM and SIGKILL. A request timeout bounds each socket
operation (the connect, each read), not name resolution, so a slow DNS
lookup for the control plane can take longer. A POST that fails during
the shutdown is counted rather than logged, and the counts, like the
session's own log line, are logged once the shutdown is over: logging
takes locks the interrupted code may hold.

Within it, each wait of the drain thread's for a lock the interrupted code
may hold lasts half a second at most (`SHUTDOWN_LOCK_WAIT_SECS`), and none
is made past the deadline: on Python 3.13 an exception a signal handler
raises while the interrupted code is at a loop's back-edge can skip that
code's `with` and `finally` exits, leaving the lock held for good. The
open streams are settled, and the events that queues posted, only when
the session's, the open-stream registry's, the policy cache's and the
event queue's locks are all free within that wait; otherwise they are
left as they are. `session_end`'s token total, framework, model and close
reason are read under the session's lock when it comes free in time, and
as plain attribute reads without it otherwise; once found held, it is not
waited for again. Nothing on this path imports a module: the modules
it uses are loaded with the sensor, because a first import can wait for
one the interrupted code is in the middle of, and module code that calls
`exec` (a dataclass definition does) clears the flag CPython uses to give
a process ended by an unhandled `KeyboardInterrupt` its SIGINT exit
status.

`end`, called after a signal started the shutdown (by `atexit`, or
`teardown()`), waits for the drain thread to finish it, up to that
10.5-second limit from the signal. A signal the application ignores
(`SIG_IGN`) is left ignored and the session carries on; a handler
installed outside Python, which Python cannot pass a signal on to, is
left in place. No thread is added for any of this.

---

## Plugin (Claude Code)

The plugin is a set of hook scripts registered in
`plugin/hooks/hooks.json`. Claude Code invokes each hook as a short-lived
child process; the plugin reads the hook event from stdin,
resolves session identity, builds an event payload, POSTs to
`/ingest/v1/events`, and exits. No in-process interception, no background
threads inside a hook, no shared state across hook invocations beyond a
small set of marker files in the plugin's state directory (session id,
per-turn dedup, cached model, endpoint and git probes, the MCP policy
cache). The one process that outlives a hook is the detached worker the
`SessionEnd` hook starts (see `SessionEnd` below).

The state directory is `$CLAUDE_PLUGIN_DATA/state`. Claude Code gives
every plugin a persistent data directory (`~/.claude/plugins/data/<id>/`)
that survives reboots and plugin updates; when it is not set (a Claude
Code without it, a test harness), the directory is
`$TMPDIR/flightdeck-plugin`. It is created 0700. Once a day the first
`SessionStart` deletes every file in it that no hook has used for seven
days. Every hook refreshes its own session's files (marker, start and
git markers, cached model and endpoint, MCP policy cache), so a session
loses them only when it has run no hook for seven days; resuming it
then starts a new Flightdeck session and fetches its MCP policy again.
The per-turn markers are empty files, one per model call. The git
commit, branch and repo name a hook reports are probed once per Claude
Code session and working directory, at `SessionStart` or the first hook
after a directory change, and read from the state directory afterwards.

By default the plugin only observes: a directive returned in a POST
response is left unread, the plugin payload sets
`context.supports_directives = false` on `session_start`, and the
dashboard hides the Stop Agent button and the Fleet Stop All control
skips these sessions. This is the observer-session class. With
enforcement on the session takes Stop and token budgets, but the
dashboard still offers it no custom directives: the plugin answers one
with an error. With the
plugin's enforcement on, the session takes directives instead (see
Enforcement).

### Configuration

The server and the token come from, in order: the `FLIGHTDECK_SERVER`
and `FLIGHTDECK_TOKEN` environment variables; the plugin's `server`
and `token` options; then `http://localhost:4000` and `tok_dev`, the
local `make dev` stack. The options are `userConfig` in
`plugin/.claude-plugin/plugin.json`, set in `/plugin` under the
plugin's **Configure options**. Claude Code keeps the server in the
user's `settings.json` (`pluginConfigs`) and the token, marked
`sensitive`, in its credential store (the macOS Keychain, otherwise
`~/.claude/.credentials.json`), and exports both to every hook process as
`CLAUDE_PLUGIN_OPTION_SERVER` and `CLAUDE_PLUGIN_OPTION_TOKEN`. The
environment wins so a wrapper script or a CI job can point one run at
another stack without changing the saved options. The defaults live in
the plugin (`core/config.mjs`), so the manifest declares none and an
option the user never saved reaches the hooks unset. A blank value
counts as unset. Credentials embedded in
the server URL are stripped before use, and the default token prints
a warning on every hook unless `FLIGHTDECK_QUIET=1`.
`FLIGHTDECK_CAPTURE_PROMPTS` and `FLIGHTDECK_CAPTURE_TOOL_INPUTS` stay
environment variables (see Content Capture). A repository's project
settings (`.claude/settings.json`, `.claude/settings.local.json`) can
set any of these variables in their `env`, which Claude Code applies
over the shell and passes to the hooks, so a repository can choose the
server, the token and the capture switches for the sessions run in it;
only managed settings, or `--settings`, outrank a repository's settings.

Every event body the plugin POSTs is at most 768 KiB
(`MAX_EVENT_BODY_BYTES`). Ingestion reads at most 1 MiB of a body and
NATS carries an event with the same 1 MiB `max_payload`; a larger body
is rejected (413 from the dev nginx, 400 from ingestion), and with it
the call's token counts. The size is measured as ingestion's Go encoder
writes the event when it rewrites one (a `session_start`, to add the
token id and name, or an event with a replaced value; see Validation
rules): `<`, `>` and `&` count six bytes each, U+2028 and U+2029 six
bytes each. A prompt, a
tool result or a sub-agent message can exceed that, so an event over
the limit has the strings of its captured `content` cut, every one to
the same largest length that fits, with
`… [flightdeck: kept N of M bytes to fit the event size limit]` in
place of the cut text. Keys, block structure and the metadata outside
`content` are untouched. When no cut fits (the structure alone is over
the limit), the event is sent with `has_content=false` and no content.
Either case writes one warning line to the hook's stderr.

### Hook configuration

`plugin/hooks/hooks.json` registers the twenty-four hooks, each running
`observe_cli.mjs`, and on `PreToolUse` and `UserPromptSubmit` a second
handler, the enforcement gate (see Enforcement). Every hook but
`SessionEnd` sets an explicit `timeout` (seconds); Claude Code's default for a command hook is 600
(30 for `UserPromptSubmit`), so a hook stuck on a wedged CLI or an
unreachable server could otherwise hold the session for ten minutes.
Each value is sized for the hook's normal worst case:

| Hook | Timeout (s) | Normal worst case |
|---|---|---|
| `SessionStart` | 30 | `claude auth status` (5 s), the `session_start` POST (2 s), the MCP policy fetch (1.5 s), git probes (1.5 s), then one POST per declared MCP server whose decision is not `allow` |
| `UserPromptSubmit` | 15 | the `session_start` backstop (git probes and its POST) and the `pre_call` POST (2 s each) |
| `PreToolUse` | 10 | local reads only (the policy cache, remembered decisions and, with enforcement on, the control state), plus a 2 s heartbeat when the session has been quiet for 5 s |
| `UserPromptSubmit` (the enforcement gate) | 10 | the same control-state read and heartbeat |
| `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` | 30 | the transcript flush: up to two `claude auth status` runs (5 s each) for a session whose billing mode is not settled, then 2 s per unsent turn |
| `SubagentStop` | 30 | up to 2 s for the subagent's final turn to reach its transcript, the same flush over that transcript, then the child `session_end` |
| `SubagentStart` | 15 | up to 1 s for the subagent's files, then the child `session_start`; on a resume, first up to 3 s for an end the previous execution still owes that another hook is sending, or that end itself, after that execution's unsent turns (under the 25 s flush deadline). The hook runs async, so Claude Code does not enforce the timeout on it |
| `PreCompact`, `PostCompact`, `PostModelSwitch`, `Notification`, `PermissionRequest`, `PermissionDenied`, `UserPromptExpansion`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `CwdChanged`, `ConfigChange`, `Elicitation`, `ElicitationResult` | 15 | one or two POSTs |

Claude Code cancels a synchronous hook that runs out of time and carries on, as for
any non-blocking error. What the hook had not done by then is deferred
or lost: unsent turns are sent by a later hook (each carries its
message-derived id, so a copy is dropped by the worker); the turn or
tool event whose POST was in flight keeps the cancelled process's
claim, which a subagent's `SubagentStop` or the `SessionEnd` worker
takes over (see below and Tool calls and failures); a `session_start` that was not accepted is retried by the next
hook; a subagent's `session_end` stays owed until a later hook sends it
(see Subagent hooks); and the policy cache is written before the policy
events, so gating continues. Lost for good are the remaining
`policy_mcp_warn` / `policy_mcp_block` events of a `SessionStart`. A
`PreToolUse` that times out lets the tool call through, like every
other failure of the gate (it fails open).

`SessionEnd` has none: Claude Code gives SessionEnd hooks a shared 1.5 s
budget, which a per-hook timeout would raise (up to 60 s) and so delay
Claude Code's exit; the hook instead hands its network work to a
detached worker (see `SessionEnd`). `PreToolUse` matches `^mcp__`, the
MCP tools the policy gate decides on; no process starts for any other
tool call. The other tool hooks match every tool.

The hooks that only report run with `async: true`: `UserPromptSubmit`,
`PostToolUse` for every tool but MCP tools (matcher `^(?!mcp__)`),
`PostToolUseFailure`, `Stop`, `StopFailure`, `Notification`,
`PermissionRequest`, `PermissionDenied`, `UserPromptExpansion`,
`TaskCreated`, `TaskCompleted`, `TeammateIdle`, `CwdChanged`,
`ConfigChange`, `ElicitationResult`, `SubagentStart` and `SubagentStop`. Claude
Code starts them and
carries on without waiting, which saves the roughly
200 ms a hook process takes on every prompt, tool call and turn end.
These stay synchronous:

- `SessionStart` writes the MCP policy cache `PreToolUse` reads;
- `PreToolUse` returns the gate's decision, and the enforcement gates
  (`PreToolUse` for non-MCP tools and the second `UserPromptSubmit`,
  both run only with enforcement on) return theirs;
- `PostToolUse` for MCP tools (matcher `^mcp__`) records a remembered
  approval the next call's `PreToolUse` reads;
- `SessionEnd` hands off to its worker inside Claude Code's exit budget;
- `PreCompact`, `PostCompact` and `PostModelSwitch` are rare and send one
  event each, and in a print-mode run a compaction or a `/model` switch
  is often the run's last act, so Claude Code would cancel them as
  pending async hooks at exit. Claude Code holds the next request up to
  five seconds for a `PostModelSwitch` hook's output; the plugin's
  worst case is one 2 s POST, two when the `session_start` backstop also
  posts;
- `Elicitation` runs before Claude Code shows an MCP server's form, so
  its `elicitation_requested` is recorded before the asynchronous
  `ElicitationResult` hook can report the answer (run together, the two
  land in either order). It prints nothing, so it never answers the
  request, and holds the form for the one POST.

Claude Code does not enforce `timeout` on an async hook, so the plugin
bounds its one open-ended step itself: a hook starts no new
transcript-turn POST after 25 s (`HOOK_FLUSH_DEADLINE_MS`; the SessionEnd
worker uses 20 s) and leaves the rest to a later hook.

Async hooks of a session can overlap with each other and with its
`SessionEnd`, so two pieces of state guard them:

- A turn's marker is claimed before its POST and names the claiming
  process; it is emptied once the server accepts the turn. When the POST
  fails, the claim is released and the flush stops there, so the next
  hook sends that turn and the ones after it; during an outage each hook
  pays one failed POST. A turn ingestion refuses as invalid (a 400 with
  ingestion's own JSON error, or a 413 for its size) is marked refused
  and the flush goes on to the next turn, so it cannot hold back the
  turns after it. Two refusals are failures instead: a 400 without that
  body (from a proxy, or a wrong server URL), and ingestion's clock-skew
  refusal of a turn younger than its 48-hour past window, which means the
  two clocks disagree (the error does not say which way) and passes once
  they agree. In a print-mode or SDK
  run, Claude Code kills the async hooks still pending at the end,
  before `SessionEnd` runs, and their claims stay behind: a subagent's
  `SubagentStop` and the SessionEnd worker, the last processes to read a
  transcript, take over every claim that was never confirmed and whose
  process is gone, and send the turn. A takeover rewrites the claim
  under a lock, so two processes never take over one turn, and a claim
  held by a live process is left to it, so two live processes never send
  one turn (the worker would count two concurrent copies). Interactive
  runs do not cancel async hooks; they finish after `SessionEnd`. The
  liveness check is a signal-0 probe of the pid: a reused pid reads as
  alive, and that turn is then lost as it would have been without the
  takeover.
- `SessionEnd` leaves an ended-session marker with the session id. A
  hook of the same Claude Code session that starts after it reports
  under that id and skips the `session_start` backstop, so it neither
  mints a stray session nor reopens the ended one; the next
  `SessionStart` (a resume) removes the marker. The worker stores the
  events such a hook sends after the `session_end`, but, as for any
  closed session, skips their side effects: a call published after the
  end adds no tokens (see Terminal-state handling). The marker is
  written only for a hook event that carries Claude Code's session id,
  never on the working-directory fallback key.

The same lateness applies to a subagent: its interior hooks run async,
so on a slow server an interior `tool_call` can reach the worker after
the child's `session_end` (sent by `SubagentStop`) and be stored without
side effects. Such a late hook never sends the child's `session_start`
again (see Subagent hooks), so it cannot reopen the child.

### Session identity

`getSessionId` resolves in this order:

1. `CLAUDE_SESSION_ID` / `ANTHROPIC_CLAUDE_SESSION_ID` env vars.
2. A marker file at
   `<state directory>/session-${sha256(native session id)[:16]}.txt`,
   keyed on Claude Code's own per-invocation session id: the
   `session_id` Claude Code stamps on every hook event, or the
   `CLAUDE_CODE_SESSION_ID` variable it exports to hook processes when
   the payload carries none. The first hook of an invocation writes it;
   every later hook in the same run reads it verbatim. The native id is
   never the Flightdeck session id; it rides on every event as
   `context.claude_code_session_id` so a dashboard session maps back to
   its Claude Code transcript.
3. A fresh RFC 4122 v4 UUID, written to that marker, so each Claude Code
   invocation is one session row. Cross-invocation continuity lives in
   `agent_id`, not in the session id.
4. When neither the hook event nor the environment names a session (a
   caller other than Claude Code), the marker is keyed on
   `sha256(cwd)[:16]` and one stderr warning is printed.
5. An ephemeral `sha256(time, pid, cwd)[:32]` when the state directory is
   unusable.

The marker file exists because every hook invocation runs as a separate
Node child process — pid-based fallbacks would create one session row per
tool call. `SessionEnd` deletes the marker, so `/clear`, a `--resume`
or a new `claude` run mints a new session id. A run that ends without
`SessionEnd` (a crash or a reboot) leaves the marker in place, so
resuming that conversation (Claude Code keeps its session id on
`--resume`, not on `--fork-session`) within seven days continues the
same Flightdeck session; in the `$TMPDIR` fallback a reboot clears the
marker.

A session that `SessionStart` mints also records when: the time is
written to `minted-${sessionId}.txt` before the marker itself, so any
hook that reads the marker finds it. It is keyed on the Flightdeck
session id rather than on the marker, so the SessionEnd worker and a
hook that runs after `SessionEnd`, which no longer have the marker,
still find it, and it is not deleted at `SessionEnd`; the seven-day
prune removes it. Every transcript flush of the session sends only the
turns that ran after that time (see Subagent hooks). The mint time and
the transcript's record times come from the same machine clock, so a
clock that steps back by Δ after `SessionStart` loses up to Δ of that
session's first turns, whose times read as before the mint. A session
minted by any other hook records no time, since its conversation was
already running when the marker was written (as when the marker was
pruned), and neither does a marker an earlier plugin release wrote; such
a session's flushes send every unsent turn of the transcript.

### `session_start` with context

`ensureSessionStarted` uses a file-marker dedup so the `session_start`
event is sent exactly once per session id (marker file is
`<state directory>/started-${sessionId}.txt`, written once the server
accepts it). Hooks of one session run concurrently (parallel tool
calls, a subagent's `SubagentStart` beside its first interior hooks), so
a hook sends the event only while it holds
`starting-${sessionId}.txt`, created exclusively; another hook finding
it held sends nothing and waits, up to 2.5 seconds, for the server to
accept it, so that its own event follows the `session_start` and its
capture posture; a claim older than 30 seconds is taken over. A
subagent's `SubagentStart` sends the child's `session_start`, with the
prompt the subagent was given, through the same claim and marker; the
child's interior hooks give it one second to claim first, then send a
`session_start` themselves only if it has not. The payload carries the `collectContext` dict.

`collectContext` is the Node.js parallel of the Python sensor's
`context.py`: pid, process_name, os (Windows / Darwin / Linux), arch,
hostname, user, node_version, working_dir, git_commit / git_branch /
git_repo (each in its own try/catch with a 500ms execSync timeout,
credential-stripped remote URL), and orchestration detection (kubernetes >
docker-compose). Each probe is independently best-effort.

The context also carries what Claude Code tells the hook about the run.
Each value is an open pass-through bounded to 64 characters and free of
control characters; the lists below are the values known today, not
vocabularies. `claude_code_session_id` is the native session id,
reported only when it is a canonical UUID. `claude_code_version` is the
transcript's `version` when it is an anchored semver string (so absent
on the first `SessionStart`, before a transcript exists;
`CLAUDE_CODE_EXECPATH` is not used because it names the outermost
Claude Code binary when a session is started from another session's
shell). `session_source` is the hook's `source` (known values include
`startup`, `resume`, `clear` and `compact`). `entrypoint` is
`CLAUDE_CODE_ENTRYPOINT` (known values include `cli` for an interactive
terminal session and `sdk-cli` for `claude -p`; the SDKs set their own).
`attended` says whether a human is at the terminal, `child_session`
that Claude Code was launched from inside another Claude Code session,
`remote` / `remote_session_id` mark a cloud session and `ci` /
`ci_provider` a CI run. `agent_type` stays `coding` for every plugin
session because the ingestion vocabulary is `coding` / `production`;
these fields are the signals that tell an interactive session from a
headless, SDK, CI or cloud run. A `claude --bare` run executes no hooks,
not even those of a plugin passed with `--plugin-dir`, so the plugin
cannot observe it.

### Tool input sanitisation

`sanitizeToolInput(input)` is a strict whitelist that keeps ONLY:
`file_path`, `command` (truncated to 200 chars), `query`, `pattern`,
`prompt` (truncated to 100 chars). Everything else (content, message
bodies, sub-agent contexts) is dropped. Returns `null` if no whitelisted
field was present. Raw file bodies written by `Write` / `Edit` are never
forwarded.

`is_subagent_call: toolName === "Task"` is emitted on the wire so the
dashboard can distinguish sub-agent spawns from regular tool calls.
Consumed alongside `parent_session_id` by the dashboard's
swimlane connectors and the SessionDrawer Sub-agents tab to render
the parent's spawn event as the anchor for child rows.

### Tool calls and failures

Every `PostToolUse` and every `PostToolUseFailure` hook first flushes
the transcript turns not yet emitted (so the `post_call` that decided
on the tool precedes the tool's own event) and then becomes one
`tool_call` event (an `mcp_tool_call` when the tool name carries the
`mcp__` namespace). Both carry Claude Code's `tool_use_id` (the
`tool_use` block id in the transcript, at most 256 characters) and its
measured tool time as `duration_ms` and, on `tool_call`, as `latency_ms`
too; Claude Code measures the tool's execution excluding permission
prompts and `PreToolUse` hooks, and the fields are null when it did not
report one. `tool_name` and `server_name` are cut at 256 characters. A
failure adds an inline `error` block in the sensor's taxonomy shape:
`error_type=other`, `error_class=PluginToolError`, `message` and
`interrupted` (when Claude Code reports whether the failure reached it
as an abort). The message is the tool's error text cut at 1000
characters plus an ellipsis, a fixed placeholder (`tool failed (Claude
Code reported no error detail)`) when the hook carried no text, and the
JSON encoding of a non-string error; it is content, so it ships only
when both capture knobs are on and reads `<redacted>` otherwise (see
Content Capture). A failed `Bash` command, a `Read` on a missing file
and an MCP call that errored thus land as the same row shape as a
success with one extra field.

A failed `tool_call` (one whose `payload.error` is an object, from the
plugin's hook or from Claude Code's OTLP `tool_result`) counts as an
error on every per-session and per-agent error count: in the session
listing's `error_types[]` aggregate and its `error_type` filter, in the
agent summary's `errors` count, and in the dashboard's live patch of
that count. The api defines the predicate once (`errorEventFilter` in
`api/internal/store`) and the dashboard once (`isErrorEvent` in
`lib/events.ts`). These surfaces still read `llm_error` only: the Fleet
"Errors" event-type filter pill, the `/v1/search` `error` category, the
swimlane's red `llm_error` node colour, and `has_terminal_error`. A
failed `mcp_tool_call` keeps its own `mcp_error_types[]` indicator and
is not an `errors` count: MCP failures carry the JSON-RPC taxonomy, not
the LLM one. Without `OTEL_LOG_TOOL_DETAILS=1`, though, an MCP failure
reported over OTLP is stored as a `tool_call` named `mcp_tool`, so it
does count in `errors`. In the session drawer a
failed `tool_call` row carries the same red error indicator as a failed
MCP row, its detail reads `<tool> · failed`, and the expanded row lists
the error's type, class and message.

A tool event carries an id derived from its `tool_use_id`
(`uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://claude-code/tool_call/<tool_use_id>")`, for `tool_call`
and `mcp_tool_call` alike), so a copy sent again is stored once. Before
its POST the hook records the event as owed in
`tool-calls-<session id>.json`, keyed by `tool_use_id`, with what only
the hook knows and no content: the tool name, whether it failed and was
interrupted, its duration, the `mcp_server` hint, the event's time and
the transcript it came from; the entry is dropped once the server
accepts the event or refuses it for good, as for a turn (see Hook
configuration). When the POST fails, the entry is
released, as a turn's claim is, and the next hook of the same session
that flushes its transcript rebuilds the event after the turns: the
fields from the entry, and the input, the result and a failure's error
text from the transcript's `tool_use` and `tool_result` records (the
result as Claude Code gave it to the model), under the same capture
rules; the flush stops at the first failed POST. `SubagentStop` and the
`SessionEnd` worker do so last, taking over entries whose process is
gone, and send an event whose transcript records cannot be found
without its content; an earlier hook keeps such an entry for later. A
subagent's `session_end` follows the tool events its execution owes:
while a live hook is still sending one, the end stays owed for a later
flush and the pass goes on with the session's other subagents; the
`SessionEnd` worker, the end's last chance, waits up to three seconds
for such a hook before its last try, and a hook still sending after that
leaves the end unsent. Only
an event a hook tried to send is rebuilt: a tool use no hook reported (a
denied permission, a hook Claude Code cancelled before it ran) stays
unreported, and a hook that carried no `tool_use_id` sends an event
without an id, which is not retried.

For MCP tools the server identity is resolved in this order: the hook's
`mcp_server.name` when Claude Code sent it (2.1.274 and later; its
`source` says where the server was declared, and known values include
`project`, `user`, `plugin` and `sdk`), else the server segment of the
tool name, rebuilt to Claude Code's `plugin:<plugin>:<server>` key when
it carries the `plugin_<plugin>_<server>` prefix. The resolved key
becomes `server_name` on every version; `mcp_server` itself is passed
through only when the hook carried a well-formed one (a string `name`
and a string-or-null `source`, each at most 256 characters), exactly as
sent. A server bundled with another Claude Code plugin is keyed
`plugin:<plugin>:<server>` and its tools are named
`mcp__plugin_<plugin>_<server>__<tool>` (every character outside
`A-Za-z0-9_-` in the key becomes `_`). Plugin-bundled servers are not in
the project's `.mcp.json`, so their `transport` is null and the MCP
policy gate cannot fingerprint them; the gate fails open for them.

### Subagent hooks

Two hooks bracket every execution of a Claude Code subagent:

- `SubagentStart` — fired when Claude Code spawns a subagent, and again
  each time a stopped subagent runs once more: when the parent resumes
  it with `SendMessage`, or when a background task it started finishes
  and wakes it (a task notification). The plugin emits a child
  `session_start` whose `parent_session_id` carries the outer session's
  id and whose `agent_role` carries the hook payload's `agent_type`
  (e.g. `"Explore"`, `"fork"`). When `capturePrompts=true`, the prompt
  the parent gave the subagent is captured as `incoming_message` on the
  child's `session_start` payload.
- `SubagentStop` — fired when the subagent returns. The plugin sends
  the subagent's unsent turns, then a child `session_end` and (when
  capture is on) the subagent's report back as `outgoing_message`.
  `SubagentStop` is the canonical end-of-life signal for each execution
  of the child.

The child session id is `uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck:subagent://<outer session id>/<agent_id>")`. The outer
session id is the Flightdeck session the hook's `session_id` resolves
to (see Session identity), not Claude Code's own session id, and
`agent_id` is the id Claude Code gives the subagent on every hook of
every one of its executions (`tool_use_id` on versions without it). A
subagent therefore keeps one child row for as long as its parent's
Flightdeck session lasts, however often it is resumed; once the
parent's session changes (a `--resume` after an exit), a later
execution of the same subagent is a new child of the new session.

Neither hook carries the messages themselves, so the plugin reads them
from the files Claude Code writes for the subagent next to the parent
transcript: `<parent>/subagents/agent-<agent_id>.jsonl` (its
transcript) and `agent-<agent_id>.meta.json`, whose `toolUseId` names
the parent's `Agent` tool call. Both exist by the time the asynchronous
`SubagentStart` hook runs; the hook waits up to one second for them.

- The incoming message is the `prompt` input of that `Agent` tool call,
  found in the subagent's transcript or in the last 4 MiB of the
  parent's (the call is the parent's latest turn when the hook runs),
  so parallel subagents each get their own; without a meta file it is
  the subagent transcript's first user message given as a string, and
  a fork has none.
- The outgoing message is the `message` of the subagent's last
  `SubagentHandback` call (the tool a subagent reports back through),
  else the hook's `last_assistant_message`, else the text of the
  subagent's last assistant turn.
- A hook that carries `tool_input.prompt` or `tool_response` itself
  (older Claude Code versions) uses those.

A fork subagent (`agent_type` `fork`, or `isFork` in its meta file)
starts from a copy of the parent's history, so its transcript repeats
the parent's turns, ending with the one that made the `Agent` call,
under their message ids. The copy ends at the record holding the meta
file's `toolUseId`; without a meta file, the copied turns are those
whose message ids are in the parent's transcript. The fork's flushes,
at its interior hooks and at `SubagentStop`, emit only the turns after
the copy, its outgoing message comes from those turns, and the parent's
`post_call` events carry the copied turns' tokens.

**Resumes.** `SubagentStop` leaves an ended marker for the child,
`subagent-ended-<child id>.txt`. A `SubagentStart` that finds it is a
resume or a wake: it removes the marker and sends a new `session_start`
for the same child id, which ingestion re-attaches to the closed row
(see Session attachment flow). The child is active again, the calls of
the resumed execution count toward its `tokens_used`, and the session
drawer marks the start with the attachment badge. Each execution thus
has one `session_start` and one `session_end`. The resume's
`session_start` carries, as `incoming_message`, the message that resumed
the subagent: the last user prompt after its last turn of its own (a
`SendMessage`'s text, which Claude Code writes as a meta record with the
origin `coordinator`). A wake by a task notification writes a meta
record too, with the origin `task-notification`, but its text is Claude
Code's notice of the task rather than a message to the subagent, so a
wake's start carries no message, neither the notice nor the spawn's
prompt. The first start of a subagent that ran before, under an earlier
parent session, carries the resume's message the same way. A
hook of the child that runs while the marker is in place, an async hook
of an execution that has ended, never sends a `session_start`, so it
cannot reopen the child; it first waits up to one second for a resume's
`SubagentStart` to remove the marker, so that the first hooks of a
resumed execution still follow its start. Two orderings of a resume that
comes right as the subagent stops are guarded. A resume whose previous
execution's end a live `SubagentStop` is still sending waits up to three
seconds for it, so the resume's start follows that end. And a
`SubagentStop` that finds a resume's prompt already after the final turn
(the resume's `SubagentStart` may then have looked for the marker before
this hook wrote it, and sent no start) leaves the child open: the two
executions stay one, ended by the later `SubagentStop`.

**Delivery.** `SubagentStop` sends the child's `session_end` only once
the subagent's turns and the tool events it owes are sent, so the end
follows every call of the execution. Claude Code runs the hook before it has written the
subagent's final turn to the transcript (in a print-mode run the turn
was still missing a tenth of a second after its own timestamp), so the
hook first waits, up to two seconds, until the transcript's last
assistant message reads as the hook's `last_assistant_message`; a hook
without that field does not wait. Until it is accepted the end is owed:
`SubagentStop` records it in `subagent-ends-<outer session id>.json`
before its first POST, with the time it ran (the end's timestamp) and
the process working on it. When a POST fails, the next hook of the
session that flushes a transcript (`PostToolUse`, `PostToolUseFailure`,
`Stop`, `StopFailure` or `SubagentStop`) sends the remaining turns and
the end, and the `SessionEnd` worker does so last; as with a turn's
claim, an entry whose process is alive is left to it. An end still owed
when its subagent is resumed is sent before the resume's
`session_start`, and dropped if that fails, so that it cannot close the
resumed child.

**Never misfiled.** A transcript turn is sent only under the Flightdeck
session that was current when it ran. A flush in a session with a
recorded mint time (see Session identity) skips every turn that ran
before it, for the root and its subagents alike, and writes to the
hook's stderr how many of them it has no record of sending. The other
end is bounded too: a process that goes on reporting under a session
after a resume has minted a later one (the `SessionEnd` worker, or a
hook that started before the resume) looks at the conversation's marker
before and after each transcript read, and sends no turn that ran at or
after the later session's mint; that session sends it. The look finds a
later session in the marker while it runs and, once its `SessionEnd`
has deleted the marker, in the ended-session marker (see Hook
configuration); when both name one, the earlier mint applies. A
session's marker is written before any of its turns, and its
ended-session marker before the marker is deleted, so whenever one of
its turns is in what was read, the second look sees that session, unless
another session has started since: the look then sees only the newest,
and the turns of the one between can reach the ended session's child. So
a subagent resumed
after its parent's session changed sends only its new turns, under its
new child, and a turn still unsent when its session ends is never sent:
it is dropped rather than filed under a later session that did not exist
when it ran. Its last chance is the `SessionEnd` worker: after the
root's `session_end` it flushes every subagent transcript written since
the mint (the `agent-<agent_id>.jsonl` files under
`<parent>/subagents/`, nested subagents included, each subagent's role
read from its meta file's `agentType`), taking over orphaned claims, and
sends the ends still owed. A session without a mint time skips that
pass.

`PostToolUseFailure` on a Task tool emits the parent's `tool_call`
event with the structured error block; it does NOT emit a child
`session_end` (disambiguation). Subagent crashes that never
reach a clean `SubagentStop` fall through the worker's existing
state-revival path: the child session ages from
`active` to `stale` to `lost`, and the next event for the
`session_id` (or the reconciler) closes the loop.

### Per-turn flush

`flushPostCallTurns` emits `post_call` events on every PostToolUse and
PostToolUseFailure hook with `markEmittedTurn` per-messageId disk-marker dedup so mid-turn LLM
activity surfaces in real time instead of batching at Stop.

The markers are a local optimisation, not the guarantee: they are pruned
after seven days, they live in `$TMPDIR` (which a reboot clears) when
Claude Code provides no data directory, and a transcript replayed or
copied to another machine has none. Two rules keep a lost marker from
counting a call twice or in the wrong session. A flush sends only the
turns that ran after its session was minted (see Subagent hooks), so
a resumed conversation does not send its history again under the new
session; a session without a recorded mint time re-reads its whole
transcript. And each turn's `post_call` carries an event id derived
from the model call's message id (`uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://claude-code/post_call/<message id>")`), so every copy of
one call has the same id, and the worker stores it once (see
`originating_event_id` chain). A flush stops at its first failed POST,
and the next flush sends that turn again (see Hook configuration).

Each `post_call` carries `provider=anthropic`, the session's
`billing_mode` and `provider_metadata.platform`, which the
`SessionStart` hook determines once (see Cost estimation) and keeps in
the session's marker directory beside the cached model, so later hooks
do not run `claude auth status` again. A Vertex AI session also carries
`inference_scope`: `global` when `CLOUD_ML_REGION` is `global`, else
`regional`; a Bedrock session's scope comes from its model id (see
Model ids).
`model_requested` is the model the transcript turn names; Claude Code
does not expose a separate served id, so `model_served` is the same
value. The turn's `requestId` is sent as `provider_metadata.request_id`
and its `effort` as `effort`. `tokens_used_session` is the running total
of `tokens_total` over the conversation's turns up to and including this
one, as the transcript records them (a resumed conversation's earlier
turns included); a subagent's counts only its own turns. The plugin
sends no `cost_reported`: Claude Code's transcript holds its cost only
as occasional cumulative session totals, so its calls are priced from
the pricing table like any other.

A turn whose every record carries Claude Code's `<synthetic>` model is
not a model call: Claude Code writes one, with zero usage, for a turn
that failed on an API error (`isApiErrorMessage`) or was interrupted.
The flush skips it, so it never becomes a `post_call`.

`StopFailure` replaces `Stop` when a turn ends on an API error. The
hook flushes the turns completed before the failure, then emits an
`llm_error` (`terminal=true`, `provider=anthropic`). Claude Code's
`error` value maps onto the taxonomy (see `llm_error`) and is
`error.provider_error_code`, unless the transcript gives a finer kind
(below):

| Claude Code `error` | `error_type` | `is_retryable` |
|---|---|---|
| `rate_limit` | `rate_limit` | ✅ |
| `overloaded` | `overloaded` | ✅ |
| `server_error` | `api_error` | ✅ |
| `authentication_failed`, `cloud_credential_error` | `authentication` | ❌ |
| `oauth_org_not_allowed`, `account_on_hold` | `permission` | ❌ |
| `billing_error` | `quota_exceeded` | ❌ |
| `invalid_request` | `invalid_request` | ❌ |
| `model_not_found` | `not_found` | ❌ |
| `max_output_tokens`, `unknown`, and any value not listed | `other` | ❌ |

Claude Code's code is coarse, so two finer signals take precedence.
The transcript's `apiError` on the failed turn: `usage_limit_reached`
(a used-up subscription allowance) and `long_context_credits_required`
are `quota_exceeded`, and that kind becomes `provider_error_code`.
Failing that, the fixed opening of Claude Code's rendered message:
`Prompt is too long` is `context_overflow`, `You've hit your … limit`
and `API Error: Usage credits required` are `quota_exceeded`. The
message is read for this test only and is not stored unless
`capturePrompts` is on.

The failed turn is the transcript's last API-error turn answering the
hook's `prompt_id`. Claude Code can run the hook before it writes that
record; an earlier failure's record never stands in for it, and the
event then goes without the turn's id, kind or status.

`error.http_status` is the status leading the hook's `error_details`
(`429 Too Many Requests`), else the transcript's `apiErrorStatus` for
the failed turn. `error.error_message` is `StopFailure: <error>`, with
Claude Code's rendered error text (the hook's `last_assistant_message`,
or `error_details`) appended only when `capturePrompts` is on: on one
line, and past 200 characters cut to 197 plus `...`, as the sensor
keeps a provider's message. The event's id is
`uuid5(NAMESPACE_FLIGHTDECK, "flightdeck://claude-code/llm_error/<message id>")`
of the failed turn's synthetic record, and its timestamp is that
record's.

`main` returns naturally instead of calling `process.exit(0)`. Two
consecutive fetches in a single script invocation crash Node on Windows
with `STATUS_STACK_BUFFER_OVERRUN` (`0xC0000409`) if `process.exit` fires
while undici is mid-cleanup; letting `main` return lets the connection
pool drain. An exception that escapes `main` is logged as one stderr
line and the hook still exits 0.

Sessions carry `flavor=claude-code`, `agent_type=coding`, and
`client_type=claude_code` (identity); the entrypoint, attended, CI and
cloud signals that tell plugin sessions apart live in `context` (see
`session_start` with context above).

### `SessionEnd`

Claude Code allows `SessionEnd` hooks 1.5 seconds in total before it
exits, and a plugin-provided hook cannot raise that budget. The hook
therefore does no network work: it resolves the session id, deletes the
session and `session_start` markers (so a `SessionStart` that follows
immediately, after `/clear` or a new `claude -p`, mints a fresh
session), drops the per-session MCP policy cache, and re-launches the
hook script as a detached worker process (`observe_cli.mjs
--session-end-worker`, hook event on stdin, the resolved session id in
`CLAUDE_SESSION_ID`). The worker flushes any transcript turns that
`Stop` or `PostToolUse` had not yet emitted as `post_call` events,
sends the session's owed tool events, and POSTs the `session_end`;
then, in a session with a recorded mint time, it sends its subagents'
remaining turns, owed tool events and owed `session_end`s (see
Subagent hooks). It never touches the session, `session_start` or
policy markers, which a new session may own by then, and writes only
the per-message `emitted-` markers, the owed subagent ends and the owed
tool events. Because
the hook itself never waits on the network it finishes inside the
budget whatever the server does; the
test suite asserts it returns under `SESSION_END_HOOK_BUDGET_MS` with
every request still unanswered. It waits up to 0.8 s for the worker to
exit, so a local or fast server receives the events before the hook
returns and Claude Code exits; a slower server leaves the worker running
detached past the hook, under a 20 s flush deadline so an orphaned
backlog against a dead server stops instead of paying one aborted POST
per turn. The worker's stderr is appended to
`<state directory>/session-end-worker.log` (the directory is
created 0700, the file 0600 and opened without following symlinks,
truncated once it passes 256 KiB). The `session_end` carries
`close_reason=normal_exit` and `end_reason`, Claude Code's own reason
passed through as sent (known values include `clear`, `resume`,
`logout`, `prompt_input_exit` and `other`). A worker that dies before
its POSTs (a machine torn down right after `claude -p` returns, as an
ephemeral CI runner is) loses that session's final flush and
`session_end`; the session then closes through the stale, lost and
reaper path like any other whose end never arrived.

---

## Identity model

Every event payload carries a 5-tuple identity. Sub-agent
sessions extend the derivation with a conditional 6th input,
`agent_role`.

| Field | Vocabulary | Source |
|---|---|---|
| `agent_id` | UUID | Deterministically derived from the other identity fields via `core/agent_id.py` |
| `agent_type` | `coding` \| `production` | Sensor `init` kwarg or `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE` env. Plugin always emits `coding`; a plugin session's entrypoint / attended / CI / cloud signals are context fields, not identity |
| `client_type` | one of the values in the client type registry below | Each client sends its own literal: the plugin `claude_code`, the sensor `flightdeck_sensor` and its Claude Agent SDK interceptor `claude_agent_sdk`; the OTLP receiver stamps `claude_code` on Claude Code's own telemetry (see Client type registry > OTLP sources) |
| `agent_name` | string | Sensor `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` env, default `{user}@{hostname}`. The plugin uses `FLIGHTDECK_AGENT_NAME`, else `{user}@{hostname}`; a sub-agent appends `/{role}`. The plugin's flavor is always `claude-code` |
| `user` | string | Resolved from `getpass.getuser` (sensor) or `process.env.USER` (plugin) |
| `agent_role` (optional 6th) | string \| null | Framework-driven on sub-agent sessions. CrewAI: `Agent.role`. LangGraph: node name. Claude Code Task: hook payload `agent_type`. Null on root sessions and direct-SDK sessions |

Plus `hostname`, the fifth input of the derivation: the machine's
host name, which `FLIGHTDECK_HOSTNAME` overrides in both the sensor
and the plugin.

Ingestion returns 400 if any of the core 5-tuple fields are missing or
outside their vocabulary. `agent_role` is optional; both
absent on the wire and explicit-null are accepted.

### Enforcement

The plugin enforces when the user turns it on, with the plugin option
`enforcement` or `FLIGHTDECK_ENFORCEMENT=1`; it only observes otherwise.
Enforcement makes the session directive-capable: its `session_start`
sets `context.supports_directives=true`, so the dashboard offers Stop
for it and fleet-wide stops and token-budget policies reach it.

**Gating.** A synchronous hook that runs before every tool call and
every prompt applies the session's control state. Two hooks registered
for this run only when enforcement is on: `PreToolUse` for every tool
but MCP tools (the MCP `PreToolUse` hook gates as well) and a second,
synchronous `UserPromptSubmit`. Their command first checks the option in
the shell, so with enforcement off Node is never started and the cost is
a few milliseconds per tool call; with it on, each gated call pays one
hook process (about 0.2 s).

**Directives.** The ingestion API returns a session's pending directive
in the response to any of its event POSTs or to `POST /v1/heartbeat`.
The plugin reads it from every response, and the gate polls the
heartbeat when the session has made no request for 5 seconds. With
enforcement on, the plugin applies it to the session's control state
(`control-<sid>.json`, beside the other markers):

| Directive | Effect |
|---|---|
| `shutdown`, `shutdown_flavor` | The session is stopped: every later tool call is denied with `continue: false`, which ends the turn, and every prompt is blocked before it reaches the model. The plugin sends `directive_result` (`acknowledged`), then `session_end` with `close_reason=directive_shutdown`. A `shutdown` whose reason is `token_budget_exceeded` also sends `policy_block`. |
| `warn` | The next gated hook shows Claude Code's user a message (`systemMessage`) that the session crossed the token policy's warn threshold; `policy_warn` is sent. |
| `degrade` | A hook cannot change Claude Code's model, so a degrade is advisory: the user is told the session crossed the degrade threshold and how to switch (`/model <degrade_to>`); `policy_degrade` and an `acknowledged` `directive_result` are sent. |
| `custom` | Not supported: `directive_result` with `directive_status=error`. |

A subagent's hooks also apply the control state of the session that
spawned it, so stopping a session stops its subagents.

**Failure mode.** Enforcement fails open: when the server cannot be
reached the gate allows the call, so an outage never stops developers.
A stop the plugin has already received stays in force from the control
state until the session ends. With enforcement off, a directive in a
response is ignored.

### Client type registry

`client_type` names the client that produced an event. Its values form a
registry: a closed list, so ingestion still rejects anything outside it,
that holds every client Flightdeck integrates with, including those
whose emitter is still planned, so adding an emitter never needs
a schema change. The Claude Code plugin sends `claude_code`, the
Python sensor sends `flightdeck_sensor` and its Claude Agent SDK
interceptor `claude_agent_sdk`, and the OTLP receiver stamps
`claude_code` on Claude Code's own telemetry and `otlp` on the GenAI
frameworks' (OTLP sources, below); the
other values are reserved for the planned integrations
([#184](https://github.com/flightdeckhq/flightdeck/issues/184),
[#186](https://github.com/flightdeckhq/flightdeck/issues/186)). Each value
carries a display label and the defaults below:

| `client_type` | Label | Expected `agent_type` | `supports_directives` default | Runs custom directives | `billing_mode` default | Worker strips tool error text |
|---|---|---|---|---|---|---|
| `claude_code` | Claude Code | `coding` | `false` | no | `subscription` | yes |
| `flightdeck_sensor` | Sensor | `production` | `true` | yes | `metered` | no |
| `claude_agent_sdk` | Claude Agent SDK | `production` | `true` | no | `metered` | no |
| `codex` | Codex CLI | `coding` | `false` | no | `subscription` | yes |
| `copilot` | GitHub Copilot | `coding` | `false` | no | `subscription` | yes |
| `opencode` | OpenCode | `coding` | `false` | no | `metered` | yes |
| `gemini_cli` | Gemini CLI | `coding` | `false` | no | `metered` | yes |
| `cursor` | Cursor | `coding` | `false` | no | `subscription` | yes |
| `otlp` | OpenTelemetry | `production` | `false` | no | `metered` | yes |

- **Label.** What the dashboard shows in the client pill and facets.
- **Expected `agent_type`.** What the client sends in normal use, and
  the pairing the test fixtures and the Fleet anomaly check assert.
  Ingestion validates `agent_type` and `client_type` each against its
  own vocabulary and does not enforce the pairing: playground runs, for
  one, send the sensor with `coding` (CLAUDE.md rule 40a.A).
- **`supports_directives` default.** Whether the client can act on a
  directive (stop, degrade, a custom handler) delivered in the response
  envelope. A session's own `context.supports_directives` wins; the
  default applies when a `session_start` omits it. Clients that only
  observe default to `false`, and the dashboard hides their Stop
  controls (see Observer-session class). The API applies the same rule
  to pick the runs a directive addressed to an agent reaches (see
  `directives`).
- **Runs custom directives** (`runs_custom_directives`). Whether the
  client runs custom directive handlers (the sensor's `@directive`
  functions). A client can act on stop and budget directives without
  them: the Claude Code plugin (enforcement on) and the Agent SDK
  interceptor answer a custom directive with an error
  `directive_result`. The dashboard offers custom directives only on a
  session that supports directives and whose type runs them (see
  Observer-session class), and the API sends a custom directive
  addressed to an agent only to such runs.
- **`billing_mode` default.** The mode the worker stores for an LLM call
  that arrives without one (see Estimated cost). It follows how the
  client is normally paid for: Claude Code, Codex CLI (ChatGPT login),
  GitHub Copilot and Cursor are seat plans, so `subscription`; the
  sensor, the Agent SDK and OpenCode call a provider with an API key,
  and Gemini CLI's users are API-key and Vertex AI accounts (its free
  tier is served through Antigravity CLI): all `metered`. A client that
  can tell sends `billing_mode` itself and the default never applies.
- **Worker strips tool error text.** A failed tool call's error text is
  content (see Prompt capture), and a hook-based client cannot be relied
  on to withhold it. For these types the worker replaces `error.message`
  with `<redacted>` on a session whose stored capture posture is off,
  whatever the event says. The sensor and the Agent SDK interceptor run
  inside the agent's own process and apply capture before sending.

An unknown `client_type` never reaches storage (ingestion rejects it).
A session row with a NULL `client_type` (a parent stub written before
its own `session_start` arrives) shows no client pill and takes no
registry default. The dashboard's client facet offers only the values
present in the data, so reserved values do not appear until a client
sends them.

**OTLP sources.** The OTLP receiver stamps the registry value of the
tool that produced the telemetry, so its sessions keep that tool's
defaults and `agent_id`: Claude Code (see OTLP ingest > Dialects) lands
as `claude_code`. Codex CLI, Gemini CLI and GitHub Copilot export
OpenTelemetry under their own `service.name` too; their records are
accepted and counted as rejected. `otlp` is for a source no registry
entry names. Pydantic AI, Strands Agents, the OpenAI Agents SDK and
Google ADK, mapped by the GenAI dialect, have no registry entry and land
as `otlp`, with that type's defaults (`production`, observe only,
`metered`, tool error text stripped with capture off);
`context.frameworks` names the framework, which the analytics
`framework` dimension reads. A framework gets no registry value of its
own, because `client_type` is part of the `agent_id` and a value added
later would split every agent already recorded.

**Claude Agent SDK and Claude Code.** The Agent SDK runs the Claude Code
CLI as a subprocess, and the sensor's Agent SDK interceptor reports each
run as a `claude_agent_sdk` session (see Sensor > Claude Agent SDK). So
that a run is reported once, the interceptor sets
`FLIGHTDECK_SDK_OBSERVED=1` in that subprocess's environment, and a
Claude Code plugin the CLI loads does nothing for a run where it is
set: it sends no events and its gates (enforcement and MCP policy) stay
off, because the interceptor's own hook callbacks apply the run's
directives and the MCP policy. A plugin that predates the variable reports the
run a second time, as a `claude_code` session under the plugin's own
session id with the Claude Code id in `context.claude_code_session_id`.
A process that also makes direct provider
calls keeps those under its sensor session (`flightdeck_sensor`); the
two are separate agents because `client_type` is part of the `agent_id`
derivation.

The list has one source, `contracts/client_types.json`, one object per
value with the seven fields above. Each component that checks or shows
the list keeps its own literal copy, because the Go services build from
their own module directory and cannot read a file outside it, and a
parity test pins every copy to the source: the ingestion validator; the
API's `client_type` filter validators and their Swagger text; the
worker's billing default (`workers/internal/billing`) and its tool-error
gate (`workers/internal/processor/event.go`); the cost query's default
(`api/internal/store/pricing.go`); the API's directive targeting (the
types whose `supports_directives` default is true and the types that
run custom directives, `api/internal/store/directives.go`); the
dashboard's `CLIENT_TYPE_META`
(label, pill, facet and directive defaults); and the `CHECK` constraints
`agents_client_type_check` and `sessions_client_type_check`, which an
integration test reads from `pg_constraint`. The test fixtures' pairing
check reads each type's expected `agent_type` from the source file
directly. The parity tests run from the repo checkout and fail, not
skip, when the source file is missing.

Adding a value is a change to the source file and its copies plus a
migration that swaps both constraints, adding the new one `NOT VALID`,
and a second migration that runs `VALIDATE CONSTRAINT`. golang-migrate
sends each file as one query, which Postgres runs as one transaction,
so keeping the validation in its own file is what lets it scan
`sessions` without the swap's exclusive lock held. The validate
migration's down re-adds the constraints `NOT VALID`; the swap
migration's down restores the previous list and fails while any row
still holds a removed value, so delete or relabel those rows first.

`context.entrypoint` says how the client process was launched. It is an
open string, not a vocabulary: the client drops a value longer than 64
bytes or containing control characters rather than truncating it, and
ingestion stores it as sent like any context field. The plugin passes
`CLAUDE_CODE_ENTRYPOINT` through (`cli` for an interactive terminal,
`sdk-cli` for `claude -p`), the Claude Agent SDK interceptor sends
`sdk-py`, and the sensor omits it.

`agent_id` is stable across process restarts: same identity tuple →
same UUID. When `agent_role` is null or empty (after `.strip`), the
derivation collapses to the 5-tuple — root and direct-SDK
sessions on a given host produce the same agent_id whether or not
the platform supports sub-agent emission. When `agent_role` is set,
it joins the input tuple, so a CrewAI Researcher and a CrewAI Writer
running on the same host land under distinct agent_ids despite
sharing the rest of the 5-tuple. The same laptop running the sensor
against multiple repos or branches still converges to ONE root agent
because `agent_name` defaults to `{user}@{hostname}`. Branch / repo
distinctions land in `context.git_branch` / `context.git_repo`, not
in identity.

**Deriving `agent_id` in a new emitter.** Ingestion checks only that
`agent_id` is a canonical UUID; it does not recompute it. Every emitter
must therefore derive it with the same recipe, or one agent splits into
two rows:

```
agent_id = uuid5(ee22ab58-26fc-54ef-91b4-b5c0a97f9b61,
                 "flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}")
```

The namespace is `uuid5(NAMESPACE_DNS, "flightdeck.dev")` and never
changes. Every field goes in verbatim, and the caller substitutes
`unknown` for a missing one rather than leaving it empty. A non-empty
`agent_role` (after trimming what Python's `str.strip()` removes: the
Unicode White_Space characters and U+001C..U+001F) is appended as a sixth
segment, `/{agent_role}`. The sensor's `core/agent_id.py`, the
plugin's `agent_id.mjs` and ingestion's `internal/identity` implement it,
and each asserts the same vector: `coding`, `omria`, `Omri-PC`,
`claude_code`, `omria@Omri-PC` derive
`ee76931b-06fa-5da6-a019-5a8237efd496`, and every vector in
`contracts/identity_vectors.json`. A new emitter's tests assert them too.

**Rollup ↔ projection symmetry.** The same UUID5 input tuple flows
through two paths:

- **Rollup path.** The worker's `UpsertAgent`
  (`workers/internal/writer/postgres.go`) reads the agent identity
  off the event payload (sensor- or plugin-stamped) and INSERTs
  the `agents` row keyed on `agent_id`. The same agent_id appears
  in every later `/v1/fleet` rollup response.
- **Projection path.** The sessions table's `agent_id` column is
  computed identically by the worker on every session_start (and
  preserved on later events via UpsertSession's ON CONFLICT). The
  `/v1/sessions` projection returns this column verbatim.

Both paths consume the SAME 6-tuple input — no skip fields, no
conditional inclusions, no field re-orderings. The dashboard's
`buildFlavors` joins by exact string equality on `agent_id`; a
drift between rollup and projection would orphan every sub-agent
session (the agent appears in the fleet roster but its sessions
array is empty, the swimlane row renders without event circles or
connectors). The contract is pinned by
`tests/integration/test_agent_id_parity.py`.

### Sub-agent sessions

Sub-agent sessions (Claude Code Task subagents, CrewAI agent turns,
LangGraph agent-bearing nodes, the agents of a LlamaIndex agent workflow
run) carry two paired columns on
`sessions`:

- `parent_session_id uuid` — references `sessions(session_id)`, set to
  the outer session's id.
- `agent_role text` — the framework-supplied role label.

Both columns are nullable. Both are populated only on sub-agent
sessions; both are null on root sessions. The reverse (role set,
parent unset) is a sensor bug — the sensor emits both together or
neither.

`GET /v1/sessions` listing rows carry a derived `child_count int`
field — the count of sessions whose `parent_session_id` equals
this row's `session_id`. Always present; zero on lone agents and
on pure children (sub-agents that have no descendants of their
own). Populated server-side via a correlated subquery on the
listing query so the dashboard's parent-row pill (`→ N`)
renders without a per-row follow-up fetch. Hits the
`sessions_parent_session_id_idx` partial index.

`GET /v1/sessions` accepts an `include_pure_children` boolean
filter (UX revision). When omitted or `true` the listing
returns every session matching the other filters (existing
behaviour). When `false` the listing excludes pure children
(rows whose `parent_session_id IS NOT NULL` AND no other
session references this row as parent), returning only
parents-with-children + lone sessions. The Events page
sends `include_pure_children=false` as its default scope so
deep sub-agent trees don't drown root activity in the table; the
"Is sub-agent" facet flips to `is_sub_agent=true` to surface
children-only.

`GET /v1/sessions` also accepts an `include_parents` boolean
flag (default `false`). When `true`, the response is augmented
with the parent session of every child session in the page, even
when the parent falls outside the time-range filter or the
`LIMIT` window. The Fleet swimlane sets this so a sub-agent
whose parent fell off the 100-row page still resolves its
topology via the front-end relationship walk; the Events page
leaves it `false` so its pagination math stays exact.
`total` continues to count only filtered rows; `sessions[]` may
exceed `total` when extra parents land in the response.

The `parent_session_id` FK is enforced. Forward references (a child
`session_start` arriving before its parent is in the DB) are handled
by a parent-stub variant of the worker's lazy-create path: when
a child arrives with a `parent_session_id` that
isn't in `sessions`, the worker INSERTs a stub row with
`flavor="unknown"` / `agent_type="unknown"`, no agent identity (NULL
`agent_id`, `client_type`, `agent_name`) and a synthetic `started_at`
matching the child's. The child INSERT then satisfies the FK. The stub
belongs to no agent until the parent's own events reach the worker.
When the real parent's `session_start` arrives, `UpsertSession` claims
the stub: it fills the identity, upgrades the `"unknown"` sentinels via
the write-once-but-upgrade-from-`"unknown"` branch, and counts the
session toward the parent's agent (see `agents` rollup). A parent whose
`session_start` is never processed is claimed by its first other event,
which fills the identity and counts the session but leaves the
`"unknown"` sentinels to a `session_start`.

### Re-attachment

When the sensor (or plugin) restarts and emits a `session_start` for a
`session_id` that already exists in `sessions`, the ingestion API attaches
the new execution to the prior row instead of creating a duplicate.
The response envelope sets `attached: true`. The session drawer and the
timeline mark each re-attaching `session_start` (see Session attachment
flow).

### `agents` rollup

The `agents` table is keyed on `agent_id` and carries denormalized
`total_sessions`, `total_tokens`, `first_seen_at`, `last_seen_at` columns
maintained by the worker. Drift between the rollup and ground truth is
healed on demand by `POST /v1/admin/reconcile-agents` which recomputes
the columns from the sessions table.

`total_sessions` goes up by one when a session row becomes attributed
to the agent: the worker inserts the row with the agent's identity (a
`session_start`, or a row lazily created by another event), or fills
the NULL identity of a parent stub (the parent's `session_start`, or
its first other event when that start is never processed). Each write
decides attribution on the row it has locked, in the statement that
writes the identity (`INSERT ... ON CONFLICT DO UPDATE ... WHERE
sessions.agent_id IS NULL` for a `session_start`, `UPDATE ... WHERE
agent_id IS NULL` for another event), so a redelivered, retried or
concurrent `session_start`, and a stub racing its parent's start, count
the session once whichever reaches the worker first. A session whose
identity is set never moves to another agent.

---

## Ingestion API

### `POST /v1/events`

Every event payload carries the identity 5-tuple, plus session-level
fields. Sub-agent sessions additionally carry
`parent_session_id` and `agent_role`. The canonical shape:

```json
{
  "session_id": "uuid",
  "agent_id": "uuid",
  "agent_name": "research-bot-1",
  "agent_type": "production",
  "client_type": "flightdeck_sensor",
  "user": "alice",
  "hostname": "worker-node-3",
  "flavor": "research-agent",
  "event_type": "post_call",
  "host": "worker-node-3",
  "framework": "crewai",
  "model": "claude-sonnet-4-6",
  "model_requested": "claude-sonnet-4-6",
  "model_served": "claude-sonnet-4-6",
  "provider": "anthropic",
  "billing_mode": "metered",
  "tokens_input": 1240,
  "tokens_output": 387,
  "tokens_total": 1627,
  "tokens_cache_read": 0,
  "tokens_cache_creation": 0,
  "tokens_cache_creation_1h": 0,
  "tokens_reasoning": 0,
  "cost_reported": null,
  "cost_source": null,
  "tokens_used_session": 42180,
  "token_limit_session": 100000,
  "latency_ms": 1840,
  "tool_name": null,
  "tool_input": null,
  "tool_result": null,
  "has_content": false,
  "content": null,
  "parent_session_id": null,
  "agent_role": null,
  "timestamp": "2026-04-07T10:00:00Z"
}
```

Sub-agent `session_start` events set `parent_session_id` to the
outer session's id and `agent_role` to the framework-supplied role.
Cross-agent message capture: when `capture_prompts=true`,
the child `session_start` payload carries an `incoming_message`
field with the parent's input to the child, and the child
`session_end` payload carries an `outgoing_message` field with the
child's response back. Bodies route through the existing
`event_content` table (no schema change) — small bodies inline,
bodies above 8 KiB use the overflow path with a 2 MiB hard
cap, and a body that leaves the event over the 768 KiB body limit is
cut to fit (see Content Capture). When `capture_prompts=false` both
fields are absent and
`has_content=false`.

Capture posture is server-authoritative. The `session_start` payload
carries a top-level `capture_prompts` boolean; the worker persists it
write-once onto `sessions.capture_prompts` (the first authoritative
`session_start` pins it and no later event can flip an established
session's posture). Every content sink — the `event_content` table and
the inline MCP `content` projection into `events.payload` — is gated on
that stored session value, not on the per-event `has_content` flag.
Content whose session posture is off, or still not known on the last
delivery the retry budget allows (an event carrying content waits for
its session's posture first; see Worker > NATS consumer), is dropped
and `has_content` is forced false on the stored row. This prevents a forged
event on the message bus from persisting prompt content for a
capture-off session. When `capture_prompts=true` for the session, the
`content` field contains a `PromptContent` object the worker stores in
`event_content`, setting `has_content=true` on the event row. The event
row and its `event_content` row are written in one transaction, so no
reader sees an event that claims content before the content exists. If
the content can never be stored (it does not parse, or Postgres rejects
the row as invalid data or a constraint, for example a content blob
without a `response`), the worker stores the event alone with
`has_content=false` and logs a warning, rather than retrying a write
that would fail the same way on every delivery. Ingestion replaces the
text Postgres cannot store before an event reaches the bus (see
Validation rules), so a NUL byte never reaches this fallback; it is
the backstop for a content row nothing upstream caught. A
transient failure (a dropped connection, a timeout) writes nothing and
the event is redelivered whole. An event that sets
`has_content` without a `content` blob is stored with
`has_content=false`.

`session_start` events additionally carry an optional top-level `context`
field with the runtime context dict (orchestration, git, frameworks, etc.).
Other event types omit it. The worker writes it once to `sessions.context`
via `UpsertSession ON CONFLICT` deliberately omitting `context` on
subsequent writes (set-once semantics).

#### Token, model and cost fields

LLM events (`post_call`, `embeddings`) carry these fields; every one is
optional on the wire, so an older client's events stay valid. The
`llm_error` of a stream that fails also carries `billing_mode`. What each
feeds is described under Cost estimation.

| Field | Stored in | Meaning |
|---|---|---|
| `model` | `events.model` | Legacy model field; the worker overwrites it with the canonical id |
| `model_requested` | `events.model_requested` | The model id the caller asked for, verbatim |
| `model_served` | `events.model_served` | The model id the response named, verbatim |
| `provider` | `events.provider` | The model's vendor |
| `billing_mode` | `events.billing_mode` | `metered`, `subscription` or `local` |
| `provider_metadata.platform` | `events.platform` (and `payload`) | The endpoint that served the call |
| `tokens_reasoning` | `events.tokens_reasoning` | Reasoning or thinking tokens, a subset of `tokens_output` |
| `tokens_cache_creation_1h` | `payload` | One-hour cache writes, a subset of `tokens_cache_creation` |
| `cost_reported` | `events.cost_reported` | USD cost the gateway or client reported for this call |
| `cost_source` | `events.cost_source` | `provider` (returned by the API or gateway) or `agent` (computed by the client); set exactly when `cost_reported` is |
| `service_tier` | `payload` | The tier that served the call as the response reports it (`standard`, `batch`, `flex`, `priority`, ...) |
| `speed` | `payload` | Anthropic's inference speed (`standard`, `fast`) |
| `inference_geo` | `payload` | Data-residency setting the response reports (Anthropic `us`, ...) |
| `inference_scope` | `payload` | `global` or `regional` cloud endpoint; sent by the sensor and the plugin for Vertex AI, derived by the worker from a Bedrock inference-profile prefix |
| `server_tool_use` | `payload` | Server-side tool request counters (`web_search_requests`, `web_fetch_requests`, `code_execution_requests`) |
| `stop_reason` | `payload` | Why generation stopped (`end_turn`, `max_tokens`, `tool_use`, `stop`, `length`, ...), verbatim from the provider |
| `effort` | `payload` | The reasoning effort a coding agent ran the call at, as it names it (Claude Code: `low`, `medium`, `high`, `xhigh`, `max`) |

`provider_metadata.request_id` (see `post_call`) completes the set. The worker copies each payload field
above into `events.payload` under the same key.

### Validation rules

The ingestion handler rejects events with 400 when:

- A key differs from a field name only in case (see below).
- `agent_id` is missing or not a UUID.
- `agent_type` is outside `{coding, production}`.
- `client_type` is outside the client type registry (see Identity model).
- `session_id` does not match the UUID regex.
- `occurred_at` is more than 48h in the past (`maxClockSkewPast`) OR
  more than 5m in the future (`maxClockSkewFuture`). The 48h past
  bound accommodates retry-after-long-outage windows.
- `tokens_input`, `tokens_output` or `tokens_total` is negative (cache
  counts are not range-checked).
- `tokens_reasoning`, `tokens_cache_creation_1h` or `cost_reported` is
  negative or not a finite number.
- `billing_mode` is outside `{metered, subscription, local}`, `provider`
  is outside `{anthropic, openai, google, xai, mistral, meta, deepseek,
  other}`, or `cost_source` is outside `{provider, agent}`.
- `cost_reported` and `cost_source` are not both set or both absent.
- `tokens_reasoning` exceeds `tokens_output`, or
  `tokens_cache_creation_1h` exceeds `tokens_cache_creation`, when both
  fields of the pair are present.
- `model_requested`, `model_served`, `service_tier`, `speed`,
  `inference_geo`, `stop_reason` or `effort` is longer than 256
  characters, or
  `inference_scope` is outside `{global, regional}`, or
  `provider_metadata.platform` is longer than 253 characters.
- `streaming` is not an object, its `final_outcome` or `abort_reason` is
  not a string, its `chunk_count` is not an integer from 0 to 2^53, or
  its `ttft_ms` or an `inter_chunk_ms` value (`p50`, `p95`, `max`, in an
  object) is not a non-negative number.
- On `llm_error`, `error` is not an object, its `error_type` or
  `abort_reason` is not a string, or its `partial_chunks`,
  `partial_tokens_input` or `partial_tokens_output` is not an integer
  from 0 to 2^53.

A JSON null counts as absent for each of these. A stream outcome, abort
reason or error type outside its vocabulary is not rejected:
`streaming.final_outcome` (`completed`, `aborted`), `streaming.abort_reason`
and an `llm_error`'s `error.abort_reason` (`client_aborted`,
`error_before_stream`, `error_mid_stream`, `timeout`) and `error.error_type`
(the 14-entry taxonomy, see `llm_error`) are diagnostics a client newer
than the server can extend, and refusing the event would also drop the
tokens it carries. Ingestion stores such a value as `other`, the
catch-all of each vocabulary (the taxonomy's own fallback for an error it
cannot name). It rewrites only an event it changed, and in it only the
replaced fields: every other value is kept, number literals included, so
a number in captured content that a float64 cannot hold (a 19-digit id, a
20-digit decimal) is stored as sent. Spelling that does not change a
value can change: Go's encoder writes `<`, `>` and `&` in every string as
`\u003c`, `\u003e` and `\u0026`, and U+2028 and U+2029 as `\u2028` and
`\u2029`; insignificant whitespace is dropped; and the keys of the top
level and of an edited object are written in sorted order. The
`session_start` that receives the token's id and name, posted or built by
the OTLP receiver, is rewritten the same way. Every value the
sensor's classifier, the Claude Code plugin's StopFailure mapping and the
OTLP receiver's API-error mapping send is in the taxonomy, which tests
read from each of them. An MCP event's and a tool failure's `error` carry
taxonomies of their own and are stored as sent.
It counts the replacements in the process and logs them at most once a
second, with the field, the running count and the value when it is a
lowercase identifier of at most 64 characters (any other value is logged
by its length, so a client cannot write arbitrary text into the log).
Replacements within the second after a line are held and logged by one
line at the end of that second, which names the latest and counts the
others, so a burst is reported even when nothing follows it. A
negative count is refused, as a negative `tokens_*` is: it comes from a
broken client, not a newer one.

Text Postgres cannot store is replaced, not refused. U+0000 (the JSON
escape `\u0000`) and a UTF-16 surrogate escape not paired with its
other half are valid JSON that Postgres refuses. In the event itself
(a name, a sub-agent message, an error, anything the worker writes to
the event row) one fails the event on every redelivery; in its content
it makes the worker store the event without its content (see `POST
/v1/events`), so the content is lost. Ingestion replaces each with
U+FFFD (`\ufffd`) in the body of every event before validating it,
whether posted or built by the OTLP receiver, and in every string it
stages for the GenAI dialect (metadata and content alike), rather than
answering 400: the character is almost always inside captured content (a
tool's binary output), and refusing would also drop the event's tokens.
The escape is rewritten in place, so the body keeps its length and every
other value its spelling. A staging write the database refuses is logged
by its SQLSTATE and the table it names, never by the database's message,
detail or context, which quote the refused value.

Field names match exactly, and a case variant of a known field name is
refused. Every check above reads a field under its exact name, while the
worker decodes an event into typed structures whose field matching
ignores case: Go's JSON decoder folds Unicode case, so `TOKENS_INPUT`,
`Tokens_Input` and `tokenſ_input` (long s) would all reach it as
`tokens_input`. Ingestion therefore answers 400 to a key that is not a
field name but folds to one, at the top level (the fields of the
worker's event structure), in `incoming_message` and `outgoing_message`,
in `streaming` and its `inter_chunk_ms`, and in an `llm_error`'s
`error`. A key that folds to no field name is published as sent. Tests
read the field names from the worker's event structure and from the
sensor's stream and error builders.

A `session_end` for a `session_id` Flightdeck has never seen (an orphan
`session_end`) is **not** rejected at ingestion — the event is accepted and
published, and the worker decides what to do with it.

A `session_end` can reach the worker before its session's `session_start`
(a client published them out of order, or the start is a redelivery; see
NATS consumer). A `session_end` whose `sessions` row is missing is therefore not
dropped on sight: the worker asks NATS to redeliver it after one second,
and once more after two, holding no goroutine in the meantime. A row that
has appeared by then is closed, provided its current run began before the
end was published; an end published before the run began is stored as an
event and closes nothing, so an emitter that sends its end before its
start leaves the session `active` until it ages to `stale` and `lost` and
the orphan-timeout reaper closes it.

Only if the row is still missing on the third and last delivery is the
event an orphan: the worker logs a warning, increments
`dropped_events_total{reason="orphan_session_end"}`, and ACKs the message
without inserting an event row (there is nothing to recover, and a closed
row created for it would describe a session the server never saw). A
`session_start` that lands after that leaves its session `active` until
the reaper closes it. A database error during the lookup is not read as
"missing": the worker NAKs the message and NATS redelivers it.

The worker counts the drop as `dropped_events_total{reason}` in its
in-process metrics registry, served at `/metrics` on the workers' metrics
listener, and logs it.

### Response envelope

```json
{ "status": "ok", "directive": null, "attached": false }
```

```json
{
  "status": "ok",
  "directive": {
    "action": "shutdown",
    "reason": "kill_switch_activated",
    "grace_period_ms": 5000
  },
  "attached": false
}
```

Directives are delivered in the HTTP response envelope of the sensor's next
`POST /v1/events` call. Delivery latency equals the time between LLM calls.
Idle agents do not receive directives until they make their next LLM call.

The `attached` boolean is `true` exclusively on `session_start` responses
whose `session_id` matches a pre-existing `sessions` row in any state.

`action="custom"` directives carry an additional `payload` field
(`*json.RawMessage`, `omitempty`) with `{directive_name, fingerprint,
parameters}` so the sensor's `DirectivePayloadSchema` can validate it and
dispatch to the registered handler. `omitempty` keeps the JSON envelope
clean for non-custom directives.

### Session attachment flow

Orchestrators (Temporal, Airflow, cron-driven batch) spawn a fresh sensor
process every time the same logical workflow runs. Without a stable
identifier, each run shows up as a brand new session in the fleet view.
The session-attachment flow gives the caller an optional hint that the
control plane honours end-to-end:

1. **Sensor — `init` accepts `session_id`.** The caller passes a stable
   ID via the kwarg OR exports `FLIGHTDECK_SESSION_ID`. The env var wins
   over the kwarg, same precedence as `FLIGHTDECK_SERVER` / `AGENT_FLAVOR`.
2. **Ingestion — synchronous attachment check on `session_start`.** On
   arrival of a `session_start` event the ingestion API calls
   `session.Store.Attach(session_id)` against Postgres BEFORE publishing
   the NATS envelope. If the row exists in `{closed, lost}` the store
   flips state to `active` and clears `ended_at` and `closed_seq`; in
   every other state the row is left as it is. Each arrival inserts one
   `session_attachments` row, which is how the API returns the full
   re-attachment history. `started_at` is never touched. Once the
   envelope is published, the store records its stream sequence in
   `start_seq` when the row pre-existed, and revives the row if the
   previous run's queued `session_end` closed it between the check and
   the stamp. The stamp is best effort: it skips a row another writer
   holds instead of queueing on its lock, so many clients re-attaching one
   session id cannot stall ingestion behind that row. It retries after
   pauses of 5, 10, 20 and 40 ms (75 ms in all, holding no database
   connection), long enough for the worker's own chain of updates to the
   row at a few milliseconds of commit latency each, then logs and gives
   up; the worker's rules still apply if the stamp is missed. If the row
   does not exist the store is a no-op and the worker creates it
   downstream.
3. **Response envelope — `attached: true` when the row pre-existed.**
4. **Sensor — INFO log on the first attached response.** Per-process
   guard so subsequent envelopes do not duplicate the log.
5. **Dashboard — an attachment badge per recorded attachment.**
   `GET /v1/sessions/:id` returns an `attachments: []time` array, each
   entry the time ingestion recorded the attach. The run drawer shows
   each re-attaching `session_start` with an ATTACH badge in place of
   its event-type pill (tooltip "Agent re-attached with the same
   session ID"), and the timeline draws that start's node in the
   warning colour (tooltip "Run attached"). Both read the same rule
   (`attachmentStartIds` in `dashboard/src/lib/events.ts`). The
   `session_start` nearest an entry, within two seconds of it, is that
   entry's start (a client's own start, which the attach stamps a
   moment later). An entry with no start that close belongs to a start
   dated by its record rather than by its arrival, as an OpenTelemetry
   re-attaching start is (see OTLP ingest), and marks the latest start
   not yet matched that is dated at or before it. That rule never takes
   the run's original `session_start`, which has no entry: every
   re-attach adds one start after it, and a run's loaded events reach
   back from its newest without a gap (see Bulk historical events
   hook), so the earliest loaded start is the original when more starts
   are loaded than the run has entries, or when the run's whole history
   is loaded (`fullHistoryLoaded` in `useSessionEvents.ts`: a fetch
   without `events_limit`, a capped fetch that came back short of its
   cap, or "Show older" reaching the first event). A window can open on
   a resume's start, so otherwise the earliest loaded start may be a
   re-attach and may be taken. `started_at` cannot tell it: for a client's run it is
   the worker's clock, which can lag the client's start by seconds. The
   Fleet swimlane draws a run that ended and was resumed as segments
   with a gap between them (see SwimLane).

The race between step 2 (synchronous) and the worker's
`HandleSessionStart` (asynchronous, via NATS) is bounded: the ingestion
API locks the answer in the HTTP response the instant the attach commits.
By the time the worker consumes the event, the row is normally already
`active`, and the worker's `UpsertSession ON CONFLICT` branch only
refreshes it. Two orderings differ, and publication order tells them
apart: every `session_start` records its NATS stream sequence in
`sessions.start_seq` (a re-attaching one already at ingestion, see step
2), and the `session_end` that closes a row records its own in
`sessions.closed_seq`.

- A re-attaching `session_start` can be ingested while the previous run's
  `session_end` is still queued. The attach check then finds the row
  `active` and leaves its state alone; the stamp that follows the publish
  records the start's sequence and, since the queued end has usually
  closed the row by then, revives it (clearing `ended_at` and
  `closed_seq`). From there the old end reads as older than the current
  run, and a call of the new run that reaches the worker before the
  start keeps its tokens. Should the stamp be missed (for example, the
  row was held through every attempt), the queued end closes the row,
  calls the worker handles before the start's own revive are stored
  without rolling their tokens up, and the `session_start`, published
  after that end, revives the row.
- A `session_start` can be processed after its own `session_end`, when it
  reaches the worker out of order (see NATS consumer). It was published
  before the end that closed the row, so the row stays closed.

In the other direction, a `session_end` published before the row's
current run began (`start_seq`) is recorded as an event but closes
nothing, and a `session_end` that finds the row already closed advances
`closed_seq` when it was published after the end that closed it, so a
`session_start` queued between a run's end and the next run's end cannot
revive a session whose later run has also ended. A row without a
sequence (written by an earlier release, created lazily by an event other
than `session_start`, a parent stub, closed by the reaper, or seeded)
follows the plain state rules: a `session_start` revives a closed row and
a `session_end` closes an open one.

### Heartbeat and health

`POST /v1/heartbeat` advances `last_seen_at` without an event payload
and returns the session's pending directive, as an event POST does. The
Claude Code plugin's enforcement gate calls it to fetch a stop for a
quiet session; the sensor does not (its post_call events give the same
signal at the cadence it produces them).

`GET /health` returns `{"status":"ok","service":"ingestion"}`.
`GET /docs/index.html` serves the Swagger UI. Request latency is served
at `/metrics` on a separate listener, not on the API port (see
Operational Concerns > Metrics > Request latency).

### OTLP ingest

Agents that export OpenTelemetry send it to the ingestion API, which
turns what it understands into Flightdeck events. This reaches runs no
hook or SDK patch sees: `claude --bare`, Claude Code in CI and cloud
sessions, any Claude Code whose telemetry is pointed at Flightdeck, and
agents built on the frameworks that export OpenTelemetry GenAI spans
(Pydantic AI, Strands Agents, the OpenAI Agents SDK and Google ADK; see
GenAI dialect, below).
The sessions it creates observe only (`context.supports_directives=false`,
`context.telemetry=otlp`): the dashboard shows them, names their source
(see Dashboard > Session source) and offers no Stop.
They carry the `client_type` of the tool that produced the telemetry
(see Client type registry > OTLP sources), so a Claude Code session
reported over OTLP is a `claude_code` session with that type's defaults;
a GenAI framework has no registry entry, and its sessions are `otlp`.

**Routes.** `POST /v1/logs`, `POST /v1/traces` and `POST /v1/metrics`,
the OTLP/HTTP paths, so an exporter pointed at `https://<host>/ingest`
reaches them through the edge proxy. Each accepts the OTLP protobuf
encoding (`application/x-protobuf`) and the OTLP JSON encoding
(`application/json`), either optionally gzip-compressed
(`Content-Encoding: gzip`; `identity`, or no header, for an
uncompressed body). Authentication is the bearer token every
ingestion route takes; an exporter sends it with
`OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ftd_..."`.

**Limits and responses.** A request body over 4 MiB, or one that
decompresses past 16 MiB, is refused with 413 before it is parsed (the
edge proxy must allow 4 MiB on `/ingest/`). A gzip body is inflated
into a buffer sized from its size trailer: a trailer declaring more than
16 MiB is a 413 before anything is inflated, and a stream that inflates
to anything but what its trailer declares is not valid gzip (400).
Decoding can take far more memory than the body (a two-byte protobuf
message decodes to a few hundred bytes), so before decoding, a single
allocation-free pass over the body estimates what decoding will
allocate: the body plus a fixed cost per message and per scalar
element, the costs measured over the OTLP message types and rounded
up. A request whose estimate passes 48 MiB is refused with 413; real
exports estimate well under that (a full 512-record batch of Claude
Code log records at about 20 MiB). A request nested more than 128
objects, arrays or messages deep is 400. Inflating, decoding and mapping
run under a global limit of concurrent decodes, sized so that the
worst admitted requests together stay within 256 MiB (half the Helm
chart's default 512 MiB ingestion memory limit, which gives 3 at once;
decoding is CPU-bound and a pod runs on at most one CPU, so more would
not add throughput). The budget covers inflating, decoding and mapping
only: the body as sent (up to 4 MiB) is read before a slot is taken, so
requests being read or waiting for a slot are outside it, bounded like
`POST /v1/events` bodies by the server's read timeout and the number of
connections (taking the slot first would let slow uploads hold every
slot). A slot is given back however its request ends, a panic
included. A request that finds none free within 2 seconds is
answered 503 with `Retry-After: 1`, which OTLP exporters honour. A body
that does not decode is 400; any other media type is 415. A body that
decodes is answered 200
with the OTLP export response, in the request's encoding, even when some
of its records are not used: `partial_success` counts the records
Flightdeck did not map (`rejected_log_records`, `rejected_spans` or
`rejected_data_points`) with a message naming why, and one record
Flightdeck cannot use never fails the request. The message names at most
five sources, each cut to 128 bytes, and counts the rest. For log records
it names reasons, the most frequent first, each with its count
(`3 log records not used: "claude_code.assistant_response" is not mapped
(2); "claude_code.tool_decision" other than a reject is not mapped (1)`),
out of at most 64 distinct reasons a request tracks; the rest are counted
as `N for other reasons`. Mapped events
pass the same validation as `POST /v1/events` (one function serves both);
a record whose event fails it is counted as rejected, the validation
message in its reason. A failed publish to NATS is 503, which OTLP
exporters retry; the deterministic event ids make the retry safe. So is a
failed session read (below): the request publishes nothing, is charged
nothing, and is answered 503.
A request whose records are all used carries no `partial_success`.
A request carrying GenAI records is answered 200 only once they are
staged, and 503 with `Retry-After: 1` when staging fails (see GenAI
dialect > Staging); a GenAI record counts as used once it is staged.

Mapping a log request can read the session table (Sessions, below),
which the decode slot does not bound, so the reads are bounded on their
own: at most 64 sessions a replica has not cached are read per request
(Claude Code exports one session and its sub-agents per process, so
only a request with invented session ids, or a collector merging many
processes' first exports, comes near it), and the records of sessions
past them are counted as rejected (`its session is past the 64 new
sessions one request may name`). Exporters do not resend records
counted in `partial_success`, so those records are dropped; the
session's later records are read once a request has room. One more
read, for all of them together, finds which of the sub-agents a request
names are closed and when each ended (Sub-agent resumes, below). All of a
request's reads share a 2-second deadline, the same wait the receiver
allows for a decode slot; a request past it, or one whose read fails,
is answered 503 with `Retry-After`. No read
happens for a request whose records cannot fit the token's budget
(Rate limit).

A request is checked in this order: bearer token (401), the token's
minute budget (429), media type and `Content-Encoding` (415 for anything
but `gzip`, `identity` or none), the size as sent (413), then, holding a decode slot
(503), the inflated size and the decode estimate (413) and decoding
(400), the budget check before any session read (413 or 429, below), a
failed or late session read (503), then the charge for its events (413
or 429, below), then, for GenAI records, the staging write (503; see
GenAI dialect > Staging). The media
type may carry parameters (`application/json; charset=utf-8`). An
error response's body is a `google.rpc.Status` (`code` the gRPC status
code, `message` the reason) in the request's encoding, and in JSON when
the media type is not supported. OTLP JSON is decoded as protojson after
a streaming pass rewrites its hex trace and span ids as base64 in place;
an id must be empty, 8 bytes or 16 bytes (16 or 32 hex characters), and
unknown fields are ignored. Every export, answered or refused, is logged
with its signal, status and counts or reason, since an exporter seldom
reports what the receiver answered: at info level, except a missing or
invalid token (401), which is logged at debug so a flood of
unauthenticated requests cannot flood the log.

**Rate limit.** A request is refused with 429 (`Retry-After`) before it
is read when the token's per-minute budget is spent. Once its records
are mapped, and before anything is published or staged, it is charged
one unit per event it will publish, synthetic `session_start` events
included, and one unit per GenAI record it will stage plus one more per
agent span among them (an agent span becomes a `session_start` and a
`session_end`): records counted as rejected while mapping cost nothing.
GenAI records refused by the per-trace cap (GenAI dialect > Staging)
are found only inside the staging write, after the charge, so they are
charged although counted as rejected. A GenAI
trace's events are published later, by the assembler, outside any
request, and are never charged again. A request whose events do not
fit in what is left of the budget is refused with 429 and a
`Retry-After` of when enough of the window will have aged out for them
to fit; one whose events exceed the whole per-minute budget can never
fit and is refused with 413. The same two refusals are first checked,
charging nothing, before the dialect reads any session, against the
most events the request's records can map to (one per record and two
per GenAI agent span, every session another client reports included):
a request that cannot fit
costs no database work. A refused request is charged nothing and
publishes nothing. The charge is taken before publishing and a request
whose publish then fails (503) is not refunded, so an exporter that
retries it is charged again for the same events. The budget is the one
`POST /v1/events` draws on, one per token.

**Dialects.** A resource is mapped by the dialect its instrumentation
scope names. Claude Code (`service.name=claude-code`, or a scope under
`com.anthropic.claude_code`) is mapped from its log records; its spans
and metrics are counted as rejected. Claude Code is matched first,
because its own `claude_code.tool` spans carry the GenAI operation name
`execute_tool` and would otherwise be mapped a second time. A resource
carrying one of the GenAI scopes `pydantic-ai`,
`strands.telemetry.tracer`, `opentelemetry.instrumentation.openai_agents`
or `gcp.vertex.agent` is mapped by the GenAI dialect (below) from its
spans and, for Google ADK, its `gen_ai.client.inference.operation.details`
log records; ADK's other log records are counted as rejected. Every
scope in such a resource is read, because a framework's spans nest
those of the provider SDK it calls (the Anthropic SDK's
`com.anthropic.sdk.python` spans under Pydantic AI's). `service.name`
never selects the GenAI dialect: two of the frameworks send
`unknown_service:python` and Google ADK sends an empty resource. Nor
does a `gen_ai.*` operation name on its own: a framework is mapped only
once a recording of its telemetry has fixed what its spans mean. Metric
data points of every source are counted as rejected (`metrics repeat
span usage`; a Claude Code resource's spans and metrics keep the Claude
Code dialect's `source "claude-code" is not mapped`), and so is every
record of any other resource, with a message naming its scope (`scope
"<name>" is not mapped`).

The rest of this section up to GenAI dialect describes the Claude Code
dialect. Attribute values are read whatever their OTLP type: Claude Code sends
numbers and booleans as strings (`"409"`, `"true"`), and the literal
`<REDACTED>` it sends for a prompt or response it was told not to log
counts as no content, as does the `[REDACTED]` other exporters send.

| Claude Code log record | Event |
|---|---|
| `claude_code.user_prompt` | `pre_call` |
| `claude_code.api_request` | `post_call`: `model`, `model_requested` and `model_served`, `provider=anthropic`, `tokens_input` (`input_tokens` + `cache_read_tokens` + `cache_creation_tokens`), `tokens_output`, `tokens_cache_read`, `tokens_cache_creation`, `tokens_cache_creation_1h` (`cache_creation_1h_tokens`), `latency_ms` (`duration_ms`), a `streaming` block holding only `ttft_ms` and `final_outcome=completed` (Claude Code reports neither chunk counts nor gaps, and the dashboard renders a block without them), `cost_usd` as `cost_reported` with `cost_source=agent`, `provider_metadata.request_id` and `provider_metadata.query_source` |
| `claude_code.api_error` | `llm_error`: `model`, `error.http_status` (`status_code`), `error.request_id`, `retry_attempt` (`attempt`), `provider=anthropic`, classified from the status code and message as the sensor classifies Anthropic's errors (400 `invalid_request`, or `context_overflow` / `quota_exceeded` when the text says so; 401 `authentication`, 402 `quota_exceeded`, 403 `permission`, 404 `not_found`, 408 and 504 `timeout`, 413 `request_too_large`, 429 `rate_limit` or `quota_exceeded`, 529 `overloaded`, other 5xx `api_error`); `error.error_message` is `Claude Code API error (HTTP <status>)`, with the record's text cut to 200 characters appended only when capture is on; `terminal` is not set, since Claude Code reports each failed attempt |
| `claude_code.tool_result` | `tool_call` with `tool_name`, `tool_use_id`, `duration_ms` (also as `latency_ms`, as the plugin sends it) and, when `success=false`, the error block `{error_type: other, error_class: ClaudeCodeToolError, message}`. With capture on, the message is the record's `error` text, line breaks kept, cut to its first 1000 characters with `…` appended when longer (enough for a multi-line shell error; `tool failed (Claude Code reported no error detail)` when the record carries none); while capture is off it is `<redacted>`. A record with `tool_name=mcp_tool` is an `mcp_tool_call` whose `server_name` and `tool_name` are its `tool_parameters.mcp_server_name` and `mcp_tool_name` (present only when the exporter sets Claude Code's `OTEL_LOG_TOOL_DETAILS=1`; without them it stays a `tool_call` named `mcp_tool`). Nothing else of `tool_parameters` is read: for other tools it holds their input |
| `claude_code.tool_decision` with `decision=reject` | `session_signal` `permission_denied`, as the plugin reports a denied tool; its `signal_data` is `tool_name`, `tool_use_id`, `reason` (the record's `source`, such as `config`) and, for an MCP tool, `mcp_server` (with `tool_name` the MCP tool's name), and never the tool's input |
| `claude_code.subagent_completed` | the sub-agent's `session_end` (`close_reason=normal_exit`), one per run of the sub-agent (Sub-agent resumes, below) |
| any other record | counted as rejected; `claude_code.assistant_response` among them, since it can only be joined to its `post_call` by state kept across requests |

An event's id is `uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://otlp/claude-code/event/<session.id>/<event.name>/<event.sequence>/<time_unix_nano>")`,
so an exporter retrying a request stores nothing twice.

**Sessions.** The Flightdeck session id is `uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://otlp/claude-code/session/<session.id>")`, never the Claude
Code `session.id` itself: the Agent SDK interceptor reports a run under
its Claude Code session id, and the two must not collide. A sub-agent's
records share the parent's `session.id` and carry its `agent_id`: they
belong to a child session, `uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://otlp/claude-code/session/<session.id>/<agent_id>")`, with
`parent_session_id` the parent's id and `agent_role` the record's
`agent.name`, else the `<type>` of a `query_source` of the form
`agent:builtin:<type>`, else none. A sub-agent's tool records carry
neither, so they take the role another record of the same sub-agent in
the request names, else the one stored on the child's row (read with the
session, below) or, when the replica has the session cached, the one it
cached; its
`agent_name` is `{user}@{host}/{role}` and its agent id adds the role to
the parent's identity, as the plugin derives a sub-agent's. The Agent tool's own `tool_result` stays a `tool_call` on
the parent.

On the first mapped record of a session a replica has not cached,
ingestion reads the session row. When the row is missing, or is a root
session's and `closed`, it publishes a synthetic `session_start` (id
`uuid5(NAMESPACE_FLIGHTDECK,
"flightdeck://otlp/claude-code/start/<Flightdeck session id>/<event id
of the record>")`) through the same attachment check and token stamping as
`POST /v1/events`, so a closed session that resumes is re-attached;
otherwise it publishes none. A closed sub-agent is started again only
by a record dated after its end (Sub-agent resumes, below). The cache is
per replica and only saves the read: an entry expires 10 minutes after
it is cached, well inside the reaper's timeout, so a root the reaper
closes is read again, and re-attached, by its next record; a sub-agent,
whose end any replica may publish, has its row read for that end on
every request (below). What a request learned is cached only once all its events are
published, so a request refused or failed on publish starts its sessions
again when the exporter retries it. The cache holds at most 50,000
sessions per replica; when full it drops expired entries, at most once a
second, and a session it still cannot hold is read on every export. A sub-agent's records
resolve the run's root first: a root whose row is missing or closed is
started before the child, so the child's parent row carries the
session's context and capture posture rather than being a stub. A read
that fails fails the request (503). The synthetic `session_start` is
dated one microsecond before the record it precedes, so it sorts first at
the database's microsecond precision, and sets `sensor_version` to the
resource's `service.version`, `capture_prompts` to the session's
posture (below), and `context` to `claude_code_session_id`
(`session.id`), `claude_code_version`, `os`, `arch`, `terminal_type`,
`telemetry=otlp` and `supports_directives=false`.

A Claude Code session another Flightdeck client already reports is not
reported again: when a `claude_code` or `claude_agent_sdk` session row
carries the `session.id` (the plugin's `context.claude_code_session_id`,
or an Agent SDK run's `session_id`) and is not an OTLP session, the
session's OTLP records are counted as rejected. The check is part of the
same first read, a containment query (`context @> {"claude_code_session_id": …}`)
that the GIN index on `sessions.context` serves, and is not repeated once
a session is stored: a session the plugin starts reporting after its
first OTLP records were stored is reported by both.

**Sub-agent resumes.** Claude Code can run a sub-agent again, under the
same `agent_id`, after its `subagent_completed`: a `SendMessage` to a
sub-agent that has completed resumes it, and each run ends with a
`subagent_completed` of its own. (A sub-agent that stops while a
background task of its own still runs has not completed: Claude Code
sends no `subagent_completed` until the run that task wakes has ended.)
A record of a closed sub-agent dated more than one second after the
sub-agent's end is a resume: it is preceded by a synthetic
`session_start` that re-attaches the row, as a closed root's is, so the
worker adds the resumed run's tokens to `tokens_used` and the start is
recorded as an attachment (see Session attachment flow). A record dated
at or before that is late, the tail of a finished run delivered out of
order: it is
published without a start, and the worker stores its event but skips
its session side effects, as for any event on a closed session (see
Session state machine): its tokens are not added and the child stays
closed, so a late record never reopens a finished sub-agent.

The end is the date of the sub-agent's latest stored `session_end`, when
no `session_start` is stored after it: the `subagent_completed` that
closed it, dated by the same Claude Code clock as the records compared
with it, or the end the reaper stored when it closed the sub-agent. The
row's `ended_at` stands in only when there is no such end: the worker
sets it by its own clock when it processes the end, up to Claude Code's
export interval (5 seconds by default) after the end, and a resumed
run's first record can come sooner than that. A late record is dated at
or before the end, since Claude Code dates a run's records before its
`subagent_completed`; a resumed run's first record follows a model
response the sub-agent gives after the resume, seconds after the end.
The second of tolerance between the two covers the database's
microsecond rounding of the end and corrections made to the client's
clock while the session runs. A record is dated by its `time_unix_nano`,
else its `observed_time_unix_nano`, else the time the receiver maps it;
one the receiver dated cannot be compared with an end on Claude Code's
clock, so it never starts a closed sub-agent and is published as late.

The worker closes a row a few database round trips before it stores the
event of the end that closed it. A row read in that moment has its
current run's `session_start` stored after its latest stored end (the
previous run's, or none), so its `ended_at` stands in: a late record,
dated before it, still reads as late, but a resumed run's record dated
within a second of it reads as late too and starts nothing; the run's
next record, read once the end event is stored, re-attaches the row.

Each record is judged by its own date against the latest end the
request knows: the row's, or a `subagent_completed` earlier in the same
request. A request holding a run's end and the resumed run's records
therefore publishes the end, then the start, then the resumed run's
records, and the worker closes and reopens the row in that order (as
for any start, the attachment is recorded only when the row exists
by the time the start is published, which a sub-agent whose first run
and resume share one export may miss). Only the first record past the
end gets a start; a late record after it lands on the reopened row and
is counted with it. Every request reads the
rows of the sub-agents it names for their ends, in one read for all of
them, since another replica may have published an end; the replica
cache saves the rest of a sub-agent's read. A resumed run's records
mapped before the worker has processed the end they follow find the row
open and get no start: the worker stores them on the row that end then
closes, and their tokens are never added. The run's next record mapped
after the worker has processed the end re-attaches the row; a resumed
run that also ends before then is never re-attached.

**Identity and billing.** `agent_type` is `coding`; the flavor is
`claude-code` unless the resource sets `flightdeck.flavor`; the user is
the record's `user.email`, else `user.account_id`, else `unknown` (an
email address, unlike the plugin's OS user, so it is personal data in
`agents.user_name`); the host is the resource's `host.name`, else
`unknown` (Claude Code sends none; operators set one with
`OTEL_RESOURCE_ATTRIBUTES`); `agent_name` is `{user}@{host}`; the agent id
is derived from them as for every client, by a Go port of the derivation.
`contracts/identity_vectors.json`, generated from the sensor by
`contracts/generate_identity_vectors.py`, holds vectors the sensor, the
plugin and the Go port each assert, the role trim included: a role is
trimmed of exactly what Python's `str.strip()` removes, which each
implementation names explicitly rather than relying on its language's
own trim; `framework` is `claude-code`, as the plugin
sends it. Each `post_call` carries
`billing_mode`: the resource's `flightdeck.billing_mode` when set
(`metered`, `subscription`, `local`), else `subscription`, Claude Code's
own default; any other value fails validation, so the session's
`post_call` records are counted as rejected with the reason named. Its
`cost_reported` therefore counts toward
`estimated_cost` only on a session the operator declares metered.

**Capture.** OTLP content is off unless the exporter declares it: a
session captures prompts when its resource carries
`flightdeck.capture_prompts=true`. With capture off, ingestion sends no
prompt text, response text, `tool_input`, MCP arguments or results, or
error text: only names, ids, counts, durations and success. With capture
on, the prompt goes on the `pre_call` as a `PromptContent`
(`provider=anthropic`, the prompt as one user message, the shape the
plugin's `pre_call` uses; Claude Code names no model on a prompt, so
the `pre_call` has none), `tool_input` goes on the `tool_call` or
`mcp_tool_call` as the record carries it (the JSON document it encodes,
else the string), in the `event_content.tool_input` column through the
tool-capture envelope the sensor and plugin use (`provider` `anthropic`,
or `mcp` with `model` the server name), and error text on its error
block; content is cut to
fit the 768 KiB event body limit as the plugin cuts it. Claude Code sends
the prompt only when `OTEL_LOG_USER_PROMPTS=1`, and tool inputs and a
failed tool's error text only when `OTEL_LOG_TOOL_DETAILS=1`. A
repository's project settings can set `OTEL_RESOURCE_ATTRIBUTES` (and
with it `flightdeck.capture_prompts`) and `OTEL_SERVICE_NAME` through
their `env`, which Claude Code applies over the shell, but not the
`OTEL_LOG_*` switches, which Claude Code ignores there; only managed
settings, or `--settings`, outrank a repository's settings.

**Lifecycle.** A Claude Code session reported over OTLP has no end event
of its own (a sub-agent's run ends with `subagent_completed`). It goes
`stale` after 2 minutes without a record and `lost` after 30, and the
orphan-timeout reaper closes it after `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`
(24 hours by default, `close_reason=orphan_timeout`); a record that
arrives after that re-attaches it through the synthetic `session_start`.

#### GenAI dialect

Agent frameworks that follow the OpenTelemetry GenAI semantic
conventions report a run as one trace of spans: an `invoke_agent` span
per agent run, a `chat` or `generate_content` span per model call and
an `execute_tool` span per tool call, related only by parent span id.
The GenAI dialect maps the four frameworks whose telemetry has been
recorded and compared (`tests/fixtures/otlp/GENAI_COMPARISON.md`); a
framework is added to the table below only from a recording of its own.

| Scope | Framework label | `sensor_version` | `provider` passed through |
|---|---|---|---|
| `pydantic-ai` | `pydantic_ai` | the scope version | yes |
| `strands.telemetry.tracer` | `strands` | the resource's `service.version` | no: Strands names itself (`strands-agents`) |
| `opentelemetry.instrumentation.openai_agents` | `openai_agents` | empty: the scope carries no version | no: the instrumentation's configured default, not the model's |
| `gcp.vertex.agent` (spans and log records) | `google_adk` | the scope version | yes |

A span is classified by its `gen_ai.operation.name`: `chat` or
`generate_content` in a recognised scope is a model call, `execute_tool`
a tool call, and `invoke_agent` with a non-empty `gen_ai.agent.name` an
agent. Every other span (OpenAI Agents' nameless `Agent workflow` root
and its `unknown` and `agent_handoff` spans, ADK's `invoke_workflow`,
Strands' `execute_event_loop_cycle`, and every span of a scope the table
does not name) only links its parent to its children.

**Staging.** OpenTelemetry GenAI frameworks export a span when it ends,
so an agent's span arrives after its model calls and tools, a run's
spans can arrive in several requests at different ingestion replicas,
and Google ADK's content arrives on `/v1/logs` in requests of its own.
Whether an agent is a root or a child, and so its session's identity,
parent and capture posture (all written once), is known only from spans
that arrive last. Ingestion therefore does not map these spans in the
request. It writes each one, keyed by the sending token, trace, span and
kind (span, or ADK log record), to the `otlp_spans` staging table (see
Database > OTLP GenAI staging), and answers 200 once the write has
committed (503 with `Retry-After: 1` if it fails, which exporters
retry). A request's traces are written in one transaction under a
2-second deadline, in (token, trace) order, so two requests that touch
the same traces cannot deadlock; a trace's row is written before its
spans and holds the lock that serialises concurrent writes to one
trace. A request that carries both Claude Code and GenAI records
publishes the Claude Code events first, then stages the GenAI records;
a failure on either side answers 503, and both are safe to retry.

A staged span keeps only metadata, the span's identity and timing
(trace, span and parent ids, whether the parent is remote, scope name
and version, name, start, end and status code) and these attributes:

- `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`,
  `gen_ai.response.model`, `gen_ai.provider.name` and `gen_ai.system`
  (the older name of the provider attribute, read when
  `gen_ai.provider.name` is absent);
- `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, the
  three cache-read spellings and
  `gen_ai.usage.details.cache_creation_input_tokens`;
- `gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.tool.type`
  (ADK's `TransferToAgentTool` marks a hand-off);
- OpenAI Agents' `gen_ai.handoff.from_agent` and `gen_ai.handoff.to_agent`,
  which give a hand-off's `{from, to}`;
- `error.type` and the first exception event's `exception.type` (ADK
  repeats the event);
- `gen_ai.server.time_to_first_token`, `operation.cost`,
  `gen_ai.response.id`, `gen_ai.conversation.id` and
  `gcp.vertex.agent.event_id` (kept for tracing a call back to ADK);
- for an ADK log record, `has_messages`: whether it carried messages,
  which is not itself content.

Stack traces and attributes not on that list are never kept. A GenAI
span without a 16-byte trace id and an 8-byte span id, or an ADK log
record without both (an all-zero id, which OTLP defines as invalid,
included), cannot be placed in a trace and is counted as
rejected (`a GenAI record needs a 16-byte trace id and an 8-byte span
id`), so a malformed record never fails the staging write. Message text, tool definitions, arguments and results,
and error text are staged, in `otlp_span_content`, only under the
capture rules below, and are deleted once the trace is assembled. A
resent span is ignored, and leaves the trace's timers as they were. A
trace holds at most 10,000 staged records; records past that are
counted as rejected (`trace exceeds 10000 spans`), which bounds one
assembly at about 20,000 events. A trace's identity resource (the
allowlisted attributes identity and billing read) is the one that
created its row, and later resources only AND into its capture
posture, so every assembly of a trace derives the same identity. A
trace that spans two services (one service's agent calling another's
over instrumented HTTP) therefore gives every agent in it the flavor,
user and host of the service whose record arrived first: the resource
is read once per trace, not per record.

**Assembly.** Every ingestion process runs an assembler. Once a second
it claims due traces under a two-minute lease (`FOR UPDATE SKIP
LOCKED`), so each trace is assembled by one process at a time and no
replica waits on another; any replica stages any request and assembles
any trace, so ADK's log records and spans meet in the table whichever
replicas they reach, and a single-replica Compose stack runs the same
path as a scaled Helm deployment. A trace is due:

- 3 seconds after its root span (no parent, or a remote parent) and its
  latest record arrived (`complete`), and for Google ADK only once every
  `generate_content` span also has its log record. ADK sends that record
  whether or not capture is on, so the count works either way.
- 30 seconds after its root span arrived, for a Google ADK trace still
  missing log records (`adk_log_timeout`); calls without their record
  keep their tokens, which come from the spans, and have no content.
- 30 minutes after its latest record, when its root span has not arrived
  (`quiet`), the same silence after which a session is `lost`.
- 24 hours after its first record, in any case (`max_hold`).

The assembler runs one deterministic mapping over the whole trace and
publishes ordinary events through the receiver's own publish path
(validation, content cutting, token stamping), in chunks of at most 500
with the lease renewed before each chunk, and inside a chunk after any
slice of 50 events that ends 30 seconds or more after the last renewal,
so a slow bus never lets the lease lapse: every session's `session_start`,
parents before children, then each session's calls, tools and signals
in order of span end, then the `session_end`s, children before parents.
It then marks the records it loaded as assembled, by key, with the
number of the assembly that marked them (`assembled_in`, 1 for a trace's
first), and deletes their content. A trace stays due if a record was staged while it was
being assembled; an assembly whose lease expired marks nothing, and the
next holder publishes the same event ids again, which the worker drops
as copies. Every claim has an owner id of its own, so an expired lease
is not renewed, released or marked even when the same process claims
the trace again. With each renewal, the first chunk's included, the
assembler re-reads the trace's capture posture, and once a record
without capture has turned it off it publishes none of the content it
loaded: it maps the rest of the trace again as if capture were off,
so the sessions it starts after that carry `capture_prompts=false`
and a failed tool's message is `<redacted>`. A trace claimed before it is complete (a Google ADK trace
still missing log records) is released to be due again, never later
than 24 hours after its first record, nor later than a record staged
during the claim made it due: 30 seconds after its root, or 3 seconds
after its next record, whichever comes first, rather than polled. A
trace claimed before its own timer (one a failed publish released to be
retried) is released to that timer, so it is never judged `quiet` or
`complete` early. A publish (or a load) that fails, the message bus
or the database being down, releases the trace, marking nothing, to be
retried after a delay that starts at one second and doubles with each
consecutive failure of that trace in the process, up to 30 seconds; the
records are durable, so exporters are not affected. A lease renewal
that errors releases the trace at once rather than leaving its lease to
lapse. While one trace of a claim assembles, the leases of the claim's
traces still waiting are renewed too, with the trace's own, at least
every 30 seconds, so a long assembly never lets them lapse; a trace
whose waiting lease was lost is left to the next claim, and one whose
renewal errored is released first. A session's first
`session_start` skips the attachment check: its id is new to every row
except one an earlier attempt at the same assembly started, whose
copy the worker drops, so only a re-attaching start runs it. On
shutdown an assembler stops claiming, finishes the chunk it is
publishing, and releases its lease without marking, so another process
assembles the trace at once and publishes the same ids. A `quiet` or `max_hold` assembly treats an agent whose chain
of ancestors is cut by a missing span as a root. An event dated more
than 48 hours before its assembly fails validation (see Validation
rules), is logged with its reason, and the rest of the trace is
published.

Records that arrive after their trace was assembled make it due again
and are assembled the same way: only their events are published, and a
model span whose subtree holds an already assembled model span
publishes nothing, so totals stay single. When their session has
already ended, they are wrapped in a `session_start` that re-attaches
it (see Session attachment flow) and a `session_end`. The re-attaching
`session_start` is dated one microsecond before the earliest event it
precedes, as the Claude Code dialect's synthetic start is, so it stays
inside the validation window however old the session is; the worker
keeps the re-attached row's `started_at` (see Session state machine >
Assembled sessions), and the session's attachment marker is drawn at
that point, mid-run. Its attachment entry carries the time the record
arrived, later than that start, and the run drawer and the swimlane
still mark that start as the attachment (see Session attachment flow,
step 5). The `session_end` is dated at the session's
original end, unless that is outside the validation window (a
`max_hold` trace whose agent ended early, given a late record a day
after its assembly), when it is dated one microsecond after the latest
event it follows. A late call that reaches a worker replica before its
re-attaching start is redelivered until the start lands, for up to
three seconds (see NATS consumer). An agent span an earlier assembly
already published takes as its parent only the nearest agent ancestor
assembled in the same assembly or an earlier one (by `assembled_in`):
the parent it was published with. An ancestor that arrived in a later
assembly is a root of its own, with its own calls and tools, in that
assembly and every one after it, and the agent's later events keep the
`agent_name`, agent id and parent it was published with
(`parent_session_id` is also written once). A late ADK log record whose call
was already assembled is dropped with its content; the call keeps its
tokens. A trace's staged records are deleted 1 hour after a `complete`
assembly and 24 hours after any other, so late ancestry can still be
used while its session can still be re-attached; a sweep every 10
minutes deletes expired traces, and one every minute deletes staged
content more than 24 hours and 30 seconds after it was staged. A record
that arrives after its trace's rows were deleted starts a new trace row
with no ancestry: it is assembled as a trace whose root never arrived,
its calls going to the unattributed session, and a record already
assembled before is published under the same ids again, which the
worker drops as copies.

**Sessions.** Each `invoke_agent` span with a `gen_ai.agent.name` is a
session. An agent span with no agent span among its ancestors is a
root. Otherwise its parent session is its nearest agent ancestor, at any
depth and through any span between them, and its `agent_role` is its
name (trimmed, at most 256 bytes, cut at a UTF-8 boundary), so an agent
called as a tool is a child. Every event of a child session (its start,
calls, tools, signals and end) carries its `parent_session_id` and
`agent_role`, as the Claude Code dialect's do. Agents that hand off are
sibling roots of the same `otel_trace_id`; the hand-off is an
`agent_handoff` `session_signal` on the agent handing off, with
`signal_data` `{from, to}` (agent names, each at most 256 bytes, cut at
a UTF-8 boundary), read from OpenAI Agents' `agent_handoff` span
(`gen_ai.handoff.from_agent`, `gen_ai.handoff.to_agent`), or from ADK's
`execute_tool` span whose `gen_ai.tool.type` is `TransferToAgentTool`
(which also stays a `tool_call`) and the sibling agent that starts
next; the tool's arguments are content and are never read for it. A
name the spans do not give (no sibling agent starts after the transfer,
or the agent handing off is the unattributed session) is left out of
`signal_data` rather than guessed. A
model call or tool belongs to its nearest
agent ancestor, never to the agent its own attributes name; one with no
named agent ancestor belongs to the trace's unattributed session, a root
created only when needed, with `context.otel_unattributed=true`, that
starts at its earliest span and ends at its latest.

A session starts at its agent span's start and ends at its end
(`close_reason=normal_exit`), with `state=error` and the sub-agent error
block when the span failed: `error_class` from `error.type`, else the
exception type (cut to 256 bytes at a UTF-8 boundary, as on a failed
tool or model call), and `message`, the span's error text cut as a
failed tool's is, only with capture on; a span that names no class and
has no message to give ends in error with no block. Its
`session_start` carries `sensor_version` (the framework's version),
`capture_prompts` (the trace's posture, below) and a `context` of
`telemetry=otlp`, `supports_directives=false`, `frameworks`
(`["<framework label>/<version>"]`, or the bare label when the version
is empty, as the plugin does for Claude Code), `otel_trace_id`, `otel_span_id`,
`otel_scope`, `otel_assembly` (the reason the trace was due, so a
degraded attribution can be told from a normal one) and
`gen_ai_conversation_id` when the framework sends one.

Ids are `uuid5(NAMESPACE_FLIGHTDECK, "flightdeck://otlp/genai/<token
id>/<trace id hex>/<kind>/<span id hex>")`, the kind `session`, `event`,
`start`, `end` or `signal`. `<first_received_at>` below is the trace
row's stored `first_received_at` column in Unix nanoseconds (the
column has microsecond precision, so the value ends in `000`), read
from the row, never the in-memory time of the insert, so a retried
assembly of the row computes the same ids. The unattributed session's
`session`, `start` and `end` ids have no span segment and end in
`/<first_received_at>`, so a trace row created again after the old
one's rows were deleted gets an unattributed session of its own rather
than reusing the closed one. A re-attaching start and its end append
`/<first_received_at>/<assembly_count>` (how many assemblies the row
has had), so they are unique even when a new row's count starts again
from zero. Timestamps are span starts and ends, so re-assembling a
trace stores nothing twice. The token in the id keeps two tokens that
send the same trace id apart: a token rotated in the middle of a run
stages the rest of the run as a separate trace with separate sessions.

**Calls and tools.** A `chat` or `generate_content` span is a
`post_call` unless another model span lies between it and its agent, so
a framework that wraps its own model span around another recognised
model span counts the call once. (The Anthropic SDK's
`anthropic.messages.create` spans that Pydantic AI nests under each
`chat` span are in a scope the table does not name, so they are link
spans and are never counted in the first place.)

| `post_call` field | Source |
|---|---|
| `timestamp`, `latency_ms` | the span's end, and its duration |
| `model_requested` | `gen_ai.request.model`, raw (ADK's LiteLLM prefix included); the worker canonicalises it |
| `model_served` | `gen_ai.response.model`, when sent |
| `tokens_input` | `gen_ai.usage.input_tokens`, which the conventions define to include cache; when it is smaller than the cache counts, they are added to it and `provider_metadata.input_excluded_cache=true` |
| `tokens_output` | `gen_ai.usage.output_tokens` |
| `tokens_total` | `tokens_input` + `tokens_output`; a count that does not parse makes it -1, which validation refuses, as in the Claude Code dialect |
| `tokens_cache_read` | the first present of `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.details.cache_read_input_tokens` and `gen_ai.usage.cache_read_input_tokens`, never their sum; left out when the span sends none (OpenAI Agents drops the cache reads OpenAI reports), so an unknown share is not recorded as zero |
| `tokens_cache_creation` | `gen_ai.usage.details.cache_creation_input_tokens`; left out when not sent |
| `provider` | `gen_ai.provider.name` from the frameworks the table above trusts, mapped to the provider vocabulary (`anthropic`, `openai`, `gcp.*` to `google`, `x_ai` to `xai`, `mistral_ai` to `mistral`); a value outside that mapping, or one from an untrusted framework, is omitted, never passed through (validation would refuse it and drop the `post_call`), and the worker derives the provider from the model |
| `streaming` | `ttft_ms` from `gen_ai.server.time_to_first_token` and `final_outcome=completed`, when sent |
| `cost_reported` | `operation.cost`, with `cost_source=agent` |
| `provider_metadata.response_id` | `gen_ai.response.id` |

Tokens come from that span only: never from agent spans (Pydantic AI's
`gen_ai.aggregated_usage.*`, the `gen_ai.usage.*` on Strands' agent
spans), from ADK's log records, which repeat their span's usage, or from
metrics. A failed model span (ERROR status) is an `llm_error` on its
agent's session, never a `post_call`. Its error text is content and
is never read for it, capture on or off: the `llm_error` names the
error by its class (below). The four frameworks' recordings carry no usage on
one (see `tests/fixtures/otlp/GENAI_COMPARISON.md` > A failed model
call), but a provider may bill a call that then fails, so the usage is
read from the failed span, else from the outermost level of model-call
spans below it, of any scope and never past an agent span, that carries
usage, summing every span at that level that does (a framework that
retried the call reports one span per attempt), and is reported as a
failed stream's is: `error.partial_tokens_input` and
`error.partial_tokens_output`, each left out when absent or malformed,
never 0, with the top-level token fields absent and `billing_mode` set
when the resource declares it. That `llm_error` is the one event that
reports those tokens, since a model span under another model span is
never a call of its own. A model span that arrives after its failed
outer call was assembled publishes nothing, so its usage is not counted:
reporting it would take a second event for the one failed call. No
framework puts the HTTP status or the provider's error code on its own
span, so the error is classified from its class name alone (`error.type`,
else the first exception's type), as the sensor classifies a provider's
exception by class: the last dotted segment is matched against the
sensor's class names, a name ending in one taking its type
(`openai.NotFoundError` and Pydantic AI's `ModelNotFoundError` are
`not_found`), and a span that names no class is `other`. Its
`error_message` is the class name, cut to 256 bytes at a UTF-8
boundary (`model call failed` when there is none), `http_status`, `provider_error_code`, `request_id` and
`retry_after` are null, `is_retryable` follows the taxonomy, and
`model_requested`, `provider` and `latency_ms` are read as for a
`post_call`. An
`execute_tool` span is a `tool_call` on its agent's session, with
`tool_name`, `tool_use_id` (`gen_ai.tool.call.id`, absent for ADK's
`<not specified>`), `latency_ms` and `duration_ms`; an `execute_tool`
that runs a child agent stays a `tool_call` on the parent. A failed tool
carries the error block `{error_type: other, error_class, message}`,
`error_class` from `error.type`, else the first exception type, cut to
256 bytes at a UTF-8 boundary (left out when the span names neither); its
message is the status message, else the exception message, cut to 200
characters, with capture on (left out when the span has neither), and
`<redacted>` with capture off.

**Identity.** `client_type` is `otlp` and `framework` is the framework
label. `agent_type` is the resource's `flightdeck.agent_type` when it
is `coding` or `production`, else `production`. The flavor is
`flightdeck.flavor`, else `service.name` unless it is empty,
`unknown_service*` or `strands-agents`, else the framework label. A root
agent's `agent_name` is `<flavor>/<agent name>`, a child's is `<root
agent_name>/<role>`, and the unattributed session's is the flavor, so
agents of the same name in different frameworks or apps stay apart when
the flavor differs. User and host come from the resource's `user.id`
(else `user.name`) and `host.name`, else `unknown`; ADK's per-record
`user.id` names the application's user and is not read. The agent id is
derived from them as for every client (see Identity model), every part
cut to 256 bytes at a UTF-8 boundary first, a child's from its root's `agent_name` and
its role. A root agent's name is trimmed and cut the way a role is, so
the two read alike. The parts are cut, not the `agent_name` they make up,
so a child's `agent_name` at any depth is its root's `agent_name` and its
own role, never the chain of agents between them (`parent_session_id`
carries that). None of the four frameworks sends a flavor, user or host, so
two apps on one framework that name an agent alike share that agent
until each sets
`OTEL_RESOURCE_ATTRIBUTES=flightdeck.flavor=<app>,host.name=<host>`.
`billing_mode` is `flightdeck.billing_mode` when set, else the `otlp`
default, `metered`.

**Capture.** A GenAI record's content is kept only when its own
resource declares `flightdeck.capture_prompts=true`, and a trace's
posture is the AND of every resource that contributed to it: once one
record of a trace comes without capture, the trace's staged content is
deleted and none is staged after it. A record is read only for the
content its event can carry: a model call span for
`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions` and `gen_ai.tool.definitions`; a tool span
for `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`; a named
agent span for its input and output messages and Pydantic AI's
`final_result`; a Google ADK log record for the four keys of a model
call, its array values converted to the equivalent JSON; and a failed
tool or agent span for its error text, the status message, else the
first exception's message (never the stack trace). Every other span
(Strands' `execute_event_loop_cycle`, which repeats its calls' messages,
other link spans, foreign scopes), and every other attribute (Pydantic
AI's `pydantic_ai.all_messages` included), stages nothing. A string that
holds a JSON object or array is kept as that JSON, any other string as
itself. Strands sends its messages as span events: under the latest
conventions as `gen_ai.client.inference.operation.details` events
carrying the same keys, each read only when the span has no attribute
of that key, so a message sent both ways is kept once; under the older
ones as one event per message (`gen_ai.system.message` the system
instructions; `gen_ai.user.message`, `gen_ai.assistant.message` and
`gen_ai.tool.message` the input messages; `gen_ai.choice` the output),
each kept as its attributes with the role its event name stands for,
and on a tool span its tool message and choice are the arguments and
result. `<REDACTED>`, `[REDACTED]`, empty values and message skeletons
(messages and parts that carry nothing beyond their `type`, `id`,
`name`, `role` and `finish_reason`, as Pydantic AI sends with its own
content switch off) count as no content. Content is cut to fit the 768
KiB event body limit when it is staged, so a staged record is never
larger than the event it becomes.

Captured content is the one content Flightdeck writes outside
`event_content`, and only transiently: it waits in
`otlp_span_content` while its trace is assembled, is written only when
the exporter declares capture, and is deleted when the trace is
assembled, or by the sweep once it has been staged for 24 hours and 30
seconds. With capture off nothing is staged, and no content reaches any
table. Assembled content lands in `event_content` like any other, stored
as the framework sent it, never converted to a provider's format, with
`provider=otel_genai`. A `post_call` carries content when its call has
input messages, output messages or system instructions (tool definitions
alone describe the agent, not the call, so a call with only those
carries none): `system` from `gen_ai.system_instructions` (JSON-encoded
into the text column), `messages` from the input messages and `response`
from the output messages (each `[]` when absent), `tools` from the tool
definitions and `model` the requested model (empty when none). A Google
ADK `post_call` takes its content from the log record with its span id,
whichever of the two arrived first; the log record's keys win over the
span's (ADK's span repeats the tool definitions without their
parameters). A `tool_call` carries `tool_input` and `tool_output` from
its arguments and result, in the tool-capture envelope. A child agent's
`session_start` carries `incoming_message` (its agent span's input
messages, else the arguments of the tool span its parent ran it through)
and its `session_end` `outgoing_message` (its output messages, else
Pydantic AI's `final_result`, else that tool span's result), shaped as
the sensor's sub-agent messages are: the body on the event up to 8 KiB,
a larger one in `event_content` under `provider=flightdeck-subagent`,
dated at the agent span's start and end. ADK records a tool's arguments
and result only inside the next model call's messages, so its
`tool_call`s carry none. A root agent's own content (its messages and
`final_result`) has no destination: whether an agent is a root is known
only at assembly, so it is staged like a child's, then deleted with the
trace's content without being published. The same text is in the root's
model calls' `messages` and `response`. An assembler that publishes
without capture (the posture turned off during the assembly) drops all
of it: content, sub-agent messages and error text.

**Lifecycle.** A GenAI session reaches the dashboard after its run
ends, 3 to 30 seconds later, already closed, with the run's own start
and end times (see Session state machine > Assembled sessions). A trace
whose root never arrives appears after 30 minutes, and a run longer
than 24 hours is assembled from what has arrived by then, the rest
following as late records.

**Operations.** Each assembly is logged once (trace, reason, records,
events, lag and chunks), with a warning for an expired lease or a
refused event. With nothing staged, an assembler's work is one claim a
second, an index probe of the empty set of pending traces, and the two
sweeps. The staging tables answer what is waiting: the pending
traces, the oldest pending trace's age, and the reasons traces were
assembled. A sensor and an OTLP exporter reporting the same run report
it twice, and nothing detects it, so an agent should report one way
(detection: [#279](https://github.com/flightdeckhq/flightdeck/issues/279)).

---

## Worker / Event Processing

The worker's only HTTP surface is its metrics listener (see Metrics).
It connects to NATS, consumes events from
the `FLIGHTDECK` stream, processes them through the session state machine
and policy evaluator, writes to Postgres, and emits `flightdeck_fleet`
NOTIFY events.

### The FLIGHTDECK stream

The ingestion API owns the `FLIGHTDECK` JetStream stream
(`ingestion/internal/nats/stream.go`). At startup, before it serves a
request, it creates the stream or brings an existing one to its
configured settings in place. The workers never create or change the
stream: a worker that starts first looks for it every two seconds,
logging once a minute while it waits (at INFO, then at WARN once it has
waited ten minutes, by when ingestion is down or cannot create it), and
then sets up its consumer.

| Setting | Value |
|---|---|
| Subjects | `events.>` |
| Storage | file |
| Retention | limits: a message stays until a limit removes it, acknowledged or not |
| Discard | old: at the size limit the oldest messages are removed to make room |
| Max age | `FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS`, default 72 hours, at least 1 |
| Max size | `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB`, default 5120 MiB (5 GiB) on each server, at least 64 MiB |
| Replicas | `FLIGHTDECK_NATS_STREAM_REPLICAS`, 1 to 5, default 1 |

The age limit lets the workers be down from a Friday evening to a Monday
morning (about 64 hours) without losing an event; a processed message is
never read again, so keeping messages longer only costs disk. Events
average about 2 KiB on the wire, so 5 GiB holds about 2.6 million: 72
hours of a sustained 10 events a second. On a compose host, where NATS
shares the disk with Postgres, the size limit is what bounds the NATS
store. Ingestion refuses to start on a value outside the bounds in the
table; an age under an hour would remove the backlog of a routine
restart, and a size under 64 MiB reads as a unit mistake.

**What a limit removes.** With workers that keep up, the limits remove
only messages already processed, whose events Postgres holds. A limit
also removes a message the workers have not processed, so events are
lost in two cases: the workers are down, or stuck, for longer than the
max age (the events published at the start of the outage age out), or
their backlog grows past the max size (the oldest unprocessed events
are discarded to make room for new ones). A removed event is never
written to Postgres; the consumer resumes at the oldest message left.
At startup the worker compares its consumer's last delivered sequence
with the stream's first and, when messages between them were removed
before delivery, logs a WARN with their count (`events were removed from
the stream by its age or size limit before the workers were delivered
them`). The check covers what the limits remove: a purge moves the
consumer past the purged messages, so it reports none. Discarding new
messages instead would not protect the backlog: a full stream of
processed messages, the steady state under limits retention, would
refuse every publish: `POST /v1/events` logs and drops an event whose
publish still fails after its retries, and the OTLP receiver answers
503.

Retention stays by limits rather than by interest: an interest stream
drops a message no consumer is subscribed to, so the events published
on a fresh install before the workers create their consumer, or while
the consumer is being recreated, would vanish. The processed window is
also what an operator can replay from with a new consumer.

**In-place update.** When the stream exists, ingestion compares its
max age, max size, discard policy and replica count with the
configured ones and, if any differs, sends a stream update that carries
the stream's current configuration with only those four fields changed,
so a field ingestion does not set (duplicate window, description) is
kept. The subjects are compared too: a subject ingestion publishes to
(`events.>`) that the stream lacks is added, in the same update, since
adding a subject removes nothing, and a subject the stream has that
ingestion does not know is logged at WARN (`stream has subjects
ingestion does not publish to; kept`) and left in place, since removing
it could drop messages another publisher relies on. JetStream applies limits and replica changes in
place: lowering a limit removes the messages beyond it at once, oldest
first, and raising the replica count copies the stream to the new
servers. The storage type cannot change in place, so a stream whose
storage or retention is not the one in the table is logged at ERROR and
left as it is; recreating it deletes its messages and is an operator's
call. Every ingestion replica runs the same check at startup with the
same settings (the compose file and the Helm config map give all of them
one set), so concurrent starts send identical updates, and a create that
loses a race with another replica reads the stream it created and
checks that one.

**When the update fails.** A stream that cannot be read, or a missing
stream that cannot be created, stops ingestion at startup: it cannot
publish without one. An update NATS refuses (a JetStream API error, the
server's answer) is logged at ERROR with the stream's current and wanted
settings (`stream update refused; the stream keeps its current
settings`), and ingestion starts on the stream as it is, so a value the
cluster cannot take does not become an ingestion outage. NATS refuses a
size larger than a server can reserve (a server without a configured
store limit reserves at most 75% of its volume's free space, measured
when it starts) and a replica count above the cluster's server count.
Correct the setting and restart ingestion. An update that gets no
answer at all (a timeout, no responders, a dropped connection), or an
answer that the cluster has no leader at the moment (JetStream codes
10008 "temporarily unavailable", 10009 "can not handle request" and
10118 "stream is offline", or a 503 with no JetStream code, as during a
rolling restart of the NATS servers), is a different case. The HTTP 503
alone does not decide: insufficient resources and JetStream not
enabled also carry it, and are refusals. Ingestion tries such an update
four times, pausing 0.25, 0.5 and 1
second between attempts (about 22 seconds at most, with the 5-second
request timeout), and then exits so its supervisor restarts it, since
it cannot tell whether the stream is usable.

**Rolling back.** Code that creates the stream with no limits and one
replica fails at startup (`stream name already in use`) on a stream with
limits or more replicas, since JetStream refuses a create whose
configuration differs from the existing stream's. Before starting such
an ingestion or worker, reset the stream with the NATS CLI: `nats
stream edit FLIGHTDECK --max-age=0 --max-bytes=-1 --discard=old
--replicas=1 --force`, which restores unbounded retention and one
replica.

### NATS consumer

`workers/internal/consumer/nats.go::Consumer` connects to NATS and pulls
from one durable consumer with one fetching goroutine, which hands each
message to one of `WorkerPoolSize` lanes (below). A message has three outcomes: ACK when
the processor returns nil (including the orphan `session_end` path, which
inserts nothing); a delayed NAK when the processor cannot act yet or
fails and the delivery budget is not spent; and Term for a payload that
does not parse, a payload whose `session_id` is not a canonical UUID, or
a processing failure on the last delivery. A NAK
redelivers after one second times the number of deliveries so far;
`MaxDeliver` is three deliveries in total and there is no dead-letter
stream (the worker counts a message that fails its last delivery as
`max_retries_exhausted`). Each delivery hands the processor the message's
stream sequence and whether it is the last delivery the budget allows.

The worker does not trust the stream. Ingestion refuses a malformed
`session_id`, but anything that can publish to NATS reaches the worker
without passing ingestion, so the fetching goroutine checks each decoded
event's `session_id` against the form ingestion enforces (8-4-4-4-12
hex digits, either case) before it picks the event's lane. An event that
fails is terminated on its first delivery, counted as
`invalid_session_id`, and logged once at WARN (`dropped event with
malformed session_id`) with its event type, stream sequence, the id's
length in bytes and at most the id's first 64 bytes. The processor never
sees it, so it holds no lane and costs no database round trip; unchecked,
it would fail at Postgres's `::uuid` cast on each of its three
deliveries. The check covers `session_id` alone, because it keys the
lanes and every session-row write; the other UUID fields (`id`,
`agent_id`, `parent_session_id`) still fail at their casts and are
retried and terminated as any processing failure is.

Payload strings that reach the worker's log lines are capped
(`workers/internal/logcap`): ids at 64 bytes (a canonical UUID is 36),
the event type and timestamp at 64, names such as the flavor and the MCP
server name at 256 (ingestion's own cap for names), and error text and a
recovered panic's value at 1 KiB, since Postgres quotes the offending
input in a cast error. A capped value keeps its leading bytes, cut on a
UTF-8 boundary, and ends with its full length (`…(4096 bytes)`). A
`session_id` needs no cap once it has passed the check above. The log
lines carry ids, names and counts only, never prompt content.

The consumer processes a session's events in stream order. The fetching
goroutine asks for up to 64 messages at a time and appends each to the
queue of one of `FLIGHTDECK_WORKER_POOL_SIZE` lanes, chosen by a hash of
its `session_id`; each lane's goroutine processes its queue one message
at a time, in the order fetched. Different sessions run concurrently
across lanes; two events of one session never do, so a `session_start`
is written before the `pre_call` published after it is looked at.

That order holds within one worker process. Every worker replica pulls
from the same durable consumer (`flightdeck-workers`; the Helm chart
runs two by default), and the server hands each fetch whatever messages
are next, so two replicas can each hold an event of one session and
process them in either order. An event carrying content that one
replica handles before another replica has stored its session's
`session_start` lands on a lazily created row with no capture posture,
and its content is dropped (see Ingestion API > `POST /v1/events`).
Likewise, a late call of an assembled OpenTelemetry session (see OTLP
ingest > GenAI dialect) that one replica handles before another has
stored the re-attaching `session_start` published ahead of it finds the
row closed with its own stream sequence above `closed_seq`, and its
tokens are not added.

Two redeliveries close these gaps, as the delayed redelivery of an
early `session_end` does, each after one second and after two:

- an event carrying content whose row is missing or has no capture
  posture, before the worker falls back to lazy creation;
- a token-bearing event (a `post_call`, `embeddings`, or an `llm_error`
  carrying partial tokens, with `tokens_total` above zero) that finds
  its row closed with its stream sequence above a known `closed_seq`,
  when the row's `context` carries `otel_trace_id`, before the worker
  falls back to the closed-session skip. The session guard already reads the row, so the check costs no
  extra query. Every other event on a closed row, and every other
  client's session, is skipped at once, as before a redelivery existed:
  a plugin's or sensor's straggler after its end is not delayed.

A start published ahead of them on another replica lands in that time.
The waiting spends deliveries, so the last delivery the budget allows
always takes the fallback (lazy creation, or the skip with the event
row stored) and never ends the message: a transient database error on
an earlier delivery is retried as before, and an event is never lost to
the wait. Across replicas, correctness otherwise rests on the
session-row rules below.

Appending never waits, so a slow session holds back only the sessions
that share its lane. The queues are bounded by the consumer's
`MaxAckPending` (1000): the server stops delivering when that many
messages are unacknowledged. A queued message is already delivered and
unacknowledged, so every ten seconds the consumer reports each message
that is waiting in a lane, or being processed, in progress
(`AckWait` is 30 seconds); its ack wait restarts without spending a
delivery. Processing one message has a ten-second deadline: a message
stuck on the database (a row lock held elsewhere) fails at the deadline,
is redelivered with the delayed NAK below, and its lane moves on. The
worker's connections set `lock_timeout` to eight seconds, under that
deadline, so Postgres itself abandons the wait rather than keeping a
backend blocked after the client has given up. A lock held through all
three deliveries (about 35 seconds) ends the message as
`max_retries_exhausted`.

Events can still reach the worker out of order: a client's concurrent
processes (the Claude Code plugin's hooks) can publish a session's events
in a different order than they happened, and a message the worker asked
to be redelivered comes back after the session's later events.
Correctness under that rests on the session-row rules below: lazy
creation on any event but `session_end`, the parent stub, the delayed
redelivery of a `session_end` that arrives before its row, the stream
sequence comparison between a session's start and end, and the
closed-session skip.

The ingestion API publishes one subject per event type — `events.<type>`
where `<type>` is the `event_type` the validator accepted, so every event
type in the vocabulary (lifecycle, LLM, tool, MCP, policy and directive
events) has its own subject, for example `events.session_start`,
`events.post_call`, `events.mcp_tool_call` and `events.policy_mcp_block`.

The worker subscribes via the `events.>` catch-all so all event types
route to a single processor without per-type subscription wiring.
Adding a new event type requires only the sensor enum + worker
processor switch update — the NATS subject lands automatically.

### Session state machine

```
                     session_end (any state)
                ┌───────────────────────────────┐
                │                               ▼
   session_start│                            closed
      ──▶ active ──▶ idle ──▶ stale ──▶ lost
                ▲                 │         │
                │                 │         │
                └─────────────────┴─────────┘
                  any event  (revive)

   any event but session_end for unknown session_id
                │
                ▼
        lazy-create (active)

   session_end for unknown session_id → redelivered after 1 s and 2 s,
   then dropped as an orphan (no row is created)

   session_start on closed (re-attachment) → active, unless its own
   session_end is later in the stream

   closed + any event → session side effects skipped with warn log
   (handleSessionGuard); the event row is still stored
```

**Thresholds.** 2 min silence after the last signal triggers `active →
stale`; 30 min total silence triggers `stale → lost`. The 30 min lost
threshold accommodates interactive Claude Code user-think-time
windows. The reconciler in `workers/internal/processor/session.go`
sweeps once per `FLIGHTDECK_RECONCILER_INTERVAL_SECS` (60 s by default;
the dev stack sets 5 s so the integration tests that wait for a tick
stay short) and applies both transitions in a single pass. A finer
tick buys nothing in production because the thresholds it enforces
are minutes to hours long; it only adds load. Each worker process runs
one reconciler: a pass that outlasts the interval delays the next tick
rather than overlapping it, and the reaper locks rows with `SKIP
LOCKED`, so the passes of several worker replicas never double-close
a session. After its UPDATEs commit, the pass sends a
`flightdeck_fleet` notification for every session it moved (see
Notify), so an open dashboard sees a run go stale or lost without
reloading; the dashboard never applies the thresholds itself.

**Assembled sessions.** A session assembled from an OpenTelemetry
trace (its `session_start` `context` carries `otel_trace_id`; see OTLP
ingest > GenAI dialect) is published after the run it describes, so it
takes its times from its events, each capped at the worker's clock:

- A `session_start` that inserts the row sets `started_at` to the
  start's timestamp. One that finds a row its session has never started
  (a parent stub, whose `started_at` is its child's start, or a row
  lazily created by another event, whose `started_at` is that event's
  time; neither has a capture posture yet, which every `session_start`
  writes) replaces that placeholder with the start's timestamp. One
  that finds a row its session already started (a re-attachment, whose
  `context` already carries `otel_trace_id`) keeps the row's
  `started_at`.
- A `session_end` that closes a row whose `context` carries
  `otel_trace_id` sets `ended_at` to the end's timestamp. An end that
  closes a lazily created row before its session's start is written
  (the start waiting on another worker replica) takes the worker's
  clock, as the row does not yet say it is assembled.

Every other session takes both from the worker's clock when it writes
the `session_start` and the `session_end`, and a lazily created row or
a parent stub keeps its placeholder `started_at` when its
`session_start` is written (see Three revival scenarios). `last_seen_at` is the worker's clock on every write
except the one that lazily creates a row or a parent stub, which sets
it to the same time as that row's `started_at`.

**Orphan-timeout reaper.** The same reconciler tick also closes `lost`
sessions that have been silent past `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`
(default 24 h). Reaping flips the row to `state=closed`, stamps
`ended_at = NOW()`, leaves `last_seen_at` at the session's last
signal, emits a synthetic `session_end` event with
`payload.close_reason = "orphan_timeout"` so the dashboard's
close-reason facet surfaces the reconciler's verdict alongside
happy-path shutdowns, notifies `flightdeck_fleet` with that event so
the dashboard receives the close like any other `session_end`, and bumps
`sessions_closed_total{reason="orphan_timeout"}` in the worker's
in-process metrics registry. The reaper exists because plugin / sensor
crashes, `kill -9`, and missed lifecycle hooks would otherwise leave
`lost` rows pinned forever; without the timeout the Fleet view
accumulates dead rows that look indistinguishable from a long pause.
The Fleet swimlane reads the reaper's close from that `close_reason`
and draws the run ending at its `last_seen_at`, as lost, rather than
at the reap (see SwimLane).

**Parent-bump propagation.** Every non-`session_start` /
non-`session_end` handler that has a non-empty `parent_session_id`
on the incoming event also bumps the PARENT session's
`last_seen_at` and revives it from `stale` / `lost` back to
`active`. A session with active descendants is logically active;
without this propagation a parent that delegated all real work to
sub-agents (Claude Code Task subagents, CrewAI hand-off, LangGraph
nodes) would age to `stale → lost → orphan_timeout` closure while
its children clearly streamed events. Closed parents are
untouched (terminal state). Revivals via this path bump
`sessions_revived_total{trigger="child_event"}` in the worker's
in-process metrics registry, so parent-via-child revivals can be charted
separately from any future revival path, and notify `flightdeck_fleet`
for the parent: the child's own notification names only the child, so
without it a parent the dashboard saw go stale would stay stale there
while its children worked. Scope is direct
parent only. The GenAI dialect of OTLP ingest builds trees of any depth,
but its sessions arrive already closed, and the bump leaves closed
parents alone, so none of its sessions depends on it.

**Terminal-state handling.** `closed` is terminal and final. `session_end`
at any non-closed state transitions directly to `closed`, unless it was
published before the row's current run began;
`handleSessionGuard` skips the session side effects (token roll-up,
freshness, revival) of any later event for a closed session with a warn
log, while the event row itself is still stored. One side effect is
kept: a call event published before the `session_end` (its stream
sequence below the row's `closed_seq`) still adds its tokens to the
session and the agent, because a sensor sends a run's last `post_call`
and its `session_end` back to back and the call can reach the worker
after the end (a redelivered call, or a client that published them out
of order). The session stays closed and `last_seen_at` does not move. Revival on `stale` /
`lost` is a correctness fix; reviving a `closed` session would contradict
the user's explicit end signal. The one exception is a re-attachment: a
`session_start` revives a closed row unless its own `session_end` was
published after it (see Session attachment flow).

### Handlers

`workers/internal/processor/session.go` exposes:

- `HandleSessionStart`: upsert agent, upsert the session with
  state=active (a closed row is revived unless its own `session_end` was
  published after this start), record the start's stream sequence, and
  add the session to the agent's `total_sessions` when this start
  inserted the row or claimed a parent stub (see `agents` rollup).
- `HandlePostCall`: add the event's `tokens_total`, when positive, to
  `tokens_used` (an `llm_error`'s is the tokens of its failed stream; see
  Database, `events`); update the session's model; advance last_seen_at. The
  policy evaluator then runs for `post_call` only. The same handler
  serves `pre_call`, `tool_call`, `embeddings`, `llm_error`,
  `directive_result`, the policy events and the MCP events; one without a
  positive token total (the policy and MCP events) only advances
  freshness.
- `HandleSessionEnd`: apply the end in one UPDATE guarded by the run's
  start, which matches only when the row's current run began before the
  end was published (or a sequence is unknown). An open row is closed
  (state=closed, ended_at, the end's stream sequence); an already closed
  row takes a greater `closed_seq` and is otherwise left alone, so a
  duplicate end costs no write. When nothing matches, a missing row asks
  for a delayed redelivery and is dropped as an orphan on the last
  delivery, a closed row makes the end a duplicate, and an end that
  predates the current run is recorded as an event without closing
  anything. Once the end has settled on an existing row, a row that no
  agent owns yet (a parent stub whose `session_start` never arrived) is
  claimed for the end's agent and counted toward its `total_sessions`;
  the claim, like the end, never creates a row.
- `HandleHeartbeat`: advance last_seen_at.
- `HandleMCPServerAttached`: merge the server fingerprint into
  `sessions.context.mcp_servers` after the freshness update.

Every handler except `HandleSessionStart`, `HandleSessionEnd` and
`HandleMCPServerAttached` (which always follows `HandlePostCall`) runs
`handleSessionGuard` before its write: `closed` sessions skip the session
side effects with a warn log; `stale` and `lost` sessions are revived to
`active` with `last_seen_at` advanced; unknown `session_id`s are
lazy-created so the event lands instead of FK-violating at `InsertEvent`;
a row that no agent owns yet (a parent stub) is first attributed to the
event's agent and counted toward its `total_sessions`.
The event's normal side effects then proceed, and the event row is
inserted, unless the event carries a client-supplied id that is already
stored: such a copy is dropped before any handler runs (see
`originating_event_id` chain).

SIGKILL bypasses all handlers. Affected sessions transition to stale
after 2 minutes and lost after 30 minutes via the background reconciler;
the next event from any re-attached process revives the session (or
lazy-creates one if the re-attach ended up on a fresh `session_id`). This
is untrappable by design.

### Revive / create sites

Five code sites know how to ensure a session is usable for an incoming
event. They mirror rather than consolidate; a unified primitive would need
a 4-axis config surface (writes_attachment, refreshes_identity,
creates_if_missing, allowed_prior_states) which is harder to read than
five focused functions:

1. **`ingestion/internal/session/store.go::Attach`**.
   Synchronous on `session_start` so the HTTP response can report
   `attached=true`. Closed/lost → active, clearing `ended_at` and
   `closed_seq`; writes one `session_attachments` row per arrival (the
   only writer of those rows).
2. **`ingestion/internal/session/store.go::RecordStart`**.
   Runs once the event is published, when the row pre-existed. Stamps the
   start's stream sequence and revives a closed row whose `closed_seq` is
   unknown or below that sequence (the previous run's queued `session_end`
   closed it between the check and the stamp), clearing `ended_at` and
   `closed_seq`. Best effort: it skips a row another writer holds instead
   of queueing on its lock, retrying after pauses of 5, 10, 20 and 40 ms;
   if the row is still held it gives up and logs that, at most one line a
   second per process. No attachment row.
3. **`workers/internal/writer/postgres.go::UpsertSession`**.
   Called on every `session_start`. Sets the state to `active` from any
   prior state, clearing `ended_at`, except a `closed` row whose
   `closed_seq` is greater than this start's stream sequence, which stays
   closed; records the start's sequence in `start_seq`. Refreshes
   identity columns from the event payload; COALESCE and CASE branches
   let a lazy-created row absorb the real session_start data when it
   arrives. Real values are write-once; only the `"unknown"` sentinel is
   upgradable.
4. **`workers/internal/writer/postgres.go::ReviveIfRevivable`**.
   State flip only: `{stale, lost} → active` plus `last_seen_at = NOW`.
   Called by `handleSessionGuard` before any non-`session_start` side
   effects run. No identity refresh, no attachment row.
5. **`workers/internal/writer/postgres.go::ReviveOrCreateSession`**.
   Delegates to `ReviveIfRevivable` when the row exists; INSERTs a new
   row with best-effort identity + `"unknown"` / NULL sentinels when it
   does not, with no `start_seq`: a straggler published after the run's
   end must not read as the run's start.

Any change to the revival contract (columns touched, state predicate)
must be applied to all five sites. The cross-reference comment on
`ReviveIfRevivable` enumerates the list.

### Three revival scenarios

The attachment flow is one of three concrete applications of a single
conceptual primitive — ensure the session row matches the incoming
event's assumption. Three scenarios, three code paths:

- **Attach-on-terminal**. A `session_start` for a session already
  in `{closed, lost}` revives to `active` and records an attachment row.
  Drives orchestrator-re-run attribution.
- **Revive-on-any-event**. Any non-`session_start` event for a
  session in `{stale, lost}` revives to `active` and advances
  `last_seen_at`. Drives interactive Claude Code sessions that pause
  during user think-time without being treated as lost by the reconciler.
- **Create-on-unknown**. Any event except `session_start` and
  `session_end` for a `session_id` Flightdeck has never seen creates the
  row lazily from the event payload with `state=active`, no `start_seq`,
  `started_at = event.occurred_at`,
  and `"unknown"` sentinels on fields the event doesn't carry (typically
  `flavor`, `agent_type`).
- **Create-parent-stub**. A child `session_start`
  whose `parent_session_id` does not yet exist in `sessions` triggers
  a parent-stub INSERT before the child is written, so the new
  `sessions.parent_session_id` FK is satisfied. The stub uses the
  same `"unknown"` sentinel pattern as create-on-unknown plus
  `started_at = child.started_at` as a placeholder, and carries no
  agent identity. When the real parent's `session_start` arrives
  later, `UpsertSession` claims the stub: it fills the identity,
  upgrades the sentinels via the write-once-but-upgrade branch, and
  counts the session toward the parent's agent once. A parent whose
  `session_start` is never processed is claimed by its first other
  event (`handleSessionGuard`, or `HandleSessionEnd` for its
  `session_end`), which fills the identity only. Same
  primitive as create-on-unknown, different trigger (FK satisfaction
  vs unknown-session-id event).

### Policy evaluator

`workers/internal/processor/policy.go::PolicyEvaluator` runs after each
post_call event:

- Look up the active policy in scope precedence: session → flavor → org →
  no-limit.
- Compare cumulative `tokens_used` against `warn_at_pct`,
  `degrade_at_pct`, `block_at_pct`.
- When a threshold is crossed, write a directive row to `directives`
  (`action=warn`, `degrade`, or `shutdown` with reason
  `token_budget_exceeded` at the block threshold). The directive lives in Postgres;
  delivery happens via the ingestion API on the sensor's next POST.
- Platform engineers cannot POST `degrade` / `warn` / `policy_update`
  directly; only `shutdown`, `shutdown_flavor`, and `custom` are
  user-creatable.

Bias: dedup on `(action, scope_value)` before writing so a single
threshold crossing in a flavor with N sessions does not write N
directives.

### Notify

The worker sends a Postgres NOTIFY on `flightdeck_fleet` for every
change an open dashboard has to see: each event it stores and each
session state change it makes. The wire payload is `{session_id,
event_type, event_id}` (`workers/internal/writer/notify.go`), one
session per notification. A payload is about 130 bytes, far under
Postgres's 8000-byte limit, so a large batch never needs splitting.

| Sender | When | `event_type` | `event_id` |
|---|---|---|---|
| `NotifyFleetChange`, after `InsertEvent` | each event write | the event's type | the stored event's id |
| `ReconcileStaleSessions` | a session goes `stale` or `lost` | empty | empty |
| `ReapOrphanedLostSessions` | a `lost` session is closed | `session_end` | the synthetic `session_end`'s id |
| `BumpParentLastSeen` | a child's event revives a `stale` or `lost` parent | empty | empty |

An empty `event_id` marks a state-only change: the session row changed
and no event was written. Carrying the event id otherwise lets the hub
fetch exactly that event by primary key instead of re-reading the
session's events and taking the newest, which races paired writes.

Every notification is sent after the write it announces has committed,
as its own statement; the reconciler and the reaper send a pass's
notifications in one `pg_notify` statement for the batch, once per
session, so a session that goes `stale` and `lost` in the same pass is
announced once. Sending after the commit means the hub never reads a
row before the change is visible. A failed notification is logged and
the change stands; the dashboard shows it on its next fetch. The state
machine therefore never depends on the notification channel: a full
NOTIFY queue costs live updates, not stale, lost or closed transitions.

Postgres delivers notifications in commit order, and the hub handles
them one at a time and re-reads the session row for each. Every
broadcast therefore carries a row at least as new as the change that
sent it, and since each change notifies after it commits, the hub's
last read of a session follows its last change. A reconciler pass and
an event that revives the same session serialize on the row lock: when
the revival commits first, the reconciler's UPDATE re-checks its
condition on the revived row, skips it and announces nothing; when the
reconciler commits first, the event's own notification follows and the
hub's re-read shows the session active again. A repeated broadcast of
the same row is harmless, because the dashboard replaces the session
row it holds.

---

## Storage

Flightdeck runs on one of two database engines behind one boundary, the
Go module `storage` (`github.com/flightdeckhq/flightdeck/storage`):

- **SQLite** (default): one file, pure Go (`modernc.org/sqlite`, no cgo),
  one process. `storage.Open(ctx, "sqlite://<path>")`.
- **Postgres**: the multi-process backend (Helm, several instances
  sharing a database). `storage.Open(ctx, "postgres://…")`, pgx as the
  `database/sql` driver.

The sections after this one describe the schema in Postgres terms; the
type mapping below says what each type is on SQLite.

### The boundary

`storage.Open` returns a `*storage.DB`: an embedded `*sql.DB`, the
`Backend` name and a `Dialect`. Stores write plain `database/sql`
against it. No pgx type and no SQLite driver symbol is used outside the
`storage` module. Where a query differs between the two engines beyond
what `Dialect` renders, the store keeps two query sets
(`queries_postgres.go`, `queries_sqlite.go`) and picks one by `Backend`;
SQL fragments are never templated beyond the dialect helpers. A store
outside the boundary holds a pgx pool and runs on Postgres only
(CLAUDE.md rule 35 lists the store packages). On SQLite the ingestion
API validates tokens and drops revoked ones through the boundary; its
directive lookups, session attachment and OTLP staging are outside it
and return an error there (an event is still accepted, with no
directive and `attached: false`; OTLP requests fail), and the GenAI
assembler does not run. `storage.Open` pings; a service opens its
database with `storage.OpenRetry`, which retries with a doubling delay
for a bounded budget (ingestion: 60 s) so a database that starts a
moment after the service does not end the process. The Postgres pool is
capped at max(4, NumCPU) connections, open and idle, idle ones closed
after 30 minutes; the SQLite writer is one connection and the reader
pool eight.

**The common subset** both engines accept, written as is: `$1, $2, …`
placeholders (SQLite binds `$NNN` by ordinal), `CAST(x AS TEXT)` (the
portable spelling of Postgres' `x::text`), `ON CONFLICT (…) DO UPDATE SET
c = EXCLUDED.c` / `DO NOTHING`, `RETURNING`, `COALESCE`, `CASE`, window
functions, recursive CTEs, partial and expression indexes.

**`Dialect` renders what differs.** Each method takes SQL expressions
(a column, a literal or a placeholder, never user input) and returns
SQL text; every helper has a test that runs on both engines and expects
the same result:

| Helper | Postgres | SQLite |
|---|---|---|
| `Placeholder(n)` | `$n` | `$n` |
| `Now()` | `NOW()` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `AddInterval(ts, secs)` | `ts + (secs) * INTERVAL '1 second'` | `strftime(…, ts, (secs) \|\| ' seconds')` |
| `DateTrunc(unit, ts)` (hour, day, week, month; weeks start Monday; always UTC) | `date_trunc('unit', ts, 'UTC')` | `strftime` with the unit's fields zeroed; week via `'-6 days', 'weekday 1'` |
| `ILike(expr, pattern)` | `lower(CAST(expr AS TEXT) COLLATE "C") LIKE lower(CAST(pattern AS TEXT) COLLATE "C") ESCAPE '\'` | `lower(expr) LIKE lower(pattern) ESCAPE '\'` |
| `InArray(expr, param)` + `ArrayArg(values)` | `expr = ANY($n)` with a `[]string` (`text[]`) | `expr IN (SELECT value FROM json_each($n))` with the JSON array text |
| `InUUIDArray(expr, param)` | `expr = ANY(CAST($n AS uuid[]))`, so the uuid column's index is used | same as `InArray` (UUIDs are text) |
| `JSONText(col, keys…)` | `col->'a'->>'b'` | `json_extract(col, '$.a.b')` |
| `Upsert(conflict, update)` | `ON CONFLICT … DO UPDATE SET c = EXCLUDED.c` | same |
| `Returning(cols…)` | `RETURNING …` | same |

Case-insensitive matching uses `lower()` on both sides on both engines
and folds ASCII only: SQLite's `lower()` is ASCII-only, and on Postgres
both sides are folded under the `"C"` collation, so the database locale
cannot make `'ÉCOLE'` match `'école'` on one engine and not the other.
A plain `LIKE` is case-sensitive on both (SQLite connections set
`case_sensitive_like`), so a store that wants case folding says so with
`ILike`. `DateTrunc` truncates to UTC boundaries whatever the session
time zone; its argument is a column or function, since a bare
placeholder has no type on Postgres (`CAST($n AS TIMESTAMPTZ)`).
`JSONText` is for string-valued keys: Postgres `->>` yields text for
every scalar, SQLite `json_extract` yields the JSON value's own type.

**Constructs with no helper**, converted per store: `LATERAL` becomes a
correlated subquery or CTE; `FOR UPDATE SKIP LOCKED` is a no-op on
SQLite (one writer, transactions begin `IMMEDIATE`); an advisory lock
becomes the `IMMEDIATE` transaction itself; `array_agg` / `unnest` /
`jsonb_array_elements` / `jsonb_set` / `split_part` get a SQLite query
of their own (`json_group_array`, `json_each`, `json_set`, string
functions).

### SQLite semantics

- **File and connections.** The database URL is `sqlite://<path>`; the
  path is percent-encoded into the `file:` URI SQLite opens, so a data
  directory containing `#`, `?`, `%` or spaces opens the file at that
  path, and a Windows drive path (`C:\…`) becomes `file:///C:/…`. Every
  connection sets `journal_mode=WAL`, `busy_timeout=5000`,
  `foreign_keys=ON` (off by default in SQLite), `synchronous=NORMAL` and
  `case_sensitive_like=ON`. The embedded `*sql.DB` is the **writer**: one
  connection, so write transactions queue in Go (context-aware) instead
  of spinning on the busy handler, and every transaction on it begins
  `IMMEDIATE`, taking the write lock at `BEGIN` so a read-then-write
  transaction cannot fail with `SQLITE_BUSY` halfway. `DB.Reader()` is a
  pool of eight `query_only` connections for statements that only read
  (a write through it fails); in WAL mode they neither block the writer
  nor wait for it. A read that must see a transaction's own uncommitted
  rows runs on the transaction. Because the writer is one connection, a
  statement issued on the writer while the same goroutine holds an open
  `Tx` or unread `Rows` from it waits forever: inside a transaction every
  statement runs on the `Tx`, and a read that needs no transaction runs
  on `Reader()`. `sql.TxOptions.ReadOnly` is enforced by Postgres and
  ignored by SQLite. On Postgres both handles are the same pool.
- **Timestamps** are `TEXT` in columns declared `TIMESTAMP`, always
  `YYYY-MM-DDTHH:MM:SS.sssZ` (RFC 3339, UTC, exactly three fractional
  digits, `storage.TimeLayout`): the text sorts chronologically byte for
  byte, SQLite's date functions read and produce it, and the driver
  scans it as `time.Time`. Every timestamp column carries a `CHECK` that
  the value round-trips through `strftime` in this layout
  (`strftime(fmt, col) IS col`: NULL passes, an empty string or any other
  shape does not), so a value with microseconds, without a zone, or a
  bare date is refused rather than sorted wrongly. The `storage` driver wrapper writes every
  `time.Time` argument in this form, so stores pass `time.Time` as on
  Postgres. Postgres keeps microseconds; SQLite keeps milliseconds. A
  timestamp an expression computes (`MAX(ts)`, `DateTrunc`) has no
  declared type and comes back as text on SQLite: scan it through
  `storage.Time`, which accepts both shapes.
- **UUIDs** are `TEXT` in canonical lower-case hyphenated form, with a
  `CHECK` on every uuid column (lower-case, `8-4-4-4-12`, hexadecimal),
  so an upper-case or unhyphenated id cannot be stored and then missed
  by a lookup; defaults generate a random version-4 UUID in SQL.
  Postgres' `uuid` type accepts other spellings (upper case, braces, no
  hyphens) and stores them canonically; SQLite stores the text as given,
  so a store lower-cases and hyphenates an id it did not generate
  before writing, on both engines, and the `CHECK` enforces it on
  SQLite. Postgres `uuid` columns compare with a bound text argument, so
  stores pass UUIDs as strings on both engines.
- **Text collation** is `BINARY`: comparison and `ORDER BY` on text are
  byte order, not locale order, on SQLite; Postgres orders by the
  database collation. Stores that need a locale-independent order sort
  on `lower()` or on a non-text key.
- **JSON** (`jsonb` on Postgres) is `TEXT` with a `json_valid()` `CHECK`,
  read with `json_extract`; the facet indexes are expression indexes on
  `json_extract(col, '$.key')` and replace the Postgres GIN index on the
  whole document. SQLite stores the document text as written, so key
  order and duplicate keys survive, where Postgres `jsonb` normalises
  them; stores compare JSON by extracted keys, never as text.
- **Booleans** are `BOOLEAN` columns holding 0 / 1; `integer`, `bigint`
  and `smallint` are `INTEGER`; `numeric` is `NUMERIC`; `bytea` is
  `BLOB`; `date` is `DATE`.
- **No stored procedures.** The Postgres trigger that announces a
  deleted access token on `flightdeck_access_token_revoked` has no
  SQLite counterpart; on SQLite the store that deletes the row publishes
  the id on the Bus after commit.

### Migrations

`storage/migrations/postgres/` holds the Postgres migrations (the table
in the Database section) and `storage/migrations/sqlite/` the SQLite
ones; both are embedded in the binaries (`go:embed`) and applied by
`storage.Migrate(ctx, url)`, which opens a connection of its own,
runs golang-migrate (`database/pgx/v5` or the modernc `database/sqlite`
driver) and leaves the caller's `DB` untouched. SQLite starts from
`000001_baseline`, the Postgres schema at 000036 translated once with
the rules above and seeded with the same `tok_dev` row (salt, hash and
prefix of Postgres migration 000010) and the same global MCP policy row.
From there **every schema change is a pair**: the same version number
and description in both directories. `scripts/check-migration-pairs.sh`
fails CI when the version lists differ, and the `storage` module's
parity test opens both engines at their newest migration and fails when
the tables, columns, nullability, primary keys or explicit indexes
differ (the GIN index is the one allowed difference). The compose files
mount the Postgres directory for the workers' runner and
`helm/Makefile sync-migrations` copies it into the chart.

### Bus

`storage.Bus` carries the notifications the services exchange: a
session or agent changed (`storage.ChannelFleet`, `flightdeck_fleet`, a
JSON object with `session_id`, `event_type`, `event_id`), an access
token was revoked (`storage.ChannelAccessTokenRevoked`,
`flightdeck_access_token_revoked`, the token id). `Publish(ctx,
channel, payload)` delivers to every current subscriber; `Subscribe(ctx,
channel)` returns a channel of payloads that closes when `ctx` ends or
the subscription is lost. A subscriber that must not miss a
notification treats a close before its context ends as a gap: it
re-reads the state it caches and subscribes again. `storage.NewBus(db)`
picks the implementation: on Postgres, `pg_notify` through the pool and
one dedicated `LISTEN` connection per subscription, so every process on
the database sees every notification; on SQLite, in-process buffered
channels, where a publisher waits for a subscriber whose buffer (256
payloads) is full rather than dropping; the wait ends with the
publisher's context or the subscriber's, and publishers never wait for
each other.

### Tests on both backends

Go tests that run SQL open their database through
`storage/storagetest`: `storagetest.Each(t, fn)` runs `fn` once per
covered backend with an open, migrated database. SQLite is always
covered (a fresh file in the test's temp directory, migrated from the
embedded baseline), so `go test ./...` runs the SQLite half everywhere;
Postgres is covered when `TEST_POSTGRES_URL` names a database, and
`FLIGHTDECK_TEST_BACKEND=sqlite|postgres` narrows a run to one engine.
`scripts/go-db-tests.sh` (`make test-go-db`) gives each DB-gated
package a Postgres database of its own on the dev stack, runs every
such package on Postgres and the storage-converted ones on SQLite as
well, and fails on a skipped test.

## Database

### `agents`

```sql
CREATE TABLE agents (
    agent_id        UUID PRIMARY KEY,
    agent_type      TEXT NOT NULL CHECK (agent_type IN ('coding', 'production')),
    client_type     TEXT NOT NULL CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')),
    agent_name      TEXT NOT NULL,
    user_name       TEXT NOT NULL,         -- wire field is "user"; column avoids the SQL reserved word
    hostname        TEXT NOT NULL,
    policy_id       UUID REFERENCES token_policies(id),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW,
    total_sessions  INTEGER NOT NULL DEFAULT 0,
    total_tokens    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_agents_last_seen_at ON agents (last_seen_at DESC);
CREATE INDEX idx_agents_client_type ON agents (client_type);
CREATE INDEX idx_agents_agent_type ON agents (agent_type);
```

`total_sessions` / `total_tokens` are denormalized rollups maintained by the
worker. Healed by `POST /v1/admin/reconcile-agents` on demand.

### `sessions`

```sql
CREATE TABLE sessions (
    session_id           UUID PRIMARY KEY,
    agent_id             UUID REFERENCES agents(agent_id),          -- nullable: parent-stub rows carry no identity yet
    agent_name           TEXT,                      -- denorm from agents (nullable on sessions)
    agent_type           TEXT NOT NULL,             -- denorm from agents
    client_type          TEXT CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')),  -- denorm from agents (nullable)
    flavor               TEXT NOT NULL,             -- legacy label
    framework            TEXT,                      -- bare name (e.g. "langchain")
    host                 TEXT,
    model                TEXT,
    state                TEXT NOT NULL DEFAULT 'active',  -- active / idle / stale / lost / closed; vocabulary enforced by the worker, not a CHECK
    tokens_used          INTEGER NOT NULL DEFAULT 0,
    token_limit          INTEGER,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW,
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW,
    ended_at             TIMESTAMPTZ,
    metadata             JSONB,                     -- unused: no write path populates it
    context              JSONB DEFAULT '{}'::jsonb,
    token_id             UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
    token_name           TEXT,
    parent_session_id    UUID REFERENCES sessions(session_id),
    agent_role           TEXT,
    capture_prompts      BOOLEAN,                   -- server-authoritative capture posture; NULL = not yet declared (treated as off)
    start_seq            BIGINT,                    -- NATS stream sequence of the session_start that opened the current run; NULL = unknown, or a row created lazily by another event
    closed_seq           BIGINT                     -- NATS stream sequence of the session_end that closed it; NULL = not closed by one, or unknown
);

CREATE INDEX idx_sessions_agent_id ON sessions (agent_id);
CREATE INDEX sessions_agent_id_started_at_desc_idx ON sessions (agent_id, started_at DESC);
CREATE INDEX sessions_state_idx ON sessions (state);
CREATE INDEX sessions_last_seen_idx ON sessions (last_seen_at);
CREATE INDEX sessions_flavor_idx ON sessions (flavor);
CREATE INDEX sessions_started_idx ON sessions (started_at);
CREATE INDEX sessions_token_id_idx ON sessions (token_id);
CREATE INDEX sessions_context_gin ON sessions USING GIN (context);
CREATE INDEX sessions_parent_session_id_idx ON sessions (parent_session_id)
    WHERE parent_session_id IS NOT NULL;       -- partial
-- Plus nine partial expression indexes, one per runtime-context facet
-- key (os, arch, hostname, user, git_branch, git_repo, orchestration,
-- python_version, process_name), each named sessions_context_<key>_idx
-- ON ((context->>'<key>')) WHERE (context->>'<key>') IS NOT NULL. They
-- back the /events runtime-context facet filters and counts; the GIN
-- index does not serve ->> equality predicates.
```

`start_seq` and `closed_seq` let the worker order a session's start and end
(see Session attachment flow); rows written without them follow the plain
state rules.

`agent_name`, `agent_type`, and `client_type` are denormalized from
`agents` so list endpoints can avoid a join. The worker populates them on
`UpsertSession`. `agent_id`, `agent_name`, and `client_type` are nullable
because the worker's parent-stub lazy-create path inserts a placeholder
row with no identity when a child's `session_start` arrives before its
parent's; the parent's `session_start` fills them in, or its first
other event when that start is never processed. There is no
index on `framework`.

`tokens_used` is the only token rollup on `sessions`; per-call input /
output / cache counts live on `events`. `capture_prompts` is the
server-authoritative capture posture, written once from the first
authoritative `session_start` (see Ingestion API above); the worker
treats NULL as capture-off.

`framework` is the bare name (`langchain`). The full
`context.frameworks[]` JSONB array carries versioned strings
(`langchain/0.3.27`), and its labels are what the analytics `framework`
dimension groups by; the session listing's `framework` filter matches
either.
`session_start` writes both. When it carried no framework, the first
later event that carries one (a call, tool call, error or signal: the
events the worker's `post_call` path handles) fills `framework` (a
framework the sensor detected after `init`). Such an event also appends
the bare label to `context.frameworks[]` whenever the session's own
label (the column still NULL, or, on a `flightdeck_sensor` session, equal
to the event's) has no entry there, versioned or bare; a row whose
context is still NULL or `{}` is left for its `session_start` or the
context upgrade to fill, and the next event appends the label then; a
`flightdeck_sensor` `session_start` that fills a NULL context of a row
whose `framework` a call already set appends that label itself, so a
run with a single call is counted too. A
stored framework is never replaced, and a session whose array already
lists its label (the plugin's `claude-code/<version>`, the Agent SDK's,
one detected at `init`) is left as it is, as is any other client's
session with a framework (an OpenTelemetry Claude Code session carries
`context.claude_code_version` and no `frameworks` entry).

`parent_session_id` and `agent_role` are paired sub-agent columns.
Both nullable, both populated only on sub-agent sessions
(Claude Code Task, CrewAI agent turn, LangGraph agent-bearing
node). The FK on `parent_session_id`
references `sessions(session_id)` and is enforced at write time;
forward references where the child's `session_start` arrives before
the parent's are handled by the worker's parent-stub lazy-create
path (see Three revival scenarios above). The partial index excludes
the null-majority root sessions
so the index stays small while supporting fast lookups for the
`?has_sub_agents` / `?is_sub_agent` / `?parent_session_id` filters
and the `agent_role` analytics dimension.

### `session_attachments`

```sql
CREATE TABLE session_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid,
    session_id  UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW
);

CREATE INDEX session_attachments_session_idx ON session_attachments (session_id, attached_at);
```

One row per re-attachment (subsequent `session_start` for an existing
`session_id`). The first `session_start` does NOT write an attachment
row — only re-attachments. The session drawer and the timeline mark
the `session_start` within two seconds of each row (see Session
attachment flow).

### `events` (metadata only — no prompt content inline)

```sql
CREATE TABLE events (
    id                    UUID DEFAULT gen_random_uuid,
    session_id            UUID NOT NULL REFERENCES sessions(session_id),
    flavor                TEXT NOT NULL,
    event_type            TEXT NOT NULL,
    model                 TEXT,
    tokens_input          INTEGER,
    tokens_output         INTEGER,
    tokens_total          INTEGER,
    latency_ms            INTEGER,
    tool_name             TEXT,
    has_content           BOOLEAN NOT NULL DEFAULT FALSE,
    payload               JSONB,                       -- type-specific extras (streaming, error, directive)
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW,
    source                TEXT,
    tokens_cache_read     BIGINT NOT NULL DEFAULT 0,
    tokens_cache_creation BIGINT NOT NULL DEFAULT 0,
    tokens_reasoning      BIGINT,                      -- subset of tokens_output; NULL when not reported
    provider              TEXT,                        -- model vendor; NULL until the worker or the backfill fills it
    billing_mode          TEXT,                        -- metered / subscription / local; NULL until filled, as provider
    platform              TEXT,                        -- endpoint that served the call (provider_metadata.platform)
    cost_reported         NUMERIC(14, 8),              -- USD reported by a gateway or client
    cost_source           TEXT,                        -- provider / agent; set exactly when cost_reported is
    model_requested       TEXT,                        -- verbatim request model id
    model_served          TEXT,                        -- verbatim response model id
    PRIMARY KEY (id, occurred_at)
);

CREATE INDEX events_session_idx ON events (session_id, occurred_at);
CREATE INDEX events_flavor_idx  ON events (flavor, occurred_at);
CREATE INDEX events_type_idx    ON events (event_type, occurred_at);
-- Plus partial expression indexes backing the /events event-grain
-- facet filters and counts: one on `model`, one per payload-JSONB
-- facet key, each `WHERE (<expr>) IS NOT NULL` so the index stays
-- small (only the minority of events carrying the field is indexed).
```

The token columns other than the cache pair are nullable so that "not
reported" stays distinct from zero. On an `llm_error` row they hold the
tokens the provider billed for a stream that failed after delivering
usage: the worker copies `error.partial_tokens_input` and
`error.partial_tokens_output` into `tokens_input` and `tokens_output`,
with their sum as `tokens_total`, when the event reports no top-level
token counts of its own. The cache pair stays 0, since the partial
counts carry no cache split, and the row takes a billing mode as an LLM
call does (see Cost estimation). No migration fills these columns: an
`llm_error` row whose token columns are NULL beside partial counts in
its payload stays so, and its tokens count in no total. `model` holds
the canonical model id and `model_requested` / `model_served` the
verbatim ones (see Cost estimation).

`payload` JSONB carries event-type-specific extras: streaming sub-object on
`post_call`, the token and cost fields that are not columns (see
`POST /v1/events`), error taxonomy fields on `llm_error`, `directive_name` /
`fingerprint` / `parameters` on `directive`, `tool_use_id` /
`duration_ms` / `error` (and `mcp_server` on MCP calls) on the Claude
Code plugin's tool events, `end_reason` on a plugin `session_end`, etc.

### `event_content` (prompt storage — separate table, fetched on demand)

```sql
CREATE TABLE event_content (
    event_id    UUID PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES sessions(session_id),
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    system_prompt TEXT, -- Anthropic system prompt
    messages    JSONB,
    tools       JSONB,
    response    JSONB NOT NULL,
    "input" JSONB, -- embeddings input, or an OpenAI Responses request's input
    tool_input  JSONB,                 -- tool args / prompt arguments
    tool_output JSONB,                 -- tool results / rendered prompts
    embedding_output JSONB,            -- embeddings vectors (capture_prompts gate)
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW
);

CREATE INDEX event_content_session_idx ON event_content (session_id);
```

`event_content` is fetched on demand via `GET /v1/events/:id/content`,
which returns 404 when capture was off for that session. The events table
never carries content inline.

**Per-column semantics by event family:**

| Column | LLM `pre_call`/`post_call` | `embeddings` | `mcp_tool_call` | `mcp_prompt_get` | LLM `tool_call` | `mcp_resource_read` |
|---|---|---|---|---|---|---|
| `messages` | chat history (`[]` for Responses) | `[]` | `[]` | `[]` | `[]` | `[]` |
| `system` | Anthropic `system`, Responses `instructions` | NULL | NULL | NULL | NULL | NULL |
| `tools` | tool schema | NULL | NULL | NULL | NULL | NULL |
| `response` | model response | `{}` | `{}` | `{}` | `{}` | resource body (overflow) |
| `input` | Responses `input` (NULL for chat) | embeddings input | NULL | NULL | NULL | NULL |
| `tool_input` | NULL | NULL | tool args | prompt args | tool input | NULL |
| `tool_output` | NULL | NULL | tool result | rendered messages | NULL (the result is in the next call's messages) | NULL |
| `embedding_output` | NULL | output vectors | NULL | NULL | NULL | NULL |

`tool_input` / `tool_output` are dedicated columns for
tool-style request/response capture. Operators querying
`event_content.tool_input` get tool args directly without
column-name overload semantics. `mcp_resource_read` body
overflow uses the `response` column path because resource
bodies are blobs, not request/response shapes.

`event_content` is where captured content is stored. The one other
table that holds content is `otlp_span_content`, and only transiently:
captured GenAI content waits there while its trace is assembled (see
OTLP GenAI staging, below).

### OTLP GenAI staging (`otlp_traces`, `otlp_spans`, `otlp_span_content`)

```sql
CREATE TABLE otlp_traces (
    token_key         TEXT NOT NULL,                 -- the sending access token's id; a trace belongs to its token
    trace_id          BYTEA NOT NULL CHECK (octet_length(trace_id) = 16),
    source            TEXT NOT NULL,                 -- framework label of the first record: pydantic_ai / strands / openai_agents / google_adk
    source_version    TEXT NOT NULL DEFAULT '',
    token_name        TEXT NOT NULL DEFAULT '',
    resource          JSONB NOT NULL,                -- allowlisted resource attributes only: service.name / service.version, host.name,
                                                     -- user.id / user.name, flightdeck.{flavor, agent_type, billing_mode, capture_prompts};
                                                     -- of the resource that created the row, never updated
    capture           BOOLEAN NOT NULL,              -- AND over every contributing resource: off wins
    first_received_at TIMESTAMPTZ NOT NULL,
    last_received_at  TIMESTAMPTZ NOT NULL,
    root_seen_at      TIMESTAMPTZ,
    resolve_at        TIMESTAMPTZ NOT NULL,          -- when the trace is next due
    pending           BOOLEAN NOT NULL DEFAULT TRUE, -- has (or may have) records not yet assembled
    gen               BIGINT NOT NULL DEFAULT 0,     -- bumped by every write that staged a new record
    lease_owner       TEXT,
    lease_expires     TIMESTAMPTZ,
    assembled_at      TIMESTAMPTZ,
    assembly_count    INTEGER NOT NULL DEFAULT 0,
    assembly_reason   TEXT,                          -- complete / adk_log_timeout / quiet / max_hold
    span_count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_key, trace_id)
);

CREATE INDEX otlp_traces_due_idx       ON otlp_traces (resolve_at)   WHERE pending;
CREATE INDEX otlp_traces_retention_idx ON otlp_traces (assembled_at) WHERE NOT pending;

CREATE TABLE otlp_spans (                            -- spans (kind 1) and ADK log records (kind 2)
    token_key      TEXT NOT NULL,
    trace_id       BYTEA NOT NULL,
    span_id        BYTEA NOT NULL,
    kind           SMALLINT NOT NULL CHECK (kind IN (1, 2)),
    parent_span_id BYTEA,
    remote_parent  BOOLEAN NOT NULL DEFAULT FALSE,
    scope_name     TEXT NOT NULL,
    scope_version  TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL,
    op             TEXT NOT NULL DEFAULT '',         -- gen_ai.operation.name
    agent_name     TEXT NOT NULL DEFAULT '',
    start_ns       BIGINT NOT NULL,
    end_ns         BIGINT NOT NULL,
    status         SMALLINT NOT NULL,
    meta           JSONB NOT NULL,                   -- the content-free allowlisted attributes
    assembled      BOOLEAN NOT NULL DEFAULT FALSE,
    assembled_in   INTEGER,                          -- the assembly that marked it (the trace's assembly_count after
                                                     -- that assembly, from 1); NULL exactly while not assembled
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id) REFERENCES otlp_traces ON DELETE CASCADE
);

CREATE INDEX otlp_spans_unassembled_idx ON otlp_spans (token_key, trace_id) WHERE NOT assembled;

CREATE TABLE otlp_span_content (                     -- written only when capture is declared
    token_key TEXT NOT NULL,
    trace_id  BYTEA NOT NULL,
    span_id   BYTEA NOT NULL,
    kind      SMALLINT NOT NULL,
    content   JSONB NOT NULL,
    staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- the backstop sweep's age is measured from it
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id, span_id, kind) REFERENCES otlp_spans ON DELETE CASCADE
);

CREATE INDEX otlp_span_content_staged_idx ON otlp_span_content (staged_at);
```

Ingestion owns these tables (see OTLP ingest > GenAI dialect), and no
other service reads them. A staging write upserts the trace row first, which satisfies the foreign
key and takes the row lock that serialises writes to one trace, then
inserts the records that are new (`ON CONFLICT DO NOTHING`, so a
resent record stages nothing and moves neither the timers nor `gen`),
then their content, and then, only when a record was new, moves the
trace's timers and bumps `gen`. The timers and the records are dated
from when the write held the row lock, not from when it began, so a
write that waited behind another never dates them earlier, and
`last_received_at` never moves back. A trace's 10,000-record cap counts
staged records, so a resent record never takes a new one's place. A
write without capture on a trace that had it, a resent record's
included (off is the safe direction), sets `capture` false and deletes
the trace's content rows in the same transaction.
An assembly marks the records it loaded `assembled`, by key, with its
own number in `assembled_in` (a check holds the two columns together),
and deletes their content; the trace row is released, and stays `pending`
when its `gen` moved during the assembly, so a record staged meanwhile
is assembled next time whatever order the two transactions committed
in. The partial indexes keep the due-trace claim and the retention sweep
on the rows they need: `pending` traces by `resolve_at`, finished ones
by `assembled_at`; `otlp_span_content_staged_idx` serves the content
backstop sweep, which deletes rows whose `staged_at` is more than 24
hours and 30 seconds old. Deleting a trace row removes its records and their
content by cascade.

### `model_pricing` (prices for estimated cost, written by the API)

```sql
CREATE TABLE model_pricing (
    model_id               TEXT NOT NULL,              -- canonical model id
    platform               TEXT NOT NULL,              -- direct / bedrock / vertex / foundry / azure
    provider               TEXT NOT NULL,
    input                  NUMERIC(14, 6) NOT NULL,    -- USD per 1M tokens, every rate below too
    output                 NUMERIC(14, 6) NOT NULL,
    cache_read             NUMERIC(14, 6) NOT NULL,
    cache_write_5m         NUMERIC(14, 6) NOT NULL,
    cache_write_1h         NUMERIC(14, 6) NOT NULL,
    reasoning              NUMERIC(14, 6),             -- NULL: reasoning tokens bill at the output rate
    tier_threshold_tokens  BIGINT,                     -- NULL: no context tier
    tier_input             NUMERIC(14, 6),
    tier_output            NUMERIC(14, 6),
    tier_cache_read        NUMERIC(14, 6),
    tier_cache_write_5m    NUMERIC(14, 6),
    tier_cache_write_1h    NUMERIC(14, 6),
    priority_multiplier    NUMERIC(8, 4),              -- NULL: no priority rate in the catalogue
    fast_multiplier        NUMERIC(8, 4),              -- NULL: no fast-mode price for the model
    source                 TEXT NOT NULL,              -- catalogue / override / alias
    deprecated_on          DATE,
    PRIMARY KEY (model_id, platform)
);
```

The table is derived data: the API rebuilds it from the vendored
catalogue and `pricing.yaml` at startup (see Cost estimation), and a
companion one-row table `model_pricing_meta` records the content hash
and load time. Nothing else writes to it. The workers apply the
migrations when they start and the API does not wait for them, so on a
fresh database the API's first rebuild can run before these tables
exist; the API then retries in the background, waiting 1 s and doubling
up to 30 s between attempts, until a rebuild succeeds. Migrations take
seconds, so the window is short, but the API's readiness does not wait
for it: until a rebuild succeeds the table is empty (on a fresh
database) or holds the previous prices, so on a fresh database
estimated cost leaves calls unpriced and a token policy's `degrade_to`
is rejected. A rebuild that keeps failing for another reason is
retried every 30 s and logged each time.

### `token_policies`

```sql
CREATE TABLE token_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid,
    scope           TEXT NOT NULL,                   -- org / flavor / session; validated by the API handler, not a CHECK
    scope_value     TEXT NOT NULL DEFAULT '',        -- '' for org scope
    token_limit     BIGINT,
    warn_at_pct     INT,
    degrade_at_pct  INT,
    degrade_to      TEXT,
    block_at_pct    INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW,
    UNIQUE (scope, scope_value)                      -- constraint token_policies_scope_scope_value_key
);

CREATE INDEX idx_token_policies_scope ON token_policies (scope, scope_value);
```

Lookup precedence: session > flavor > org > no-limit. Workers join against
`sessions` to find the matching policy row.

### `directives`

```sql
CREATE TABLE directives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid,
    session_id      UUID,                            -- NULL for flavor-wide
    flavor          TEXT,                            -- NULL for session-scoped
    action          TEXT NOT NULL,                   -- shutdown / degrade / warn / custom (a shutdown_flavor request fans out into per-session shutdown rows)
    reason          TEXT,
    grace_period_ms INTEGER NOT NULL DEFAULT 5000,
    issued_by       TEXT NOT NULL DEFAULT 'platform',
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW,
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    degrade_to      TEXT,
    payload         JSONB                            -- custom directive parameters
);

CREATE INDEX directives_session_pending_idx ON directives (session_id) WHERE delivered_at IS NULL;
CREATE INDEX directives_flavor_pending_idx ON directives (flavor) WHERE delivered_at IS NULL;
```

`LookupPending(sessionID)` does an atomic UPDATE...RETURNING that combines
lookup and mark-delivered in a single operation: the oldest pending
directive addressed to the session, or addressed to its flavor with no
session, is returned and stamped `delivered_at = NOW` so it is not
re-delivered on subsequent POSTs. A row for another session of the same
flavor is never returned, so a stop for one session cannot reach
another (a `shutdown_flavor` fans out into one row per session).

A request with `agent_id` fans out the same way, in the API, to each
live (active or idle) session of the agent that can act on the
directive. A session takes a `shutdown` when its
`context.supports_directives` says so, or, when it does not set it,
when its client type's registry default does (a row with no client
type counts unless its flavor or frameworks mark Claude Code, the
dashboard's rule). A `custom` directive also needs the client type's
`runs_custom_directives` and a session flavor that registered the
directive's fingerprint. All rows of one request are inserted in one
transaction, and the `X-Directive-Count` response header carries how
many were created (1 for a single session). The CORS middleware lists
the header in `Access-Control-Expose-Headers`, so a dashboard served
from another origin can read it.

A `custom` request names its targets one of three ways: `session_id`
for one session (a `flavor` beside it only narrows the fingerprint
check), `flavor` for every live session of the flavor, or `agent_id`
for the agent's runs as above, which a `flavor` narrows to the runs of
that flavor. A request that reaches no session answers 404, and a
fingerprint no flavor registered (or not the given one) answers 422.

### `custom_directives`

```sql
CREATE TABLE custom_directives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid,
    fingerprint   TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    JSONB,
    registered_at TIMESTAMPTZ DEFAULT NOW,
    last_seen_at  TIMESTAMPTZ DEFAULT NOW,
    UNIQUE (fingerprint, flavor)                     -- constraint custom_directives_fingerprint_flavor_key
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives (flavor);
CREATE INDEX custom_directives_fp_idx ON custom_directives (fingerprint);
```

Uniqueness is scoped to `(fingerprint, flavor)`: the same handler
fingerprint registered by two flavors is two rows. The sensor registers
handlers via `/v1/directives/sync` (which looks up by fingerprint within
the flavor and bumps `last_seen_at` for known ones, returning unknown
fingerprints) and `/v1/directives/register` (which inserts the schema, or
only bumps `last_seen_at` when the `(fingerprint, flavor)` pair already
exists). On register, the same transaction issues
`pg_notify('flightdeck_fleet', 'directive_registered')` so the dashboard
hub broadcasts a fleet update and the Directives page / FleetPanel
sidebar refresh in real time when the sensor registers a brand new
flavor's directives via `init`.

### `access_tokens`

```sql
CREATE TABLE access_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,  -- hex(SHA256(salt || raw_token))
    salt         TEXT NOT NULL,         -- 16 random bytes as hex
    prefix       TEXT NOT NULL,         -- first 8 chars of raw_token
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX access_tokens_prefix_idx ON access_tokens (prefix);
```

Salted SHA-256 storage with per-token salt. The raw token is returned to
the caller exactly once via `POST /v1/access-tokens`. The dev-seed
`tok_dev` row is non-deletable and non-renameable via the API; it is
disabled by unsetting `ENVIRONMENT=dev` in production deployments
.

### Migrations

All schema changes use `golang-migrate` numbered up/down pairs in
`storage/migrations/postgres/`, with the SQLite translation of the same
change under the same number in `storage/migrations/sqlite/` (the
Storage section has the pairing rule and the type mapping). Schema is
never modified via `init.sql` (seed data only). Existing migrations are
never modified; new changes always create a new numbered migration. The
table below is the Postgres history; SQLite's `000001_baseline` is the
schema this history reaches at 000036.

| # | Description |
|---|---|
| 000001 | Initial schema (agents, sessions, events, event_content, directives, token_policies) |
| 000002 | `events.source` column |
| 000003 | `directives.degrade_to` column |
| 000004 | `custom_directives` table |
| 000005 | `directives.payload` JSONB column |
| 000006 | `sessions.context` JSONB + GIN index |
| 000007 | `custom_directives` unique key recast to `(fingerprint, flavor)` |
| 000008 | `sessions.last_attached_at` column |
| 000009 | `session_attachments` table; drops `sessions.last_attached_at` (one row per re-attachment replaces the single timestamp) |
| 000010 | Salted `access_tokens` schema |
| 000011 | `sessions.token_id` FK + `token_name` column |
| 000012 | Rename `api_tokens` → `access_tokens` |
| 000013 | `events.tokens_cache_read` + `tokens_cache_creation` columns |
| 000014 | Normalize legacy `agent_type` values |
| 000015 | Drop and recreate `agents` table with `agent_id` PK |
| 000016 | `event_content.input` JSONB column for embeddings capture |
| 000017 | `sessions.parent_session_id` FK + `sessions.agent_role` text + partial index |
| 000018 | `mcp_policies` + `mcp_policy_entries` + `mcp_policy_audit_log` tables + indexes. The `mcp_policy_versions` table this migration created was dropped by 000020 — see that row |
| 000019 | Seed empty-blocklist global `mcp_policies` row |
| 000020 | Drop `mcp_policy_versions` table + `mcp_policies.version` column |
| 000021 | `event_content.tool_input` + `tool_output` JSONB columns for tool / prompt capture |
| 000022 | `event_content.embedding_output` JSONB column for embeddings vector capture |
| 000023 | `events` partial expression indexes (`model` + payload-JSONB facet keys) for `/events` event-grain facet filtering and counts |
| 000024 | `sessions` partial expression indexes on the nine runtime-context keys (`context->>'os'`, `arch`, `hostname`, `user`, `git_branch`, `git_repo`, `orchestration`, `python_version`, `process_name`) for `/events` runtime-context facet filtering and counts |
| 000025 | `sessions (agent_id, started_at DESC)` composite index backing the per-agent latest-session lookup |
| 000026 | `sessions.capture_prompts` nullable BOOLEAN: server-authoritative capture posture written once from `session_start` |
| 000027 | `sessions.start_seq` and `sessions.closed_seq` nullable BIGINT: NATS stream sequence of the `session_start` that opened the current run and of the `session_end` that closed it, so the worker orders a session's start and end without holding events back |
| 000028 | `access_tokens_notify_revoked` trigger: every deleted `access_tokens` row sends its id on the `flightdeck_access_token_revoked` NOTIFY channel, so both services drop cached validations of a revoked token at once |
| 000029 | Token and cost model: `events.tokens_reasoning`, `provider`, `billing_mode`, `platform`, `cost_reported`, `cost_source`, `model_requested`, `model_served`; the `model_pricing` and `model_pricing_meta` tables |
| 000030 | `events_model_backfill_idx`: partial index on events that name a model but have no `model_requested`, the rows the worker's model-id backfill rewrites |
| 000031 | `model_pricing.fast_multiplier`: per-model fast-mode price multiplier from the catalogue |
| 000032 | `agents_client_type_check` and `sessions_client_type_check` swapped for the client type registry's list, added `NOT VALID` |
| 000033 | Validates the two `client_type` constraints 000032 added, in its own step so the scan of `sessions` does not hold the swap's exclusive lock |
| 000034 | `sessions_active_by_agent_idx`: partial index on `sessions (agent_id) WHERE state = 'active'`, so the agent state rollup the hub reads for every broadcast finds an agent's active runs in one small probe |
| 000035 | `otlp_traces`, `otlp_spans` and `otlp_span_content`: the OTLP GenAI staging tables and their indexes; the down file drops the three tables, last created first |
| 000036 | `otlp_spans.assembled_in`: the assembly that marked a record, with a check that it is set exactly when `assembled` is (records marked before it get their trace's `assembly_count`); the down file drops the column |

---

## API

### Endpoint inventory

Each endpoint carries full swaggo annotations on the handler; the Swagger
UI at `/api/docs/index.html` (and `/ingest/docs/index.html`) is the
authoritative parameter-level reference.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/fleet` | Fleet summary: agents with state rollup, total sessions, total tokens, recent_sessions rollup, and runtime-context projection (`os`, `arch`, `git_branch`, `git_repo`, `orchestration`, `python_version`, `process_name` — sourced from the agent's most recent session's `context` JSONB via a `LEFT JOIN LATERAL`), context_facets |
| `GET` | `/v1/sessions` | Paginated session listing; filters: `agent_id`, `flavor`, `framework`, `state`, `error_type`, `policy_event_type`, `mcp_server`, `from` (default: 7 days ago), `to` (omitted, no upper bound on `started_at`: Postgres stamps it, so ending the range at the API's clock would drop a session that just started whenever that clock reads behind), `q`, `parent_session_id`, `is_sub_agent`, `has_sub_agents`, `agent_role[]`, `include_pure_children`, `include_parents`, `close_reason`, `estimated_via`, `terminal`, `matched_entry_id`, `originating_call_context`; returns per-session aggregates (`error_types[]`, the error types of the session's `llm_error` and failed `tool_call` events, which the `error_type` filter matches the same way; `policy_event_types[]`, `mcp_server_names[]`, `close_reasons[]`, `estimated_via_values[]`, `has_terminal_error`, `matched_entry_ids[]`, `originating_call_contexts[]`), `child_count`, and `attachment_count` (the number of re-attachments to the session, surfaced as the agent drawer Runs-tab attached pill) |
| `GET` | `/v1/sessions/:id` | Session detail: metadata (including `close_reasons`, the distinct `close_reason` values of its `session_end` events, and `capture_prompts`, the session's stored capture posture: `true` or `false` once a `session_start` declared it, `null` while none has) + chronological events (always an array, empty until the first event row lands) + attachments array |
| `GET` | `/v1/agents` | Paginated agent listing; filters: `agent_type`, `client_type`, `state`, `hostname`, `user`, `os`, `orchestration` (multi-value — OR within a dimension, AND across; `os` and `orchestration` use any-session EXISTS semantics on `sessions.context`), `search` (case-insensitive substring on `agent_name` + `hostname`), `updated_since`; `sort` + `order`; `limit` (default 25, max 100) + `offset`. Each row carries the sub-agent rollup fields `agent_role` and `topology` (`lone` / `parent` / `child`) plus the runtime-context projection (`os`, `arch`, `git_branch`, `git_repo`, `orchestration`, `python_version`, `process_name` — latest-session-only, same source as the `/v1/fleet` projection) |
| `GET` | `/v1/agents/:id/summary` | Per-agent activity summary (totals + per-bucket series) over a 1h/24h/7d/30d window. Powers the per-agent landing page. |
| `GET` | `/v1/events` | Bulk events query: `from` (required), `to` (omitted, no upper bound on `occurred_at`, the client's timestamp, which ingestion accepts up to five minutes ahead of its clock), `flavor`, `event_type`, `session_id`, `agent_id`, `model`, payload-JSONB facet filters (`error_type`, `close_reason`, `estimated_via`, `matched_entry_id`, `originating_call_context`, `mcp_server`, `terminal`), `framework` (`agent_id` + `framework` resolve via a `sessions` subquery), session-context facet filters (`os`, `arch`, `host`, `user`, `git_branch`, `git_repo`, `orchestration`, `python_version`, `process_name` — resolved via the sessions JOIN against partial expression indexes on `sessions((context->>'<key>'))` from migration 000024), `q` (free-text ILIKE search across event_type / model / session_id / agent_name / framework), `before` + optional `before_id` (keyset cursor on `occurred_at`, then `id`) + `order` (`asc`/`desc`) for newest-first drawer pagination, `facets=true` to return per-dimension chip counts over the filtered set instead of the event list, `limit` (default 500, max 2000), `offset` (max 100000) |
| `GET` | `/v1/events/:id/content` | Event prompt content; 404 when capture was off for the session |
| `GET` | `/v1/policy` | Sensor preflight: returns the policy applicable to a flavor + session_id |
| `GET` | `/v1/policies` | List all token policies (org + flavor + session scopes) |
| `POST` | `/v1/policies` | Create a policy, or replace the one with the same scope and scope value; validates `warn < degrade < block`, and that `degrade_to` is one of the models `GET /v1/pricing/models` lists (always checked, even when re-sending a policy's stored value) |
| `PUT` | `/v1/policies/:id` | Update a policy; the same validation as `POST`, except that an unchanged `degrade_to` is not re-checked |
| `DELETE` | `/v1/policies/:id` | Delete a policy |
| `GET` | `/v1/pricing/models` | The models a policy may degrade to: `model_pricing` rows priced on the provider's own API (the sensor passes `degrade_to` to the SDK as the model id, so a cloud-platform-only id would fail), with an output price (embedding models have none), that are not an operator alias from `pricing.yaml` or an `ft:<base>` fine-tune price key (a callable fine-tune id adds an org and suffix), and whose `deprecated_on` date (from the catalogue or a `pricing.yaml` override) has not passed; `[{model_id, provider}]` ordered by provider then model id |
| `POST` | `/v1/directives` | Create a `shutdown` (one session, or every live run of an agent with `agent_id`), a `shutdown_flavor`, or a `custom` directive (one session, a flavor, or an agent's runs); `X-Directive-Count` carries how many rows were created |
| `GET` | `/v1/directives/custom` | List registered custom directives; optional `flavor` filter |
| `DELETE` | `/v1/directives/custom` | Delete custom directives by name prefix (`name_prefix` query param). Registered only when `ENVIRONMENT=dev`; the route does not exist otherwise |
| `POST` | `/v1/directives/sync` | Sensor uploads its registered fingerprints; returns unknowns |
| `POST` | `/v1/directives/register` | Sensor uploads full directive schemas for unknown fingerprints |
| `GET` | `/v1/analytics` | Flexible breakdown query; see Analytics |
| `GET` | `/v1/search` | Cross-entity search (agents, sessions, events) |
| `GET` | `/v1/access-tokens` | List access tokens (no hash, no salt, no plaintext) |
| `POST` | `/v1/access-tokens` | Mint a new token; raw token returned ONCE |
| `DELETE` | `/v1/access-tokens/:id` | Revoke (dev-seed row protected: 403) |
| `PATCH` | `/v1/access-tokens/:id` | Rename (dev-seed row protected: 403) |
| `POST` | `/v1/admin/reconcile-agents` | Recompute `agents.total_sessions`/`total_tokens`/`first_seen_at`/`last_seen_at` from sessions ground truth |
| `GET` | `/v1/mcp-policies/global` | Global MCP protection policy + entries |
| `GET` | `/v1/mcp-policies/:flavor` | Flavor MCP protection policy + entries |
| `GET` | `/v1/mcp-policies/resolve` | Sensor / plugin preflight resolve; query params `flavor`, `server_url`, `server_name` |
| `POST` | `/v1/mcp-policies/:flavor` | Create a flavor MCP policy |
| `PUT` | `/v1/mcp-policies/global` | Replace global MCP policy state |
| `PUT` | `/v1/mcp-policies/:flavor` | Replace flavor MCP policy state |
| `DELETE` | `/v1/mcp-policies/:flavor` | Delete a flavor MCP policy (audit-log row preserved) |
| `GET` | `/v1/mcp-policies/:flavor/audit-log` | Mutation audit log |
| `GET` | `/v1/mcp-policies/global/audit-log` | Global mutation audit log |
| `GET` | `/v1/mcp-policies/:flavor/metrics` | Aggregated `policy_mcp_warn` / `policy_mcp_block` events; `?period=24h\|7d\|30d` |
| `GET` | `/v1/mcp-policies/templates` | List shipped templates |
| `POST` | `/v1/mcp-policies/:flavor/apply_template` | Apply a named template to a flavor policy |
| `WS` | `/v1/stream` | Real-time WebSocket fleet updates |
| `GET` | `/health` | Liveness check |
| `GET` | `/docs/` | Swagger UI |

### Authentication

Every authenticated request carries a Bearer token. Tokens are opaque
strings minted by the platform; they carry no claims and are validated by
hash lookup against `access_tokens`.

#### Token format

```
ftd_<32 random hex chars>
```

- `ftd_` prefix identifies a Flightdeck-issued production token.
- 32 random hex chars = 16 bytes of entropy from `crypto/rand`.
- The first 8 characters (e.g. `ftd_a3f8`) are stored in the `prefix`
  column so the auth middleware narrows the candidate row set before
  iterating per-row salted hashes.

`tok_dev` is a fixed dev-seed token. Accepted only when the service reads
`ENVIRONMENT=dev` from the environment at validation time; every other
context returns 401 with:

```json
{"error": "tok_dev is only valid in development mode. Create a production token in the Settings page."}
```

#### Validation algorithm

1. Extract the Bearer token from the `Authorization` header.
2. If the raw token equals `tok_dev`:
   - `ENVIRONMENT=dev`: accept and return the seeded `Development Token`
     row's `(id, name)`.
   - Otherwise: 401.
3. Else if the raw token begins with `ftd_`:
   - Take the first 8 chars as `prefix` and fetch every row from
     `access_tokens` with a matching prefix.
   - For each candidate: compute `SHA256(row.salt || raw_token)` and
     compare (constant-time) to `row.token_hash`. On match, stamp
     `last_used_at` and return `(id, name)`.
   - No match: 401.
4. Any other format: 401.

The resolved `(token_id, token_name)` is attached to the request context.
For `session_start` events the ingestion API injects those values into the
NATS payload so the worker's `UpsertSession` persists them onto the new
session row. Subsequent events on the same session do not rewrite the
token fields — a session belongs to whichever token opened it.

#### Validation cache and revocation

Both the ingestion API and the query API keep an in-memory cache of
successful validations (keyed by the SHA-256 of the raw token, never the
plaintext; at most 1000 entries, each trusted for 60 seconds) so repeat
clients do not hit Postgres on every request. Unknown tokens are never
cached, so a newly created token works at once.

Revocation reaches every replica of both services as soon as the delete
commits. On Postgres, deleting an `access_tokens` row, through
`DELETE /v1/access-tokens/:id` or directly in SQL, fires the
`access_tokens_notify_revoked` trigger, which sends the token id on the
`flightdeck_access_token_revoked` NOTIFY channel when the transaction
commits; on SQLite the store that deletes the row publishes the id on
the storage Bus after commit. The ingestion API subscribes to that
channel on the storage Bus (`storage.Bus.Subscribe`, one dedicated
LISTEN connection on Postgres, outside its request pool); the query API
holds a LISTEN connection of its own. Each drops the cached validations
for that id when the notification arrives. The SQLite bus is in-process,
so a token deleted by a process other than the one serving the request
is refused only once its cached validation expires, after at most 60
seconds. Every invalidation also bumps a
generation counter; a validation that was already querying the database
when the revocation arrived caches its result only if the counter has not
moved, so a lookup that read the row just before the delete cannot put
the revoked token back into the cache. A NOTIFY is not queued for a
listener that is not connected, so each process clears its whole cache
every time its LISTEN connection is (re)established; a revocation that
happens while a listener is down never outlives the reconnect. The
60-second limit is the last backstop: if a process cannot listen, or its
listen connection dies without the process noticing (a half-open TCP
connection is only detected by keepalive, after about two and a half
minutes), a revoked token it has cached is accepted for at most 60
seconds.

#### Endpoint auth scope

Every `/v1/*` route on the Query API is wrapped in the auth middleware,
except `/health` and `/docs/`. The WebSocket `/v1/stream`
accepts the token via `?token=` because browsers cannot set
`Authorization` on the upgrade handshake.

The Ingestion API authenticates `POST /v1/events` and `POST /v1/heartbeat`
with the same middleware against the same `access_tokens` row.

`/v1/admin/*` endpoints share the same Bearer-token auth. They are
intended to be exposed only on internal interfaces (firewall / ingress
level) — production deployments protect them at the network boundary
rather than via token scopes. Single-tier auth: any valid bearer token
has full access to every endpoint, including `/v1/admin/*` and the
MCP protection policy mutations.

#### Dashboard token configuration

The dashboard's bearer token is fetched at runtime from
`/runtime-config.json` rather than baked into the SPA bundle. The
file lives at `dashboard/public/runtime-config.json` in source and
ships with the dev token (`tok_dev`). Vite copies `public/*` to
`dist/*` at build time so the same path resolves in dev (vite dev
serves it directly) and prod (the dashboard image's nginx serves it
from `/usr/share/nginx/html/`). Production deployers replace the
file via volume mount over
`/usr/share/nginx/html/runtime-config.json` — token rotation is a
single-file edit + `nginx -s reload`, no rebuild.

Bootstrap order (`dashboard/src/lib/runtime-config.ts`):

1. `main.tsx` awaits `ensureAccessToken()` before mounting React.
2. `ensureAccessToken()` reads `localStorage.flightdeck-access-token`.
   If a token is set, that value wins (operator self-serve override).
3. Otherwise, fetch `/runtime-config.json` (with `cache: no-store`),
   validate the `{ access_token: string }` shape, write to
   localStorage, return.
4. Bootstrap failure (network error, non-2xx, malformed JSON) renders
   an actionable error message inline on `#root` rather than an
   empty page.

The dashboard image's `nginx.conf` emits the strict cache-discipline
header pack on `/runtime-config.json` so no intermediate proxy holds
a stale token after rotation:

- `Cache-Control: no-store, no-cache, must-revalidate` — HTTP/1.1
  caches discard the response after delivery and refuse to serve any
  stale entry.
- `Pragma: no-cache` — HTTP/1.0 intermediaries that ignore
  Cache-Control fall back to this header.
- `Expires: 0` — HTTP/1.0 caches that respect Expires see the
  response as already-stale.

The headers carry the `always` parameter so a 4xx / 5xx response
(e.g. a misconfigured prod mount returning 404) still ships the same
discipline rather than leaving a cacheable error in flight. `expires
off` disables nginx's automatic Cache-Control / Expires emission so
the response carries our explicit values only — no duplicate headers.

Dev-vs-prod nuance: in dev, vite serves `dashboard/public/` directly
and emits its own default `Cache-Control: no-cache` header. The
strict triplet is a production-only discipline served by the
dashboard image's nginx. The dev stack uses `tok_dev` regardless, so
the looser dev header is acceptable; production deployers always run
the multi-stage image where the strict triplet applies.

### Real-time push: NOTIFY → Hub → WebSocket

Changes reach the dashboard through a four-step LISTEN / NOTIFY chain,
fully decoupled from REST paths.

1. **Worker write.** On each event,
   `workers/internal/writer/postgres.go::InsertEvent` INSERTs into `events`
   and RETURNS the generated UUID primary key. A session state change
   (the reconciler, the reaper, a parent revived by its child) updates
   the `sessions` row; the reaper also inserts its synthetic
   `session_end`.
2. **NOTIFY publish.** The worker sends a Postgres NOTIFY on the
   `flightdeck_fleet` channel with payload `{session_id, event_type,
   event_id}`, one per changed session (see Worker / Event Processing →
   Notify for who sends what, and when).
3. **Hub LISTEN + single-row fetch.** The API hub
   (`api/internal/ws/hub.go::listenOnce`) holds one pgx connection
   permanently subscribed to `flightdeck_fleet`. On each notification it
   parses the payload, fetches the session row via
   `store.GetSession(session_id)`, and, when `event_id` is set, fetches
   that event via `store.GetEvent(event_id)` — a PK lookup on `events.id`.
   When the session has an agent, it also reads the agent's rolled-up
   state via `store.GetAgentState(agent_id)`, the same rollup the agent
   endpoints return.
4. **WebSocket broadcast.** The hub wraps the session (+ event) into a
   `fleetUpdate` envelope `{type, session, last_event?, agent_state?}`
   and broadcasts it to every WebSocket client connected to
   `/api/v1/stream`. The envelope's `type` is `session_start` or
   `session_end` for those event types and `session_update` otherwise.
   A state-only change (no `event_id`) broadcasts as `session_update`
   with the fresh session row and no `last_event`. `agent_state` is the
   agent's state at broadcast time, omitted when the session has no
   agent or the read fails; the dashboard takes the agent's badge from
   it, since a page holds only some of an agent's runs.

Per NOTIFY the hub makes three indexed reads, none of which scans a
session's events or an agent's run history: the session by primary key
(with its effective-policy lookups), the event by primary key on
`events.id`, and the agent rollup. The rollup's "any run active" check
is one probe of `sessions_active_by_agent_idx`, a partial index that
holds only active runs and so stays small, and its "newest run" read
takes the first entry of the agent's `(agent_id, started_at DESC)`
index. When `GetSession` returns an error (e.g. session deleted
between notify and read), the hub logs a warning and continues rather
than exiting the listener loop; a failed agent-state read only drops
`agent_state`.

The session drawer renders events via `GET /v1/sessions/:id`, which calls
`GetSessionEvents` once on drawer-open and returns the list ordered by
`occurred_at`, then `id`. No race window: the query runs once after the
user has already scrolled to the session, not once per incoming event.

#### Wire contract

`workers/internal/writer/notify.go::fleetNotifyPayload` is the
authoritative definition. The hub's `notifyPayload` struct in
`api/internal/ws/hub.go` must stay field-compatible. Adding fields is
backward compatible (`json.Unmarshal` silently drops extras); removing or
renaming fields is not. `event_type` and `event_id` are empty strings in
a state-only change, which the hub reads as "the session changed, no
event to fetch".

The WebSocket envelope is the hub's `fleetUpdate` struct, read by
`dashboard/src/store/fleet.ts` through the `FleetUpdate` type; the same
rule applies to it: `agent_state` is optional on the wire, and a client
that does not know it ignores it.

### Analytics endpoint

`GET /v1/analytics` accepts:

- `metric` (required): one of `tokens`, `sessions`, `latency_avg`,
  `latency_p50`, `latency_p95`, `policy_events`, `estimated_cost`,
  `parent_token_sum`, `child_token_sum`, `child_count`,
  `parent_to_first_child_latency_ms`. The four sub-agent-aware
  metrics operate over the parent / child relationship:
  `parent_token_sum` rolls up token usage across a parent session
  AND all its descendants via recursive CTE on `parent_session_id`;
  `child_token_sum` rolls up descendants only; `child_count` reports
  the number of distinct child sessions per parent;
  `parent_to_first_child_latency_ms` reports
  `MIN(child.started_at) - parent.started_at`.
- `group_by` (optional): one or two dimensions, comma-separated. The
  first dimension is the **primary** axis (outer GROUP BY); when a
  second dimension is supplied it is the **secondary** axis (inner
  GROUP BY, returned as nested buckets so a chart can render
  per-primary stacked segments). Single-dim queries (no comma)
  preserve the single-axis wire shape exactly; the per-series payload
  contains a flat `data: [{date,value}]` array. Two-dim queries
  return per-series payloads of shape `data: [{date, breakdown:
  [{key, value}]}]` where `key` is the secondary-axis bucket value.
  Allowed dimension values (in either position): `flavor`, `model`,
  `framework`, `host`, `agent_type`, `team`, `provider`,
  `agent_role`, `parent_session_id`. `provider` reads
  `events.provider` and, for a row whose `provider` is empty, falls
  back to a SQL CASE over the model id's prefix. `agent_role` groups
  by the framework-supplied role string; sessions with null
  `agent_role` bucket as `(root)`. `parent_session_id`
  groups by parent session UUID; sessions without a parent (root
  sessions and direct-SDK sessions) bucket as `(root)`. The two-dim
  shape is supported for any pair where both dimensions resolve to
  the standard query path; the canonical pair is
  `parent_session_id,agent_role` driving the dashboard's per-parent
  stacked breakdown chart.
- `range` (optional): `7d`, `30d`, `90d`, or `custom`.
- `from` / `to` (ISO 8601, used when `range=custom`).
- `granularity`: `hour`, `day`, `week`.
- `filter_flavor`, `filter_model`, `filter_agent_type`, `filter_provider`
  (optional).
- `filter_agent_id` (optional, UUID). Scopes the analytics window to
  events from sessions owned by a single agent. Composes with the
  other filters via AND. Joins `sessions` when the metric's base
  table is events. Used by the per-agent landing page.
- `filter_parent_session_id`, `filter_is_sub_agent`,
  `filter_has_sub_agents` (optional). Filter analytics scope to
  the children of a specific parent session, to children only, or to
  parents only.

Returns a series array with per-dimension totals and time-series data.
GROUP BY queries are built dynamically with parameterized inputs; no raw
string interpolation. The `tokens` metric sums `tokens_total` over
`post_call` and `embeddings` events and over `llm_error` events whose
failed stream was billed for tokens (see `llm_error`): the provider-billed
tokens the session and agent totals and `estimated_cost` count, so every
server-side total of tokens agrees. The latency metrics (`latency_avg`, `latency_p50`,
`latency_p95`) aggregate `post_call` events only; the `latency_ms` a
plugin `tool_call` carries (the tool's own duration) is not included.

Dimensions that live on `sessions` (`framework`, `host`, `agent_type`,
`agent_role`) are accessed via a JOIN against `sessions` when the
metric's base table is `events`, so event-based metrics can group by
session-level attributes. `framework` groups by the label of each
entry of the session's `context.frameworks[]`, the part before the `/`:
an entry is versioned (`langchain/0.3.27`, `pydantic_ai/2.64.0`) or bare
(a framework detected after `init`, or one reported without a
version), and both forms of one framework are one series, whatever the
version. A session counts once under each label it lists, so one with
several frameworks counts under each and one with none under
`unknown`; the bare `sessions.framework` column is not read. The `framework` filter of
`GET /v1/sessions` and `GET /v1/events` matches either.

Latency aggregates use `events.latency_ms` and fall back to 0 via
`COALESCE` when no events fall in the bucket.

`parent_token_sum` uses a recursive CTE walking
`parent_session_id` to aggregate the parent and every descendant in
the same scope. The recursion is bounded by the actual tree depth
(typically 1-2 levels in practice); query cost grows roughly with
the size of the parent's descendant set. The traversal is accurate
but unindexed at the deep-recursion frontier, so analytics over
large historical windows on parents with many descendants pay a
seq-scan-like cost on the recursive step.

### Per-agent activity summary

`GET /v1/agents/{agent_id}/summary` returns one agent's activity
totals plus a per-bucket time series, scoped to a window. Powers
the per-agent landing page. Query params:

- `period` (optional): `1h`, `24h`, `7d` (default), `30d`.
- `bucket` (optional): `hour`, `day`, `week`. Derived from
  `period` when omitted (1h / 24h → `hour`; 7d / 30d → `day`).

Returns:

- `totals.tokens`: `SUM(events.tokens_total)` over `post_call` and
  `embeddings` events and the `llm_error` events of failed streams that
  carry tokens, as the analytics `tokens` metric counts them.
- `totals.errors`: `COUNT(*)` of `llm_error` events and of
  `tool_call` events whose `payload.error` is an object (a failed
  tool call; see Tool calls and failures). Policy events are
  enforcement decisions, not errors, and are not counted here; MCP
  failures have their own `mcp_error_types[]` indicator.
- `totals.sessions`: `COUNT(DISTINCT session_id)` across events
  in the window. Every run with any activity in the window
  counts, regardless of when it started.
- `totals.cost_usd`: metered cost of the window's `post_call` and
  `embeddings` events (see Cost estimation), with
  `totals.partial_estimate`, `totals.models_unpriced` and
  `totals.billing_modes` as in the analytics response, so the page
  can render the subscription and partial states.
- `totals.latency_p50_ms` / `totals.latency_p95_ms`:
  `PERCENTILE_CONT` over `events.latency_ms` filtered to
  `event_type='post_call'`, matching the analytics endpoint
  convention.
- `series[]`: per-bucket rows with `ts` (`date_trunc(bucket,
  occurred_at)`), `tokens`, `errors`, `sessions`, `cost_usd`,
  `latency_p95_ms` (p50 omitted at series granularity —
  totals carry it for context).

Handler returns 400 on a malformed UUID, an unknown `period`,
or an unknown `bucket`; 404 when no agent matches the id; 200
with zero totals + empty series for an agent whose window
contained no events.

### Cost estimation

Cost answers one question: what did this LLM call cost the operator?
The answer depends on how the call was paid for, so every LLM event
carries a **billing mode** and cost is only summed for calls that are
paid per token.

#### Billing modes

| `billing_mode` | Meaning | Counted in `estimated_cost` |
|---|---|---|
| `metered` | Paid per token: a provider API key, a cloud platform account (Bedrock, Vertex AI, Foundry, Azure OpenAI) or a gateway account (OpenRouter, a litellm proxy) | Yes |
| `subscription` | Covered by a flat-rate plan: a Claude Pro, Max, Team or Enterprise seat signed in to Claude Code, or an equivalent plan of another coding agent | No |
| `local` | A self-hosted model with no per-token charge (Ollama, vLLM, LM Studio and similar servers on the operator's own hardware) | No (costs $0, and is not reported as unpriced) |

The sensor stamps `metered` on every call by default and `local` when the
client's base URL is a loopback address (`localhost`, `127.0.0.0/8`,
`::1`). A model server elsewhere on a private network is not assumed to
be free, since a gateway or a metered proxy often sits on such an
address; the override below covers a self-hosted server there. The Claude Code
plugin determines the mode once at `SessionStart`, and a subagent's
session takes the mode of the session that spawned it, since both run
in the same Claude Code process on the same login. Bedrock, Vertex AI
and Foundry sessions (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`CLAUDE_CODE_USE_FOUNDRY`) and API-key logins are `metered`; a
`claude.ai` or `oauth_token` login is `subscription`. The login comes
from `claude auth status` (`api_key`, `api_key_helper` and `third_party`
are metered methods, and its `apiProvider` names a cloud provider).

An `ANTHROPIC_API_KEY` in the environment is the login only when
Claude Code uses it, which depends on how the session runs. A
non-interactive run (`claude -p` and the Agent SDK, whose
`CLAUDE_CODE_ENTRYPOINT` starts with `sdk`) and a bare one
(`CLAUDE_CODE_SIMPLE`) use any key they find. An interactive session
(the CLI or the VS Code extension) uses it only once the user has
approved that key: Claude Code asks, and records the answer by the
key's last 20 characters under `customApiKeyResponses` in
`~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set).
`claude auth status` reports `api_key` for any key in its environment,
so for a key the session does not use the plugin runs the command
without it, and the command reports the login the session does run
on, such as the user's `claude.ai` plan. Where the command is
unavailable, a key the session uses or an `ANTHROPIC_AUTH_TOKEN` counts
as an API-key login, and anything else as a subscription. A command
that fails is retried by one later hook before that fallback stands
for the session. A session with
`FLIGHTDECK_BILLING_MODE` set does not run the command, so its platform
comes from the provider variables alone. Both clients
accept `FLIGHTDECK_BILLING_MODE` (`metered`, `subscription`, `local`)
to override the detected value, for the cases detection cannot see.

The main such case is a subscription's **extra usage**: once a Claude
plan's included usage runs out, Claude Code continues at API rates,
billed separately. Claude Code exposes no per-request signal for this,
so those calls stay `subscription` and are not counted. An organisation
whose Claude Code usage is billed per token (usage-based Enterprise
billing, or a team that routinely runs on extra usage) sets
`FLIGHTDECK_BILLING_MODE=metered` in the plugin's environment, and its
sessions are then priced like any API-key session.

An event that arrives without a `billing_mode` (a client that does not
send one) is stored with the `billing_mode` default of the event's
`client_type` (see Client type registry): `subscription` for Claude
Code, Codex CLI, GitHub Copilot and Cursor, `metered` for every other
type; the worker fills it in when it writes the row. The cost query
applies the same rule to a row whose `billing_mode` is empty, so a row
the backfill (see Model ids) has not reached yet is counted the same
way.

The sensor stamps the same `billing_mode` on the `llm_error` of a
stream that fails (see `llm_error`) as on its calls: the configured
mode, else `local` for a loopback client and `metered` otherwise, so a
`local` or `subscription` session keeps its failed streams out of
`estimated_cost`. An `llm_error` that carries a failed stream's tokens
without a billing mode (sent by a sensor that predates the field) gets
the billing mode of the session's latest `post_call`, preferring one of
the same model, else its client type's default. Such an event names no
platform, so it is priced from the `direct` price list, and its input
tokens, which carry no cache split, at the input rate.

#### Where a call's cost comes from

For a `metered` call, Flightdeck uses the first of these that exists:

1. **Reported cost** (`cost_reported`, `cost_source`). Some gateways
   return the billed amount with the response (OpenRouter's
   `usage.cost`, `cost_source=provider`); some clients compute their
   own (litellm's `response_cost`, a coding agent's own cost figure,
   `cost_source=agent`). A client that reports a cost applies pricing
   Flightdeck cannot see (negotiated rates, a custom price table), so
   a reported cost is preferred over Flightdeck's own estimate.
2. **Estimate** from the pricing table and the call's token counts,
   below.
3. **Unpriced**: the model has no price and no cost was reported. The
   call contributes $0, and the response names the model (see
   `models_unpriced` below) instead of presenting $0 as a price.

#### Model ids

A model id reaches Flightdeck in many spellings: a provider's API id
(`claude-sonnet-4-5`), a dated snapshot (`claude-sonnet-4-5-20250929`,
`gpt-5.1-2025-11-13`), a Vertex AI id (`claude-sonnet-4-5@20250929`), a
Bedrock id or inference profile (`anthropic.claude-sonnet-4-5-20250929-v1:0`,
`us.anthropic.claude-...`), a gateway-prefixed id (`openrouter/anthropic/claude-sonnet-4.5`,
`anthropic/claude-sonnet-4-5`, `bedrock/...`), a dotted version
(`claude-sonnet-4.5`), an Azure deployment name, or a local tag
(`llama3.1:8b`).

The worker canonicalises every LLM event's model id once, when it writes
the row, with a pure function in the workers module, and stores:

- `model_requested`: the id the caller asked for, verbatim. For an
  event that sends only the legacy `model` field, the worker stores
  that raw value here before canonicalising it.
- `model_served`: the id the provider's response named, verbatim
  (`response.model`); it differs from the request on a server-side
  fallback or alias resolution.
- `model`: the canonical id, derived from `model_served`, else
  `model_requested`, else the legacy `model` field. This is the value
  the `model` dimension groups by and the pricing table is keyed by.
  Display surfaces show the canonical id and keep the verbatim ids in
  the event detail.

Canonicalisation is a fixed set of string rules with no lookup: it
strips gateway and platform prefixes, Bedrock region prefixes (`us.`,
`eu.`, `apac.`, `global.`) and the `anthropic.` vendor prefix with its
`-v1:0` suffix, the Vertex `@date` suffix and OpenRouter's `:free` /
`:beta` suffixes, and turns dotted Claude versions into the API's
hyphenated form. A dated snapshot keeps its date. An OpenAI fine-tune
(`ft:<base>:<org>:...`) becomes `ft:` plus its canonical base model, the
form the catalogue prices it under, and a Hugging Face Hub model a local
server pulled (`hf.co/<org>/<model>:<quant>`) is kept whole, host and
organisation included.
Stripping a Bedrock
region prefix records its scope first: `global.` is
`inference_scope=global`, any other region prefix `regional`. An id the
rules do not recognise is stored as given (lower-cased, whitespace
trimmed). The rules are pinned by a table of test vectors.

Rows stored with a raw id are rewritten by a backfill the worker runs in
the background. Because the write path always fills `model_requested`
for an LLM event that names a model, a row with a `model` and an empty
`model_requested` is one the write path never canonicalised. The
backfill takes batches of those rows (`FOR UPDATE SKIP LOCKED`, so
several workers share the work, and a failed batch is retried with
backoff), moves the raw id into
`model_requested`, stores the canonical id in `model`, copies
`provider_metadata.platform` from the payload into `platform`, adds the
`inference_scope` a Bedrock region prefix implies, and fills `provider`
and `billing_mode` by the rules here. The sessions those rows belong to
get the canonical id in `sessions.model` while it still holds the raw
one. A partial index on the rows still to do keeps each batch from
scanning the table; it is empty once the backfill has run. It
is idempotent and resumes where it stopped after a restart.

Two mappings depend on configuration and so are applied when cost is
computed rather than when the row is written, which means they reach
past events too:

- **Aliases.** Operators map deployment names (Azure, a gateway's
  custom routes) to a model id in the `aliases` section of
  `pricing.yaml`. Each alias key is normalised like an event's id
  (canonicalised, lower-cased, trimmed) and becomes a `model_pricing`
  row with the target model's rates, under the platform family the
  alias names (`platform`, default `direct`). An alias whose key
  collides with a catalogue id fails the load with an error naming
  it.
- **Undated fallback.** A dated id with no price of its own (a
  snapshot the catalogue does not list) is priced as its undated id.

#### Provider and platform

- `provider` (column) is the model's vendor: `anthropic`, `openai`,
  `google`, `xai`, `mistral`, `meta`, `deepseek` or `other`. The sensor
  stamps it only when the endpoint settles it: the Anthropic SDK's
  clients (`anthropic`), and the OpenAI SDK against the `openai` or
  `azure` platform (`openai`). An OpenAI-compatible client pointed
  anywhere else (xAI, DeepSeek, OpenRouter, a local server) leaves it
  out. The plugin stamps `anthropic`. For an event that carries none,
  the worker derives it from the canonical model id, and the analytics
  `provider` dimension applies the same model-prefix rule to a row whose
  `provider` is empty.
- `platform` is the endpoint that served the call: `anthropic`,
  `openai`, `bedrock`, `bedrock-mantle`, `aws`, `vertex`, `google-cloud`,
  `foundry`, `azure`, the bare host of a gateway or local server, or
  `invalid-host`. Clients send it as `provider_metadata.platform` (see
  `post_call`; the plugin sets `bedrock`, `vertex` or `foundry` from the
  Claude Code provider variables, else `anthropic`, or the host of
  `ANTHROPIC_BASE_URL` when that names a gateway). The worker copies it
  into the `events.platform` column, which the cost query groups by. It
  selects which price list applies and is shown in the event detail. It
  is not an analytics dimension.

#### Pricing table

Prices come from two layers, merged at API startup into the
`model_pricing` table:

1. **Catalogue**: a pruned copy of litellm's
   `model_prices_and_context_window.json` (the chat, responses and
   embedding modes of the providers above), vendored in the api module
   and embedded in the binary. `make pricing-refresh` regenerates it
   and the change ships as an ordinary pull request. The API makes no
   outbound request for prices.
2. **Overrides**: `pricing.yaml` (located through
   `FLIGHTDECK_PRICING_PATH`, then `/etc/flightdeck/`, then the working
   directory). An entry there replaces the catalogue's entry for the
   same model and platform field by field, so an operator with
   negotiated prices states only the rates that differ, or adds a model
   the catalogue does not list (retired models litellm dropped, which
   carry their `deprecated_on` retirement date so a token policy cannot
   degrade to them). An
   override of a base rate drops the model's context tier, so calls
   above the threshold are priced at the override's rates. It also
   holds the `aliases` map and the multipliers below. A file with an
   invalid entry is ignored as a whole, with a warning naming the entry,
   and the catalogue alone prices calls.

The catalogue keeps chat, responses and embedding models of the
providers above on their own APIs and on Bedrock, Vertex AI, Azure
OpenAI and Foundry; each litellm key is canonicalised with the same
rules as event model ids (the API keeps a twin of the worker's rules,
both pinned by one test-vector file), and when several keys reach the
same row (a Bedrock model and its regional profiles, an Azure model and
its `eu` / `us` data-zone keys) the key that names no region wins, then
a `global` one, then a regional one.

Each row is keyed by canonical model id and platform family (`direct`
for the provider's own API, `bedrock`, `vertex`, `foundry`, `azure`) and
holds, in USD per million tokens: `input`, `output`, `cache_read`,
`cache_write_5m`, `cache_write_1h`, and optionally `reasoning` (when
reasoning tokens are priced apart from output), a context tier
(`tier_threshold_tokens` with the five rates that apply above it),
`priority_multiplier` (the ratio of the catalogue's priority-tier rate
to the standard rate) and `fast_multiplier` (Anthropic's fast-mode price
for the model). A
call on a platform with no row of its own is priced from the `direct`
row. Platform labels map to a family: `bedrock` and `bedrock-mantle` to
`bedrock`, `vertex` to `vertex`, `foundry` to `foundry`, `azure` to
`azure`; `anthropic`, `openai`, `aws` (Claude Platform on AWS) and
`google-cloud` (Claude Platform on Google Cloud), which bill at the
provider's own prices, and every gateway host and `invalid-host` price
from `direct`. The load replaces the table's contents in one transaction and is
skipped when the merged content's hash matches what the table holds, so
several API replicas starting together write it at most once each.

#### Formula

Per `post_call` and `embeddings` event, and per `llm_error` event whose
failed stream was billed for tokens, with `t_in` the input tokens
(cache reads and writes included, as the providers report them) and
`t_cw1h` the one-hour subset of the cache writes:

```
t_uncached = GREATEST(t_in - t_cache_read - t_cache_creation, 0)
t_cw5m     = GREATEST(t_cache_creation - t_cw1h, 0)
t_plain    = GREATEST(t_out - t_reasoning, 0)
rates      = tier rates when t_in > tier_threshold_tokens, else base rates

cost = ( t_uncached     * input
       + t_cache_read   * cache_read
       + t_cw5m         * cache_write_5m
       + t_cw1h         * cache_write_1h
       + t_plain        * output
       + t_reasoning    * COALESCE(reasoning, output)
       ) / 1e6
       * multiplier(service_tier) * multiplier(speed)
       * multiplier(inference_geo) * multiplier(inference_scope)
       + server-tool fees
```

Ingestion rejects counts that break the subset rules (below), and the
`GREATEST` clamps keep a row stored before that check from producing a
negative term.

Reasoning tokens are a subset of `tokens_output` on every provider. A
client reporting a provider that counts reasoning apart from its output
(Gemini's thinking tokens) must add it into `tokens_output` so the
subset rule holds; litellm does so before the sensor reads its usage,
and the sensor has no `google-genai` path of its own (see Sensor >
Framework support). A provider that reports no
cache or reasoning split leaves those terms at 0 and the formula
collapses to `t_in * input + t_out * output`.

The multipliers and server-tool fees live in `pricing.yaml`, so a
provider's change is a data edit. A missing or unrecognised value
multiplies by 1.

- `service_tier`: `batch` and `flex` 0.5; `priority` at the model's
  `priority_multiplier` (1 when the catalogue has no priority rate).
- `speed`: `fast` at the model's `fast_multiplier` (1 when it has
  none).
- `inference_geo`: 1.1 for Anthropic's US-only inference.
- `inference_scope`: 1.1 for every call on a `regional` cloud endpoint
  (a Bedrock regional or multi-region inference profile, a Vertex AI
  regional endpoint); `global` endpoints 1. The premium is not limited
  to the models whose cloud pricing carries it, so a call to an older
  Claude model on a regional endpoint is priced 10% high; an operator
  who needs it exact sets `inference_scope.regional: 1` in
  `pricing.yaml`.
- Server tools: per-request fees, such as web search per 1,000
  searches from `server_tool_use.web_search_requests`.

The cost is computed at query time rather than stored per event, so a
price correction, a new override or a new alias applies to past events
as well as new ones. Each LLM event is joined to its `model_pricing`
row (exact id, then the undated id; the platform family's row, then
`direct`) through a lateral lookup that Postgres memoises per distinct
model and platform, and the formula is summed over the events. The
multipliers and server-tool fees from `pricing.yaml` are written into
the query as constants (numbers and quoted literals from the API's own
configuration, never request input). The `models_unpriced` probe
collects the window's distinct model and platform pairs first and
checks only those against the table. The API's database connections
run with Postgres's JIT disabled: compiling the long cost expression
costs more than it saves for interactive queries. An estimated-cost
query over 100,000 LLM calls in its window answers in about half a
second.

Every response that carries a cost also says what the number leaves
out, with three keys: `partial_estimate` is true when `models_unpriced`
(the canonical ids of metered calls in the window that had neither a
price nor a reported cost) is non-empty, and `billing_modes` lists every
billing mode the window's calls used, so a surface can say that
subscription usage is not included, or show `Subscription` where nothing
was metered. `GET /v1/analytics` with `metric=estimated_cost` returns
them at the top level of the response, beside `series`, computed over
the whole window without the chart's filters, so a filtered chart can
name a model or a mode outside its filter; the per-agent summary
returns them inside `totals`, scoped to the agent.

### Search

`GET /v1/search?q=term` returns up to 5 hits per entity, grouped by
agent / session / event. Implemented as three parallel ranked
queries via `errgroup` so the slowest field doesn't gate the
others. Powers the Cmd/Ctrl+K command palette.

Matched columns per entity:

- **Agents** — `agent_name`, `hostname`, `user_name`. Sensor-keyed
  agents already embed `user@hostname` in `agent_name`, but seeded /
  test / cloud agents often don't, so both columns are searched
  independently. Each agent result also carries `client_type` and a
  LATERAL-derived `state` (via the shared `agentStateRollupSQL`),
  so the palette's AgentRow renders the same identity primitives
  as `/agents` (ClaudeCodeLogo, ClientTypePill, state chip) and
  the two surfaces agree on every agent's rolled-up state. It
  carries the latest session's `telemetry` as the agent rows do,
  for the source pill (see Dashboard > Session source).
- **Sessions** — `session_id`, `flavor`, `host`, `model`, plus
  `context->>'hostname'`, `context->>'os'`, `context->>'git_branch'`,
  `context->>'python_version'`, and `(context->'frameworks')::text`.
  Each session result carries its `context` and `client_type`, so the
  palette names the client beside the session's source.
- **Events** — `event_type`, `tool_name`, `model`, plus a curated
  English-term-to-event_types map (`search.go::curatedEventTypeTerms`):
  `llm` → pre_call / post_call / llm_error; `tool` → tool_call /
  mcp_tool_list / mcp_tool_call; `policy` → all five policy_* event
  types; `error` → llm_error / policy_block / policy_mcp_block;
  `embedding` → embeddings; `mcp` → every mcp_* + policy_mcp_* +
  mcp_server_* event; `session` → session_start / session_end;
  `block` → policy_block / policy_mcp_block; `directive` →
  directive_result. The map is the source of truth (unit-tested);
  extending search vocabulary is a single map edit.

Ranking is shared across entities: exact case-insensitive match
outranks prefix outranks substring. Within each tier, fields have a
fixed precedence so a query that matches multiple fields on the
same row lands in the most semantic slot:

- events: event_type > tool_name > model (curated map sits at rank 3,
  between exact and prefix)
- agents: agent_name > hostname > user_name
- sessions: session_id > flavor > host > model (context-JSONB
  matches share the substring tier)

Recency (`occurred_at DESC` for events, `last_seen_at DESC` for
agents, `started_at DESC` for sessions) is the per-tier tiebreaker.

**Result routing.** The Cmd/Ctrl+K palette routes each
result type to a different surface — agent and event hits open
overlay drawers via URL params on the *current* route, run hits
navigate to the events page:

- agent → `?agent_drawer=<agent_id>` (mounted by
  `AgentDrawerHost`, app-level overlay).
- event → `?event=<event_id>&event_session=<session_id>&event_at=<occurred_at>`
  (mounted by `EventDetailDrawerHost`, app-level overlay; distinct
  param pair so the run drawer (`?run=`) cannot mount
  simultaneously). Hydrated through `GET /v1/events` scoped to
  `session_id` (`findSessionEvent` in
  `dashboard/src/hooks/findSessionEvent.ts`), so an event anywhere in
  a run of any length resolves:
  - with `event_at` (the palette always sets it), one request whose
    `from` and `to` bound that millisecond returns the event and any
    that share it (the search API's timestamps come in Postgres's text
    form, which the events filter does not take, so the dashboard
    rewrites them as ISO; a failed request falls through to the next
    rule);
  - without it (an older bookmark), or if that misses, the run is
    read newest first in pages of `EVENT_LOOKUP_PAGE_SIZE` (2,000,
    the endpoint's cap) with the keyset cursor until the event turns
    up, the run ends, or `EVENT_LOOKUP_MAX_PAGES` (25) pages are read.
    Those pages reach back from the run's newest event without a gap,
    so they merge into `eventsCache` by id like every other load (see
    Bulk historical events hook); the single-timestamp answer does
    not, since it would leave a gap.
  An event that is not found surfaces an explicit "not found" empty
  state rather than an invisible drawer.
- run → navigates to `/events?run=<session_id>` (the run drawer
  lives on that page).

External deep links should prepend a base route that makes sense
when the operator closes the drawer (e.g.
`/agents?agent_drawer=<id>` or `/events?event=<eid>&event_session=<sid>`)
rather than a bare `?...` fragment.

### Bulk events

`GET /v1/events` runs the COUNT and SELECT inside a single
`pgx.BeginTx` with `pgx.TxIsoLevel("repeatable read")`. Without the
explicit isolation level, a worker INSERT between the COUNT and SELECT
could leave `total` stale relative to `events`, breaking pagination math
(`offset + len(events) > total`). Repeatable read pins both reads to the
same snapshot.

Rows are ordered by `occurred_at`, then `id`, both in the requested
direction (`order=asc`, the default, or `desc`). The `id` tiebreaker
makes the order total: events often share a timestamp (a client that
stamps whole seconds, the reaper's synthetic `session_end` rows, which
share one `NOW()`), and without it Postgres may order tied rows
differently in each page's query, so offset paging could skip or repeat
a row at a page boundary. `GET /v1/sessions/:id` orders its events the
same way, also when `events_limit` caps them to the newest N.

Two paging styles share the order. Offset paging (`limit` + `offset`)
serves the Events page and the agent drawer. Keyset paging serves
Fleet's history load and the run drawer's "Show older", both newest
first (`order=desc`), each page continuing from the oldest event the
previous one returned: `before` alone
returns rows with `occurred_at < before`; `before` with `before_id`
(the id of the oldest row the caller holds) returns the rows strictly
before that row in the order, `occurred_at < before`, or
`occurred_at = before` and `id < before_id`, so rows that share the
cursor's timestamp are neither skipped nor repeated. `before_id`
without `before`, or one that is not a UUID, is a 400.

Each returned event carries the session-level identity attributes
`framework`, `client_type`, and `agent_type`, projected via a
`LEFT JOIN` to `sessions` on `session_id` — the events table stores
none of them. The filter + ORDER + pagination run inside a subquery
so the join only touches the page's rows; the COUNT query runs on
`events` alone and never includes the join, so it is unchanged.
`framework` and `client_type` are nullable on `sessions`;
`agent_type` is `NOT NULL` there.

The optional `q` param is a free-text search powering the `/events`
page search bar: the handler wraps it in an ILIKE pattern and
`buildEventsWhere` matches it against the `events` columns
`event_type`, `model`, and `session_id` (cast to text), plus the
session-level `agent_name` and `framework` resolved through a
`sessions` subquery. Because `buildEventsWhere` is shared with the
facet-count path, `q` narrows the `facets=true` chip counts as well
as the row list.

### Server timeouts

`withRESTTimeout` middleware wraps every REST handler in
`http.TimeoutHandler` with a 30-second limit (answering `503` with
`{"error":"request timeout"}`) so a slow store query cannot hold an HTTP
goroutine forever. The WebSocket route `/v1/stream` is registered WITHOUT
this wrapper — the WebSocket pump runs for the lifetime of a client
connection and applies its own per-message write deadline. The HTTP
server's `WriteTimeout` is intentionally not set so the long-lived
WebSocket stream is not killed by a global write deadline.

### Context facets

`api/internal/store/postgres.go::GetContextFacets(ctx)` runs:

```sql
SELECT key, value, COUNT(*) AS count
FROM sessions, jsonb_each_text(context)
WHERE state IN ('active', 'idle', 'stale')
  AND context != '{}'::jsonb
GROUP BY key, value
ORDER BY key ASC, count DESC
```

Returns `map[string][]ContextFacetValue` keyed by context field name.
Empty context dicts are excluded so they do not pollute facet groups
with `{}` entries. `GetContextFacets` failure is best-effort — the
fleet handler logs a warning and returns an empty map rather than
failing the entire `GET /v1/fleet` response.

### `AgentSummary.recent_sessions`

Each `AgentSummary` row on the `/v1/fleet` response carries a
`recent_sessions` field — a JSON array of up to
`store.RecentSessionsPerAgent` sessions belonging to that agent,
sorted by `started_at` descending. Populated by
`store.GetRecentSessionsByAgentIDs` as a single batched query
keyed off the page's `agent_id` slice; the per-agent rollup is
computed via `ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY
started_at DESC, session_id ASC)` so the ordering is deterministic
when two sessions share a `started_at` timestamp.

Each entry is a lean projection (`store.RecentSession`) carrying
only the columns the dashboard's swimlane row and the `/agents`
filter chips consume: identity fields (session_id, flavor,
agent_type, agent_id, agent_name, client_type, host, model,
framework), lifecycle fields (state, started_at, ended_at,
last_seen_at, tokens_used, token_limit), the `capture_enabled`
flag, and the sub-agent linkage columns (parent_session_id,
agent_role). `framework` is the bare-name `sessions.framework`
attribution; it feeds the `/agents` page framework filter chips.
It also carries `close_reasons`, the distinct `close_reason` values of
the run's `session_end` events (always an array): a run the
orphan-timeout reaper closed has been silent for at least the orphan
timeout (24 h by default), so it is older than the Fleet's 24 h
sessions page and this rollup is where the swimlane learns it was
reaped. The array is computed in the outer query, for the kept rows
only. The other heavy correlated-subquery columns of
`SessionListItem` (error_types, policy_event_types, mcp_server_names,
...) are intentionally absent so the per-agent rollup stays cheap on
fleet pages with 50+ agents.

The rollup guarantees each visible agent row carries its
`RecentSessionsPerAgent` most-recent sessions independently of
the paginated `/v1/sessions` window: the swimlane row's data
dependency on its agent's sessions is per-agent bounded, while
the `/v1/sessions` 100-row page is global and cliff-shaped.
`dashboard/src/store/fleet.ts::buildFlavors` merges the embedded
slice with the paginated intersection so each agent's swimlane
row always has at least its top-5 to render event circles from;
the paginated slice fills in any younger siblings that did not
make the per-agent top-N cut. Merge precedence: paginated wins
on the same `session_id` because `SessionListItem` is the richer
projection (it carries `context` and `token_name`; the embedded
`RecentSession` omits both).

The swimlane's default time range is `1m` (see
`dashboard/src/pages/Fleet.tsx::timeRange` initial state). The
SwimLane row's render path clips events to
`[NOW - timeRange, NOW]`; the default lands on the
live-monitor view ("what's happening RIGHT NOW") rather than a
historical span. The `recent_sessions` rollup populates the row's
session slice independently of the time range — operators widen
via the picker (`5m / 15m / 30m / 1h`) when they need historical
context, and `Return to live` snaps back to `1m`. A row whose
sessions all fall outside the visible window renders without
event circles even though the row materialises; widening the
time range surfaces the circles without re-fetching.

The wire shape uses `omitempty`; consumers treat the field as
optional and apply the paginated-only path when it is absent.

### `AgentSummary` runtime-context projection
Each `AgentSummary` row carries eight nullable JSONB-derived
fields sourced from the agent's MOST RECENT session's
`sessions.context`: `os`, `arch`, `git_branch`, `git_repo`,
`orchestration`, `python_version`, `process_name` and `telemetry`
(`otlp` when that session was reported over OpenTelemetry; the
dashboard's source pill reads it, see Dashboard > Session source). `hostname`
and `user` already live as direct columns on the `agents`
table (denormalised at agent-upsert time); the eight
fields ride a single shared `LEFT JOIN LATERAL` per agent
(`agentLatestContextSQL` in `api/internal/store/postgres.go`)
that runs `SELECT context->>'<key>' ... WHERE agent_id =
a.agent_id ORDER BY started_at DESC LIMIT 1`.

The lateral attaches to all three agent-row projection paths —
`GetAgentFleet`, `ListAgents`, `GetAgentByID` — so `/v1/fleet`
and `/v1/agents` carry an identical agent-row shape on the
new columns. The agents arm of `GET /v1/search` joins the same
lateral for `telemetry` alone, so a search hit names its source too. `/v1/agents/:id/summary` returns
`AgentSummaryResponse` (totals + per-bucket series) rather
than `AgentSummary`, so it does NOT surface the projection;
`GetAgentByID` is called by the summary handler only as a 404
existence guard and its `AgentSummary` return value is
discarded.

Sessions with no context, missing keys, or NULL context all
project as null on the relevant field; the `omitempty` JSON tag
elides absent values from the wire payload. The dashboard
treats `null` and "key missing" identically — both mean "no
value for this agent" and contribute no chip count on the
`/agents` sidebar.

The `LIMIT 1` lookup rides the composite index
`sessions_agent_id_started_at_desc_idx` on `sessions(agent_id,
started_at DESC)` from migration 000025, so the per-agent
projection is a single index seek (no heap-sort step). The same
index also speeds the pre-existing state-rollup subquery, which
performs the identical lookup shape.

**Semantic:** an agent that ran across multiple hosts / branches
facets by its LATEST run only. This is the single-valued
projection required by the `/agents` page's one-row-per-agent
facet model; the alternative (union of all values across
sessions) would explode cardinality and break the
single-row-per-agent contract. Operators chasing historical
breadth use `/events` whose runtime-context facets surface every
event's session context independently.

### Swimlane sub-agent connector overlay

`dashboard/src/components/timeline/SubAgentConnector.tsx` renders
the Bezier curves that link a parent agent's spawn-event circle
to the child agent's first event inside the visible domain. The
geometry rule the layout effect enforces: each child row's
anchor is its **first event inside the visible time domain**, not
its absolute first event. Events with timestamps outside the
domain are never used as anchors regardless of `started_at`, so
the overlay always aligns with the swimlane's visible state.

The parent anchor is picked by `pickSpawnEvent`: the
temporally-closest parent event preceding the child's first
in-domain event. The chosen pair is kept only when both endpoints
fall inside the domain; pairs spanning the boundary are skipped
so the curve never anchors off-screen. D3 supplies the time
scale; the SVG path is constructed in React (Rule 16 — D3 is
math only, never DOM manipulation).

Each path starts on the rim of the parent's spawn-event circle and
ends at the centre of the child's first circle inside the time
domain. Both points are measured from the rendered circles, looked
up by `data-event-id` inside the parent's and the child's rows (the
expanded ALL row draws the same events), so a connector lands on its
circles wherever they sit. The rim radius is half the circle's
`offsetWidth`, which a hover scale does not change. A pair is
skipped when a circle is not mounted, such as one on a virtualised row,
or when its row's timeline panel clips it near "now" (its centre past
the panel's edge), so a connector never runs past the now line.

Connectors rest at 10% opacity. Hovering a run's mark (an event
circle or a run glyph), or focusing a run glyph from the keyboard
(`:focus-visible`), raises every connector that starts or ends on that
run to 50%: a parent run lights
its whole fan-out, and a child run lights only its own link, even
when several runs share a row. Each mark carries its run's id as
`data-session-id`, and `Timeline.tsx` reads it from one delegated
handler. Focus a mouse click leaves on a glyph does not count, so the
highlight never sticks after the pointer leaves. Hovering a connector
itself raises it too.

---

## Dashboard

React + TypeScript + Vite + Zustand. shadcn/ui and custom components
only — never MUI, Ant Design, or Chakra UI.

### Pages

- `/` (Fleet) — primary view. Sidebar + fleet header + timeline.
- `/agents` — one-row-per-agent table with KPI sparklines, filter
  chips, sort, and a per-agent swimlane modal. Companion to
  `/` (Fleet) for operators who want a list view and one-shot
  per-agent investigation without leaving the page.
- `/events` — event search and filtering surface. Rows are
  individual events; URL-driven facets: `event_type`,
  `policy_event_type`, `error_type`, `framework`, `model`,
  `close_reason`, `estimated_via`, `matched_entry_id`,
  `originating_call_context`, `mcp_server`, `agent_id`, and a
  `terminal` toggle. Legacy `/investigate` is served at the nginx
  edge with a permanent 301 to `/events` preserving the query
  string.
- `/session/:id` — full session drilldown (drawer-based via deep-link).
- `/analytics` — flexible breakdown charts.
- `/policies` — token policy CRUD.
- `/directives` — custom directive registry + trigger forms.
- `/settings` — access token CRUD.

### Table primitive

Every tabular surface in the dashboard renders through one
shared primitive at `dashboard/src/components/ui/table.tsx`.
Components exported: `Table`, `TableHeader`,
`TableBody`, `TableRow`, `TableHead`, `TableCell`. The
primitive is the single source of table styling — header cells
are 11-px / `font-semibold` / `uppercase` /
`tracking-[0.06em]`, body cells are 12-px / `align-middle`
with `px-3 py-2` padding throughout, header rows carry
`border-b border-border bg-surface`, body rows carry
`border-b border-border-subtle`, and an `interactive` prop on
`TableRow` adds `hover:bg-surface-hover cursor-pointer` for
clickable rows. Header-vs-body styling is resolved through a
React context flag that `TableHeader` sets — descendant
selectors collide with class ordering rules and were rejected.

`TableCell` has a `mono` prop that switches the cell to
`font-mono` (resolves to `var(--font-mono)` / GeistMono). The
canonical content rule: numbers, measurements, IDs,
timestamps, and model strings use `mono`; names, flavors,
labels, and prose use the default UI font. `TableHead` and
`TableCell` accept `align="right"` for numeric columns.

Surfaces on the primitive: `AgentTable.tsx` + `AgentTableRow.tsx`
(the `/agents` route), and the events `<table>` + `EventRow`
function inside `Investigate.tsx` (the `/events` route).
Surfaces not yet on the primitive: the policy tables
(`PolicyTable.tsx`, `MCPPolicyEntryTable.tsx`,
`MCPPolicyAuditPanel.tsx`), the Runs tab inside the Agent drawer
(`AgentDrawerRunsTab.tsx`), and `Settings.tsx`. The unmigrated
surfaces still render their own table chrome; the primitive is
the canonical contract every future table adoption inherits.

### Agents table

`dashboard/src/pages/Agents.tsx` hosts the `/agents` route. The
page is a one-row-per-agent sortable table backed by the same
`GET /v1/fleet` roster the swimlane uses. It loads that roster
through `useFleet`, as Fleet does: once when the page mounts (a direct
visit included), then live. The page starts no load of its own, so an
empty roster, or a load that failed, waits for the next load (a new
agent's run, a reconnect, the next visit) instead of loading again at
once. Each row carries
per-agent KPI sparklines fetched from
`GET /v1/agents/:id/summary?period=7d&bucket=day` (one fetch per
visible row on first mount, cached module-level so a re-render
or modal-open does not refetch).

Columns, left to right:

1. **Identity** — agent name (monospace), `ClientTypePill`
   (CC / SDK) and, for an agent reported over OpenTelemetry, the `OTEL`
   source pill (see Session source), `agent_type` badge (coding / production),
   provider / OS / orchestration icons derived from the agent's
   most-recent session context.
2. **Topology** — `TopologyCell` pill (lone / ↳ child /
   ⤴ parent N), the same primitive the swimlane label strip
   uses.
3. **Tokens (7d)** — total + day-bucketed sparkline over the
   trailing 7 days.
4. **Latency p95 (7d)** — total + sparkline.
5. **Errors (7d)** — total + sparkline.
6. **Sessions (7d)** — count.
7. **Cost USD (7d)** — the agent's metered spend (see Cost
   estimation). An agent whose calls in the window were all
   `subscription` shows `Subscription` instead of an amount (and no
   sparkline), and an agent with no metered spend shows `$0.00`,
   never an em-dash. A total that leaves out unpriced models or
   subscription calls carries a `*` marker whose tooltip names what
   it leaves out. The reading comes from the window's billing modes,
   not the client type, so a Claude Code agent on an API key shows
   its metered cost. The column header's info-icon tooltip explains
   the billing modes, and the per-agent swimlane modal's `Cost (7d)`
   KPI tile reads the same way (`AgentCost` renders both).
8. **Last seen** — relative time with absolute-time tooltip.

Column order shipped (`COLUMNS` array in `AgentTable.tsx`):
Agent → Status → Topology → Tokens (7d) → Latency p95 (7d) →
Errors (7d) → Sessions (7d) → Cost (7d) → Last seen. The
**Status** column sits second (right after Agent); its cell is a
clickable chip wrapping `AgentStatusBadge` that opens the
per-agent swimlane modal. The active-state animation is a
rotating gradient ring around the dot (`agent-status-active-ring`
class in `globals.css`), degrading to a static soft glow under
`@media (prefers-reduced-motion: reduce)`. A trailing actions
column (not in the sortable `COLUMNS` array) carries an
**Events ↗** quick action; the empty-state row's `colSpan`
covers both the sortable columns and the actions column.

**Family grouping** — rows form families with the same visual
contract as the Fleet swimlane: a parent row is immediately
followed by its descendants. The active column sort orders
FAMILIES by the parent's (or lone agent's) sort key +
direction; within each family the descendants render directly
under their root, sorted among themselves by the same key +
direction. Holds for every sortable column. The linkage source
is `AgentSummary.recent_sessions[].parent_session_id` —
per-agent backfilled, so a child whose parent's sessions fall
outside any wall-clock window still groups with its parent.
Depth-2 chains (grandparent → parent → leaf) flatten to one
indent level under the root family. Descendant rows carry an additional
`data-topology="child"` attribute (distinct from
`data-agent-topology` which mirrors the agent's structural
topology on the wire); the row's first cell applies a 28-px
`padding-left` to match the swimlane / Investigate sub-row
indent. Orphan children — whose parent isn't in the current
view (filtered out OR off the API window) — render as
single-row families at their own sort position so a filtered
view never silently hides a child. Pagination respects family
boundaries: a family never splits across a page; an oversized
family (rare — sub-agent fan-out is normally ≤ 10) lands on
its own oversized page rather than splitting. Page-size is 50;
displayed row counts reflect actual page slice sizes, not a
fixed `PAGE_SIZE` multiplier.

A left facet sidebar — the same visual pattern the `/events`
page uses — carries thirteen filter dimensions, each chip
rendered with its dimension's visual:

- **STATE / AGENT TYPE / CLIENT / FRAMEWORK** — `state` a
  coloured dot beside the value text, `agent_type` an
  `AgentTypeBadge`, `client_type` a `ClientTypePill`,
  `framework` a `FrameworkPill` (the pill / badge is itself the
  chip label for the latter three). CLIENT lists, in registry
  order, the client types some agent carries plus any already
  selected (see Client type registry); an agent with no
  `client_type` shows no pill and matches no CLIENT filter.
- **HOSTNAME / USER / OS / ARCH / GIT BRANCH / GIT REPO /
  ORCHESTRATION / PYTHON / PROCESS** — nine runtime-context
  dimensions rendered via the shared `FacetIcon` (same icon
  vocabulary `/events` uses), so the sidebar reads as one icon
  family across the two pages.

Selections compose AND across dimensions and OR within. Every
dynamic group (FRAMEWORK + the nine runtime-context dims) hides entirely
when no visible agent carries a value in that dimension —
parity with the FRAMEWORK group's empty behaviour. A full-width
search bar above the sidebar + table filters the roster
client-side by agent name, `agent_type`, `client_type`,
framework, the runtime-context fields, and recent-session
model; Escape clears it.

Filtering is **fully client-side** over the loaded
`useFleetStore().agents` slice. The page never re-fetches on
chip toggle; `filterAgents()` runs in a `useMemo` over the
roster and the `AgentTable` re-renders with the filtered slice.
Runtime-context dimensions are sourced from `AgentSummary` fields the
projection carries (delivered to the page via `/v1/fleet`; the
same fields are also present on `/v1/agents` rows for callers
that hit that endpoint directly): `hostname` and `user` are
direct agents-table columns (single-valued per agent); the
other seven (`os`, `arch`, `git_branch`, `git_repo`,
`orchestration`, `python_version`, `process_name`) come from a
`LEFT JOIN LATERAL` against each agent's MOST RECENT session's
`sessions.context` JSONB. An agent that ran across multiple
hosts / branches facets by its latest run only — a single-row-
per-agent facet model requires a single-valued projection.
Agents whose latest session's context omits a key (or whose
context is NULL) surface that field as null and contribute no
chip count to the dimension.

Sortable column headers on every column except the sparkline
tiles themselves (sparklines are visual; the sort key is the
column's numeric total). Pagination defaults to page size 50.

Clicking anywhere on a row opens that agent's **agent drawer**
(see below). The row's **status chip** in column 2 — the
labeled badge wrapped in a hover-affordance button — opens the
per-agent swimlane modal; the actions cell on the right edge
carries an **Events ↗** shortcut (deep-link to
`/events?agent_id=…`).

Live update contract: the fleet store's `lastEvent` subscription
patches the affected row's KPI cells and status chip in place;
the table itself does not re-render. `useAgentSummary`'s
module-level cache is keyed by the composite
`(agent_id, period, bucket)` tuple so the table's `7d / day`
view and any other surface (e.g. the per-agent swimlane
modal) caching a different period coexist without colliding.
The hook patches the agent a WebSocket event belongs to: the
`agent_id` of the session the broadcast carries with the event, else
the fleet row that holds the event's run (an event carries its
flavor, a label, and no agent id; one neither ties to an agent is
left to the next fetch). It adds the `tokens_total` of a `post_call`,
an `embeddings` call or a failed stream's `llm_error` to
`totals.tokens` and the most-recent series bucket, as the summary
endpoint counts them, counts an `llm_error` and a failed `tool_call`
in `errors`, and raises
`latency_p95_ms` to a `post_call`'s latency above it, then ticks a
per-agent counter so only that row's memoised cells invalidate.

The agent drawer's open/closed state is URL-backed via the
`?agent_drawer=<agent_id>` query param: a `/agents` row click
sets it, a deep-linked or bookmarked value opens the drawer on
load, and the browser back button closes it. The `agent_id` is
validated against the canonical UUID shape before use so a
malformed value silently no-ops instead of throwing.

### Per-agent swimlane modal

`dashboard/src/components/agents/PerAgentSwimlaneModal.tsx`
opens as a shadcn Dialog at ~80 vw × 80 vh from two surfaces:
the `/agents` row STATUS chip (column 2) and the agent drawer
header's **Open in swimlane** button. It scopes the existing `SwimLane` /
`VirtualizedSwimLane` primitives to a single agent's flavor
(plus its sub-agents when the **Show sub-agents** toggle is on).

Modal layout:

- **Header** — agent name, topology pill, status badge (with
  a rotating gradient ring on active; passes
  `align="inline"` so the badge hugs the topology pill on the
  left — the badge's default `auto-right` mode applies
  everywhere else `AgentStatusBadge` ships), KPI totals
  summary (Tokens, Latency p95, Errors, Sessions and Cost, all
  over 7 days), and an explicit close `×` button at the top-right
  (outside-click and `Esc` also close via Radix's
  `onOpenChange`).
- **Time-range picker** — the five Fleet ranges `1m / 5m /
  15m / 30m / 1h`, defaulting to `1m`. Options and default are
  the shared `TIME_RANGE_OPTIONS` / `DEFAULT_TIME_RANGE`
  constants the Fleet view also reads, so the two pickers
  cannot drift. Affects both the modal's swimlane events and
  the live feed strip below — the feed projects a subset of
  the in-memory event cache filtered by
  `occurred_at >= NOW − TIMELINE_RANGE_MS[r]` so narrowing the
  picker drops older rows and widening re-exposes them without
  a re-fetch. Does not affect the `/agents` table sparklines.
- **Show sub-agents toggle** — defaults ON for parents
  (`topology === "parent"`), DISABLED + off for lone agents.
  When ON, the modal renders the parent row plus every
  sub-agent row with the existing `SubAgentConnector` overlay.
- **Swimlane body** — the existing `SwimLane` primitive
  filtered to the agent's flavor set. The Timeline's natural
  inner width (`leftPanelWidth + TIMELINE_WIDTH_PX`) is typically
  wider than the 80 vw modal viewport, so a horizontal
  scrollbar appears on the swim wrapper. The modal snaps
  `scrollLeft` to the rightmost position when it opens, when
  the picker range changes, and when the scope flips, so the
  "now" pole at the rightmost pixel of the Timeline surfaces at
  the right edge of the visible swim viewport (matching Fleet,
  where the page-width viewport fits the timeline naturally).
  Manual horizontal scroll between those events is preserved.
- **Live feed strip** — a `LiveFeed` strip below the swimlane
  body, scoped to the same session set the lanes use.
  Pipeline: per-session `fetchSession` seeds the feed from
  `eventsCache` for each session in the scoped set (mirroring
  the swimlane's `useSessionEvents` path so the lane and the
  feed read from one source of truth, including events older
  than any wall-clock window), merging each fetched run into the
  cache by event id (`mergeIntoEventsCache`);
  `useFleetStore.lastEvent` ticks every WS event into the feed
  dedup'd by `event.id` and merges it into `eventsCache` the same
  way, so the swimlane sees the same live tick. Both streams filter through
  `scopedSessionIds` (a `Set<string>` of `session_id` values)
  before merging — `session_id` is the match key, not
  `flavor`, because `FlavorSummary.flavor` carries the
  agent_id UUID while `AgentEvent.flavor` carries the
  seed-time flavor string; the two never match. The scope set
  is memoised behind a sorted-joined `scopedSessionIdsKey`
  string so the seed effect is stable across store mutations.
  Toggling **Show sub-agents** rescopes the lanes and the
  feed in lockstep. The modal does not open its own
  WebSocket — the host page drives `lastEvent`: `Fleet.tsx`
  via its `useFleet()` call on `/fleet`, `Agents.tsx` via the
  same hook called purely for its side-effect on `/agents`. A
  feed row click reuses the same `setSelectedEvent` setter
  the swimlane circle click does, so the event detail drawer
  mounted inside the Dialog opens identically from either
  surface.
- **Event circle click** — sets the modal's local
  `selectedEvent` state which mounts the existing
  `EventDetailDrawer` inside the Dialog content. The drawer
  is a `motion` (`motion/react`) position-fixed overlay (not a nested
  Radix Dialog), so it stacks above the modal without
  Radix focus-trap or backdrop-click conflicts. Closing the
  drawer clears `selectedEvent`; the modal stays open. Its
  "View entire run →" link closes it and opens that run in the
  run drawer.
- **Run glyph click** — a run's ▶ or ■ glyph sets the modal's
  local `selectedRunId`, which mounts `SessionDrawer` (the run
  drawer) inside the Dialog content, the same `motion` overlay
  the Fleet page uses. Closing it clears `selectedRunId`; the
  modal stays open. Re-pointing the modal at another agent clears
  both the selected event and the selected run.
- **Close** — the header's `×` button calls the host's
  `onClose`; outside-click routes through the same path. `Esc`
  closes the innermost open layer first: the event detail drawer,
  then the run drawer, then the modal (the Dialog's
  `onEscapeKeyDown` keeps the modal open while a drawer is up).
  Returns to the launching surface at the same scroll
  position; the URL gains no segments while the modal is
  open.

### Agent drawer

`dashboard/src/components/agents/AgentDrawer.tsx` — a right-rail
slide-in panel (520px, the same width and `motion` slide
as `SessionDrawer`). It is mounted once at the app level and
driven entirely by the `?agent_drawer=<agent_id>` URL param, so
it opens identically from the `/agents` table (row click) and
the Fleet swimlane (agent-name click) with no route change. A
deep-linked `?agent_drawer=` opens it on load; the browser back
button closes it.

Header — four sibling rows, in deterministic vertical order
(testid `agent-drawer-header-{identity,status,actions,subagents}`).
The four rows give the layout a fixed grammar: identity, then a
status descriptor, then primary actions, then navigation. The
shape stays stable across topology variants — a wide topology
descriptor or a long sub-agent linkage cluster cannot push the
action row onto a wrapping line.

- **Row 1 — identity card** — agent name (monospace),
  `ClientTypePill` (CC / SDK), `agent_type` badge, provider /
  OS / orchestration icons. Close `×` button anchored to the
  right edge via `marginLeft: auto`.
- **Row 2 — status + topology descriptor** — `StatusDot` +
  `STATUS_LABEL` text, plain muted styling (NOT link-styled —
  this row is information, not navigation). On active state
  the dot wears the rotating-gradient `agent-status-active-ring`
  decoration. A topology descriptor follows the label after a
  pipe separator, derived from `linkage` (the
  `deriveAgentLinkage(agentId, flavors)` result — a
  `{ parent: AgentLink | null; children: AgentLink[] }` object
  resolved from the fleet-store session graph in
  `dashboard/src/lib/relationship.ts` — NOT the discrete
  `agent.topology` field, so depth-2 middle agents that are
  simultaneously a child AND a parent read correctly):
  `spawns N` when the agent has children, `sub-agent` when it
  has a parent, `sub-agent • spawns N` when it has both.
  **Name-free by contract** — the parent / child agent names
  live in row 4 pills, never duplicated in row 2.
- **Row 3 — action buttons** — bordered icon + label buttons.
  `Open in swimlane` (Activity icon) opens the per-agent
  swimlane modal stacked over the drawer; `Open in events`
  (ListTree icon) routes to `/events?agent_id=<id>`. Both
  carry the same affordance so the two read identically as
  primary actions. Testids `agent-drawer-open-swimlane` and
  `agent-drawer-open-in-events`.
- **Row 4 — linkage sections** (conditional) — labelled
  uppercase muted headers above the pill rows so the cluster
  reads as a navigation surface, not free-floating chips.
  **PARENT** section renders first when the agent has a parent
  (one `← parent: {name}` pill), then **SUB-AGENTS** when the
  agent has children (one `↳ {name}` pill per child). Both
  sections coexist for depth-2 middle agents. Pills wear the
  shared `.agent-status-chip` hover + focus-visible affordance
  from `globals.css`. Clicking a pill rewrites
  `?agent_drawer=` to re-point the drawer at the linked agent.

Below the identity chrome sit three collapsible panels: the MCP
servers the agent has connected to (union across loaded
sessions), the latest run's **runtime context panel**, and the
most recent policy events.

The runtime-context panel renders **every** key present in
`sessions.context` for the most recent run, not a curated
subset. The curated key list — User, Host, OS, Arch, PID,
Process, Python, Git branch, Git repo, Git commit,
Orchestration, Frameworks — renders first, in that fixed
order, with deliberate labels. Any key NOT in the curated set
renders generically below, alphabetised, with a snake_case →
"Title case" label (e.g. `node_version` → `Node version`) so
a new sensor-emitted field is never silently hidden. The
`orchestration` value renders specially: a bare string emits
one flat row; an object (k8s / compose detection) expands
into the parent "Orchestration" row plus indented sub-rows.
The curated orchestration sub-keys, in emission order, are
`k8s_pod`, `k8s_namespace`, `k8s_node`, `k8s_cluster`,
`compose_project`, `compose_service`; any further sub-key the
sensor emits surfaces alphabetically below the curated set
with the same humanised-label fallback as top-level unknown
keys. Empty / null / empty-array values are skipped.
`mcp_servers` is excluded — its dedicated MCP SERVERS panel
above renders that data.

Two tabs:

- **Events** (default) — a paginated, newest-first event list
  for the agent, backed by `GET /v1/events?agent_id=<id>`. Each
  row carries the event-type icon, timestamp, model, and a run
  badge (the 8-char `session_id` prefix). A row click opens the
  `EventDetailDrawer`; a run-badge click opens the run drawer.
- **Runs** — a paginated, newest-first run (session) list backed
  by `GET /v1/sessions?agent_id=<id>`, sortable, default
  `started_at` descending. Columns: start time, duration, status
  (with a `close_reason` badge), tokens used, a count of the
  distinct error types observed in the run, and an `attached`
  pill when `attachment_count > 0`. A row click opens the run
  drawer (`SessionDrawer`) stacked over the agent drawer with a
  `← Back to {agent_name}` breadcrumb that returns to the
  drawer.

The drawer's identity row reuses the same identity primitives
the `/agents` table and the swimlane label strip render
(`ClientTypePill`, provider / OS / orchestration icons,
`agent_type` badge); the `useAgentSummary` cache keeps the
header data byte-identical across surfaces. Row 2's
`StatusDot` + label and row 4's pills both ship from
`@/lib/agent-status` so the colour-to-state mapping cannot
drift. It coexists with the per-agent swimlane modal: the
modal (status-chip click on the `/agents` row) is a quick
visual peek at one agent's swimlane; the drawer (row click)
is the drill-down into the agent's events, runs, and
sub-agent linkage.

### Session source

A client can report the same agent more than one way, and an operator
needs to know which, because it decides what Flightdeck can do with
the session: Claude Code through the plugin, or through its own
OpenTelemetry exporter (see OTLP ingest), which observes only. The
source is read from the session's `context.telemetry`, never from the
client type (an OTLP-reported Claude Code session is a `claude_code`
session with that type's defaults), and for an agent from its latest
session's, which the agent rows carry as `telemetry` (see
`AgentSummary` runtime-context projection).

- **Compact rows.** An `OTEL` pill (`TelemetrySourcePill`, the muted
  pill treatment) follows the `ClientTypePill` on the Fleet swimlane
  label strip and sidebar row, the `/agents` identity cell, the agent
  drawer's identity row and the search palette's agent and session
  hits (and its recent-agents list). Its tooltip reads "Claude Code via
  OpenTelemetry: observe only, no directives reach it". The plugin, the
  sensor and the Agent SDK interceptor get no pill: they are each
  client's default way of reporting, and a pill on every one of their
  rows would be noise.
- **Run drawer.** The Claude Code header bar spells the source out
  after the version: `via OpenTelemetry` or `via plugin`. The version
  comes from the plugin's `claude-code/<version>` framework entry or an
  OTLP session's `context.claude_code_version`; the bar shows for any
  session whose `client_type` is `claude_code`, so an OTLP session
  under a custom `flightdeck.flavor` keeps it.
- **Agent frameworks.** A run an agent framework reports over
  OpenTelemetry GenAI (`client_type` `otlp`, see OTLP ingest > GenAI
  dialect) is named after its framework: `Pydantic AI`, `Strands
  Agents`, `OpenAI Agents` or `Google ADK`, read from the label in
  `context.frameworks[0]` (else the session's `framework`); a label the
  dashboard has no name for shows as itself. Its run drawer has an
  OpenTelemetry header bar in place of the Claude Code one: the
  framework and its version, `via OpenTelemetry` (its tooltip "Reported
  by <framework>'s OpenTelemetry instrumentation", not the Claude Code
  exporter's), an `unattributed` mark on the trace's unattributed
  session (`context.otel_unattributed`, the calls no named agent
  made), the first 8 characters of `context.otel_trace_id` (all of it
  in the tooltip; a hand-off's sibling roots share it) and the
  sub-agent relationship pill. The OTel pill's tooltip names the
  framework ("Pydantic AI via OpenTelemetry") where the row holds the
  framework: the `/agents` row and the agent drawer (from the agent's
  latest run) and the search palette's run hits. The Fleet swimlane and
  sidebar rows and the palette's agent hits carry no framework, and
  read "Reported via OpenTelemetry".
- **Controls.** An OTLP session takes no directives (see
  Observer-session class): no Stop Agent, no Stop All, no
  custom-directive triggers.
- **Accessible name.** The pill's screen-reader text and the drawer
  label's both carry what the tooltip says, "observe only, no
  directives reach it", since a tooltip is not announced. A source
  with no client name, or the generic `otlp` type, reads "Reported via
  OpenTelemetry".

### Fleet view

`dashboard/src/pages/Fleet.tsx` composes the FleetPanel sidebar (240px),
fleet header (time range, live indicator), the swimlane timeline, and
live feed. The swimlane is the only main-area rendering; there is no
view toggle.

`pauseQueue: FeedEvent[]` state buffers WebSocket events when `isPaused`
is true. New events are appended; if the queue length reaches
`PAUSE_QUEUE_MAX_EVENTS` the oldest entry is dropped (FIFO). `pausedAt:
Date | null` freezes the time scale. "Resume" drains the queue;
"Return to live" discards it and snaps back.

`sortFlavorsByActivity(flavors)` sorts agents by activity priority so
flavors with active or idle sessions float to the top of the swimlane and
stale / closed / lost ones sink to the bottom. Stable secondary order is
alphabetical.

A sub-agent's activity floats its whole parent + sub-agent cluster:
the fleet store's `applyUpdate` resolves the parent agent from an
incoming child event's `parent_session_id` and bumps the parent
flavor's `last_seen_at` and activity-bucket entry. `sortFlavorsByActivity`
then reads those bumped values on the next render, so the cluster
sorts by the latest activity across the parent AND all its
sub-agents, not the parent's own direct events alone — the
front-end counterpart of the worker's parent-bump propagation.
The resolution is best-effort: an unloaded parent is skipped and
self-heals on the next fleet load.

`applyUpdate` applies a WebSocket update to the session row it names:
the swimlane row's copy of the session, the agent's `recent_sessions`
entry, and the counts derived from them. A run's state comes only from
the worker, which announces each reconciler and reaper transition (see
Worker / Event Processing → Notify); the dashboard never applies the
stale or lost thresholds itself. Only a `session_start` or an update
that carries an event a client sent counts as activity. A state-only
update (no `last_event`) and the reaper's close (a `session_end` whose
`close_reason` is `orphan_timeout`; ingestion accepts that value from
any client, but only the worker's reaper sends it in practice) change
the run without refreshing the agent row's `last_seen_at`, moving it
between activity buckets, or bumping its parent's cluster. When the
page does not hold the run, the swimlane takes nothing from them: they
add no row and no run, so a run the reaper closes after a day of
silence does not appear as if it had just ended, and their event
reaches neither the live feed nor the store's `lastEvent`. A row's
`last_seen_at` never moves back: it takes the later of its own value
and the session's.

A run start adds one to the agent's `total_sessions` only for a new
run, as the server counts a run once, when its row is first inserted.
The agent's `recent_sessions` holds its `RECENT_SESSIONS_WINDOW` (5)
newest runs by `started_at`, as the API builds it, and a re-attached
run keeps its `started_at`. So a start of a run in that window is a
re-attachment (or the same start again), and so, once the window is
full, is a start of a run that started before the window's oldest
run: a resumed Claude Code session, or a late OpenTelemetry record
re-opening a closed run. After a start the window is re-sorted by
`started_at`: a new run leads it, a re-attached run keeps its place,
and one older than a full window stays out. The page cannot tell such a
re-attachment from the first start of a genuinely new run that started
before the window's oldest run (an OpenTelemetry session created late
from an old record): it does not count that one either, and the next
fleet load (a new agent's run, a reconnect, a filter change) corrects
the count.

The agent's rolled-up `state`, which the Agents table, agent drawer and
per-agent modal badges show, comes from the update's `agent_state`: the
hub reads the agent's state with the same rollup the agent endpoints
use (`active` when any of its runs is active, else the state of its
most recently started run) and sends it with every broadcast. The page
holds only an agent's newest runs and the last day's, so a state
derived from those would miss a long-running run started earlier. The
agent row the page holds takes the value even when the update's run is
one the swimlane ignores; an update without `agent_state` leaves the
badge as it was. The swimlane row badge reads the session rows the
swimlane holds.

Every update's session state is also recorded in the store
(`lastSessionChange`) before it is applied, whether or not the page
holds the run, for the run drawer (see Session drawer).

`load()` (first load, filter change, a new agent's first run, the
reconnect catch-up) replaces `agents` and `flavors` with a snapshot the
API read while the request was out. An update broadcast after that
read can arrive before the response, and the worker sends each state
change once, so the store keeps such updates: while a load is in
flight, `applyUpdate` records the newest update per session, and the
load re-applies them over its snapshot in the order of each session's
latest update, so an agent's badge ends on the state sent last.
Updates applied before the load started are already in its snapshot
and are not re-applied. A run start adds to the agent row's run count
only when the row's recent runs do not already hold that run, so a
start re-applied over a snapshot that counted it, or a start that
arrives twice, counts once. A re-applied run start of an agent the
snapshot lacks (filtered out, or off the page) draws the run without
starting another load.

One load of a view (page, page size, type filter) runs at a time. A
call made while that view's load is in flight does not start a second
one: once the load lands, or fails (every API request times out after
30 seconds), one more load runs for all such calls, so each caller
still gets a snapshot read after its call (the new agent's row, what a
reconnect missed). A stream of calls (pages mounting together, new
agents arriving) therefore cannot keep every load from landing, and
the first paint waits for one load, not the last of several. A load of
another view (a type filter change) supersedes the one in flight,
which drops its result when it lands.

Broadcasts sent while the stream is down are lost. After the stream
reconnects, `useFleet` waits `RESYNC_DELAY_MS` (two seconds, twice the
first reconnect step, so an API that opens and drops the socket while
it restarts costs one refetch) and then `resync`s: it refetches the
fleet as the first load does and bumps `resyncSeq`, which tells an open
run drawer to refetch its run.

`sessionStateCounts` is computed via `useMemo` from the live `flavors`
array on every render and passed down to `SessionStateBar` as a prop.

The fleet store filters out orphan agents — rows in the `agents` table
from prior runs that have no sessions: `total_sessions` is 0 and
`recent_sessions` is empty. An agent whose `recent_sessions` carries a
session stays even when its counter reads 0, so counter drift cannot
hide a live agent.

### Events view

Component file `dashboard/src/pages/Investigate.tsx` mounted at the
`/events` route — a URL-driven facet sidebar plus an event table.
Rows are individual events across seven columns: the event
timestamp; the AGENT cell (agent flavor, the `ClientTypePill`,
and the `agent_type` badge); a run badge (the 8-char `session_id`
prefix); the event-type icon; the MODEL cell (provider logo,
model, and a framework pill — rendered only for LLM events that
carry a model); the humanized event detail string
(`lib/events.ts::getEventDetail`) with a trailing prompt-capture
indicator on events whose `has_content` is set; and a status
chip. The `framework` / `client_type` / `agent_type` values are
joined onto each event from its `sessions` row by `GET /v1/events`.
Default sort is newest-first; pagination defaults to page size 50.
A full-width search bar at the top of the page filters events
server-side via the `/v1/events` `q` param (free-text ILIKE
across event type, model, session id, and the session's agent
name and framework); Escape clears it.

A row click opens the `EventDetailDrawer`. The run-badge column
opens the run drawer (`SessionDrawer`) scoped to that event's run.

URL state round-trips via `parseEventsUrlState` /
`buildEventsUrlParams`. Filters apply by clicking facet pills in
the sidebar — an active pill carries `data-active` and
`aria-pressed`, and clicking it again clears that value. There is
no separate active-filter chip bar; the sidebar's highlighted
pills are the filter-state display.

The facet sidebar is event-grain. Its dimensions: AGENT (keyed on
`agent_id`, `agent_name` display labels, with a `CC` / `SDK`
client-type pill disambiguating same-named agents), `event_type`,
`policy_event_type`, `error_type`, `framework`, `model`,
`close_reason` (gated to `session_end` events), `estimated_via`,
`matched_entry_id`, `originating_call_context`, `mcp_server` (the
MCP event's `payload.server_name`, with a Claude Code plugin-bundled
server's flattened `plugin_<plugin>_<server>` key, which some stored
rows carry, read as `plugin:<plugin>:<server>` so one server is one
value; filtering on the colon key matches both
spellings), `terminal` (toggle), plus 9
runtime-context dims sourced from `sessions.context`: `os`,
`arch`, `hostname` (URL param `host`), `user`, `git_branch`,
`git_repo`, `orchestration`, `python_version`, `process_name`.
Each chip's count comes from the `/v1/events` facet-count query
(`facets=true`), computed over the active filter set. Each chip
also carries a per-dimension icon: a provider logo on MODEL, a
`FrameworkPill` on FRAMEWORK, the `ClientTypePill` + `agent_type`
badge on AGENT, the colored `EventTypePill` on EVENT TYPE +
POLICY (matching the table-row badge chroma at a glance), and a
`FacetIcon` category glyph everywhere else — `OSIcon` for the OS
column, `OrchestrationIcon` for the orchestration column, and
lucide glyphs (Fingerprint / Waypoints / Power for
`matched_entry_id` / `originating_call_context` / `terminal`;
Server / User / GitBranch / GitCommit / Cpu / Package / Terminal
for the runtime-context dims) so the sidebar reads as one icon
family across every dimension.
`policy_event_type` is not a server facet dimension — the
dashboard classifies the `event_type` facet's policy-enforcement
values into a separate POLICY group, and both groups write the
single `event_type` filter. The server returns `terminal` as a
counted `true`/`false` facet; the sidebar renders it as one
toggle. At event grain each event carries exactly one value per
dimension, so the per-session aggregate arrays (`error_types[]`,
`close_reasons[]`, …) have no event-grain analogue.

The drawer deep-link param is `?run=<session_id>`. The legacy
`?session=` param is still accepted and transparently rewritten to
`?run=` so existing bookmarks keep resolving.

Filtering composes server-side via `GET /v1/events`. `event_type`
and `model` are plain `events` columns; `error_type`,
`close_reason`, `estimated_via`, `matched_entry_id`,
`originating_call_context`, `mcp_server`, and `terminal` extract
from the `payload` JSONB; `framework` and `agent_id` resolve
through a `sessions` subquery (the `events` table has no
`agent_id` column and frameworks live on `sessions`). Multi-value
entries OR within a dimension; dimensions AND. The migration
`000023_events_facet_indexes` adds JSONB expression indexes for
the payload-extraction predicates. Footer count and pagination
total reflect the filtered total.

### Session drawer

`dashboard/src/components/session/SessionDrawer.tsx` — slide-in right
panel (520px). Two modes:

- **Mode 1** (default): session event list, token usage bar, Prompts tab.
- **Mode 2**: single-event detail (back-button to Mode 1), Details tab
  and Prompts tab for the focused event.

The active detail event is derived from props every render:
`activeDetailEvent = directDismissed ? internalDetailEvent:
(directEventDetail ?? internalDetailEvent)`.

`directEventDetail` is set by the parent when the user clicks an event
circle in the swimlane. `internalDetailEvent` is set by clicking "Open
full detail" inside the drawer. `onClearDirectEvent` is called by the
Back button so the parent knows the prop-fed event was dismissed. Mode is
rendered directly from `activeDetailEvent` truthiness.

The drawer header carries session ID + state badge, a Claude Code bar
for `claude_code` sessions (logo, label, `coding` badge, version and
source, see Session source), or the OpenTelemetry bar for an agent
framework's run, a metadata bar (its Duration is start to end for an
ended run, start to now for an open one), and a
collapsible RUNTIME panel (only renders when `session.context` is
non-empty; combines git / kubernetes / compose / frameworks fields).
Tabs: Timeline, Prompts, Directives (conditional). The Directives tab
only appears when the session runs custom directives (a sensor session
that supports directives, see Observer-session class) and
`flavorDirectives.length > 0` (filtered from the fleet store's
`customDirectives` slice by the session's flavor).

The drawer reads its run through its own fetch (`useSession`), and the
fleet store's live stream tells it when to refetch: on an
`mcp_server_attached` event of the run (the MCP SERVERS panel), when
the store's `lastSessionChange` reports the run in a `state` or with
an `ended_at` other than the drawer last asked for (the worker marking
it stale or lost, a close, a revival; recorded even for a run the page
does not hold), and when `resyncSeq` moves after the stream
reconnected. "Last asked for" is the change the drawer last refetched
for, or, before any since it opened the run, what it shows: a refetch
reads the run after the change it was started for, so a quick revival
that arrives while a stale refetch is in flight refetches again even
though the screen still shows the run active. The state badge carries
`data-testid="session-drawer-state"` and the state in `data-state`.

Operator-facing prose calls a session a **run**; the drawer is the
run drawer. It opens from five entry points: (1) an event circle on
the Fleet swimlane, (2) a run-bracket glyph on the Fleet swimlane or
in the per-agent swimlane modal, (3) a row in the agent drawer's Runs
tab, (4) the "View entire run →" link in the `EventDetailDrawer`
metadata section (on Fleet and in the per-agent modal), and (5) the
run-badge column on the `/events` event table. When opened from
the agent drawer (entry point 3) the optional `backLabel` /
`onBack` props render a "← Back to {agent}" breadcrumb that
returns to the agent drawer; the other four entry points omit
them.

An event's Prompts tab (the run drawer's event detail view and the
event detail drawer) loads `PromptViewer` for an event with
`event.has_content`, which shows the capture-disabled message when
`GET /v1/events/:id/content` fails for any reason (a 404, or any other
error, since the client reads every failed fetch as no content); an
event without content
shows one of the empty states below. A `session_signal` event's
Prompts tab shows its captured text instead, and without it the
capture-disabled message for a signal whose text the plugin always
sends while capture is on (`context_compacted`, `notification`,
`task_created`, `task_completed`, `elicitation_requested`), otherwise
"This event carries no captured text." An embeddings event's input is
shown by `EmbeddingsContentViewer` in its expanded event row. The run
drawer's Prompts tab lists the run's events that stored content of
the types `post_call`, `tool_call`, `mcp_tool_call` and
`mcp_prompt_get`, each opening in `PromptViewer`. The viewer's
header names the provider and, when the content names one, the model.
Provider terminology is preserved exactly — Anthropic sessions display
`system`, `messages`, `tools`, and `response` as separate fields; OpenAI
sessions display `messages` (system role included), `tools`, and
`response`. An OpenAI Responses call (the sensor's `responses` calls
and litellm's) is shown in the Responses API's own terms: its stored
`system` text under `instructions`, and its stored `input` under
Input, a string as written and an input item list as one box per item:
a message item with its role and its content parts (`input_text` and
`output_text` as text, `refusal` labelled, `input_image`, `input_file`
and `input_audio` named by type), a `function_call` with its name,
`call_id` and arguments, a `function_call_output` with its `call_id`
and output, a `reasoning` item with its summary text, and any other
item type labelled by its `type` and shown as its JSON, never dropped.
Its function tools, which the Responses API declares flat (`name`,
`description`, `parameters`), show their parameters, and a hosted tool
(`web_search_preview` and the like) is named by its `type`. A legacy
completion (litellm's `text_completion`) shows its stored `input` under
Prompt, the request parameter it holds: a string as written, a list of
prompts as one box each, token ids as their JSON. The viewer knows
either call by the stored response's `object`, which the API sets on
every response object: `"response"` for a Responses call and
`"text_completion"` for a legacy completion (a chat completion carries
`chat.completion`, an embeddings response `list`, an Anthropic message
has none). Neither the event nor the content names the API a call
used, and the content's shape alone (no `messages`, an `input`) is the
same for a Responses call, a legacy completion and an embeddings call.
A call whose stored response carries no `object` shows no Input or
Prompt, and its stored `system` text under System. A Responses stream
the caller leaves before its terminal event still stores a response
that carries `object`: the OpenAI SDK's `ResponseStreamState` snapshot,
built from `response.created` on, and for litellm the latest response a
`response.created` / `response.in_progress` event carried
(`status: "in_progress"`, no output). An embeddings
call's input stays with `EmbeddingsContentViewer`. A tool call's content (the sensor's `tool_call`,
`mcp_tool_call` and `mcp_prompt_get`, and Claude Code's `tool_call`
over OpenTelemetry) shows its stored `tool_input` as Arguments and its
`tool_output` as Result, an object as labelled fields, text as written
and any other value as JSON; the `{}` such a row holds in `response`
is not shown as a response. The Claude Code plugin's hook `tool_call`
keeps its `tool_use` block under `tools` and its `tool_result` under
`response`, and shows them there. Content stored with
`provider=otel_genai` (an OpenTelemetry
GenAI framework's; see OTLP ingest > GenAI dialect > Capture) is
displayed as the framework sent it by its own renderer, never through a
provider's branch, under an `OpenTelemetry GenAI` header:

- the system instructions (JSON in the text column, shown as the parts
  or blocks they hold), each input message and each response message,
  in its own box with its role and `finish_reason`;
- a message's `parts` (the GenAI conventions: `text`, `reasoning`,
  `tool_call` with its arguments, `tool_call_response` with its result
  or response, `uri`, `blob` and `file` named by type), else its
  `content` or `message` list (Strands' Bedrock-style `text`, `toolUse`
  and `toolResult` blocks under the older conventions), else the
  message as stored; text is shown as written, so OpenAI Agents' repr
  of an SDK object stays that text;
- a tool call's arguments and result (`tool_input`, `tool_output`);
- the call's tool definitions, folded when the call has messages;
- a part or block it does not know as its JSON, and content with no
  messages, response or tool input and output as its stored fields.

Every box keeps its Pretty / Raw toggle, Raw showing the value as
stored.

The Prompts tab's empty states read the run's stored capture posture,
`capture_prompts` on `GET /v1/sessions/:id` (the run drawer and the
event drawer both load the run through it), and whether any of its
events stored content (`capture_enabled`). Capture is on for a run when
either is true: a run older than the stored posture carries `null`
there, and content can only have been stored with capture on.

- capture off: the capture-disabled message (CLAUDE.md rule 21);
- capture on and nothing stored for the run: "No content was recorded
  for this run", and, for an OpenTelemetry GenAI run, why: the
  framework sent none (its own content switch off, or only tool
  definitions, which store none);
- capture on and nothing stored for one event (its detail view's
  Prompts tab): "No content was recorded for this event", and, for an
  OpenTelemetry GenAI run, why: a call whose framework sent no
  messages, or a Google ADK tool call, whose arguments and result are
  inside the next model call's messages.

The Sub-agents tab shows its capture-disabled message by the same
rule (a message body on the run's events also counts as capture on).

Streaming `post_call` rows render TTFT in the detail string and a
`<StreamingPill>` (`STREAM` for completed, `ABORTED` for aborted). The
expanded grid grows TTFT, Chunks, Inter-chunk, and Stream outcome rows.

`llm_error` rows render an `<ErrorEventDetails>` accordion with
request_id, retry_after as `<n>s`, is_retryable as a `Retryable` /
`Not retryable` pill, plus abort_reason and partial chunks/tokens on
stream-error variants.

### Event detail drawer

`dashboard/src/components/fleet/EventDetailDrawer.tsx` — standalone
right-slide drawer (520px) for a single event opened from the live
feed (independent of `SessionDrawer`). Tabs: Details, Prompts,
Neighbors. The Details tab shows a summary grid, the shared
`<EnrichmentSummary>` block (operator-actionable enrichment fields:
policy_decision_*, provider_metadata, output_dimensions,
retry_attempt + terminal, close_reason, policy_actions_summary,
policy_entries_orphaned, sensor_version + interceptor_versions,
policy_snapshot, originating-event jump link), and the JSON
payload via the shared `<SyntaxJson>` component. The Prompts tab
is the event Prompts tab described under Session drawer (it loads
the event's run to pick its empty state, and its empty state shows
nothing until the run has loaded). The Neighbors tab renders
`<SurroundingEventsList>` — ±5 events from the same session,
clickable to swap the drawer's displayed event. It brackets the open
event's `occurred_at` with two `GET /v1/events` calls, the events up to
it newest first and the events from it oldest first with no upper
bound (each a few more than five, for events sharing its timestamp), so
the window is the event's own however deep it sits in a long session.
Events are ordered by `occurred_at` to the microsecond, then id.

The summary grid comes from `getSummaryRows` in
`dashboard/src/lib/events.ts`, which the session drawer's expanded
row and its full-detail view use too. For an LLM call (`post_call`)
it lists the model, input, output and total tokens and latency, then
each generation field the client reported (cache reads, cache writes
with the one-hour share, reasoning tokens, stop reason, server tool
counts) and each serving field: the verbatim requested or served
model id where it differs from the canonical `model`, billing mode,
platform, service tier, speed, inference geo and scope, and
`cost_reported` with its `cost_source`. An `embeddings` call lists
its model, input tokens and latency, then the same serving fields. A
field the client did not report (or a count of zero) has no row, so
a call from a client that reports none keeps its base rows. An event
that names no model (Claude Code's prompt record over OpenTelemetry
carries none) shows `—` in its Model row and leaves the model out of
its feed line, a line with nothing else reading `—`; no surface shows
a model it was not told. A streaming block that holds only `ttft_ms`
and `final_outcome` lists TTFT and Stream outcome and no chunk rows.

The same `<EnrichmentSummary>` and `<SurroundingEventsList>`
components are also embedded in the in-page `EventDetailView` that
the SessionDrawer's Timeline tab opens via the per-row "Open full
detail" affordance, so the two surfaces (slide-in drawer + in-page
replacement view) render byte-identical enrichment fidelity.

### Live feed

`dashboard/src/components/fleet/LiveFeed.tsx` renders `FeedEvent[]`
capped at `FEED_MAX_EVENTS` from the back, then optionally filtered by
`activeFilter`.

Columns: Flavor, Session, Type, Detail, Time. Default sort is `time desc`.
Clicking any non-time column header changes the sort and auto-pauses the
feed via `onPause`.

Display order is driven by `arrivedAt` (the FeedEvent field) so events
always appear in the order the dashboard received them. The "Time"
column shows `arrivedAt` formatted as wall-clock time. The column header
row is `position: absolute` with `z-index: 10` to stay pinned above the
scrollable rows.

Header badge:

- Live: `${filtered} of ${capped} events` when a filter is active,
  otherwise `${filtered} events`.
- Paused (queue under cap): `Paused · ${queueLength} events waiting` in
  amber.
- Paused (queue at cap): `Paused · ${queueLength} events buffered (oldest
  dropped)` in orange.
- Catching up: `Catching up...` while a queue drain is in progress.

Column widths and panel height persist to `localStorage` under
`FEED_COL_WIDTHS_KEY` and `FEED_HEIGHT_STORAGE_KEY`. All rows render
directly (no virtualised window) — simpler and faster in practice for
the 500-event cap.

### Bulk historical events hook

`dashboard/src/hooks/useHistoricalEvents.ts` loads the selected
window's events through `fetchBulkEvents` (`GET /v1/events`), newest
first (`order=desc`), `HISTORY_PAGE_SIZE` (1,000) events per request.
The window's `from` and `to` are fixed when the range is picked. Each
page after the first continues from the oldest event the previous page
returned, with the keyset cursor (`before` + `before_id`). The hook
keeps requesting pages while `has_more` is true, until the window is
complete or `HISTORY_DRAIN_MAX_EVENTS` (5,000) events are loaded, so a
window busier than the cap loses its oldest events, never its newest.
A failed page stops the drain and a range change aborts it. The hook
returns the events loaded so far, oldest first, after every page; the
previous range's events stay in place until the new range's first page
arrives.

Fleet merges every page into `eventsCache` by event id
(`mergeIntoEventsCache` in `useSessionEvents.ts`), keeps each run's
list in the server's order (`occurred_at` to the microsecond, then
`id`; `dashboard/src/lib/event-order.ts`), and bumps the version of
only the runs whose list changed. Every writer of the cache merges the
same way and never replaces or drops a run's list: live WebSocket
events, a run's own history fetch (`useSessionEvents`), the run
drawer's fetch (`useSession`) and its "Show older" pages, the
per-agent swimlane modal's seed and live ticks, and the event deep
link's newest-first pages (`findSessionEvent`). Switching ranges
therefore only adds circles. A run with nothing cached fetches its
history once, when its row first mounts.

Every load ends at the run's newest event (a window, a run's own
fetch, the drawer's newest `events_limit`) or continues back from the
oldest event already held (the drawer's "Show older"), so a run's
cached events have no gap in the middle. Live events sent while the
WebSocket was down would leave one, so when the stream reconnects
Fleet loads the selected window again, ending at that moment (the
store's `resyncSeq`, which also refetches the fleet); the merge by id
keeps what is already held. The run drawer's "Show older"
calls `fetchOlderEvents`, the keyset variant of the same endpoint:
`before` and `before_id` name the oldest event the drawer holds, picked
in the server's order, with `order=desc`. The drawer's page-size pill
sets how many events its fetch and each "Show older" page ask for;
changing it refetches the run and merges the answer, so the drawer
keeps showing every event it already holds.

The live feed is seeded from the same pages and keeps the newest
`FEED_MAX_EVENTS` events by arrival (`mergeFeedEvents`), so history
that loads after live events never displaces them. The Fleet sidebar's
Directive Activity and Policy Events panels read the feed, so they
show the window's newest events too.

### Timeline

`dashboard/src/components/timeline/Timeline.tsx` composes flavor rows
with expand-in-place, a shared time axis, and a resizable left panel.

`leftPanelWidth: number` state initialises from
`localStorage[LEFT_PANEL_WIDTH_KEY]` clamped to
`[LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH]` = `[200, 640]`. Default
is `LEFT_PANEL_DEFAULT_WIDTH` (460), sized so a typical `user@host`
agent name plus the full pill chrome (client-type pill, agent-type
badge, provider/OS/orchestration icons, relationship pill, status
badge) fits without truncation on first load. A sub-agent row keeps
its `/{role}` suffix whole and gives way at the head of its name (see
the SwimLane section). `LEFT_PANEL_MAX_WIDTH` (640) gives operators
room to drag wider for verbose sub-agent role strings; below the
width at which a given name fits, the agent-name link
ellipsis-truncates with an always-on `title` tooltip.

A drag handle is rendered absolutely on the right edge of the
inner content div, full-height so it stays grabbable as flavor
rows scroll past. The handle is a transparent 10px-wide
hit-area positioned at `left: leftPanelWidth - 5` so the 10-px
grab strip straddles the column's right border without
displacing the visible 1-px column edge; on hover, the strip
fills with `var(--accent)` to surface the affordance. The drag
binds `pointermove` + `pointerup` + `pointercancel` listeners
on `document` rather than `mousemove`/`mouseup` so Firefox's
text-selection heuristic over the label strip can't abort the
drag mid-gesture. The handler clamps the new width on every
move and writes through to localStorage immediately via
`persistLeftPanelWidth`, which also dispatches a same-tab
`CustomEvent` so Fleet.tsx's left-fade overlay tracks the
column edge in lockstep.

`leftPanelWidth` flows down as a prop through `VirtualizedSwimLane` to
`SwimLane`, whose `React.memo` comparator includes it so a drag
invalidates every row immediately.

Fixed-width canvas: `TIMELINE_WIDTH_PX = 900`. The xScale maps the
selected range domain to `[19, 881]` for every time range: the panel
less `TIMELINE_SCALE_INSET_PX` (19 px, half a 22 px circle plus an 8 px
buffer) at each end. The oldest circle therefore clears the label strip
by the buffer, and a circle at "now" sits whole inside the panel, as
does the ▶ of a run that has just started. Wider ranges produce denser
circles, which is the correct trade-off: fixed pixel space, no
horizontal scrollbar, label intervals adapt to the range. The rows, the
grid overlay and `TimeAxis` share this one scale, so an event's circle,
its time's grid line and that line's label sit at one x.

`TimeAxis.tsx` renders 6 evenly-spaced relative labels (e.g.
`48s 36s 24s 12s now` for a 1-minute range) at fractions
`[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]` of the range, placed with the
Timeline's scale. The `formatRelativeLabel(ms)` helper
picks the unit suffix: `s`, `m`, or `h`. No D3 tick generation — D3 is
used for `d3-scale` and `d3-time` math only.

A vertical grid line overlay on Timeline.tsx renders 6 thin vertical
lines at the same fractions as the time-axis labels, dropping from the
top of the inner content div to the bottom of the last flavor row. The
rightmost line is highlighted as the "now" line in `var(--accent)`; the
rest are `var(--border)` at low opacity. Constrained to the right-panel
area only (`left: leftPanelWidth, width: timelineWidth`).

A fleet-wide ALL aggregate row sits above the AGENTS section,
rendered by `AllSwimLane` in `SwimLane.tsx`. It merges every
session's events across every agent onto a single pulse line so
operators see fleet-wide activity without scanning each row.
Its visibility is collapsible and persisted to
`localStorage[ALL_ROW_COLLAPSED_KEY]` (`"1"` collapsed, `"0"`
expanded; default collapsed) via `lib/allRowCollapsed.ts`. When
collapsed, the row reduces to a 24px-tall toggle bar (matching
the AGENTS section header height directly below) carrying a
`ChevronRight` icon + "All" label; clicking the toggle expands
the row to its full 36px height with the aggregated pulse pane
(`data-testid="swimlane-all-pulse"`) on the right. The pane uses the
agent rows' scale, so a given time sits at the same x on every row, and its circles sit on the pane's
centre line, inside the row. The default
is collapsed because the `/agents` page now serves as the
dedicated fleet-overview surface — the pulse line is redundant
for most operators but stays one click away. The ALL row
ignores the CONTEXT sidebar filter (it's a fleet-wide
overview, not a filtered subset); the event-type filter bar
still applies inside each circle via `EventNode.isVisible`.

### SwimLane

`dashboard/src/components/timeline/SwimLane.tsx` renders one row per
agent, with one label, one status badge and a fixed 48 px height. Every
event of every one of the agent's runs streams onto that row; there are
no per-run rows. While two or more of the agent's runs overlap inside
the window, the row's timeline panel splits into run lanes, one per run
(see Run lanes); otherwise every run shares one line. Sub-agent rows render indented beneath their parent
via the `data-topology` attribute (`"root"` or `"child"`); the indent
and background tint live in `globals.css` under the
`[data-topology="child"]` selector. The tint is translucent, so a child
row's sticky label paints it opaquely, in layers: its own tint, the
row's 2 px accent line, the row's tint, and the colour the rows sit on
(`--bg`, or the host's `--swimlane-label-backdrop`, which the per-agent
swimlane modal sets to `--surface`). At rest that is the row's own look.
Event circles scrolled under the label therefore stay hidden. The
accent line is part of the label's paint, so when the swimlane scrolls
sideways the label keeps a 2 px accent line pinned at its left edge,
while the row's own line scrolls away with the row. A root row's label
inherits the row's opaque `--surface`. `SubAgentConnector.tsx` draws a
Bezier connector from each parent spawn event to the child run's first
event in view (see Swimlane sub-agent connector overlay).

The left panel of each row carries the agent label strip, in this
left-to-right order:
1. optional `ClaudeCodeLogo` (on a Claude Code row: `client_type`
   `claude_code`, or the `claude-code` flavor);
2. agent name;
3. `ClientTypePill` (the registry label, e.g. "Claude Code", "Sensor");
4. `TelemetrySourcePill` (`OTEL`, only when the agent reports over
   OpenTelemetry, see Session source);
5. agent_type badge (coding / production);
6. provider icon;
7. OS icon;
8. orchestration icon;
9. `RelationshipPill` (`↳ parent` on a sub-agent row, `→ N` on a
   parent, none on a lone agent);
10. optional `SubAgentLostDot` (when the most recent sub-agent session
    per role is in `lost` state);
11. `AgentStatusBadge` at the right edge.

The agent-name link (`data-testid="swimlane-agent-name-link"`) sets
`white-space: nowrap`, `overflow: hidden` and `text-overflow: ellipsis`,
so a too-narrow column truncates the name rather than wrapping it. It
carries a native `title` with the full `agent_name` at every width. A
`min-width: 3rem` floor (about six characters plus the ellipsis at the
13 px label font) keeps the name from collapsing: at the 200 px
`LEFT_PANEL_MIN_WIDTH` floor, the trailing chrome clips against the
strip's `overflow: hidden` first.

On a sub-agent row whose name ends in `/{agent_role}` (the role of its
most recent run), the name renders in two parts: a head, which
truncates first, and the role suffix
(`data-testid="swimlane-agent-name-role"`). The part that differs from
the parent's row therefore stays readable. The role part keeps its
full width and truncates only once it fills the whole link; it does
not share the head's shrink, because a fraction of a pixel of shrink
is enough for the browser to draw its ellipsis. The row's relationship
pill shrinks, down to 1.75rem with an ellipsis, before the name gives
up any width. At the 460 px default, a typical `user@host/role`
sub-agent row shows its role. The link's `aria-label` carries the
whole name, since the two parts would otherwise read with a space
between them. Root rows, and sub-agent names without the suffix, render
as one text.

The ellipsis fallback is the graceful narrow-width behaviour. The
resizable column (see Timeline section above) is the operator's
primary recourse for a long name, and its `localStorage`-persisted
width survives reloads.

The provider / OS / orchestration icons derive from the agent's
most-recent session; the per-event provider logos on event circles
carry the granular per-call attribution. Per-agent state is the
max-priority state across the agent's runs (active > idle > stale
> closed > lost). The `STATE_ORDINAL` map in `SwimLane.tsx` defines
the ranking that rolls multiple session states up into a single
per-agent badge state.


`AgentStatusBadge.tsx` renders the state colour dot + label via
the shared `StatusDot` primitive (`lib/agent-status.tsx`). When
state is `active`, the dot picks up the
`agent-status-active-ring` class which renders a rotating
gradient arc around the dot on a `::before` pseudo-element —
the conic-gradient is static, only `transform` rotates so the
animation is GPU-cheap when many dots paint at once.
`@media (prefers-reduced-motion: reduce)` falls back to a
static soft glow. Theme-agnostic — colours resolve to
`var(--status-*)` custom properties.

**Run segments.** `dashboard/src/lib/swimlane-lanes.ts` works out
where each of the row's runs ran, as pure functions with no DOM and no
D3 beyond the shared scale. A run is one or more segments: each stretch
from a `session_start` to the following `session_end` is a segment, and
the time between a `session_end` and the next `session_start` (a run
resumed under the same session id, see Session attachment flow) is a
gap, where the run draws nothing. The first segment starts at the run's
`started_at`, which a resume keeps, so an event dated more than the
two-second attach match window before it is not a boundary of the
run. A `session_start` inside a segment, a client re-attaching to a
run that never ended, continues that segment.

The session row describes the run's last segment, in the state the
worker last announced (the dashboard applies no stale or lost
thresholds of its own, see Fleet view):
- an `active`, `idle` or `stale` run is open, and its last segment
  reaches the window's right edge;
- a `lost` run's last segment ends at its `last_seen_at`;
- a `closed` run's last segment ends at its `ended_at`, unless the
  orphan-timeout reaper closed it. A reaped segment ends at the run's
  `last_seen_at`, which the reaper leaves at the run's last signal,
  and reads as lost. The reaper's close is a `session_end` whose
  `close_reason` is `orphan_timeout`: the run's last `session_end`
  when the page holds it, otherwise the run's `close_reasons`. Every
  session row the page holds carries them: `GET /v1/sessions`, the
  agents' `recent_sessions` rollup, and the session the live stream
  re-reads (`GetSession`), and a live update keeps the reasons the
  page already knew when its row lacks them.

An earlier segment that the reaper closed ends at the run's last event
before that `session_end`, and reads as lost too.

Segment boundaries come from the run's events the page holds
(`eventsCache`, see Bulk historical events hook). A run fetches its
whole history once, when its row first mounts with nothing cached for
it; a run whose events in the selected window reached the cache first
holds only those and the live ones. So:
- a run with no events loaded draws as one segment from its
  `started_at`;
- a run whose earliest loaded event is a resume's `session_start`
  draws nothing before that start, since the boundaries before it are
  not loaded;
- a run that the session row shows running again after its last
  loaded `session_end` starts its last segment at its first loaded
  event after that end, or at its `last_seen_at` when there is none.

The run drawer lists every event of a run, gaps included. The events
cache notifies its readers on every write, and SwimLane re-derives the
row's segments when it changes.

**Run lanes.** Every segment of every run the row holds gets a
track, in start order, with ties broken by run id: the lowest track
that is free when the segment starts and whose last segment ended no
more than one window span earlier; otherwise a new track below the
others. A track is free once its last segment has ended, within a
tolerance (`OVERLAP_TOLERANCE_MS`, 1 s, or one pixel of the window when
that is longer). The worker stamps a run's `started_at` and the
previous run's `ended_at` with its own clock as it processes each
event, so a hand-off can overlap by a few milliseconds. A gap frees its
track, so a run that ran inside another run's gap shares that track,
and the segments of a resumed run can sit on different tracks.

A segment is in view when it overlaps the window, and only segments in
view count. When no two segments in view overlap inside the window by
more than the tolerance, the row is one line (`data-lane-count="1"`):
22 px circles on the row's centre line and glyphs on its top edge. A
hand-off does not count as an overlap. Otherwise the tracks with a
segment in view become lanes, in track order: the panel's 47 px of
content (the 48 px row less its bottom border) splits into equal
lanes, and each lane draws its segments' circles, glyphs and run line
on its centre (`data-lane-count`, 2 to 4).

| Lanes | Lane height | Circle | Icon | ▶ / ■ |
| --- | --- | --- | --- | --- |
| 1 | 47 px | 22 px | 13 px | 10 / 11 px, top edge |
| 2 | 23.5 px | 18 px | 11 px | 10 / 11 px, lane centre |
| 3 | 15.7 px | 12 px | 8 px | 10 / 11 px, lane centre |
| 4 | 11.75 px | 10 px | none | 8 / 9 px, lane centre |

`LANE_GEOMETRY` in `lib/swimlane-lanes.ts` holds the table. At four
lanes the circles of neighbouring lanes stay 1.75 px apart, and a
10 px circle has no room for an icon, so it is coloured only.

As a result:
- a run that ends as another starts hands its lane on;
- runs that start together get separate lanes;
- a track with nothing in view closes, and the lanes below it move
  up, so the top lane is always in use;
- a run that starts takes a free lane already shown or opens one at
  the bottom, so it moves no shown run. The exception is a run first
  drawn after its start (a page catching up after a pause or in a
  background tab): it can reuse a track that left the window in the
  meantime, and the lanes below it move down;
- a range switch re-assigns every track, since the warm span is one
  window.

At most `MAX_RUN_LANES` (4) lanes are drawn. When more tracks are in
view, every segment from the fourth track on shares the fourth lane,
the overflow lane: the row carries `data-lane-overflow="true"`, and
each glyph and line in that lane says how many runs share it.

Each segment's circles, glyphs and line carry its lane as
`data-run-lane` (`0` is the top lane). A circle takes the lane of its
run's segment that holds its time; an event outside every segment in
view, such as the reaper's synthetic `session_end` long after the run's
last signal, takes the lane of the run's nearest segment in view, and
otherwise the top lane. A layout change applies at once, with no
animation; the lanes change only when a segment starts, ends or leaves
the window.

**Run glyphs.** `RunBracket.tsx` draws each mark SwimLane places, at
the start and end of each segment in view, on the row's top edge on a
one-line row and on its lane's centre on a split row:
- The start glyph is a filled triangle (▶) in `var(--accent)`. Its
  flat base sits 1 px inside the segment's start, and it points into
  the segment.
- The end glyph is a square whose right edge sits 1 px inside the
  segment's end, about 1.3 times the triangle's bounding-box area so
  the closure reads heavier. A closed segment's square is filled with
  `var(--accent)`; a lost segment's square is hollow, with a
  `var(--status-lost)` stroke. The button carries the kind as
  `data-end-kind` (`closed` or `lost`).
- An open segment has no end glyph, so a missing square reads as
  "still running".

Each glyph is drawn when its own time is in the window, so a segment
that started before the window still shows its end. A segment's
square always follows its own triangle, past the segment's end when
the segment is narrower than the two glyphs, so a short run reads ▶■.
Glyphs in one lane are spread apart where they would overlap: they sit
side by side in time order, 1 px apart, with an end before a start at
the same instant, so a hand-off reads ■▶. A glyph that would cross the
panel's right edge, as on a crowded edge near "now", is pulled back
inside it with the glyphs before it; a lone ▶ at "now" fits inside the
scale's inset and stays at its time. No glyph
moves more than `MAX_GLYPH_SHIFT_PX` (24 px, the shift a zero-length
run's square needs to follow its triangle) from where its time puts
it, so on a busy row, where spreading every glyph would carry it far
from its run, glyphs past that limit overlap near their own time
instead. Every glyph also stays inside the panel, never under the
label column. A glyph sits inside its segment's span, so the centre of
the circle at a segment's start or end stays clickable.

Each glyph is a `<button>` at z-index 2, with a `var(--accent)`
focus-visible outline and an `aria-label` that names the run, the
glyph, its time and, on a split row, its lane. Hover or focus opens a
portal tooltip with the run id prefix, the segment's start, its end
(`hh:mm:ss`, `running`, or `lost · last seen hh:mm:ss`), the run's
state and total tokens, on a resumed run which segment it is
(`segment 2 of 3`), and on a split row its lane (`lane 2 of 3`, or
`lane 4 of 4 · shared by 2 runs`). A click opens the run drawer scoped
to that run, in the Fleet view and in the per-agent swimlane modal.
Glyphs are React-rendered SVG positioned with the shared `xScale` (D3
is used for math only, never to manipulate the DOM).

**Run lines.** On a split row each segment in view draws a 2 px line
in `var(--accent)` at 60% opacity along its lane's centre
(`data-testid="swimlane-run-line-<id8>"`, a `<button>` under the
circles and glyphs):
- it runs from the segment's start, or from the panel's left edge when
  the segment started earlier, to its end, or to the now line while
  the segment is open;
- a `stale` run's open segment is dashed from its `last_seen_at` on
  (`data-tail="quiet"`, else `live`), the worker's own stale mark, so
  a run that went quiet reads as such without the dashboard keeping a
  threshold of its own;
- it rises to full opacity while any mark of its run (circle, glyph or
  line) on the row is hovered or focused;
- a click opens the run drawer, like a glyph;
- it takes keyboard focus (with the glyphs' focus-visible outline)
  only when neither of its segment's glyphs is in view, so every
  segment on a split row has a keyboard path without doubling the tab
  stops.

The overflow lane's lines overlap one another, so they take no pointer
input there (the lane's glyphs and circles do); they still draw, show
the hovered run's extent and take keyboard focus when their glyphs are
out of view. A one-line row draws no lines.

**Event circles.** `EventNode.tsx` draws each event as a 22 px circle
(`EVENT_CIRCLE_SIZE`), or the lane size above on a split row, coloured
by event type, with a lucide icon sized to the circle (none at 10 px),
a portal tooltip and a 1.25x hover scale; MCP events are hexagons. A
circle is centred on its event's x, so a circle at a grid line's time
sits on that line. It sits on the row's centre line, or its lane's centre, and carries
`data-event-id`, `data-session-id` and `data-run-lane`. The vertical
centring is a single CSS translate (`top` at the line's percentage
with `translate: 0 -50%`); the hover scale is a separate `transform`,
so it scales about the circle's centre. Sub-agent connectors measure
the rendered circles, so they land on a circle in any lane.

The time scale's 19 px inset at each end of the panel (see the
fixed-width canvas above) keeps the oldest circle clear of the label
strip and the newest one, at "now", whole inside the panel; the grid
overlay draws the now line through its centre. Glyphs are kept inside
the panel's own edges, so one packed at "now" fits in the inset.

Circles are coloured by event type, never by run, and render at once,
with no mount fade. Runs are told apart by lane, line and glyphs.

`SwimLane` is wrapped in `React.memo` with a custom comparator that
includes `activeFilter`, `leftPanelWidth`, `sessionVersions` and the
scale's domain. `EventNode`'s comparator compares the circle's
position, size, visibility and event fields, so a row re-render leaves
unchanged circles alone. The scale's right edge is floored to whole
seconds, so the domain, and with it every circle's x, changes at most
once per second. A WebSocket event still re-renders the rows, through
the `sessionVersions` map.

`VirtualizedSwimLane.tsx` wraps `SwimLane` with an
IntersectionObserver-backed virtualizer so off-screen agent rows
render as lightweight placeholders. A row keeps its 48 px height in
every lane layout, so a placeholder never changes size when a row
splits. Specs that locate a fixture
agent must scroll the fixture into view before asserting on its
`data-testid` (see `bringSwimlaneRowIntoView` in
`tests/e2e/_fixtures.ts`).

### Fleet panel sidebar

`dashboard/src/components/fleet/FleetPanel.tsx` (240px) renders
section headers (uppercase tracked), fleet overview, session states
(large counts), flavor list (active border), policy events, directive
activity, and CONTEXT facets.

CONTEXT facets render one filterable group per `context_facets` key
with 2+ values (single-value facets are skipped); click-to-toggle with
`onContextFilter`; clear-all `X` in the header when filters are
active.

Each sidebar row is an agent, keyed by its `agent_id`, while a sensor
registers custom directives under the flavor string its sessions carry.
The row's `Directives` icon button therefore lists the directives
registered under any flavor its sessions run as, and appears when that
list is non-empty and at least one live (active or idle) session of
the agent runs custom directives (see Observer-session class). A
`DirectiveCard` opened from the row sends the directive with the row's
`agent_id`, so it reaches this agent's live runs whose flavor
registered it and never another agent's runs that share the flavor.
The `Stop All` button appears when at least one live session of the
agent takes directives, and sends one `shutdown` request with the
row's `agent_id`; the API stops every live run of the agent that can
act on it, including runs the dashboard has not loaded, and the
success message names how many runs the stop reached. Both
buttons are icon-only (Zap and OctagonX from lucide-react) so they
don't push the agent name to truncate at the 240px sidebar width.
Clicking the first opens a Dialog with one `DirectiveCard` per
directive.

DIRECTIVE ACTIVITY section shows the 5 most recent `directive` and
`directive_result` events with a colored status dot (green for
`directive_result`, purple for `directive`), `flavor · truncated session
id`, and timestamp. Hides BOTH header and body when the recent-activity
buffer is empty.

`applyUpdate(update: FleetUpdate)` snapshots whether the session's
flavor is already in the store BEFORE mutating flavors. If
`update.type === "session_start"` and the flavor is new, the store
fires `fetchCustomDirectives` and patches the result into the
`customDirectives` slice. The new `FlavorItem` picks up the resulting
Directives icon button automatically because `FleetPanel` reads
`customDirectives` via a `useFleetStore` selector. Best-effort —
failures are swallowed.

### Directives page

`dashboard/src/pages/Directives.tsx` — dedicated page. Header + flavor
`Select` + search input. Renders one card per known custom directive
(loaded from `GET /v1/directives/custom`), with its registration
details and a trigger that targets every live run of the directive's
flavor or one run picked by id.

The shared `DirectiveCard` (`components/directives/DirectiveCard.tsx`)
serves the Fleet sidebar row's dialog and the SessionDrawer Directives
tab. It renders the directive name, description, parameter inputs
(string / int / float / bool / select via Radix Select), and a Run
button. The button targets a single session (`sessionId`, the run
drawer) or the live runs of an agent (`agentId`, the Fleet row; the
request carries the directive's own flavor, so only the agent's runs of
the flavor that registered it are reached). After an agent-wide send it
names how many runs the directive reached.

### Settings page

`dashboard/src/pages/Settings.tsx` carries the access token CRUD UI.
List, create, revoke, rename. Plaintext is shown once at creation and
never recoverable afterwards. Token name badge renders on sessions in
Fleet, Events, and the session drawer so operators can trace
which access token opened each session.

### Theme system

Two themes shipped: neon dark and clean light. Defined entirely in
`dashboard/src/styles/themes.css` via CSS variables. The `useTheme`
hook toggles a class on the `html` element and persists to
`localStorage[THEME_STORAGE_KEY]`.

Both themes are first-class — every component renders correctly under
each. Tests run under both theme projects via Playwright's `projects`
config and assertions are theme-agnostic.

### Constants

`dashboard/src/lib/constants.ts` is the single source of truth for
tunable magic numbers:

| Constant | Value | Purpose |
|---|---|---|
| `FEED_MAX_EVENTS` | 500 | Live feed display buffer cap |
| `PAUSE_QUEUE_MAX_EVENTS` | 1000 | Pause queue cap |
| `HISTORY_PAGE_SIZE` | 1000 | Events per request of Fleet's history load |
| `HISTORY_DRAIN_MAX_EVENTS` | 5000 | Most events Fleet's history load keeps per window (its newest) |
| `EVENT_LOOKUP_PAGE_SIZE` | 2000 | Events per request when the event deep link reads a run newest first |
| `EVENT_LOOKUP_MAX_PAGES` | 25 | Most pages the event deep link reads before it reports the event not found |
| `FEED_INITIAL_LOAD` | 100 | Initial fleet store load size |
| `FEED_MIN_HEIGHT` | 120 | Live feed resize lower bound |
| `FEED_MAX_HEIGHT` | 600 | Live feed resize upper bound |
| `FEED_DEFAULT_HEIGHT` | 240 | Initial feed height |
| `FEED_HEIGHT_STORAGE_KEY` | `flightdeck-feed-height` | localStorage key |
| `FEED_COL_WIDTHS_KEY` | `flightdeck-feed-col-widths` | localStorage key |
| `FEED_COL_DEFAULTS` | `{flavor:120, session:80, type:96, detail:400, time:80}` | Default column widths |
| `LEFT_PANEL_MIN_WIDTH` | 200 | Resizable swimlane left panel lower bound |
| `LEFT_PANEL_MAX_WIDTH` | 640 | Upper bound |
| `LEFT_PANEL_DEFAULT_WIDTH` | 460 | Initial width if no localStorage value |
| `LEFT_PANEL_WIDTH_KEY` | `flightdeck-left-panel-width` | localStorage key |
| `ALL_ROW_COLLAPSED_KEY` | `flightdeck-all-row-collapsed` | Fleet ALL-row collapse state |
| `ALL_ROW_HEIGHT_COLLAPSED` | 24 | ALL-row height when collapsed (matches AGENTS header) |
| `ALL_ROW_HEIGHT_EXPANDED` | 36 | ALL-row height when expanded (pulse pane) |
| `TIMELINE_WIDTH_PX` | 900 | Fixed event-circles canvas width |
| `TIMELINE_SCALE_INSET_PX` | 19 | Time scale inset at each end of the canvas (half a circle plus an 8 px buffer); `Timeline.tsx` |
| `TIMELINE_RANGE_MS` | `{1m: 60_000, 5m: 300_000, 15m: 900_000, 30m: 1_800_000, 1h: 3_600_000}` | Range labels → ms |
| `THEME_STORAGE_KEY` | `flightdeck-theme` | Theme persistence key |

### Models registry

`dashboard/src/lib/models.ts`:

- `getProvider(model): Provider` — the provider of a model id
  (`anthropic`, `openai`, `google`, `xai`, `mistral`, `meta`,
  `deepseek`, `other`; `unknown` when there is no model), by the same
  rule the API applies to canonical ids (`modelid.Provider`): a
  `ft:` fine-tune reads its base model, a Bedrock vendor prefix
  (`meta.`, `mistral.`, ...) names the vendor, then id prefixes. A
  Vitest test reads the Go twins' shared vectors file
  (`workers/internal/modelid/testdata/vectors.json`) so the two cannot
  drift.
- `PROVIDER_META` — label and chart colour token per provider;
  `isProvider(value)` tells an analytics dimension value that names a
  provider from one that does not.

Single source of truth for provider detection used by the policy
degrade dropdown, PromptViewer, session drawer, live feed rows, and
analytics legend. Provider marks live in
`dashboard/src/components/ui/provider-icons.ts`: Anthropic and OpenAI
paths, and Google (the Gemini mark), Mistral, Meta and DeepSeek from
`simple-icons`; xAI, other and unknown fall back to a generic glyph.

The Analytics page's summary row is built from one `metric=tokens`,
`group_by=provider` query: total tokens, one card per provider that
used tokens in the window (largest first; a card toggles the page's
provider filter), total runs and average tokens per run.

### OS / orchestration icons

`dashboard/src/components/ui/OSIcon.tsx` renders one of three glyphs
based on `session.context.os`: Darwin, Linux, Windows. Returns `null`
for unknown / missing values. Darwin and Linux use brand SVG paths from
the `simple-icons` npm package (devDependency); Windows is hand-crafted
at viewBox 14x14. Color overrides: Apple `#909090` (siApple.hex is
`#000000`, invisible on dark backgrounds), Linux `#E8914A` (Tux orange),
Windows `#0078D4`.

`OrchestrationIcon.tsx` renders one of five glyphs based on
`session.context.orchestration`: kubernetes, docker, docker-compose
(reuses Docker glyph), aws-ecs (hand-crafted hexagon), cloud-run (uses
the Google Cloud simple-icon as the closest fit). Exports
`getOrchestrationLabel(orchestration)` and `ORCHESTRATION_LABELS` for
tooltip text mapping.

A shared `SimpleIconSvg` helper renders simple-icons paths at viewBox
24x24 with a `<title>` for accessibility.

### State management

`dashboard/src/store/fleet.ts` is the Zustand store: fleet state,
session map, WebSocket stream, customDirectives slice.

`dashboard/src/hooks/useWebSocket.ts` reconnects with exponential
backoff: 1s → 2s → 4s, capped at 30s, starting over after every
successful open. When a socket opens after an earlier one was lost it
calls the caller's `onReconnect`; `useFleet` uses it to refetch what
the page missed while the stream was down (see Fleet view).

---

## Event Types

`sensor/flightdeck_sensor/core/types.py::EventType` enum lists every
event the sensor emits. Inbound directives are NOT event types — they
arrive in the response envelope of `POST /v1/events` (see Directives
section); the sensor's acknowledgement is the `DIRECTIVE_RESULT`
event.

22 emitted event types:

`SESSION_START`, `SESSION_END`, `PRE_CALL`, `POST_CALL`, `TOOL_CALL`,
`EMBEDDINGS`, `LLM_ERROR`, `POLICY_WARN`, `POLICY_DEGRADE`,
`POLICY_BLOCK`, `POLICY_MCP_WARN`, `POLICY_MCP_BLOCK`,
`DIRECTIVE_RESULT`, `MCP_TOOL_LIST`, `MCP_TOOL_CALL`,
`MCP_RESOURCE_LIST`, `MCP_RESOURCE_READ`, `MCP_PROMPT_LIST`,
`MCP_PROMPT_GET`, `MCP_SERVER_NAME_CHANGED`, `MCP_SERVER_ATTACHED`,
`SESSION_SIGNAL` (only the `agent_handoff` signal; see below).

Hook-based clients add `mcp_policy_user_remembered` (see MCP
Protection Policy, Event taxonomy) and the rest of the
`session_signal` vocabulary (below).

### `session_start`

Carries the identity 5-tuple plus `flavor`, `framework`, `model`,
`agent_type`, and an optional `context` dict (orchestration, git,
frameworks, hostname, OS, Python version, k8s details). Set-once: the
worker's `UpsertSession ON CONFLICT` deliberately omits `context` on
subsequent writes.

Operator-actionable enrichment:

- `sensor_version` (required): the `flightdeck-sensor` package
  version, captured via `importlib.metadata`. Answers "did this
  session run under the buggy build" for triage.
- `interceptor_versions` (optional): `{dep_name: version}` for
  every framework the sensor has interceptors for that's installed
  in the agent's process (anthropic, openai, litellm, langchain,
  langgraph, llama-index-core, crewai, mcp). Uninstalled deps
  silently omitted.
- `policy_snapshot` (optional): identity-only snapshot of the
  policy state in effect at session_start. Token-budget side
  carries `{policy_id, scope}`; MCP side carries
  `{global_policy_id, flavor_policy_id, flavor}`. Omitted when
  no policy is configured / preflight failed.

### `session_end`

Marks the session terminal with `state=closed`, stamps `ended_at`. A
`session_end` for a `session_id` Flightdeck has never seen is accepted at
ingestion; the worker redelivers it twice in case its `session_start` is
still in flight and then drops it as an orphan (see Validation rules).

Operator-actionable enrichment:

- `close_reason` enum: `normal_exit` / `directive_shutdown` /
  `policy_block` / `orphan_timeout` / `sigkill_detected` / `unknown`.
  Sensor populates the first three (atexit fires normally;
  shutdown directive flag was set; BudgetExceededError tore down
  the process). Worker fills `orphan_timeout` on the post-mortem
  path: when the reconciler's reaper closes a `lost` session past
  `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`, it emits a synthetic
  `session_end` event with `payload.close_reason="orphan_timeout"`
  and bumps `sessions_closed_total{reason="orphan_timeout"}` in the
  worker's metrics registry so the facet aggregate and the counter agree.
  `sigkill_detected` is part of the locked enum but no path
  populates it today. `unknown` is the catch-all when no path
  resolves.
- `policy_actions_summary` (worker-computed): tally of every
  policy enforcement event for the session, per the events table
  GROUP BY query. Shape: `{policy_warn: N, policy_degrade: N,
  policy_block: N, policy_mcp_warn: N, policy_mcp_block: N}` —
  fields with zero count are omitted.
- `last_event_id` (worker-computed): the immediately-prior event's
  UUID for the dashboard's incident-triage time-skip affordance
  ("what fired right before close").
- `end_reason` (string, Claude Code plugin only): Claude Code's own exit
  reason, passed through as sent and bounded to 64 characters (known
  values include `clear`, `resume`, `logout`, `prompt_input_exit` and
  `other`), carried next to `close_reason`, which stays `normal_exit`
  for all of them. Ingestion rejects a non-string. Stored in
  `payload.end_reason`.

### `pre_call`

Pre-call event emitted before the LLM request goes out. The Python
sensor emits one per real_fn call from `_pre_call`; the Claude Code
plugin emits one per `UserPromptSubmit` hook fire. Carries:

- `model`, `tokens_input`: the model the caller asked for and the
  pre-call estimate.
- `estimated_via`: `"tiktoken"` / `"heuristic"` / `"none"` —
  attributes the estimate's source. Sensor populates unconditionally;
  the plugin path doesn't run estimation and omits the field.
- `policy_decision_pre`: shared `policy_decision` block when the
  pre-call policy check decision is non-allow (warn / degrade /
  block). Omitted on allow.

### `post_call`

The primary LLM-call event. Carries `tokens_input`, `tokens_output`,
`tokens_total`, `tokens_cache_read`, `tokens_cache_creation`,
`latency_ms`, `model`, and `framework`. `tokens_cache_read` is the
prompt-cache read, a subset of `tokens_input`: Anthropic's
`cache_read_input_tokens`, or OpenAI's `cached_tokens` usage detail
(`prompt_tokens_details` on chat, `input_tokens_details` on Responses,
on direct and streamed calls alike). `tokens_cache_creation` is the
cache write, also a subset of `tokens_input`: Anthropic's
`cache_creation_input_tokens`, or OpenAI's `cache_write_tokens` usage
detail in the same two objects (0 when the response carries none).
`tokens_reasoning` is the reasoning share of `tokens_output`:
Anthropic's `output_tokens_details.thinking_tokens`, OpenAI's
`reasoning_tokens` detail (`completion_tokens_details` on chat,
`output_tokens_details` on Responses). `tokens_cache_creation_1h` is the
one-hour share of Anthropic's cache writes
(`cache_creation.ephemeral_1h_input_tokens`). The event also carries
`model_requested`, `model_served`, `provider`, `billing_mode`,
`service_tier`, `speed`, `inference_geo`, `server_tool_use` and
`stop_reason` where the response reports them, and `cost_reported` with
`cost_source` when litellm or a gateway returned a cost (see
`POST /v1/events` for the field table and Cost estimation for how each
is used).
Operator-actionable enrichment additionally carries:

- `estimated_via`: passthrough from the pre-call estimator so a row
  scanner sees the attribution without fetching the sibling pre_call.
- `provider_metadata`: `{platform, ratelimit_remaining_tokens,
  ratelimit_remaining_requests, ratelimit_limit_tokens,
  processing_ms, request_id, model_info, query_source}`. Best-effort per provider
  (raw-response paths surface more headers; parsed-response paths
  may surface none). Field names are normalised across providers.
  `query_source` is the Claude Code call site a call came from (for
  example `sdk` or `agent:builtin:general-purpose`), set only on calls
  reported over OTLP (see Ingestion API > OTLP ingest).
  `platform` is set on every Anthropic and OpenAI `post_call` and names
  the endpoint the client talked to. An OpenAI call reports `openai`, or
  `azure` for Azure OpenAI hosts; an Anthropic call reports `anthropic`, `bedrock`, `bedrock-mantle`, `aws`,
  `vertex`, `google-cloud` or `foundry` for the hosts the SDK's own
  client classes default to (matched on dot-separated suffixes, `vertex`
  only for the Vertex AI API hosts and `google-cloud` only for Claude
  Platform on Google Cloud's `claude.googleapis.com`, so look-alikes such as `evilanthropic.com` or
  `storage.googleapis.com` are not labelled), else the bare host of
  whatever the client was pointed at (a gateway or proxy). It is derived
  from `client.base_url.host` and
  nothing else, so a first-party client pointed at a gateway reports the
  gateway. A bare host is reported only when it is a well-formed
  hostname -- at most 253 characters (the DNS limit), lowercase letters,
  digits, dots and hyphens -- and any other host is reported as the fixed
  label `invalid-host`, so a malformed or hostile `base_url` cannot put
  arbitrary bytes into every `post_call` of a session.
- `policy_decision_post`: shared `policy_decision` block when this
  call's cumulative usage crossed a threshold the pre-call check
  didn't catch (cache-read tokens / output tokens push the cumulative
  over warn or block AFTER the call lands). Omitted on no-crossing.

When `stream=true` on the underlying request, the payload also carries:

```json
"streaming": {
  "ttft_ms": 142,
  "chunk_count": 38,
  "inter_chunk_ms": {"p50": 12, "p95": 47, "max": 109},
  "final_outcome": "completed",
  "abort_reason": null
}
```

A `post_call` reported over OTLP carries a `streaming` block with only
`ttft_ms` and `final_outcome` (`completed`): Claude Code reports no chunk
counts or inter-chunk timings, so `chunk_count`, `inter_chunk_ms` and
`abort_reason` are absent and readers treat them as optional.

`final_outcome` is `"completed"` when the response was read in full: the
stream reached its end, the caller stopped at the event that ends the
response (Anthropic's `message_stop` or the `message_delta` carrying
`stop_reason`, OpenAI's usage chunk, a Responses
`response.completed`), or a helper stream reports its message complete. It
is `"aborted"` when the caller left before that (`break`, `close()`,
leaving the `with` block, a cancellation), in which case `abort_reason` is
`"client_aborted"`. `latency_ms` runs to the last chunk the guard delivered
unless the guard read the stream to its end, or a helper read it to
completion itself; with no chunk delivered it runs to the moment the
response opened. A stream obtained by parsing an Anthropic raw or
streaming view (`with_raw_response.create(stream=True)`) is timed from
the `parse()` call, where the guard opens, not from the request. A stream
that fails emits `llm_error` instead (`abort_reason` `error_before_stream`,
`error_mid_stream` or `timeout`). The streaming sub-object is omitted
entirely for non-streaming calls. Ingestion stores a `final_outcome` or
`abort_reason` outside these values as `other` (see Validation rules).

#### Streaming metering

SDK stream objects carry no `usage` of their own, so a streamed call is
metered from the usage the provider sends inside the stream:

- **Anthropic.** `message_start` carries the input and cache counts and
  each `message_delta` carries the cumulative output count. On the
  `messages.stream()` helper (sync and async) the sensor also reads the
  helper's accumulated `current_message_snapshot.usage` when the call
  settles, which never reads further from the network, and once
  `stop_reason` is set it takes that snapshot as the response: content
  blocks are complete before `message_delta` arrives, so this is the full
  message without reading the trailing `message_stop` frame, and content
  capture and tool-call extraction see the full response.
- **OpenAI chat.** The final chunk carries `usage`; the sensor injects
  `stream_options.include_usage` so the provider sends it. That chunk has
  empty `choices`, which the usual loop body (`chunk.choices[0]`) does
  not expect, so a caller who did not ask for usage never sees it: the
  guard records its usage and drops it, the stream looks exactly as it
  does without the sensor, and `chunk_count` counts the chunks the caller
  saw. A caller who set `include_usage` themselves receives it as usual.
  The usage chunk is the event that ends the response; stopping at the
  `finish_reason` chunk before it leaves the usage unread, and that call
  reports `aborted` with the pre-call estimate.
- **OpenAI Responses.** `response.completed` carries `usage`.
- **litellm.** The sensor injects `stream_options.include_usage` into the
  litellm call, and litellm appends one trailing chunk carrying `usage`
  after the `finish_reason` chunk, with one choice and an empty delta
  rather than empty `choices`; the guard tells it apart by its delta
  fields and hides it from a caller who did not ask for usage. As with
  OpenAI chat, that chunk ends the response; stopping at the
  `finish_reason` chunk leaves the usage unread. A `text_completion`
  stream works the same way, its chunks `TextCompletionResponse`s, the
  usage chunk the one whose `usage` is not zero (every chunk carries a
  `Usage`). A `responses` stream carries `usage` on its terminal event,
  as an OpenAI Responses stream does.

The sensor wraps the SDK stream in a guard (`GuardedStream`, or
`GuardedAsyncStream` for async clients, in `interceptor/base.py`) that
records usage as events pass through it and emits the `post_call` once, at
the first of: the stream being read to its end, `close()`, leaving the
`with` block, the guard being garbage-collected (a plain `for` loop left
with `break`), or the session ending while the stream is still open; in
that last case the events are flushed before `session_end` goes out, so
the workers roll the tokens up on an open session.
Leaving the `with` block on an exception emits `llm_error` only when the
response had not been read in full and either the error classifier knows
the exception's class or the guard recognises its module (`httpx`,
`httpcore`, `httpx2`, `httpcore2` (the transport of the anthropic 2.x and
openai 3.x SDKs), `anyio`, `h11`, `h2`, `anthropic`, `openai`) or a
`ConnectionError`:
an SDK error, a raw transport error such as `httpx.ReadTimeout` or
`httpx.RemoteProtocolError` raised by a helper method that read the stream
itself, a connection reset, or a look-alike such as the builtin
`TimeoutError` or `PermissionError`. Such an exception counts whoever
raised it (the classifier matches by class name whatever the module, so a
failing `httpx` call of the caller's own inside the block, or another
library's `ReadTimeout`, is attributed to the stream). An error raised
while reading through the guard is reported as it happens, and one that
another intercepted call already reported is not reported again. Cancellations
and interrupts (`CancelledError`, `GeneratorExit`, `KeyboardInterrupt`),
the sensor's own policy exceptions (`BudgetExceededError`,
`DirectiveError`, `MCPPolicyBlocked`) and the caller's own exceptions
count as the caller leaving: the call is reported as completed when the
response had been read in full, else as aborted. The garbage-collection
path never settles inline: the cyclic collector can run a finalizer on
any thread, inside a critical section of the session, its policy cache or
its event queue, and none of those locks is re-entrant, so the finalizer
records what the settle needs, drops the SDK stream (whose connection
then closes at collection, as it would without the sensor) and queues the
settle; the next LLM call the sensor intercepts, or the session's end,
runs it. `messages.stream()`, `messages.create(stream=True)`,
`chat.completions.create(stream=True)`, `responses.create(stream=True)`,
OpenAI's `chat.completions.stream()` and `responses.stream()` helpers and
an event stream parsed from a raw or streaming view all take this path,
with or without a `with` block
(`for chunk in client.chat.completions.create(..., stream=True)`) and with
`async for`. `create(stream=True)` sends the request inside the call, as the
unguarded SDK does, so provider errors surface there; `messages.stream()`
sends it when the context is entered, like the SDK's own manager, or on
the first iteration or public-attribute read when no `with` block is
used.

`chunk_count`, the inter-chunk timings and `partial_chunks` count the
events the SDK yields to the caller. Protocol frames the SDK consumes
itself (Anthropic's `ping` keep-alive, OpenAI's `[DONE]` end-of-stream
marker) never reach the guard and are not counted.

A stream that ends before its final usage event reports the usage that had
arrived (for Anthropic, the `message_start` input and cache counts and the
latest output count); only when no usage arrived at all does `post_call`
fall back to the pre-call estimate as `tokens_input` with `tokens_output =
0`.

The guard proxies every other public attribute (`get_final_message`,
`response`, `request_id`) to the SDK stream and re-implements
`text_stream` on top of itself (only for streams that have one, as on the
SDK object) so text readers are metered too; the async guard exposes these
only after `async with` or the first `async for`.
Helper streams yield the SDK's derived events (text deltas and the like)
alongside the raw ones, so `chunk_count` is higher for `messages.stream()`
than for `create(stream=True)` on the same response.

A streamed call stores the same response and emits the same `tool_call`
events as a non-streamed one. The Anthropic `messages.stream()` helper
assembles its own message: when it is complete the assembled final
message is the response, and when the caller leaves early the helper's
accumulated snapshot is stored as it stands, without reading further (a
helper reported from collection stores no partial content: the finalizer
drops the stream before the settle runs). A raw event stream
(`create(stream=True)`, and the stream an OpenAI `.stream()` helper or a
view reads through the guard) is assembled by the guard with the SDK's
own accumulator, the one the SDK's helpers run on the same events:
Anthropic's `accumulate_event` (its beta form for `beta.messages`),
OpenAI's `ChatCompletionStreamState` for chat, and for Responses the
`Response` the terminal event carries, with `ResponseStreamState` folding
the deltas before it. The guard feeds the accumulator every event it
reads, the usage chunk it hides from the caller included, and at the
settle:

- a stream read to its end hands over the assembled message, which is
  the response: content capture stores it and the `tool_call` events
  come from it (a streamed `tool_use` block's input is parsed from its
  JSON deltas, a chat tool call's arguments are concatenated);
- a stream the caller left early stores the partial message under
  capture and emits no `tool_call`: a half-streamed call is not a call
  the model made. Usage, model and stop reason come from the events as
  before. A raw stream reported from collection keeps its accumulator
  (parsed events only, not the connection), so it stores the partial
  message too;
- a stream that fails emits the `llm_error` with partial tokens and no
  content, as before.

An accumulator that raises is dropped for the rest of the stream (a
message missing an event would be stored as if it were the response),
and the call is metered as before; the failure is logged by exception
class only, since the SDK accumulators build their messages from the
streamed tool-call arguments. A chat stream is assembled only when
something reads the result -- capture on, or a request that offers the
model `tools` (or the legacy `functions`): the SDK's chat state
re-serialises the message on every chunk, the price its own `.stream()`
helper pays, and a stream that can carry no tool call with capture off
does not pay it. A Responses stream is always assembled (its terminal
event carries the whole response), and folds deltas only under capture;
an event the fold cannot take (a delta for an item the stream never
announced) ends the partial snapshot, not the assembly.
`.parse()` never streams and is metered like `create()`, with the
`Parsed*` result stored as the response when capture is on.

### `tool_call`

Tool-use events. For Anthropic and OpenAI tool-use messages, the sensor
emits one `tool_call` per tool invocation in the response, streamed or
not: a stream read to its end is assembled into the message a
non-streamed call returns (see Streaming metering), and a stream the
caller left early emits none. Carries
`tool_name`, optionally `tool_input` (when `captureToolInputs=true` for
the plugin or `capture_prompts=true` for the sensor), `tool_result` (when
the next assistant turn shows the tool's output and capture is on).

On the wire a sensor `tool_call` carries `tool_name` and `model`, and
`server_name` for a call the provider made to an MCP server on the
agent's behalf (an OpenAI Responses `mcp_call`, see below); under
capture its input travels in the `event_content` envelope as
`tool_input`, served by `GET /v1/events/:id/content`. The id a provider
gives a call (a chat tool call's `id`, a Responses function call's
`call_id`, a hosted or MCP item's id) stays in-process on
`ToolInvocation.tool_id` and is not part of the event.

For a chat completion the invocations are `choices[0].message.tool_calls`
(`tool_name` is the function name). For the Responses API
(`responses.create()` / `.parse()` and their raw-response forms) the
sensor emits one `tool_call` per output item that is a call:

- `function_call`, `mcp_call` and `custom_tool_call` carry the tool's own
  name as `tool_name`; the input is the JSON-decoded `arguments` (for a
  custom tool, `{"input": <text>}`, as those tools take free-form text).
  An `mcp_call` also carries its `server_label` as `server_name`, the
  field every MCP event and the plugin's MCP tool events name the server
  with, cut at 256 characters as the plugin cuts it. It is metadata,
  like the tool name, and ships with capture off; the event stays a
  `tool_call` because the provider, not the agent's MCP client, made the
  call, so it has no transport, fingerprint or MCP policy decision. The
  Events view's MCP server filter matches it by `payload.server_name`.
- Hosted tools have no per-call name, so the item type is the
  `tool_name`: `web_search_call`, `file_search_call`,
  `code_interpreter_call`, `image_generation_call`, `computer_call`,
  `local_shell_call`, `shell_call`, `apply_patch_call`,
  `tool_search_call`. The input is what the model asked the tool to do,
  taken from an allowlist of fields per item: a web search action's
  `query`, `queries`, `url` and `pattern`; the file-search `queries`; the
  interpreter `code`; a computer action's coordinates, button, keys,
  path and text; a local shell action's `command`, working directory,
  timeout and user; a shell action's `commands`, timeout and output
  limit; an apply-patch operation's `path` and `diff`; the tool-search
  `arguments`. Nothing else on the item is input: a search action's
  `sources` are the results, a local shell action's `env` is the
  environment the command runs with, a computer call's pending safety
  checks are the provider's verdicts, and tool results (image bytes,
  interpreter outputs, file-search results, an MCP call's `output` and
  `error`) are outputs; none is ever captured. An image generation call
  carries no input at all.
- Messages, reasoning items, tool output items and MCP bookkeeping items
  (`mcp_list_tools`, `mcp_approval_request`, `mcp_approval_response`)
  emit nothing.

The Claude Code plugin emits one `tool_call` per `PostToolUse` and per
`PostToolUseFailure` hook and adds:

- `tool_use_id` (string, at most 256 characters; ingestion rejects any
  other type): Claude Code's id for the tool invocation, the `tool_use`
  block id in the transcript. Stored in `payload.tool_use_id`.
- `duration_ms` (integer, milliseconds) and `latency_ms` (the same
  value): the tool's execution time as Claude Code measured it; null
  when Claude Code did not report it.
- `error` (object, failures only): `error_type` (`other`),
  `error_class` (`PluginToolError`), `message` (the tool's error text
  cut at 1000 characters plus an ellipsis; a fixed placeholder when the
  hook carried no text; the JSON of a non-string error; `<redacted>`
  unless both capture knobs are on, and again `<redacted>` by the
  workers service when the session's stored capture posture is off) and
  `interrupted` (boolean, when Claude Code reports whether the failure
  reached it as an abort). Stored in `payload.error`, where `llm_error`
  and MCP failures keep theirs.

### `embeddings`

Emitted by `client.embeddings.create` (OpenAI), `litellm.embedding` /
`litellm.aembedding`, and `LangChain.OpenAIEmbeddings.embed_*`
transitively. Anthropic has no native embeddings API; routing through
litellm → Voyage is the supported path.

Token accounting carries input tokens only (`tokens_output=0`).
The `estimated_via` / `provider_metadata` / `policy_decision_post`
fields described under `post_call` apply here too. Embeddings adds:

- `output_dimensions`: `{count, dimension}` — small + observable
  summary so the dashboard renders the shape chip
  (`<dim>-d × <count> vec`) without fetching `event_content`.

When `capture_prompts=true`:

- `payload.content.input` carries the request's `input` parameter
  (string or list of strings) — round-trips into `event_content.input`.
- `payload.content.embedding_output` carries the raw vectors as
  `list[list[float]]` — round-trips into
  `event_content.embedding_output`. The single `capture_prompts` gate
  protects this; there is no separate dial.

### `llm_error`

Structured error event with a 14-entry taxonomy:

| `error_type` | HTTP | Description | OTel mapping | `is_retryable` |
|---|---|---|---|---|
| `rate_limit` | 429 | Request-rate limit exceeded | `rate_limit_error` | ✅ |
| `quota_exceeded` | 402 / 429 / 400 | Billing problem (402); a spend limit, spend cap or exhausted credit balance reported under 429 or 400 | `quota_exceeded_error` | ❌ |
| `context_overflow` | 400 / 200 | Input exceeded the model context window, or the response stopped with `model_context_window_exceeded` | `context_length_exceeded` | ❌ |
| `content_filter` | 400 / 200 | Provider content filter blocked the request, the response ended with `refusal` or `content_filter`, or the filter replaced the completion (OpenAI's `ContentFilterFinishReasonError` from `chat.completions.parse()`: `http_status` 200, `provider_error_code` `content_filter`) | `content_filter_error` | ❌ |
| `invalid_request` | 400 / 200 | Other validation failure; also OpenAI's `LengthFinishReasonError` from `chat.completions.parse()`, when the output hit the caller's `max_tokens` before the structured output was complete (`http_status` 200, `provider_error_code` `length`, message that `max_tokens` is too small for the schema) | `invalid_request_error` | ❌ |
| `authentication` | 401 | Missing / invalid credential; OpenAI's `AuthenticationError` and its `OAuthError` subclass (a rejected OAuth bearer token) | `authentication_error` | ❌ |
| `permission` | 403 | Credential lacks permission | `permission_error` | ❌ |
| `not_found` | 404 | Resource (model, endpoint) not found | `not_found_error` | ❌ |
| `request_too_large` | 413 | Request body too large | `request_too_large_error` | ❌ |
| `api_error` | 500 | Provider internal error | `api_error` | ✅ |
| `overloaded` | 529 / 503 | Anthropic 529, OpenAI engine overloaded | `overloaded_error` | ✅ |
| `timeout` | 504 / — | Gateway timeout (504), or a client-side timeout before a response | `timeout_error` | ✅ |
| `stream_error` | — | Mid-stream error after a 200 response | `stream_error` | ⚠ case-by-case |
| `other` | — / 200 | Fallback for unknown; also a `chat.completions.parse()` completion that fails the caller's schema (`http_status` 200, `provider_error_code` `schema`) | `other` | ❌ |

Ingestion stores an `error_type` outside this table as `other` (see
Validation rules).

Plus `provider`, `http_status`, `provider_error_code`, `request_id`,
`retry_after`, `is_retryable`. For a streamed call, `abort_reason` and the
`partial_*` counts below sit with these under `payload.error`
(`retry_attempt` and `terminal` are top-level payload fields). A failure
while opening the stream keeps the classification of the error it raised,
with `abort_reason=error_before_stream` and `partial_chunks=0`; a failure
on the first read gets `error_before_stream` or `timeout`. A failure once
data had arrived (a chunk through the guard, or usage accumulated by a
helper the caller read through `get_final_message()`, which leaves
`partial_chunks=0`) emits `error_type=stream_error` with `abort_reason`
`error_mid_stream` (or `timeout`), `partial_chunks` (chunks read before
the failure) and, when the stream had delivered usage,
`partial_tokens_input` / `partial_tokens_output`, and the event carries
the call's top-level `billing_mode` (see Cost estimation, Billing modes).
Ingestion stores an `abort_reason` outside these values as `other` and
refuses a `partial_*` count that is not an integer from 0 to 2^53 (see
Validation rules).
The provider bills those
tokens. The sensor adds them to the in-process session counter that
drives its local budget checks, and the worker stores them as the
`llm_error` row's `tokens_input`, `tokens_output` and `tokens_total`
(see Database, `events`), so they count in the session and agent
totals, the `tokens` metric, `estimated_cost` and the per-agent summary
as a completed call's tokens do. Each billed token is reported by one
event: a stream that completes, or that the caller leaves early, is
reported by its `post_call` and never by an `llm_error`; a stream that
fails is reported by the `llm_error` alone (the guard settles a stream
once, so no `post_call` follows); a retry is a new call with its own
event; and the `llm_error` that accompanies a billed `post_call` (an
HTTP 200 refusal, a `parse()` failure) carries no `partial_tokens_*`.

Classification walks the exception's class name first (each SDK names
its classes consistently; the Anthropic-specific `DeadlineExceededError`,
`OverloadedError` and `RequestTooLargeError` are mapped by name), then
lets the HTTP status, the provider's error code and the provider's
message override it. By status: 402 is `quota_exceeded` and 504 is
`timeout` whatever class the SDK raised, because the Anthropic SDK never
raises a dedicated class for either: `DeadlineExceededError` is declared
and mapped by name, but the SDK's status mapping delivers a 504 as
`InternalServerError` and a 402 as a bare `APIStatusError`; 413 is
`request_too_large`; 529 is `overloaded`. By message, for Anthropic
exceptions only: a 429 or 400 whose provider message contains the
phrase `spend limit`, `spending limit`, `spend cap` or `credit balance`
is `quota_exceeded` rather than `rate_limit` or `invalid_request`, since
Anthropic reports its organisation spend cap as a 429
`rate_limit_error` and a per-user spend limit or an exhausted credit
balance as a 400 `invalid_request_error`, and only the message tells
them apart. The match is a substring test over the first 2,048
characters of the lower-cased message; single words are not matched,
because a 400 echoes caller-supplied identifiers (a schema named
`monthly_report`, a tool `get_billing_info`) and a per-minute "quota
exceeded" 429 is a genuine rate limit. No other provider's message is
read at all, so a status-less or foreign exception pays nothing for it,
and an Anthropic 400 or 429 pays for at most that 2,048-character
slice. The error's `provider` is the adapter's `name` on this path as
on every other `llm_error` the adapter's calls produce, so a transport
or builtin error raised inside an intercepted call reports `anthropic`,
`openai` or `litellm` rather than `unknown`. The message
is read for that test only and never stored: `error_message` is the
exception class name, with the provider's text appended (clipped to 200
characters) only when `capture_prompts` is on; the three
`chat.completions.parse()` failures below carry a sensor-authored
message instead, under either setting, and never the provider's text.

A response the provider answered with HTTP 200 can still be a failed
call. When the stop reason is one of Anthropic's `refusal` (its safety
classifiers declined the request) or `model_context_window_exceeded`
(the context window ran out mid-response), an OpenAI chat or litellm
`finish_reason` of `content_filter` (which is also how litellm reports
an Anthropic refusal routed through it), an OpenAI structured-output
refusal (`message.refusal`, reported as `refusal`), or an OpenAI
Responses call left `incomplete` with `incomplete_details.reason`
`content_filter`, the sensor emits an `llm_error` beside the
`post_call`: `error.error_type` is `content_filter`, or
`context_overflow` for the context-window overrun; `error.http_status`
is 200; `error.provider_error_code` is the stop reason;
`error.error_message` is `stop_reason=<reason>` (never response
content); `error.request_id` is the response's request id (stamped on
the parsed SDK object, or read from a raw-response wrapper's headers);
`error.is_retryable` is false and the top-level `terminal` is true; and
`originating_event_id` is the id of the `post_call` it accompanies,
which is how an operator pairs the error with the billed call. Any
`llm_error` the sensor derives from a response the provider answered
with HTTP 200 records `error.http_status` 200. A truncated response
(Anthropic `max_tokens`, OpenAI `length` or `max_output_tokens`) is a
success when the SDK returns it: the text is valid, just cut short;
`chat.completions.parse()` raises `LengthFinishReasonError` instead
(below). The `post_call` keeps the
billed usage, so token totals and `estimated_cost` are unchanged, while
the error counts toward the per-agent error count and sets the
session's `has_terminal_error` flag like any other terminal
`llm_error`. The reason comes from the provider protocol's
`response_stop_reason` (a complete message, a raw-response wrapper, or
a helper stream's accumulated snapshot) or, for a raw stream that has no
final message object, from the streamed event that carries it
(Anthropic `message_delta`, an OpenAI chat chunk with `finish_reason`,
an OpenAI `response.incomplete` event) through
`stop_reason_from_stream_chunk`, which the stream guard records as
events pass. Only `post_call` events get this treatment; `embeddings`
responses carry no stop reason.

The same rule covers a call the provider answered with HTTP 200 and
billed but that still failed for the caller: it is reported as both a
`post_call` and an `llm_error`. OpenAI's `chat.completions.parse()` raises
`LengthFinishReasonError` when the completion arrived but the output hit
the caller's `max_tokens` before the structured output was complete; the
sensor emits the `post_call` from the completion the exception carries
(its usage, model and tool calls, with the request id and rate-limit
headers of the HTTP response it came from) and then the `llm_error`
(`http_status` 200, terminal, chained to that `post_call` through
`originating_event_id`), and re-raises. The billed tokens therefore reach
the session totals and the analytics metrics like any completed call.
`ContentFilterFinishReasonError` (`content_filter`) carries the
completion from openai 3.x and none before; a completion that fails the
caller's schema (a pydantic `ValidationError`: `other`,
`provider_error_code` `schema`) carries none. Without a carried
completion the `post_call` is built from the HTTP body (usage, model,
request id from the headers). One failure is one `llm_error`: when the
`post_call`'s own stop reason already filed it (a carried
content-filtered completion ends with `finish_reason` `content_filter`),
the exception is not reported again.
To have that body, `chat.completions.parse()` and `responses.parse()`
fetch the response through the SDK's own raw-response closure and parse
it eagerly (the SDK caches a successful parse); the caller still gets
the parsed object, or the SDK's exception with its message, exactly as
from the plain `parse()`. On the raw-response path
(`with_raw_response.parse()`), where the SDK would only fail at the
caller's own `.parse()`, out of the sensor's sight, the same eager parse
reports the failure and still returns the raw response, so the caller's
`.parse()` raises as it would without the sensor. When neither a
completion nor a JSON body can be read (a 200 whose body is not a JSON
object), only the `llm_error` is emitted: the direct `parse()` raises
the SDK's exception and the raw-response path still returns the raw
response. A failed parse never lands as a success-looking `post_call`
of estimated tokens. `responses.parse()` returns an
incomplete result without raising, so the length case does not apply to
it; a schema failure does.

Operator-actionable retry-chain context:

- `retry_attempt`: 1-based counter keyed by `(provider, request_id)`
  on the Session's bounded LRU. Increments on every emission for
  the same key.
- `terminal`: bool. `True` when the classifier marks the error
  non-retryable (best-effort signal for "did the retry chain
  finally give up"). `False` for transient classes the caller is
  expected to retry.

### Shared `policy_decision` payload block

Every policy enforcement event (`policy_warn`, `policy_degrade`,
`policy_block`, `policy_mcp_warn`, `policy_mcp_block`) carries a
`payload.policy_decision = {...}` block with operator-actionable
state metadata. Always included regardless of `capture_prompts`.

Required fields on every policy event:

- `policy_id` — UUID of the policy row, `"local"` for sensor-side
  init(limit=...) thresholds, or `"server"` when a warn / degrade
  directive arrives for a policy the sensor never fetched (one created
  after the session started).
- `scope` — `"org"` / `"flavor:<v>"` / `"session:<v>"` /
  `"global"` / `"local_failsafe"` / `"fail_open"` / `"server"` (the
  same unfetched-policy case as `policy_id="server"`).
- `decision` — `"warn"` / `"degrade"` / `"block"` / `"allow"` /
  `"deny"`.
- `reason` — sensor-built operator-readable single-line string
  built per pattern `"<what happened> + <by what mechanism> +
  <relevant context>"`.

MCP-policy events additionally populate:

- `decision_path` — `"flavor_entry"` / `"global_entry"` /
  `"mode_default"`.
- `matched_entry_id` — UUID of the matched MCP policy entry
  (omitted on mode-default fall-through).
- `matched_entry_label` — the entry's `server_name` (display
  formatting belongs to the dashboard).

Token-budget events leave the three MCP-only fields undefined,
so their `policy_decision` block ships 4 keys; MCP entry-path
events ship 7 keys.

The block is built by
`flightdeck_sensor.core.types.PolicyDecisionSummary` (sensor) and
`plugin/hooks/scripts/mcp_policy.mjs::buildPolicyDecisionBlock`
(plugin) so both surfaces produce byte-identical wire envelopes.
Ingestion validates the required fields at the wire boundary; payloads
missing them are rejected before NATS publish.

### MCP Protection Policy enforcement on all server-access paths

MCP Protection Policy enforces on all six server-access paths
the patched `ClientSession` exposes:

- `call_tool`
- `list_tools`
- `read_resource`
- `get_prompt`
- `list_resources`
- `list_prompts`

When a server matches a block decision, the sensor raises
`MCPPolicyBlocked` from every path. An agent blocked from a
server cannot bypass via list_*/read_resource/get_prompt — the
operator's "this server is blocked" intent means ALL access
blocked, not just tool execution.

The `originating_call_context` enum on every `policy_mcp_warn` /
`policy_mcp_block` event tells the operator which call site
fired the decision. `tool_name` is method-specific: populated
for `call_tool` (tool name), `read_resource` (resource URI),
`get_prompt` (prompt name); omitted for `list_*` paths.

Discovery family events (`mcp_tool_list`, `mcp_resource_list`,
`mcp_prompt_list`) carry an `item_names` field — the array of
identifiers the server returned, capped at 100 with
`truncated:true` overflow flag. Operationally key for the
drift-detection workflow ("did this server's tool inventory
change last week"). Empty arrays are valid (server with no tools
landed).

### `originating_event_id` chain

Sensor mints a UUID per emission via `Session._build_payload`
(`payload.id`); the Claude Code plugin derives each `post_call`'s id
from the model call's message id. Worker's `InsertEvent` uses it via
`COALESCE(NULLIF($1, '')::uuid, gen_random_uuid)`. Before any side
effect the worker drops an event whose id is already stored
(`dropped_events_total{reason="duplicate_event"}`), so a retried POST,
a NATS redelivery or a re-sent model call adds no tokens and touches no
session. The first copy stored keeps its session and billing mode. A
copy processed while the first is still in flight passes the check and
can still add its tokens; `ON CONFLICT (id, occurred_at) DO NOTHING`
then keeps the second row out.

`Session._current_call_event_id` tracks the most-recent
`post_call` emission's id. Every "downstream of an LLM call"
event type stamps `payload.originating_event_id`:

- `tool_call`, `llm_error`
- `policy_warn` / `policy_degrade` / `policy_block`
- `policy_mcp_warn` / `policy_mcp_block`
- All six `mcp_*` event types

Originator types (`pre_call`, `post_call`, `embeddings`) and
call-window-independent types (`session_start`, `session_end`,
`mcp_server_attached`, `mcp_server_name_changed`,
`directive_result`) skip the chain stamp.

The Claude Code plugin sets an id only where Claude Code names the
thing reported: `post_call` (from the model call's message id),
`llm_error` (from the failed turn's message id, when the transcript
holds that turn), and `tool_call` and `mcp_tool_call` (from the
`tool_use_id`, when the hook carries one). Its other events carry no
id, so the worker generates one, and it stamps no
`originating_event_id`.

### `policy_warn`

Emitted when token-budget enforcement crosses the warn threshold.
Two emission paths:

- **Local** — sensor `init(limit=...)` threshold crossed. `_pre_call`
  emits with `source="local"`, the call proceeds. Local thresholds
  fire WARN only — never BLOCK or DEGRADE. Fires once per
  session (fire-once tracking in PolicyCache).
- **Server** — worker policy evaluator detects the threshold cross,
  writes a `warn` directive; the sensor receives it on the next
  response envelope and `_apply_directive(WARN)` emits with
  `source="server"`.

Payload fields: `source`, `threshold_pct`, `tokens_used`,
`token_limit`. The local path uses the local threshold (`local_warn_at`
× 100); the server path uses `policy.warn_at_pct`.

### `policy_degrade`

Emitted ONCE on `_apply_directive(DEGRADE)` arrival — when the worker
policy evaluator writes a `degrade` directive that the sensor
receives. Decision event with `source="server"` (local never
fires DEGRADE). Per-call swaps after the directive arrives are visible
via `post_call.model` only; subsequent `_pre_call` invocations on the
armed session do NOT re-emit.

Payload fields: `source`, `threshold_pct` (`policy.degrade_at_pct`),
`tokens_used`, `token_limit`, `from_model`, `to_model` (the directive's
`degrade_to`). Co-emitted with a `DIRECTIVE_RESULT` (acknowledged) ack
event so both the user-facing decision (`policy_degrade`) and the
control-plane plumbing (`directive_result`) land on the timeline in
chronological order.

### `policy_block`

Emitted by `_pre_call` when the local PolicyCache decision is BLOCK.
Sensor calls `EventQueue.flush` synchronously to ensure the event
lands before the process exit, then raises `BudgetExceededError`. The
caller's call never reaches the provider.

Payload fields: `source` (always `"server"` — local thresholds never
upgrade past WARN), `threshold_pct`
(`policy.block_at_pct`), `tokens_used`, `token_limit`,
`intended_model` (the model the blocked call was going to use; lets
operators answer "which call hit the limit?").

The worker's policy evaluator also detects block-threshold crossings
on every `post_call` event, but it writes a `shutdown` directive rather
than a `block` directive — there is no `BLOCK` `DirectiveAction` value.
The sensor's local `policy_block` emission is the user-facing
enforcement decision; the directive write is a parallel mechanism that
covers SIGKILL'd or directive-aware sessions on subsequent re-attach.

### `directive_result`

Sensor's acknowledgement / execution response. Fields:

- `directive_status`: `"acknowledged"` (sensor saw the directive and is
  about to act), `"success"` (custom handler ran without exception),
  `"error"` (custom handler raised), `"timeout"` (handler exceeded the
  5s budget — never fires in practice because handlers run on the
  directive thread, not the main thread).
- `directive_action`: matches the source directive (`shutdown`, `degrade`,
  `custom`, etc.).
- `result`: handler return value (custom directives) or action-specific
  dict (`from_model` / `to_model` for degrade, `reason` for shutdown).
- `error`: plain string when `directive_status="error"`. (Distinct from
  the structured `LLM_ERROR` payload.)
- `duration_ms`: handler execution time.

### `session_signal`

A change in a session that is not a model call, a tool call or a policy
decision: a context compaction, a model switch, a permission prompt, a
slash command, a task, a directory or settings change, an MCP server's
request for input. One event type carries
all of them, named by `signal`, so a client that reports a new kind of
change adds a signal name rather than an event type. The Claude Code
plugin emits it from its hooks.

- `signal` (required): a lowercase identifier, `^[a-z][a-z0-9_]{0,63}$`.
  The vocabulary is open; ingestion checks the form only, and the
  dashboard labels the signals it knows and shows any other by name.
- `signal_data` (optional): an object of at most 32 keys whose values
  are strings of at most 256 bytes, numbers, booleans or null. It
  carries metadata only, never content.
- A signal's text (a compaction summary, the instructions given to
  `/compact`) is content: it is sent only while `capturePrompts` is on,
  as `has_content=true` with `content.provider = "flightdeck-signal"`
  and the text under `content.response` keyed by its name, and lands in
  `event_content` like any captured content.

| `signal` | Claude Code hook | `signal_data` | Content (capture on) |
|---|---|---|---|
| `context_compaction_started` | `PreCompact` | `trigger` (`manual`, `auto`) | `custom_instructions` |
| `context_compacted` | `PostCompact` | `trigger` | `compact_summary` |
| `model_switched` | `PostModelSwitch` | `from_model`, `to_model`, `requested_model`, `source` (`command`, `picker`, `sdk`, `auto`, `resume`), `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` | none |
| `notification` | `Notification` | `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `agent_needs_input`, `quota_auto_resume_fired`, and the rest Claude Code sends) | `title`, `message` |
| `permission_requested` | `PermissionRequest` | `tool_name`, `mcp_server` for an MCP tool, and the tool's sanitised input fields | none |
| `permission_denied` | `PermissionDenied` (auto mode) | `tool_name`, `tool_use_id`, `reason` (the classifier's rule, such as `[Data Exfiltration]`), `mcp_server` for an MCP tool, and the tool's sanitised input fields | none |
| `command_expanded` | `UserPromptExpansion` | `expansion_type` (`slash_command`, `mcp_prompt`), `command_name`, `command_source` | `command_args` |
| `task_created` | `TaskCreated` | `task_id`, `teammate_name` | `task_subject`, `task_description` |
| `task_completed` | `TaskCompleted` | `task_id`, `teammate_name` | `task_subject`, `task_description` |
| `teammate_idle` | `TeammateIdle` (an agent-team teammate finished its turn and waits) | `teammate_name` | none |
| `cwd_changed` | `CwdChanged`, or the first other hook to run in a new directory | `old_cwd`, `new_cwd` | none |
| `config_changed` | `ConfigChange` | `source` (`user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`), `file_path` | none |
| `elicitation_requested` | `Elicitation` (an MCP server asks the user for input) | `mcp_server`, `mode` (`form`, `url`), `elicitation_id` (URL mode) | `message`, `url`, `requested_schema` (as JSON text) |
| `elicitation_responded` | `ElicitationResult` | `mcp_server`, `mode`, `elicitation_id`, `action` (`accept`, `decline`, `cancel`) | `content`, the user's answer (as JSON text) |

Two signals come from a framework rather than a hook. `agent_handoff`,
on the agent that hands off, with `signal_data` `from` and `to` (the
two agents' names, either left out when not known) and no content,
whatever the capture setting. Ingestion's GenAI dialect emits it for
an OpenTelemetry GenAI run (see OTLP ingest > GenAI dialect >
Sessions), and the Python sensor emits it through
`Session.emit_agent_handoff`, which the LlamaIndex and OpenAI Agents
SDK wraps call
(see Sensor > Sub-agent framework coverage), with the same names,
bounds and stored shape, so the worker and the dashboard do not tell
the two apart. The dashboard's feed line reads
`hand-off · <from> → <to>`. `guardrail_tripwire`, on the guarded
agent, from the sensor's OpenAI Agents SDK wrap through
`Session.emit_guardrail_tripwire`: `signal_data` `guardrail`, `kind`
(`input`, `output`, `tool_input`, `tool_output`) and `agent`, names
only and no content, whatever the capture setting. The dashboard's feed
line reads `guardrail tripped · <guardrail> · <kind>`, with the kind's
underscore as a space.

The sanitised input fields are the whitelist `tool_call` events use
(`file_path`, `command`, `query`, `pattern`, `prompt`; see Content
Capture), with line breaks and tabs turned into spaces and each cut
to 256 bytes, sent only while `captureToolInputs` is on and only for
built-in tools: an MCP tool's arguments stay in its `mcp_tool_call`
content. The directory and settings-file paths are metadata, like the
session's `working_dir`, and are cut to 256 bytes rather than dropped.
The expansion hook's `prompt` is not repeated in the signal: the
turn's own events carry it (its `pre_call`, and the user message in
its `post_call` content).

Claude Code runs a plugin's `CwdChanged` hook only when the user's
settings register a `CwdChanged` hook too, so the plugin also detects a
change itself. It keeps the directory each session's hooks last ran in,
set at `SessionStart`. Every hook except `SessionStart`, `SessionEnd`,
`SubagentStart`, `SubagentStop` and `PreToolUse` compares its `cwd`
with it, and one whose `cwd` differs reports `cwd_changed` before its
own event; a subagent's hooks compare against the subagent session's
own record. The compare and the write happen under a lock, so of
several hooks running at once in the new directory exactly one reports
the change, and the `CwdChanged` hook records through the same state,
so a change is reported once. The record is written before the POST:
a change whose POST fails is not reported again. A hook that started
before a `cd` and runs after a later one has recorded the new
directory reports a change back to its own `cwd`.

The plugin registers the compaction, model-switch and `Elicitation`
hooks synchronously and the rest asynchronously (see Hook
configuration). Every one of them only observes: an asynchronous hook
cannot answer a permission prompt or block an expansion, a task or a
settings change, and the synchronous `Elicitation` hook prints nothing,
so it never answers or changes an MCP server's request for input. An
elicitation's URL is content, not metadata: a URL-mode request can
carry a token in it.

The worker stores the event and advances the session's `last_seen_at`.
A `model_switched` signal carries the new model as `model`, which the
worker makes the session's model, and the plugin labels later
`pre_call` events with it; the other signals carry no `model`. No
signal changes a token count.

### MCP event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`)

First-class observability for Model Context Protocol (MCP) traffic. The
sensor patches `mcp.client.session.ClientSession` directly so
every framework that mediates MCP through the official SDK
(LangChain via `langchain-mcp-adapters`, LangGraph via the same,
LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`,
plus the raw mcp SDK) routes through one patch surface and emits
the same six event types.

The Claude Code plugin emits **only** `MCP_TOOL_CALL` —
`mcp__<server>__<tool>` is the only MCP namespace visible from the
hook surface; resource reads, prompt fetches, and list operations
are below the hook layer. Both surfaces share the same wire schema
for tool calls so the dashboard renders identically across origin.
The plugin's `server_name` is the resolved server key (the hook's
`mcp_server.name` when Claude Code sent it, else the tool-name segment
rebuilt to `plugin:<plugin>:<server>`; see Tool calls and failures), and
it adds two fields the sensor never sends: `tool_use_id`, and
`mcp_server` (`{name, source}` exactly as Claude Code sent it, present
only when the hook carried it, stored in `payload.mcp_server`).

**Lean payload**. Sensor MCP events drop the LLM-baseline fields
(`tokens_input`, `tokens_output`, `tokens_total`, `tokens_cache_*`,
`model`, `latency_ms`, `tool_input`, `tool_result`, `has_content`)
and carry only MCP-specific fields; the plugin's `mcp_tool_call` still
carries its base identity block with `model` and zeroed `tokens_*`
fields, which the workers service does not read for MCP rows:

| Field | List events | tool_call | resource_read | prompt_get |
|---|---|---|---|---|
| `server_name` | ✓ | ✓ | ✓ | ✓ |
| `transport` | ✓ | ✓ | ✓ | ✓ |
| `duration_ms` | ✓ | ✓ | ✓ | ✓ |
| `count` | ✓ | — | — | — |
| `tool_name` (top-level) | — | ✓ | — | — |
| `tool_use_id` (plugin only) | — | ✓ | — | — |
| `mcp_server` (plugin only) | — | ✓ | — | — |
| `arguments` | — | gated | — | gated |
| `result` | — | gated | — | — |
| `resource_uri` | — | — | ✓ | — |
| `content_bytes` | — | — | ✓ | — |
| `mime_type` | — | — | gated | — |
| `prompt_name` | — | — | — | ✓ |
| `rendered` | — | — | — | gated |
| `error` | optional | optional | optional | optional |

`gated` fields appear only when `capture_prompts=True`. The structured
`error` block (taxonomy: `invalid_params` / `connection_closed` /
`timeout` / `api_error` / `other`) is populated on failure paths
across every type.

**Server fingerprint at session level**. The handshake is patched to
stamp an `MCPServerFingerprint` onto the sensor session: on mcp 1.x
`ClientSession.initialize` (from its `InitializeResult`); on mcp 2.x
`ClientSession.adopt`, which every 2.x handshake reaches (the legacy
`initialize()`, the `server/discover` probe of `Client(mode="auto")`,
and a caller adopting a prior discover result), reading the session's
negotiated `server_info`, `protocol_version`, `server_capabilities`
and `instructions`. mcp 2.x's high-level `Client` builds its session
over a dispatcher rather than a marked stream pair and binds its
transport factories at import, so `Client._build_session` is patched
to stamp the transport and server URL from the `Client`'s target (a
URL string is `http`; `StdioServerParameters` is `stdio` with
`<command> <args>`; an in-process server has neither). Result models
are stored under the protocol's JSON names on both SDK lines
(`model_dump(by_alias=True)`: 2.x models use snake_case fields with
camelCase aliases), and the JSON-RPC request-timeout code `-32001`
classifies as `timeout`. When the sensor's
session_start ships AFTER the initialize call, `context.mcp_servers`
carries the full fingerprint list — name, transport, protocol_version
(str | int, preserved verbatim per Override 5), version, capabilities,
instructions — which the worker writes once into `sessions.context`.
For servers initialised AFTER `session_start` (the common case for
late-attaching MCP frameworks), the sensor emits a wire event
`mcp_server_attached` carrying the same fingerprint plus an
`attached_at` timestamp; the worker projects it into
`sessions.context.mcp_servers` via an idempotent UPSERT-with-dedup
keyed on `(name, server_url)`. The dashboard's SessionDrawer
re-fetches the session detail when an `mcp_server_attached` event
arrives on the matching session over the existing fleet WebSocket,
so the MCP SERVERS panel populates within 2-3s of the attach for
in-flight sessions. Emission is fire-and-forget — failure to emit
never adds latency to or breaks the agent's hot path.

`mcp_server_attached` carries `policy_decision_at_attach`, the
shared `policy_decision` block evaluated against the attached
server at attach time. Operator sees what the policy says about
this server without joining time-windowed policy state. Mode-
default fall-through path populates the block with
`decision_path="mode_default"` and no `matched_entry_id`. Allow
decisions populate the block; deny decisions populate it AND the
enforcement path raises `MCPPolicyBlocked`.

`mcp_server_name_changed` records the rename itself. A rename leaves
every policy entry for the server's URL in force, because entries match
on the URL, so the worker adds nothing to the event. A stored row that
carries a `policy_entries_orphaned` block (`{count,
sample_entry_ids[<=5], affected_policies[]}`) is rendered inline as
"name drift: \<old\> → \<new\> (N entries orphaned)".

**Content overflow** (B-6). `MCP_RESOURCE_READ` payloads can carry
large captured bodies. The wire envelope routes content one of two
ways:

- **Inline** when the captured body fits the events.payload column
  (≤ 8 KiB threshold) — `content` lands in `events.payload.content`
  via the worker's MCP-content projection.
- **Overflow** when `has_content=true` is set on the wire — the
  worker's existing `event_content` table path takes over (the same
  path LLM prompt content uses), and the dashboard fetches via
  `GET /v1/events/{id}/content`. A 2 MiB hard cap applies; bodies
  beyond that are truncated with a marker.

`MCP_TOOL_CALL` and `MCP_PROMPT_GET` route their captured arguments
and result (rendered messages for a prompt fetch) to `event_content`'s
`tool_input` / `tool_output` columns with `has_content=true`; nothing
is inline on the event. The event's MCP details accordion fetches them
from `GET /v1/events/{id}/content` when it opens and shows them as
Arguments and Result (or Rendered). A row stored before the dedicated
columns keeps them inline as `arguments` / `result` / `rendered`
(with per-field truncation markers for large values), and the
accordion shows those as stored. A call with nothing captured says
why: the capture-disabled notice when capture is off for its run
(the run's stored `capture_prompts`, or any of its events storing
content, as the Prompts tab reads it), otherwise that the call
recorded no request or response body. When the run cannot be loaded,
its capture setting is unknown and the accordion says it could not
check it, with the error, rather than claiming capture is off.

**Dashboard surfacing**. Every MCP event_type renders with its own
TYPE pill ("MCP TOOL CALL", "MCP TOOLS DISCOVERED", "MCP RESOURCE
READ", "MCP RESOURCES DISCOVERED", "MCP PROMPT FETCHED", "MCP
PROMPTS DISCOVERED" — verbs distinguish "agent invoked" from
"agent discovered", "MCP" prefix disambiguates from the generic
`tool_call` "TOOL" pill in contexts without colour-family
attribution). The Fleet swimlane renders MCP events with a
hexagon clip-path shape (B-5b) so the family is identifiable
from the timeline at a glance even without reading badge text. A
small inline error indicator (red AlertCircle) decorates rows
whose `payload.error` is populated, and failed `tool_call` rows
alike, so failures surface without expanding the row. The session detail drawer's MCP SERVERS panel
lists every fingerprint from `context.mcp_servers`.

### Per-event `framework` field

Every event carries a bare-name `framework` field (`langchain`,
`crewai`, `langgraph`,...) populated at sensor `init` from
`FrameworkCollector` via `Session.record_framework`, or from a later
event once a framework imported after `init` is loaded (see Sensor >
Framework attribution). Higher-level framework wins over SDK transport.
The versioned form (`langchain/0.3.27`) lives in `context.frameworks[]`
for diagnostic detail; the bare name lives on the per-event field.

`framework=null` is valid and means no classifier has matched yet. The
Claude Agent SDK interceptor emits `framework="claude_agent_sdk"` on its
sessions' events, with `claude_agent_sdk/<version>` first in their
`context.frameworks[]`. The Claude Code plugin emits `framework="claude-code"`, with
`claude-code/<version>` in `context.frameworks[]`, or a bare
`claude-code` when it cannot tell the version; the OTLP receiver
sends `framework="claude-code"` for Claude Code's telemetry too, and
`context.claude_code_version` in place of the versioned entry. Its GenAI dialect
emits the framework label (`pydantic_ai`, `strands`, `openai_agents`,
`google_adk`), with `<label>/<version>` in `context.frameworks[]`.

---

## Content Capture

Event payloads carry two classes of captured content, each gated by an
independent knob. The two-knob split is deliberate: the
privacy calculus and the safe handling differ per class, and a single
knob would either strip too much or too little for the developer use case
the plugin targets.

### `captureToolInputs` — tool-call arguments

Governs tool-call arguments: file paths, command strings, query strings,
search patterns, and prompt strings on tools that accept one.

Every tool_input passes through the sanitiser before emission. The
sanitiser is a strict whitelist implemented in
`plugin/hooks/scripts/claude_code/tools.mjs::sanitizeToolInput`:

- Keys kept: `file_path`, `command`, `query`, `pattern`, `prompt`. Every
  other field is dropped at the source; structured inputs that don't map
  onto one of these keys never reach the network.
- String values truncated: `prompt` at 100 chars, everything else at 200.
  Truncation happens before JSON serialisation.
- Raw file bodies written by `Write` / `Edit` are never forwarded. Those
  tools carry their body as the `content` key, which is not on the
  whitelist.

Plugin default: ON. The Python sensor has no direct equivalent because it
captures tool use via the LLM message array when `capture_prompts=true`.

### `capturePrompts` — LLM content and tool results

Governs LLM prompt / response content, embedding inputs, and tool_result
bodies: the user's prompt text, assistant response text, thinking blocks,
embedding inputs, and the output of each tool the LLM invoked. A
streamed response is stored as a non-streamed one is, assembled from the
stream; a stream the caller left early stores what had arrived (see
"Streaming metering" under `post_call`). An OpenAI Responses request is
stored as its own parameters: `instructions` in `system` and `input`
verbatim in `input` (a string, or the list of input items, SDK objects
among them dumped as the JSON the SDK sends); `messages` stays empty, as
the Responses API has no messages parameter.

No sanitiser applies. Outputs can carry arbitrary prompt-like content
(model-generated text, tool-fetched web pages, search results) and a
whitelist cannot express "keep the parts that are safe" without mangling
the structure or leaking the content it was trying to protect. The knob
is all-or-nothing per session.

The plugin and the sensor cut captured content that would take an
event past the 768 KiB body limit, marking each cut string (see
Plugin, Configuration, which describes the measure and the marker; the
sensor's `transport/body_limit.py` applies the same rule to every
event it POSTs). Token counts and the metadata outside `content` are
never cut.

When `capture_prompts=false`, every content field on every event type is
zeroed: `has_content=false`, `content=null`. The event still ships, so
the dashboard shows the session, token counts, and metadata; only the
bodies are absent. The Prompts tab renders "Prompt capture is not
enabled for this deployment."

A failed tool call's error text is content of both classes at once: a
command's stderr is a tool result, and an `Edit` failure quotes the
`old_string` argument it could not find. The plugin therefore sends
`error.message` only when both knobs are on and otherwise ships it as
`<redacted>`, with `error_type`, `error_class` and `interrupted` intact;
the workers service applies the session's stored capture posture to the
same field for every client type the registry marks as stripping tool
error text (the hook-based clients and OTLP), so a forged per-event flag
cannot smuggle the text in.

Plugin default: ON. A developer running `claude` locally is
observing their own conversation; an empty Prompts tab would make the
feature useless without improving privacy. Python sensor default:
OFF. The sensor runs inside production agents where content may
carry
PII, proprietary prompts, and customer context; opt-in is the correct
posture.

### Why two knobs

A developer who wants tool-call visibility but not LLM response bodies
sets `capturePrompts=false` and keeps `captureToolInputs=true`. That
configuration matters for tools whose outputs are sensitive (internal
search indexes, fetched documents) even though their inputs are narrow
strings. A single knob would either strip tool visibility entirely or
leak response bodies alongside safe tool args.

### Modality parity principle

> Every modality that has a request/response payload supports content
> capture gated by the `capture_prompts` flag (or modality-specific
> variants where genuinely needed). Modalities that ship without content
> capture ship a documented gap that must be called out in the coverage
> matrix and fixed before launch.

Per-framework embeddings content capture matrix:

| Framework | Native embeddings | Capture path |
|---|---|---|
| Anthropic SDK | N/A — route via litellm → Voyage | N/A |
| OpenAI SDK | ✅ | `interceptor/openai.py`; `extract_content` branches on `event_type=EMBEDDINGS` to capture `request_kwargs["input"]` |
| litellm | ✅ | Module-level patch on `embedding` / `aembedding` |
| LangChain | ✅ via OpenAI transitively; ⚠ Voyage-direct deferred | `OpenAIEmbeddings.embed_*` rides through the OpenAI patch |
| Claude Code plugin | N/A — observational | N/A |

Content (when captured) round-trips: sensor `PromptContent.input` →
ingestion `payload.content` → worker `event_content.input` JSONB →
`GET /v1/events/:id/content` → dashboard `<EmbeddingsContentViewer>`.

The viewer carries three render branches: single string (`"text to
embed"`), list (`["batch", "of", "strings"]`), and no-content
(`capture_prompts=false`).

### `GET /v1/events/:id/content`

Returns 404 when capture is disabled for that session. Not 200 with
empty data. Not 403. 404 — the resource does not exist.

---

## Directives

### Built-in actions

| Action | Source | Sensor behaviour |
|---|---|---|
| `shutdown` | Operator (`POST /v1/directives` with `session_id`, or with `agent_id` for every live run of an agent) | Raises `DirectiveError` after `grace_period_ms`; triggers `session.teardown` |
| `shutdown_flavor` | Operator (`POST /v1/directives` with `flavor`, fans out via `GetActiveSessionIDsByFlavor`) | Same as `shutdown` per session |
| `degrade` | Worker policy evaluator | Sets `_forced_degrade` + `degrade_to`; subsequent `check` returns `DEGRADE` |
| `warn` | Worker policy evaluator | Fires `WARN` callback once per session at `warn_at_pct` (fire-once rule) |
| `policy_update` | No issuer today (the sensor keeps the handler) | Calls `PolicyCache.update(policy_dict)`; clears `_forced_degrade` |
| `custom` | Operator (with registered fingerprint) | Validates payload via `DirectivePayloadSchema`, looks up handler, runs with timeout, emits `directive_result` |

`degrade` / `warn` / `policy_update` are NOT user-creatable via
`POST /v1/directives`. `degrade` and `warn` are written by the worker's
policy evaluator when a session crosses a threshold, so the only way to
trigger a `degrade` is to create a token policy and let the worker fire it
on the next `post_call` event. `policy_update` has a sensor-side handler
but no server path issues it: the policy mutation endpoints do not write
directives, so a running sensor keeps the policy it fetched at init.

There is no `block` `DirectiveAction` value. When the worker's policy
evaluator detects that a session has crossed `block_at_pct`, it writes
a `shutdown` directive (action `shutdown`, reason `token_budget_exceeded`)
rather than a `block` directive. Block enforcement happens locally in
the sensor's `_pre_call` via the PolicyCache decision, which raises
`BudgetExceededError` and emits a `policy_block` event before the
provider is reached. The worker's `shutdown` directive is the parallel
mechanism that catches sessions that re-attach with stale local cache
state. See "Event Types → policy_block".

### Delivery

Directives are delivered in the HTTP response envelope of the sensor's
next `POST /v1/events` call. `LookupPending(sessionID)` does an atomic
UPDATE...RETURNING that combines lookup and mark-delivered in a single
operation — directives are delivered exactly once.

### Sensor acknowledgement

Before acting on `SHUTDOWN`, `SHUTDOWN_FLAVOR`, or `DEGRADE`, the sensor
emits a `directive_result` event with `directive_status="acknowledged"`.
For shutdown variants the sensor calls `EventQueue.flush` synchronously
before raising the shutdown flag so the acknowledgement is not lost when
the process exits. Custom handlers emit `directive_result` with
`directive_status` of `success` or `error` after handler return.

### Observer-session class

A session is directive-capable when its `context.supports_directives`
is `true`, or, when its `session_start` omitted the field, when its
`client_type`'s registry default is `true` (see Client type registry).
The Claude Code plugin sets `context.supports_directives` explicitly:
`true` when its enforcement is on (see Plugin > Enforcement), `false`
otherwise; the sensor omits it and takes its type's `true` default. A row with neither
the flag nor a `client_type` (the column is nullable on `sessions`) is
treated as observer-only when its flavor or framework marks it as a
Claude Code session, so an old plugin row never regains a Stop button.
The dashboard hides the Stop Agent button for observer sessions and
gates the Fleet Stop All control on at least one directive-capable live
session of the agent. Custom directives need more: a session runs them
when it is directive-capable and its `client_type` runs custom
directives (the registry's `runs_custom_directives`, `true` only for
the sensor; a row with no `client_type` falls back as above). The run
drawer's Directives tab and the Fleet sidebar's directive trigger
appear only for such sessions, so neither an observer session nor an
enforcement-on Claude Code plugin session or Agent SDK run, which
answer a custom directive with an error, is offered one. A Claude Code
session reported over OTLP is an observer session: its
`context.supports_directives` is `false`. So is every session of an
OpenTelemetry GenAI framework (`client_type=otlp`, see OTLP ingest >
GenAI dialect), which also arrives already closed.

---

## MCP Protection Policy

The MCP Protection Policy gates which Model Context Protocol servers an
agent is allowed to talk to. It rides on the same `ClientSession` patch
surface that powers MCP first-class observability — the policy
machinery evaluates each `call_tool` against a fingerprinted server
identity and emits warn / block decisions through the standard event
pipeline. The policy is fetched once per session at sensor `init`
(Python) or `SessionStart` (Claude Code plugin) and cached for the
session's lifetime; mid-session policy updates apply at the next
`session_start`.

### Identity model

Server identity for policy is the canonical URL (or stdio command).
Entries match on it alone: two servers with the same URL but different
declared names are the same enforcement target, and a server that
reports another name, or none (an mcp 2.x server may omit its
`server_info`), still meets the entries for its URL. The name is the
display label and the tamper-evidence axis: when an agent declares a
server with a known URL under a new name, the sensor emits a
`mcp_server_name_changed` event so operators can see drift. The sensor,
the plugin and the API's resolve endpoint all match this way, so a
dashboard preview agrees with enforcement.

**HTTP canonical form.** Lowercase scheme + host. Strip default ports
(`:80` for `http`, `:443` for `https`). Strip a trailing slash only at
the root (`https://example.com/` → `https://example.com`; deeper paths
preserve their trailing slash because path semantics carry). Preserve
path case beyond the root segment. Drop user-info, fragment, and query
entirely.

**Stdio canonical form.** Prefix with `stdio://`. Concatenate the
literal command and its args with single-space separators after
collapsing internal whitespace runs to one space. Resolve env-var
references (`$VAR`, `${VAR}`) at fingerprint time using the agent's
current environment. Args are case-sensitive (file paths and flags
matter byte-for-byte).

**Hash recipe.** `sha256(canonical_url + 0x00 + name)`, hex-encoded.
The first 16 hex characters are the display fingerprint stored on each
entry and stamped on policy decisions; it names a (URL, name) pair for
display and drift tracking, and is not the matching key. The 0x00
separator prevents `("https://a.com", "bservice")` and
`("https://a.combservice", "")` from colliding.

### Two-scope policy model

One **global** policy plus zero or more **per-flavor** policies. The
global policy carries the **mode** (allowlist or blocklist) and a list
of entries; per-flavor policies carry only allow / deny entry deltas
against whatever the global resolves to. A flavor policy never carries
its own mode.

On install the platform auto-creates an empty global policy in
`blocklist` mode with zero entries — fully permissive by default. No
operator action is required for MCP traffic to keep flowing on a fresh
deployment; locking down a flavor is opt-in.

### Per-server resolution

For a server URL evaluated against `(global, flavor)`, where a scope
that holds several entries for the URL (recorded under different names)
uses the most restrictive one (a blocking deny, then a warning deny,
then an allow):

1. If the per-flavor policy has an entry whose canonical URL matches,
   use that entry's enforcement decision (allow / deny + warn / block;
   `interactive` is accepted on entries but enforced as block, see
   Enforcement).
2. Else if the global policy has an entry whose canonical URL matches,
   use that.
3. Else apply the global mode default: `allowlist` mode → block;
   `blocklist` mode → allow.

Worked example. Global is `allowlist` mode with entries
`[https://maps.example.com, https://search.example.com]`. Flavor
`production` overrides with a deny entry for `https://maps.example.com`
and an allow entry for `https://wiki.internal/`.

| Request | Step 1 (flavor) | Step 2 (global) | Step 3 (mode default) | Result |
|---|---|---|---|---|
| `https://maps.example.com` | flavor deny | — | — | block (flavor wins) |
| `https://search.example.com` | no entry | global allow | — | allow |
| `https://wiki.internal/` | flavor allow | — | — | allow |
| `https://other.example.com` | no entry | no entry | allowlist → block | block |

### Enforcement

Per-entry decisions carry an enforcement value:

- `warn` — emit `policy_mcp_warn`, let the call proceed.
- `block` — emit `policy_mcp_block`, raise `flightdeck.MCPPolicyBlocked`
  before the wire request leaves the agent.
- `interactive` — accepted by the API and offered in the dashboard's
  entry dialog, but no enforcement path implements it: the sensor and the
  plugin both treat a deny entry marked `interactive` as `block`. The
  interactive flow that does exist is the plugin's unknown-server prompt:
  in `allowlist` mode a server with no entry makes the `PreToolUse` hook
  answer `ask`, Claude Code shows its own permission prompt, and an
  approval is remembered locally — see Plugin remembered decisions below.

`block_on_uncertainty` is a per-flavor boolean toggle, default false,
only meaningful in `allowlist` mode. When true, the resolution
algorithm's step 3 fallback becomes "block + emit `policy_mcp_block`"
instead of the standard allowlist-mode block. The semantic difference
is auditing: `block_on_uncertainty=true` means "I want a block decision
recorded against this URL the first time it's seen so I can promote it
to a deliberate allow." Under `blocklist` mode the toggle is ignored
because the mode default is already permissive.

### Storage schema

> **Binding contract.** The schema below is the live state after
> migrations 000018 (initial four tables), 000019 (seed
> empty-blocklist global row), and 000020 (drop the
> `mcp_policy_versions` table and the `version` column). Migrations
> ship under `storage/migrations/` (the Postgres files, and the SQLite
> baseline that carries the same tables); the Helm chart picks the
> Postgres files up via `helm/Makefile sync-migrations`. Any deviation
> — column rename, type change, additional or removed constraint,
> index difference — requires a new `DECISIONS.md` entry recording
> the pivot BEFORE the migration is written.

```sql
CREATE TABLE mcp_policies (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid,
    scope                 TEXT NOT NULL CHECK (scope IN ('global', 'flavor')),
    scope_value           TEXT,                                 -- NULL for global, flavor name for flavor
    mode                  TEXT CHECK (mode IN ('allowlist', 'blocklist')),  -- NULL on flavor rows
    block_on_uncertainty  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW,
    CHECK ((scope = 'global' AND scope_value IS NULL AND mode IS NOT NULL)
        OR (scope = 'flavor' AND scope_value IS NOT NULL AND mode IS NULL))
);

CREATE UNIQUE INDEX mcp_policies_scope_idx
    ON mcp_policies (scope, COALESCE(scope_value, ''));

CREATE TABLE mcp_policy_entries (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid,
    policy_id             UUID NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE,
    server_url_canonical  TEXT NOT NULL,
    server_name           TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,        -- 16-char hex (display); full sha256 not stored
    entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('allow', 'deny')),
    enforcement           TEXT CHECK (enforcement IN ('warn', 'block', 'interactive')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW
);

CREATE UNIQUE INDEX mcp_policy_entries_policy_fp_idx
    ON mcp_policy_entries (policy_id, fingerprint);
CREATE INDEX mcp_policy_entries_url_idx
    ON mcp_policy_entries (server_url_canonical);

CREATE TABLE mcp_policy_audit_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid,
    policy_id    UUID REFERENCES mcp_policies(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN (
        'policy_created', 'policy_updated', 'policy_deleted',
        'mode_changed', 'entry_added', 'entry_removed',
        'block_on_uncertainty_changed'
    )),
    actor        UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW
);

CREATE INDEX mcp_policy_audit_log_policy_idx
    ON mcp_policy_audit_log (policy_id, occurred_at DESC);
```

Three live tables: `mcp_policies`, `mcp_policy_entries`,
`mcp_policy_audit_log`. The `mcp_policy_versions` table that
migration 000018 created was dropped by 000020; the audit log is the durable modification trail; per-PUT
snapshots and the diff endpoint are gone. The `version` column on
`mcp_policies` was dropped by the same migration.

The audit log table records **policy mutations only** — actor + diff
of operator-initiated changes. Sensor-observed system state (name
drift, decision events) ships through the standard event pipeline as
typed event rows, not as audit log entries.

Soft-delete is intentionally not implemented — a deleted flavor
policy means the global takes over, and the deletion event is
preserved in the audit log.

### Fetch and cache lifecycle

**Sensor (Python).** The control-plane client fetches the active
policy at `init` synchronously, alongside the existing token policy
preflight. Result is cached on the `Session` object for the session's
lifetime. A `policy_update` directive received in a response envelope
refreshes the cache in place; the new policy applies at the next
`session_start` (in-flight sessions keep the policy that was active at
their start). Fail-open: if the control plane is unreachable AND
`FLIGHTDECK_UNAVAILABLE_POLICY=continue` AND `block_on_uncertainty`
is not in force on a relevant flavor, the agent proceeds with no
enforcement.

**Plugin (Claude Code).** The `SessionStart` hook fetches the policy
applicable to the active flavor. Cached on disk at
`~/.claude/flightdeck/mcp_policy_cache.json`, keyed by token. TTL
defaults to one hour; subsequent `SessionStart` invocations reuse the
cache until the TTL expires, at which point the next start re-fetches.
Cache miss + control plane unreachable produces the same fail-open
behaviour as the sensor.

**Dashboard.** Direct REST against the policy endpoints (see
Enforcement contracts below). No client-side cache: the MCP Protection
tab loads on mount and reloads after every mutation.

### Enforcement contracts

**Sensor.** The MCP interceptor's `call_tool` patch calls
`PolicyCache.evaluate_mcp(server_url, server_name, tool_name)` before
invoking the wrapped method. The result is one of `allow` / `warn` /
`block`. On `warn` the sensor emits `policy_mcp_warn` and proceeds. On
`block` the sensor emits `policy_mcp_block`, flushes the event queue
synchronously (so the block lands at the dashboard before the agent
sees the failure), and raises `flightdeck.MCPPolicyBlocked` — a typed
exception that frameworks surface as a tool-call failure to the
agent's reasoning loop. The exception carries `server_url`,
`server_name`, `fingerprint`, `policy_id`, and `decision_path` so the
agent (or its surrounding harness) can render an actionable failure
message.

**Plugin.** Enforcement is split across three Claude Code hooks.
Every hook runs one entry script
(`plugin/hooks/scripts/observe_cli.mjs`), which hands the event to the
dispatcher in `claude_code/dispatch.mjs`; it branches on
`hook_event_name`, and the MCP policy branches live in
`claude_code/mcp_policy_dispatch.mjs`.

- **`SessionStart`** — reads `.mcp.json` (the existing
  `loadMcpServerFingerprints(cwd)` helper handles
  `~/.claude.json` overrides), fingerprints each declared server,
  and batch-fetches global + flavor policies in parallel via
  `Promise.all` against `GET /v1/mcp-policies/global` +
  `GET /v1/mcp-policies/{flavor}`. Cached to a per-session marker
  file at `<state directory>/mcp-policy-<session_id>.json`
  so subsequent `PreToolUse` invocations don't repeat the HTTP
  fetch on the agent hot path. The cache lives for the whole Claude
  Code invocation: `Stop` leaves it in place so later turns stay
  enforced, and `SessionEnd` deletes it. SessionStart additionally emits
  `policy_mcp_warn` / `policy_mcp_block` events for any
  non-`allow` decision so operators see fleet-level enforcement
  activity at session boot. Fail-open: any HTTP error produces an
  empty cache and per-call evaluation falls through to mode-default.
- **`PreToolUse`** — the per-call gate. When `tool_name` matches
  the `mcp__<server>__<tool>` shape: resolve the server (the hook's
  `mcp_server.name` when Claude Code sent it, else the parsed server
  segment), look up its `.mcp.json` fingerprint by that key or by the
  literal tool-name segment (a project server named `plugin_foo_bar`
  parses to `plugin:foo:bar` but is declared under its literal name),
  read the per-session policy cache AND
  read the remembered-decisions file fresh (NOT cached at
  `SessionStart` — concurrent Claude Code sessions on the same
  machine see each other's remembered decisions in real time),
  and emit a hook decision:
  - **block** decision → write
    `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..."}}`
    to stdout. Claude Code refuses the call and surfaces the reason to
    the agent reasoning loop. Block in plugin context is the per-call deny rather than
    a session-wide unreachability flag, mirroring the sensor's
    architecture of "block at call_tool" rather than "block at
    initialize".
  - **unknown-allowlist** decision → `permissionDecision: "ask"` in
    the same envelope. Claude Code's built-in approval flow prompts the
    user yes / no; a previously remembered approval answers `allow`
    instead.
  - **allow** / **warn** → write nothing; Claude Code's normal
    permission flow applies.
- **`PostToolUse`** — the de-facto-approval write path. When
  an `mcp__<server>__<tool>` call succeeded AND the server was
  unknown-allowlist on this session AND no remembered decision
  exists yet for the active token: write the
  remembered-decisions file AND emit
  `mcp_policy_user_remembered` event, carrying the hook's
  `permission_mode`. Reactive yes-and-remember
 Claude Code's `ask` flow returns yes/no only with
  no built-in "remember" affordance, so the plugin treats a
  successful post-`ask` call as evidence of de-facto approval.
- **`Stop`** — leaves the per-session policy marker file in place so
  later turns stay enforced; `SessionEnd` deletes it.

Operator-side deny entries always override remembered allows.
A remembered "yes" the user gave on day 1 stops applying the
moment the operator pushes a flavor deny entry for that server
— the next `SessionStart` re-fetches the policy and `PreToolUse`
sees the deny first.

**Control-plane API.** Endpoints live under `/v1/mcp-policies`
(kebab-plural, matching the `/v1/access-tokens` convention).
Authentication uses the standard Bearer-token middleware that
covers the rest of the API. Single-tier auth: every authenticated
bearer token has full access — both reads and mutations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/mcp-policies/global` | Fetch the global policy + entries. Always returns 200 (seeded by migration 000019; idempotently re-ensured at API boot) |
| `GET` | `/v1/mcp-policies/:flavor` | Fetch the flavor policy + entries. 404 when no flavor policy exists |
| `GET` | `/v1/mcp-policies/resolve` | Sensor / plugin preflight. Query params `flavor`, `server_url`, `server_name`; returns the resolved decision (`allow` / `warn` / `block`) and the `decision_path` that produced it (`flavor_entry` / `global_entry` / `mode_default`). GET-only — idempotent, safe, cacheable |
| `GET` | `/v1/mcp-policies/global/audit-log` | Mutation history for the global policy. Query params `from` (ISO 8601), `to`, `event_type`, `limit`, `offset` |
| `GET` | `/v1/mcp-policies/:flavor/audit-log` | Mutation history for the flavor policy, same query params |
| `GET` | `/v1/mcp-policies/:flavor/metrics` | Aggregated `policy_mcp_warn` + `policy_mcp_block` events scoped to the flavor's policy. `?period=` accepts `24h` / `7d` / `30d`. Returns `granularity` ("hour" for 24h, "day" for 7d/30d) plus zero-filled `buckets` array alongside per-server aggregates |
| `GET` | `/v1/mcp-policies/templates` | List shipped templates — name, description, recommended_for. Three templates ship: `strict-baseline`, `permissive-dev`, `strict-with-common-allows` |
| `POST` | `/v1/mcp-policies/:flavor` | Create a new flavor policy. The global is seeded on install and cannot be POST'd. 409 if the flavor policy already exists |
| `PUT` | `/v1/mcp-policies/global` | Replace global policy state — mode, entries, `block_on_uncertainty`. Atomic transaction: SELECT FOR UPDATE → UPDATE policy → DELETE entries → INSERT new entries → INSERT audit-log entry |
| `PUT` | `/v1/mcp-policies/:flavor` | Replace flavor policy state — entries, `block_on_uncertainty` (mode is global-only). Same atomic transaction shape as the global PUT |
| `DELETE` | `/v1/mcp-policies/:flavor` | Delete a flavor policy. Global cannot be deleted. The audit-log entry survives via `ON DELETE SET NULL` on `policy_id`; the deletion event is preserved |
| `POST` | `/v1/mcp-policies/:flavor/apply_template` | Apply a named template (`{"template": "strict-baseline"}` body) to the flavor policy. Same atomic transaction as PUT; audit log payload carries `applied_template=<name>` |

#### Install-time seed and boot-time idempotent retry

The empty-blocklist global policy row is seeded by migration
`000019_mcp_protection_policy_seed_global.up.sql`. The
seed SQL is an idempotent INSERT identical in shape to the boot
hook below:

```sql
INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
SELECT 'global', NULL, 'blocklist', false
WHERE NOT EXISTS (SELECT 1 FROM mcp_policies WHERE scope = 'global');
```

The migrator is the single writer for this row. By the time api
can `SELECT` from `mcp_policies` the seed has already landed,
which closes the cold-boot race where api raced workers to a
fresh postgres and 500'd every `GET /v1/mcp-policies/global`
until manual restart (context).

`store.EnsureGlobalMCPPolicy(ctx)` still runs at API boot as a
defensive idempotent retry — same SQL, same `WHERE NOT EXISTS`
predicate, race-safe under read-committed because the unique
index `(scope, COALESCE(scope_value, ''))` rejects a concurrent
second insert; on `pgconn.PgError.Code = '23505'`
(unique_violation) the caller treats it as "already created" and
proceeds. this hook noops on every cold boot
(migration owns the row); it remains for install paths that
might run api before migrations (e.g. operator-managed Helm
charts in the future). API startup logs `INFO ensure global mcp
policy at boot complete` on success.

#### Policy templates

Three templates ship with the API, embedded via `embed.FS` from
`api/internal/handlers/mcp_policy_templates/*.yaml`:

- **`strict-baseline`** — allowlist mode, `block_on_uncertainty=true`,
  zero entries. Operator adds explicit allows from there. Use case:
  production flavor where the operator wants the "everything blocks
  until I say so" posture.
- **`permissive-dev`** — blocklist mode, `block_on_uncertainty=false`,
  zero entries. Same shape as the default global, but explicit. Use
  case: dev flavor where unknown servers should pass.
- **`strict-with-common-allows`** — allowlist mode,
  `block_on_uncertainty=true`, plus three pre-populated allow entries
  for well-known MCP servers (filesystem npx package, github HTTPS
  endpoint, slack HTTPS endpoint). Use case: the most common
  production starting point.

The third template carries a maintenance warning in its YAML
header and in the `description` field surfaced via
`GET /v1/mcp-policies/templates`: the pre-populated server URLs
reflect well-known MCP server endpoints as of August 2026;
operators are expected to verify against their provider's current
documentation before relying on them in production. The other two
templates ship with no embedded URLs and carry no equivalent
warning.

`POST:flavor/apply_template` replaces the flavor policy state
with the template's content, bumps version, and writes an
audit-log entry with `payload.applied_template=<name>` so an
operator can answer "did someone apply a template here?" later.

### Plugin remembered decisions

`~/.claude/flightdeck/remembered_mcp_decisions-<tokenPrefix>.json`
is the local cache of de-facto approvals — servers the user said
"yes" to via Claude Code's built-in `ask` flow on first call.
The file path is per-token: `<tokenPrefix>` is the first 16 hex
characters of `sha256(token)`, matching the access-token prefix
indexing pattern used by the API. Two operators on the same
machine using different bearer tokens see distinct files.

File schema:

```json
{
  "version": 1,
  "decisions": [
    {
      "fingerprint": "ab12cd34ef567890",
      "server_url_canonical": "stdio://npx -y @scope/server-x",
      "server_name": "x",
      "decided_at": "2026-05-06T10:00:00Z"
    }
  ]
}
```

Atomic writes via temp-file + `fs.rename`. Reads tolerate
missing or corrupted files by returning an empty list (rather
than crashing the hook).

`PreToolUse` reads this file fresh on every invocation rather
than caching the contents at `SessionStart`. Concurrent Claude
Code sessions on the same machine therefore see each other's
remembered decisions in real time — a "yes" the user said in
session A applies to session B's next call without restart.
The performance cost is one stat + read per `PreToolUse` (~tens
of microseconds against the local filesystem), well below the
no-hot-path-latency threshold.

Operator-side deny entries always override remembered allows
(step 1 / 2 winning over the local merge). The remembered
file is a private convenience for the user; the policy cache
fetched at `SessionStart` is the authoritative source. When the
operator pushes a flavor deny entry, the next `SessionStart`
re-fetches the policy and the next `PreToolUse` returns deny
regardless of what's in the remembered file.

When the user approves an unknown-allowlist server, the plugin
also emits `mcp_policy_user_remembered` to the standard event
pipeline. This is operator-visibility, not policy
mutation — the dashboard shows "alice approved server X on her
dev machine" so a security team can decide whether to promote
to a real flavor allow entry. The remembered file does NOT
synchronise back to the control plane via PUT; the operator
makes the policy change deliberately if they want fleet-wide
effect.

### Event taxonomy

Five event types ride the worker's `events.<type>` NATS subject
routing: the first four are members of the sensor's `EventType` enum,
and `mcp_policy_user_remembered` comes from the Claude Code plugin
only. All ride the standard event pipeline; none are audit-log
entries.

- **`policy_mcp_warn`** — emitted when an evaluation resolves to
  `warn`. Payload: `server_url`, `server_name`, `fingerprint`,
  `tool_name`, `policy_id`, `scope` (`global` or `flavor:<value>`),
  `decision_path` (one of `flavor_entry`, `global_entry`,
  `mode_default`).
- **`policy_mcp_block`** — emitted when an evaluation resolves to
  `block`. Same payload as warn, plus `block_on_uncertainty`
  (true/false — distinguishes the explicit-block-list case from the
  uncertainty-fallback case).
- **`mcp_server_name_changed`** — emitted by the sensor when an agent
  declares a server whose canonical URL is already known under a
  different name. Payload: `server_url_canonical`, `fingerprint_old`,
  `fingerprint_new`, `name_old`, `name_new`, `observed_at`. The event
  surfaces drift on the dashboard so operators can investigate; the
  policy decision still resolves on URL.
- **`mcp_server_attached`** — emitted by the sensor every time an
  MCP server is initialised after `session_start`. Payload:
  `fingerprint`, `server_url_canonical`, `server_name`, `transport`,
  `protocol_version`, `version`, `capabilities`, `instructions`,
  `attached_at`. The worker projects it into
  `sessions.context.mcp_servers` via an idempotent UPSERT-with-dedup
  on `(name, server_url)`; the dashboard's SessionDrawer re-fetches
  the session detail when one arrives so the MCP SERVERS panel
  populates live for in-flight sessions.
- **`mcp_policy_user_remembered`** — emitted by the Claude Code
  plugin when it records a remembered approval (see Plugin
  remembered decisions). Payload: `fingerprint`,
  `server_url_canonical`, `server_name`, `flavor`, `decided_at`
  (all required), and `permission_mode`, the Claude Code permission
  mode the session was in when the approved call ran (`default`,
  `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`;
  passed through as sent, at most 64 characters, absent when the hook
  carries none). The mode is audit context: Claude Code honours the
  plugin's `ask` in every mode, `bypassPermissions` and `auto`
  included, so the approval was answered at a prompt (by the user, or
  by an SDK application's permission callback) whatever the mode.

### Audit

Every successful mutation through `POST` / `PUT` / `DELETE
/v1/mcp-policies` writes one row to `mcp_policy_audit_log` with the
`actor` resolved from the request token, the `event_type` from the
mutation kind, and a `payload` JSONB carrying the diff (added /
removed entries, mode change, `block_on_uncertainty` flip).

The audit log is the authoritative record of operator-initiated
changes — it answers "who changed this and when." Observed system
state (decision events, name drift) lives in the events pipeline and
is queried via the standard event endpoints.

The mutation transaction is single-shot: PUT does (1) `SELECT FOR
UPDATE` of the current row + entries, (2) `UPDATE mcp_policies`
with `updated_at = NOW`, (3) `DELETE mcp_policy_entries WHERE
policy_id = ?` followed by `INSERT` of the new entries, (4) `INSERT
mcp_policy_audit_log`, all in one `BEGIN... COMMIT` block. Failure
of any step rolls the whole mutation back. `SELECT FOR UPDATE`
prevents lost-update races between concurrent PUTs.

Per-PUT version snapshotting and the diff endpoint were removed in
No version-history table is maintained. The audit log carries the
modification trail; an operator who needs point-in-time reconstruction
reads the audit log payloads in chronological order and replays them
by hand. The schema has no `mcp_policy_versions` table and no
`version` column on `mcp_policies`.

### Dashboard surfaces

MCP Protection lives as a sub-tab under the unified `/policies`
route. The other sub-tab is Token Budget (existing
token-budget-policy management content, unchanged from the prior
`/policies` page). Default tab on visit is Token Budget; the
`?policy=mcp` query param deep-links to MCP Protection. There is no
`/mcp-policies` route (hard 404, no redirect).

#### Layout (MCP Protection sub-tab)

The sub-tab opens directly to a scope picker — a shadcn `<Select>`
with the Global scope plus one entry per flavor policy the operator
has access to. The mode toggle is editable on the Global scope only
(enforced in UI; on flavor scopes the global mode is rendered
read-only as context). The `block_on_uncertainty` toggle is editable
on every scope.

The active scope persists in the URL alongside the sub-tab
(`?policy=mcp&scope=global` / `?policy=mcp&scope=flavor:prod`) so
deep-links and browser back/forward survive.

#### Per-scope panels

- **Mode toggle** (segmented control, allowlist / blocklist).
  Global scope only. Visually dominant — operators read mode
  before per-entry enforcement, so the toggle sits above the
  entry table at full width with a one-sentence explanation.
  Active state is a solid background fill (var(--primary) or
  similar accent), not text-color-only — the inactive option
  is transparent background + muted text. Transition 150ms
  ease-out on background-color and color, no layout reflow on
  click. Keyboard arrow keys move active state between options.
- **`block_on_uncertainty` toggle** (Switch component). Per-
  flavor + global. Only meaningful in allowlist mode; hidden
  entirely when the global mode is blocklist (the
  toggle is a no-op there, hide-rather-than-grey precedent).
  Server-side BOU value persists across mode flips.
- **Entry table.** Search by URL / name, sort columns,
  multi-select for bulk delete, status pill per row (allow /
  deny + enforcement override). Click a row to open the edit
  dialog. Skeleton rows during load (not bare spinner).
  Empty state copy teaches the next action: "Add your first
  allow rule to start gating this flavor" (allowlist mode) or
  "Add your first deny rule to block specific servers"
  (blocklist mode). When `entries.length === 0` AND no
  template has been applied this session, a single "Quick
  start: apply a template →" link appears alongside the
  empty-state copy; clicking opens a dropdown of the three
  shipped templates with one-line descriptions, applying
  hides the link for the rest of the session.
- **Add / edit dialog.** Form fields URL (raw), Name, kind
  (allow/deny), enforcement (warn/block/interactive/none).
  Live fingerprint preview via debounced (300ms) `GET
  /v1/mcp-policies/resolve` so the operator sees the exact
  fingerprint the server will store. Validation per the
  storage schema CHECKs; errors render inline next to
  the offending field after the operator's first submit
  attempt (not on dialog open with empty fields).
- **Resolve preview panel** (collapsible card). Two inputs
  (server URL, server name) + Resolve button. Renders the
  API's `MCPPolicyResolveResult` plus decision_path, scope,
  fingerprint. Educational — operators verify their policy's
  effective behavior before they save.
- **Audit trail.** Calls `GET /:flavor/audit-log`. Paginated
  table with filters by event_type, actor, date range. Each
  row expands to reveal the full payload JSON.

#### MCP server policy decision rendering (SessionDrawer)

The `MCPServersPanel` in `SessionDrawer.tsx` lists each declared
MCP server with the policy decision rendered as inline coloured
text next to the server name, NOT a pill (a pill design failed the
1-second-glance bar):

```
[server-name] · ALLOW
[server-name] · WARN
[server-name] · BLOCK
[server-name] · BLOCK (default)
```

The decision text uses the existing chroma family
(allow=green, warn=amber, block=red); the mode-default modifier
renders the same hue at reduced opacity + italic, with the
"(default)" qualifier reading as a plain English clarification
that the decision came from the mode default rather than an
explicit policy entry. Decision derived by calling `GET /resolve`
for each server in parallel via `Promise.all`. Skeleton text
shimmer during load.

This treatment removes the background-fill / text-contrast bug
class the pill suffered, naturally legibly at small sizes, and
applies theme tokens cleanly without the Tooltip
collision-padding complication the pill needed.

#### Tooltips

Non-obvious fields carry shadcn `<Tooltip>` content lifted
verbatim from this document. Specifically: identity model
canonical form rules (sub-section "Identity model") and mode
semantics (sub-section "Two-scope policy model" + "Per-server
resolution"). Verbatim then trimmed only when the sentence is
too long to fit a tooltip — never paraphrased.

#### Adjacent surfaces (extensions to existing screens)

- **Fleet sidebar Policy Events panel.** The existing panel
  in `FleetPanel.tsx` renders `policy_warn` / `policy_block` /
  `policy_degrade` events. Extended to render the four new
  MCP-policy event types with a chroma hierarchy that
  separates enforcement events from informational ones:
  - `policy_mcp_warn` → amber (matches `policy_warn`).
  - `policy_mcp_block` → red (matches `policy_block`).
  - `mcp_server_name_changed` → purple/info (matches
    `directive_result`).
  - `mcp_policy_user_remembered` → purple/info (FYI signal,
    not enforcement; operator visibility only ).

  Result: amber/red = "policy fired" axis, purple = "FYI"
  axis. No new theme tokens are introduced; chromas reuse
  existing CSS variables already declared in `themes.css`.
- **Events page event-type filter.** The existing Events
  page's event-type chip picker carries dedicated chips for
  the four MCP-policy event types under their own collapsible
  "MCP POLICY" facet group. The analytics-dimension lock holds —
  the types are filterable but not group-by-able.

---

## Operational Concerns

### Deployment

Flightdeck is one binary, `flightdeck` (the root Go module,
`cmd/flightdeck`). It runs the ingestion API, the workers and the query
API as goroutines of one process, serves the dashboard from the binary,
and embeds its message bus. Postgres is the one external dependency
(`--database-url`); the binary refuses to start without it.

**Ports and routes.** One listener, `--listen`, default `127.0.0.1:4000`.
The router serves `/` and every path with no other owner from the
embedded dashboard bundle (`webui/dist`, filled by `make build-webui`
from `dashboard/dist` without the source maps), falling back to
`index.html` for the SPA's client-side routes (an `/assets/*` path that
names no file is a 404, never `index.html`); `/assets/*` with a
one-year immutable cache, since Vite hashes the file names;
`/runtime-config.json`, generated (below) and sent with `Cache-Control:
no-store`; `/investigate` as a permanent redirect to `/events`; `/api`
and everything under it to the query API's handler; `/ingest` and
everything under it to the ingestion handler, each path forwarded as
sent (the services strip their own prefix; see Public path prefixes).
A bare `/v1/...` is answered 404 with a hint naming the two prefixes, so
a sensor pointed at the origin without `/ingest` learns why. When the
ingestion handler answers without reading the request body (a body
over the receivers' 4 MiB cap is refused with 413 unread), the router
drains up to 16 MiB of it, the receivers' inflated-body cap, so the
client receives the status rather than a connection reset, as it does
behind the compose nginx, which reads the whole body itself. The
dashboard responses carry the browser security headers the compose
dashboard's nginx sets (`X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, the same
`Content-Security-Policy`). The server has a 15-second header read
timeout, a 120-second idle timeout and no server-wide write timeout,
because `/api/v1/stream` is a WebSocket; instead the router sets the
services' own per-request deadlines on the connection: the ingestion
read and write timeouts (10 seconds each) on `/ingest`, the query
API's read timeout (15 seconds) on `/api` except the WebSocket, so a
client that stalls mid-body holds a connection no longer than it
could with the standalone services. The query API's own 30-second
REST timeout and the ingestion body limits still apply inside their
handlers. A port already in use stops the start with the error and a
`--listen` hint; a privileged port the process may not bind (`:80`
and `:443` of `--domain`) with the remedy (root, `CAP_NET_BIND_SERVICE`
or a higher `--listen` port). The sockets are bound before anything
else, so either message arrives before any side effect. The three services' metrics listeners
(ports 9102, 9103 and 9104, see Metrics) are off unless `--metrics` is
given; the public port never serves `/metrics`.

**Data dir.** `--data-dir` (`FLIGHTDECK_DATA_DIR`), default
`~/.flightdeck` (`%LOCALAPPDATA%\flightdeck` on Windows), created with
mode 0700; an existing directory with a wider mode is used as it is and
a warning names the `chmod`, since it holds the bus store and the
secrets file. It holds `nats/`, the embedded JetStream store;
`secrets.json` (mode 0600) with the JWT secret, generated once, and the
dashboard token of the non-loopback mode below; and `acme/`, the TLS
certificate cache. A `--database-url` is the only other state the
binary needs, so a new data dir on an existing database is a working
install.

**Embedded NATS.** The binary starts a `nats-server` in process with
JetStream on, `StoreDir=<data>/nats` and `DontListen`, so no port is
opened for the bus, and ingestion and the workers connect to it through
in-process connections (`nats.InProcessServer`). The `FLIGHTDECK`
stream, its limits (72 hours, 5 GiB) and the durable consumer are the
ones described under Worker / Event Processing; the JetStream store
limit is set from the stream's size limit so the reservation never
depends on free disk at start. `--nats-url` (`FLIGHTDECK_NATS_URL`)
switches to an external server and starts no embedded one; several
instances sharing a database (Helm) point at one external NATS, since
each embedded server is a bus of its own.

**Auth bootstrap.** The listen address decides the mode. Bound to a
loopback address (`127.0.0.1`, `localhost`, `::1`), the binary runs the
services with the development semantics the dev compose had
(`ENVIRONMENT=dev`, set in process): the seeded `tok_dev` is accepted,
`/runtime-config.json` returns it, the dev-only `DELETE
/v1/directives/custom` route is mounted, and the start-up block prints
the token. Bound to any other address, or started with `--domain`, the
dev token is refused with the usual 401; on the first start the binary
mints an `ftd_` access token named `Bootstrap token` through the
query API's token store (stored salted and hashed in `access_tokens`
like any other), prints it once in the start-up block, and keeps the
plaintext in `secrets.json` so `/runtime-config.json` can hand it to the
dashboard on every start. On a later start the stored token is
validated against the database and re-minted if it no longer resolves
(a new database under an old data dir). Serving the dashboard token
from `/runtime-config.json` to anyone who can reach the origin is the
same trust boundary the mounted `runtime-config.json` had: a
non-loopback deployment protects the origin at the network edge or
with `--domain`. Further tokens are minted in the Settings page.

**TLS.** `--domain example.com` (`FLIGHTDECK_DOMAIN`) terminates TLS in
the binary with certificates from Let's Encrypt (`acme/autocert`,
HTTP-01, cache in `<data>/acme`): it listens on `:443` for the domain
and on `:80` to answer the ACME challenge and redirect every other GET
or HEAD to `https://<domain>` with the same path and query, whatever
`Host` the request carried; `--listen` is ignored in this mode. Without `--domain`
the binary serves plain HTTP.

**Time zone.** The binary sets the process's local zone to UTC at
start, as the compose containers have: the query API
formats the timestamps it reads from Postgres in the process's zone,
and its contract is RFC 3339 in UTC, whatever zone the host is in.

**Start-up output.** One block on stdout: the version, the dashboard
URL, the ingestion URL for `FLIGHTDECK_SERVER`, the token (or where it
was printed), the data dir, the database (URL with the password
masked) and the bus (embedded, with its store dir, or the external
URL). Everything else is `slog` on stderr.

**Tuning.** The services' tuning variables keep their names and
defaults under the binary (`FLIGHTDECK_RATE_LIMIT_PER_MINUTE`,
`FLIGHTDECK_WORKER_POOL_SIZE`, `FLIGHTDECK_RECONCILER_INTERVAL_SECS`,
`FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`, `FLIGHTDECK_NATS_STREAM_*`,
`FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS`, `FLIGHTDECK_CORS_ORIGIN`,
`FLIGHTDECK_PRICING_PATH`, `SHUTDOWN_TIMEOUT_SECS`); the integration
suite runs the binary with the same two overrides the dev compose
sets.

**Start order and shutdown.** The binary binds its port(s) first (so a
busy or privileged port fails before anything is touched), prepares
the data dir and secrets, connects to Postgres, applies the embedded
migrations, starts the bus, then the three services together, then
serves. On SIGINT or SIGTERM, or when a service or a listener fails,
it stops in order: the HTTP server stops accepting and drains the
requests in flight (which still have the services they are calling),
then the services are cancelled and waited for (each joins its own
loops: the ingestion assembler and the worker lanes finish their
current message within `SHUTDOWN_TIMEOUT_SECS`), each step bounded by
30 seconds; then the embedded NATS server and the database pool close,
the bus last so every publish and acknowledgement before it has reached
the store. A service's failure is the exit status's reason; a stop on
a signal exits 0.

**The `app` packages.** Each service exports `ingestion/app`,
`workers/app` and `api/app`: `Config` (the service's tunables, the
values its environment variables carry), `Deps` (a `*pgxpool.Pool`, a `*nats.Conn` and, for the
workers, the migrations `fs.FS`; a nil dependency is dialled from
`Config`), `New`, `Run(ctx)` and, for ingestion and the API,
`Handler()`. `Run` joins every goroutine it starts before it closes
the connections it owns; the workers' `Run` does not migrate (the
binaries call `Migrate` once, first). The per-service `cmd/main.go` is environment parsing plus
`app.Run`, and the compose dev overlay still runs them with `go run
./cmd/` behind nginx on `:4000` for the dashboard hot-reload loop; the
dashboard's Vite proxy forwards `/api` and `/ingest` to `:4000`, so
`go run ./cmd/flightdeck` plus `npm run dev` in `dashboard/` is the
other dev loop.

**Helm chart (Kubernetes).** A Chart at `helm/` ships a values file
covering image tags, replicas, HPA bounds, NATS JetStream PVC sizes,
ingress configuration, and an `externalUrl` escape hatch for managed
Postgres. The bundled Postgres StatefulSet is fine for small
deployments; production should provide an external HA Postgres via
`postgres.externalUrl`. The chart passes the `FLIGHTDECK` stream's
settings to ingestion from `nats.jetstream.stream` (`maxAgeHours`,
`maxSizeMiB`, `replicas`; see Worker / Event Processing > The
FLIGHTDECK stream). Unset, `replicas` is 3 when `nats.replicas` is 3 or
more and 1 otherwise: 3 copies keep a quorum through the loss of one
server, while 2 copies need both servers for a quorum and so would stop
the stream on either one's loss. A set `replicas` must be 1 to 5, not 2
for that reason, and at most `nats.replicas`, and the render fails
otherwise, as it does for an age under 1 hour, a size under 64 MiB, or
a size above 75% of `nats.jetstream.fileStore.size` (read when it is a
plain integer with a `Ki`/`Mi`/`Gi`/`Ti` or `K`/`M`/`G`/`T` suffix).
Each NATS server holds a full copy on its own PVC, so `maxSizeMiB`
stays well under the 75% of free space a server reserves at most: 5120
MiB on the 10Gi default volume, 30720 MiB on the 50Gi volume of
`values.prod.yaml`. The ingestion pods carry a checksum of the three
settings, so changing one rolls them and the new settings apply to the
stream in place. The chart runs the per-service images.

**Compose.** `docker/docker-compose.yml` with the dev overlay
(`make dev`) runs the seven-service topology (nginx, postgres, nats,
ingestion, workers, api, dashboard) from source for contributors who
want the dashboard's hot reload behind nginx on `:4000`; the production
overlay terminates TLS at nginx. Every compose service logs through
Docker's `json-file` driver with rotation: a container's log file is
rotated at 20 MiB and five files are kept, so one container holds at
most 100 MiB of logs and the seven at most 700 MiB. Without it the
driver keeps a container's whole output in one file that grows until
the disk is full, and the workers log a line for every event they drop,
so a flood of bad events would fill the host disk through the log
alone. 20 MiB and five files are the defaults of Docker's own rotating
`local` driver; `json-file` is kept over `local` because `docker logs`
reads both, while log shippers that tail container files read only
`json-file`. The rotation is set in `docker-compose.yml` and applies
under the dev and prod overlays alike; a daemon-wide `log-opts` in
`/etc/docker/daemon.json` does not override it. Under Helm the kubelet
rotates container logs (`containerLogMaxSize`, `containerLogMaxFiles`)
and the chart sets nothing.

**Public path prefixes.** Clients reach ingestion under `/ingest` and
the query API under `/api` on one origin, and each service also accepts
its own prefix: `/ingest/v1/events` and `/v1/events` reach the same
ingestion handler, `/api/v1/fleet` and `/v1/fleet` the same API one
(Swagger UI included). The services strip the prefix themselves and
every edge forwards the path unchanged: the Helm chart's Ingress because
a rewrite is specific to each ingress controller, the compose nginx and
the vite dev proxy so that a redirect a service builds from the request
as received (Swagger UI's) keeps the prefix, and the services see the
same path under every deployment. The prefix is stripped only when it is
the whole first segment of the path as sent, so `/ingestx/...` and
`/ingest%2F...` are a 404, and the rest of the path keeps its escaping.
A redirect a service answers for a prefixed request (`/api/docs` to
`/api/docs/`) keeps the prefix. Neither service has a route of its own
under its prefix.

The Docker Compose and Helm targets are feature-equivalent (Key
Constraint #4).

### Environment variables

**`flightdeck` binary:** flags win over environment variables, which win
over the defaults.

| Flag | Variable | Purpose |
|---|---|---|
| `--listen` | `FLIGHTDECK_LISTEN` | Address of the one listener (default `127.0.0.1:4000`); a loopback address enables the development token |
| `--database-url` | `FLIGHTDECK_DATABASE_URL` | Postgres DSN (required); percent-encode reserved characters in the password (`@` as `%40`) |
| `--data-dir` | `FLIGHTDECK_DATA_DIR` | Data directory (default `~/.flightdeck`, `%LOCALAPPDATA%\flightdeck` on Windows): `nats/`, `secrets.json`, `acme/` |
| `--nats-url` | `FLIGHTDECK_NATS_URL` | External NATS server; unset, NATS runs embedded with no port |
| `--domain` | `FLIGHTDECK_DOMAIN` | Public host name: TLS on `:443` with Let's Encrypt certificates, `:80` redirects; implies the non-loopback token mode |
| `--metrics` | `FLIGHTDECK_METRICS` | `true` starts the three services' metrics listeners on their default ports (9102, 9103, 9104) |

The services' tuning variables below keep their names and defaults under
the binary; `FLIGHTDECK_PORT`, `FLIGHTDECK_POSTGRES_URL`, `ENVIRONMENT`
and `FLIGHTDECK_MIGRATIONS_DIR` are read by the standalone service
binaries only, since the one binary derives them from its flags.


**Ingestion API:**

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_PORT` | HTTP port (default 8080) |
| `FLIGHTDECK_POSTGRES_URL` | Postgres DSN (required); percent-encode reserved characters in the password (`@` as `%40`), since the URL's `user:password` part ends at the first `@` |
| `FLIGHTDECK_NATS_URL` | NATS connection URL (default `nats://nats:4222`). The production compose overlay starts NATS with `--auth` and embeds the token in the URL's user slot (`nats://<FLIGHTDECK_NATS_TOKEN>@nats:4222`; a lone user is sent as the auth token, so the token is limited to URL-unreserved characters); the dev stack runs NATS unauthenticated and bound to 127.0.0.1 |
| `ENVIRONMENT` | `dev` enables `tok_dev` token; any other value rejects it with 401 |
| `FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS` | Age limit of the `FLIGHTDECK` stream in hours (default 72, at least 1); see Worker / Event Processing > The FLIGHTDECK stream |
| `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB` | Size limit of the stream on each NATS server in MiB (default 5120, at least 64) |
| `FLIGHTDECK_NATS_STREAM_REPLICAS` | NATS servers holding a copy of the stream, 1 to 5 (default 1). The compose file sets 1, since it runs one NATS server, which accepts a higher count without placing any further copy |
| `FLIGHTDECK_METRICS_PORT` | Port of the metrics listener that serves the request-latency histogram at `/metrics` (default 9103; `0` turns it off; the service refuses to start outside 0 to 65535) |
| `SHUTDOWN_TIMEOUT_SECS` | Graceful shutdown deadline (default 30) |

**Workers:**

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_POSTGRES_URL` | DSN (required); percent-encode reserved characters in the password (`@` as `%40`), since the URL's `user:password` part ends at the first `@` |
| `FLIGHTDECK_NATS_URL` | NATS URL, same token convention as the ingestion API |
| `FLIGHTDECK_WORKER_POOL_SIZE` | NATS consumer goroutine count (default 10) |
| `FLIGHTDECK_MIGRATE_ONLY` | `true` applies pending migrations and exits without consuming |
| `FLIGHTDECK_RECONCILER_INTERVAL_SECS` | Seconds between reconciler ticks, 1 to 3600 (default 60); the worker refuses to start outside that range. The dev compose override sets 5 so the integration tests that wait for a tick stay short |
| `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS` | Silence window after which a `lost` session is closed with `close_reason=orphan_timeout` (default 24, must be above 0; the worker refuses to start otherwise) |
| `FLIGHTDECK_METRICS_PORT` | Port of the metrics listener that serves `/metrics` (default 9102; `0` turns it off; the worker refuses to start outside 0 to 65535) |
| `SHUTDOWN_TIMEOUT_SECS` | Graceful shutdown deadline (default 30) |

**Query API:**

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_PORT` | HTTP port (default 8081) |
| `FLIGHTDECK_POSTGRES_URL` | DSN (required); percent-encode reserved characters in the password (`@` as `%40`), since the URL's `user:password` part ends at the first `@` |
| `ENVIRONMENT` | Same `tok_dev` semantics as ingestion; also registers the dev-only `DELETE /v1/directives/custom` route |
| `FLIGHTDECK_CORS_ORIGIN` | `Access-Control-Allow-Origin` (default `*`); lock to the dashboard origin in prod |
| `FLIGHTDECK_JWT_SECRET` | Signs dashboard login tokens; production Helm renders fail unless it is set |
| `FLIGHTDECK_ADMIN_EMAIL` / `FLIGHTDECK_ADMIN_PASSWORD` | Seed the initial dashboard login |
| `FLIGHTDECK_PRICING_PATH` | Overrides the location of `pricing.yaml` (the price overrides layered over the built-in catalogue) |
| `FLIGHTDECK_METRICS_PORT` | Port of the metrics listener that serves the request-latency histogram at `/metrics` (default 9104; `0` turns it off; the service refuses to start outside 0 to 65535) |
| `SHUTDOWN_TIMEOUT_SECS` | Graceful shutdown deadline (default 30) |

**flightdeck-sensor (agent environment):**

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_SERVER` | Ingestion base URL |
| `FLIGHTDECK_TOKEN` | Access token |
| `FLIGHTDECK_API_URL` | Control-plane base URL (derived from server if unset) |
| `FLIGHTDECK_SESSION_ID` | Stable session UUID for orchestrator re-runs |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` to enable full payload capture |
| `FLIGHTDECK_BILLING_MODE` | `metered`, `subscription` or `local`; overrides the billing mode the sensor detects (see Cost estimation) |
| `FLIGHTDECK_UNAVAILABLE_POLICY` | `continue` (default) or `halt` |
| `FLIGHTDECK_HOSTNAME` | Override `socket.gethostname` |
| `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` | Persistent agent label; default `{user}@{hostname}` |
| `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE` | `coding` or `production`. Any other value raises `ConfigurationError` |

**Postgres:** standard Postgres environment plus the optional
`POSTGRES_PASSWORD` / `POSTGRES_USER` / `POSTGRES_DB` for the bundled
StatefulSet.

### Health checks

Every service except `workers` exposes `GET /health` returning
`{"status":"ok","service":"<name>"}`. The compose health check polls
this endpoint at 5s intervals; nginx waits for `service_healthy` before
serving traffic. `workers` has no `/health`: the Helm chart reads its
readiness from the metrics listener (`/metrics`), which opens after the
startup migrations and the NATS connection, and a worker whose consumer
cannot create the stream or subscribe exits so its supervisor restarts
it.

### Stream sequences

The sequences stored in `sessions.start_seq` and `sessions.closed_seq`
are positions in the `FLIGHTDECK` stream and are only comparable within
one incarnation of it. If an operator recreates the stream, numbering
restarts at one and every stored value would outrank every new event,
so the worker clears any stored sequence above the stream's last
sequence when it starts (logging how many rows it touched; a failed
sweep is logged and the worker consumes anyway) and those rows follow
the plain state rules until their next `session_start` or
`session_end`. A stale value at or below the new stream's last sequence
survives that sweep and is compared as if it belonged to the new stream
until the row's next `session_start` or `session_end` replaces it. The
sweep scans the `sessions` table once per start. After recreating the
stream on purpose, clear every stored sequence before the workers start
(`UPDATE sessions SET start_seq = NULL, closed_seq = NULL`) so no stale
value survives. `make dev-reset` wipes both volumes together and needs no
such care.

### Metrics

The workers keep an in-process, reason-labelled counter registry
(`workers/internal/metrics`):

- `dropped_events_total{reason}` — events the worker did not apply:
  `unmarshal_error`, `invalid_session_id` (a `session_id` that is not a
  canonical UUID; see NATS consumer), `process_panic`,
  `max_retries_exhausted`, `closed_session_skip`, `orphan_session_end`,
  `superseded_session_end` (a `session_end` published before the run of
  a still-open session began; on a closed row the same end counts as
  `closed_session_skip`), and `duplicate_event` (an event whose
  client-supplied id is already stored).
- `sessions_closed_total{reason}` — non-event close paths the
  worker performs directly (today: `orphan_timeout` via the
  reaper). The dashboard's close-reason facet still reads from
  `events.payload->>'close_reason'`; this counter is the time-
  series shape for the same verdict.
- `sessions_revived_total{trigger}` — worker-side revival paths
  that flipped a session from `stale` / `lost` back to `active`.
  Today's only trigger is `child_event` (parent-bump propagation:
  any event for a child session whose `parent_session_id` is set
  bumps the parent's `last_seen_at` and revives the parent if it
  was stale/lost).

The workers serve the registry at `GET /metrics` on a listener of their
own (`FLIGHTDECK_METRICS_PORT`, default 9102; any other path is 404) in
the Prometheus text format: a `# TYPE <family> counter` line per family,
then one sample per label value in sorted order. The counters are
process-local and start at zero when a worker starts, so with several
worker replicas each one is scraped separately and the series summed.
The listener opens after the startup migrations and the NATS
connection, and a consumer that cannot create the stream or subscribe
exits the worker, so the Helm chart uses the listener as the workers'
readiness probe (liveness stays a process-alive check, so a long
migration never restarts the pod) and lists it on the workers' headless
Service for scrapers. A port that cannot be bound is logged and event
processing continues. Compose does not publish the port; nginx does not
route to it. The worker's log lines for the same events (drops, reaper
closes, revivals) remain the signal when the listener is off.

#### Request latency

The ingestion API and the query API each time the requests they serve
into one histogram family, `flightdeck_http_request_duration_seconds`,
kept in process (`ingestion/internal/metrics`, `api/internal/metrics`;
the two packages are twins, as the services share no Go module). The
name carries the `flightdeck_` namespace because HTTP latency is a
family every service in a cluster can export under a generic name; the
workers' counters predate it and keep their names so existing scrapes
do not break. Each series has three labels, all bounded:

- `route` — the pattern the request matched as registered on the
  service's router, without its method: `/v1/events`,
  `/v1/sessions/`, `/v1/agents/{agent_id}/summary`. A path parameter
  stays a placeholder, so session and agent ids never become label
  values. A request no pattern matched (a 404, a 405) is `unmatched`,
  and so is any method outside the known set below, because the
  router's answer to a `CONNECT` names the raw path.
- `method` — `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or
  `OPTIONS`; any other method is `OTHER`, so a client cannot mint
  label values.
- `status_class` — `1xx` to `5xx` from the status the handler wrote (a
  handler that writes no status answered `200`). A panic the recovery
  middleware turns into a `500` counts as `5xx`, a REST call cut by the
  query API's 30-second timeout as the `503` it returned.

The buckets, in seconds, are 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05,
0.1, 0.25, 0.5, 1, 2.5, 5, 10 and 30, the same for both services so
their percentiles compare. The millisecond buckets resolve the
ingestion hot path (validate, publish to NATS, look up a directive),
which takes one to two milliseconds on the dev stack; 10 is the
ingestion server's write timeout and 30 the query API's REST timeout,
so a request that ran to either limit lands in a bucket of its own
instead of only in `+Inf`.

The timer starts when the request reaches the router, after the public
prefix is stripped, and stops when the handler returns, so it measures
the service's own work and not the time a slow client takes to send the
body (the server's read timeout bounds that). The query API's CORS
preflights are answered before the router and are not timed. A request
whose connection is hijacked is not recorded: the `/v1/stream`
WebSocket runs for as long as the dashboard stays open, and its
duration is a session length, not a latency. An upgrade the handler
refuses (a `401`) is an ordinary response and is recorded under
`/v1/stream`.

Each service serves the histogram at `GET /metrics` on a listener of
its own, like the workers: `FLIGHTDECK_METRICS_PORT`, default 9103 on
ingestion and 9104 on the query API (`0` turns it off; any other path
is 404), in the Prometheus text format with `# HELP` and `# TYPE`
lines, cumulative `_bucket` samples ending in `le="+Inf"`, then `_sum`
and `_count`, series in sorted label order. The listener carries no
auth, so it is kept off the public edge: compose does not publish the
port and nginx does not route to it, and the Helm chart
(`ingestion.metricsPort`, `api.metricsPort`) declares the port on the
pods and lists it on a headless `<release>-ingestion-metrics` or
`<release>-api-metrics` Service, never on the Service the Ingress or a
`LoadBalancer` uses. Each deployment sets its own
`FLIGHTDECK_METRICS_PORT` (the workers' included) rather than the
shared ConfigMap, since all three services read the same variable. The
ports differ from the workers' 9102 so the three services can share one
host's network without a clash. The listener binds every interface
(only its port is configurable): in compose it is reachable on the
internal network only and in Kubernetes on the pod IP, so an operator
running the binaries on a bare host firewalls the port, or turns the
listener off with `0`. The metrics listeners, the workers' included,
are internal, on ports of their own, and are not part of the
Swagger-documented API surface, which covers the API ports only. The
service's readiness and liveness
stay on `/health`; a metrics port that cannot be bound is logged and
the API keeps serving.
The histogram is process-local and starts empty when the process
starts, so with several replicas each pod is scraped and the series
summed by `route`.

### Operator endpoints

`/v1/admin/*` endpoints share the same Bearer-token auth as
user-facing endpoints. Single-tier auth: every authenticated
bearer token has full access. Production deployments protect these
routes at the network boundary (firewall / ingress) rather than via
token scopes.

`POST /v1/admin/reconcile-agents` is a two-phase operator endpoint
that makes the `agents` table correct in one call. Phase 1 recomputes
the `agents.total_sessions`, `total_tokens`, `first_seen_at`, and
`last_seen_at` columns against the sessions table ground truth (per-
agent transaction; per-agent failures land in the response's `errors`
array and the sweep continues). Phase 2 deletes orphan rows whose
post-reconcile `total_sessions = 0` AND `last_seen_at < NOW() -
orphan_threshold_secs` (default 30 days). Pass
`orphan_threshold_secs=0` to skip the delete step (counters-only
mode); values `1..59` are rejected with 400 to prevent reaping
freshly-upserted agents that the worker has not yet wired up to a
`session_start` row. Concurrent calls serialise via a process-level
mutex (409 on contention) — multi-replica deployments would need a
Postgres advisory lock; the process mutex covers the current
single-replica deployment shape.

**When to call** — after a data cleanup (manual `DELETE` against
`sessions` or `agents`), after a schema migration that touched
denormalised columns, when the Fleet page shows implausible run
counts (`total_sessions` unrealistically high vs the visible run
rows), or when stale orphan rows from old test runs / smoke fixtures
are crowding the AGENT facet, the `/v1/agents` listing, or the
agent-id resolver. NOT on a schedule — this is for targeted operator
action, not a scheduled task. Reconcile is also not
atomic against concurrent worker writes (the worker's
`BumpAgentSessionCount` and `IncrementAgentTokens` execute as
`SET col = col + N` deltas), so a bump landing between our `SELECT
COUNT(*)` and `UPDATE SET` overshoots by that delta and creates small
drift the next reconcile fixes; invoke during quiet windows if
strict-zero residual drift matters. The full request / response
contract lives in the Swagger UI at `/api/docs/index.html`.

### Makefile structure

The root `Makefile` orchestrates per-component Makefiles. Common
targets:

| Target | Effect |
|---|---|
| `make dev` | Boot the dev stack via docker-compose.dev.yml |
| `make test` | Per-component unit tests (sensor, ingestion, workers, api, dashboard) |
| `make test-integration` | Run pytest against the dev stack |
| `make playground-<script>` | Live-API regression demo for `<script>` |
| `make playground-all` | All playground demos, skip those without API keys |
| `make lint` | Per-component lint (ruff, golangci-lint, ESLint, mypy) |
| `make build` | Builds every component, the `flightdeck` binary included |
| `make build-webui` | Builds the dashboard and copies `dashboard/dist` (without source maps) into `webui/dist` for `go:embed` |
| `make build-flightdeck` | `make build-webui`, then builds `bin/flightdeck` with the VERSION file's version |
| `make run-flightdeck` | Runs the binary from source against `FLIGHTDECK_DATABASE_URL` |
| `make release-prep VERSION=vX.Y.Z` | Test and lint, bump every version location, date the CHANGELOG, open the release PR |
| `make release-tag VERSION=vX.Y.Z` | After the release PR merges: check the versions and push the tag (starts the release pipeline) |
| `make version-check` | Check every version location matches the `VERSION` file |

Each component (`sensor/`, `ingestion/`, `workers/`, `api/`,
`dashboard/`, `docker/`, `helm/`, `plugin/`) has its own Makefile with
`build`, `test`, `lint`, `clean` targets at minimum. `ingestion/Makefile`
and `api/Makefile` run `go tool swag init -g cmd/main.go -o docs` (the
generator version each `go.mod` pins; ingestion adds `--v3.1` for its
OpenAPI 3.1 spec, the api writes Swagger 2.0) before `go build` so the
Swagger UI matches the latest annotations.

---

## Testing strategy

### Unit tests

- **Sensor (Python):** pytest under `sensor/tests/unit/`. No real API
  calls. Mock control plane and provider clients. Covers session
  lifecycle, policy enforcement, transport unavailability, provider
  token estimation, content extraction, framework attribution, runtime
  context, agent_id derivation. mypy `--strict` clean. CI runs the
  suite twice: once with the framework packages installed (they pin the
  provider SDKs below their current majors) and once with the newest
  anthropic and openai releases and no frameworks, where the framework
  tests skip. Those SDKs are built on `httpx2`, so `tests/conftest.py`
  aliases `httpx` to `httpx2` when the installed SDK needs it, and the
  pytest config disables respx's plugin, which would import `httpx`
  first. An autouse fixture refuses every non-loopback connection, so a
  provider mock that stops matching fails the test instead of reaching
  the real API. The repo-level integration suite does the same in
  `tests/integration/conftest.py`; the Makefile targets pass
  `-p no:respx`, and a run without it stops with a message naming the
  flag when an installed SDK needs the alias.
- **Go components (ingestion / workers / api):** Go testing package.
  Mock NATS and Postgres at the boundary. Covers handler validation,
  session state machine transitions, policy evaluation, NATS
  subject routing, directive lookup, fleet aggregation. golangci-lint
  clean.
- **Dashboard:** Vitest + React Testing Library. Every component that
  handles data or state has unit tests. Covers Timeline rendering,
  SwimLane state, SessionDrawer mode transitions, FleetPanel counts,
  PolicyEditor validation, PolicyTable, TokenUsageBar, DimensionChart
  group-by switching, PromptViewer provider terminology,
  EmbeddingsContentViewer render branches, ErrorEventDetails accordion.
  TypeScript clean.

### Integration tests

`tests/integration/` runs against the live dev stack (real NATS, real
Postgres) via `make test-integration`:

- `test_pipeline.py` — POST event → fleet → session detail → events
- `test_session_states.py` — active → idle → stale → lost → revive
- `test_ws_session_transitions.py` — the reconciler's stale and lost
  transitions, the reaper's close and a parent revived by its child
  reach an open `/v1/stream` WebSocket
- `test_events_paging.py` — events that share a timestamp page through
  `GET /v1/events` (offset, both directions, and the `before` /
  `before_id` keyset) without a gap or a repeat
- `test_enforcement.py` — WARN, DEGRADE, BLOCK threshold crossings
- `test_killswitch.py` — single-agent + flavor-wide directive delivery
- `test_prompt_capture.py` — `event_content` round-trip
- `test_analytics.py` — analytics GROUP BY queries
- `test_event_shapes.py` — embeddings, llm_error, streaming,
  framework filter, `error_types[]` listing
- `test_sensor_e2e.py` — end-to-end sensor lifecycle including
  acknowledgement events and singleton behaviour
- `test_sensor_streaming.py` — server-sent-event streams through the real
  sensor: in-stream usage, chunk counts, a mid-stream failure, OpenAI chat
  and Responses
- `test_openai_responses_events.py` — a Responses hosted-tool `tool_call`
  with its captured input served by the content endpoint, a `post_call`
  carrying `provider_metadata.request_id`, and a `post_call` carrying a
  prompt-cache read as `tokens_cache_read`

### Production-image smoke

The Dashboard CI job's final steps build the dashboard production
image (multi-stage Node build → nginx-alpine), run it standalone, and
assert three contracts on the resulting container. Permanent
regression protection on `dashboard/nginx.conf` + `dashboard/Dockerfile`
— a future edit that weakens any of the assertions below fails the
Dashboard job and blocks the PR.

Why a separate image build (rather than reusing the integration / e2e
job stacks): those jobs use the `docker-compose.dev.yml` override
which swaps the dashboard image for `vite dev` running in a
node:24-alpine container. vite serves the file but emits its own
default `Cache-Control: no-cache` header on `/runtime-config.json` and
no headers at all on `/assets/` — the production discipline only
ships when the actual dashboard nginx config is in play. So the smoke
builds the multi-stage image directly, no compose involved.

**Assertion 1 — `/runtime-config.json` strict cache discipline.**
Three-header pack (`Cache-Control: no-store, no-cache, must-revalidate`
+ `Pragma: no-cache` + `Expires: 0`) on both 200 (GET) and 405 (POST).
The 405 path verifies the `always` parameter on every `add_header`
directive — without it, error responses would ship without the
discipline and a 404 / 405 from a misconfigured prod mount could be
cached by an intermediary.

**Assertion 2 — `/assets/` immutable cache contract.** Hashed bundles
emitted by Vite carry a content hash in the filename, so the URL
itself changes whenever the content does. The contract is exactly one
`Cache-Control: public, max-age=31536000, immutable` header (no
duplicates from the expires module, no separate `Expires:` header).
The smoke resolves a representative hashed asset via `docker exec ls
/usr/share/nginx/html/assets/`, hits both 200 (GET) and 405 (POST),
counts the `Cache-Control:` header lines (must be exactly 1), and
asserts the canonical value.

**Assertion 3 — non-root container.** `docker exec ... id -u` must
return a non-zero UID. The Dockerfile's `USER nginx` directive drops
the master process to UID 101; a regression that removed the directive
or accidentally re-elevated would surface here.

### Manual playground demos

`playground/` runs real-API regression demos per supported framework.
Manual, NOT in CI — they cost money and need live API credentials.
Each script self-skips (exit 2) when its framework / API key /
optional gateway URL is missing so `make playground-all` runs cleanly
on any box.

| Target | Driver |
|---|---|
| `make playground-anthropic` | `playground/01_direct_anthropic.py` |
| `make playground-openai` | `playground/02_direct_openai.py` |
| `make playground-langchain` | `playground/03_langchain.py` |
| `make playground-langgraph` | `playground/04_langgraph.py` |
| `make playground-llamaindex` | `playground/05_llamaindex.py` |
| `make playground-llamaindex-agents` | `playground/39_llamaindex_agents.py` |
| `make playground-crewai` | `playground/06_crewai.py` |
| `make playground-litellm` | `playground/12_litellm.py` |
| `make playground-mcp` | `playground/13_mcp.py` |
| `make playground-claude-code` | `playground/14_claude_code_plugin.py` |
| `make playground-bifrost` | `playground/15_bifrost.py` (optional) |
| `make playground-policies` | `playground/policy_demo_*.py` × 4 |
| `make playground-all` | Runs every script, skips missing-env-var ones |

`playground/_helpers.py` carries the shared bootstrap (`init_sensor`,
`require_env`, `wait_for_dev_stack`, `mcp_server_params`,
`fetch_events_for_session`, `assert_event_landed`) so each demo stays
focused on what it's demonstrating. Scripts assert payload shape
inline using `print_result` + `raise AssertionError`; `run_all.py`
exits 0 only when every script returned 0 (PASS) or 2 (SKIP).

### End-to-end (Playwright)

`dashboard/tests/e2e/` covers full user journeys against a seeded dev
stack. Tests run under both `neon-dark` and `clean-light` theme
projects via Playwright's `projects` config. Tests do not hardcode
theme-specific selectors or computed colour values.

`_fixtures.ts` provides `bringSwimlaneRowIntoView(page, agentName)`
for the virtualized swimlane — under realistic data volume the
IntersectionObserver-backed virtualizer keeps off-screen rows as
placeholders without their `data-testid`, so specs must scroll to
find their fixture before asserting.

`waitForFleetReady` waits for any swimlane row to mount, then
leaves fixture-by-fixture lookup to `bringSwimlaneRowIntoView`.

---

## Key Constraints

1. Sensor never adds meaningful latency to the agent hot path.
2. Sensor fails open when control plane unreachable and policy=continue.
3. `make dev` brings up all services healthy with one command.
4. Docker Compose and Helm chart are feature-equivalent.
5. Both neon dark and clean light themes work at all times.
6. Every task that writes code also writes tests.
7. Never use MUI, Ant Design, or Chakra UI.
8. D3 is used for time scale math only. React owns the DOM.
9. SQL lives only in each service's store packages, never in handlers:
   `api/internal/store` (with the token lookups and revocation `LISTEN`
   of `api/internal/auth`), `ingestion/internal/session`,
   `ingestion/internal/auth`, `ingestion/internal/directive`,
   `ingestion/internal/otlpstage` (the OTLP GenAI staging tables) and
   `workers/internal/writer`; `workers/internal/migrate` applies the
   migration files. The current places outside store packages that run
   SQL are `workers/internal/processor/policy.go` (token policy lookups
   and the directives it issues), `workers/internal/processor/session.go`
   (session-row reads: `rowOwnerless`, `handleSessionGuard`,
   `sessionLookupState`), the `enrichSessionEnd` queries in
   `workers/internal/processor/event.go`, and the `LISTEN` / `UNLISTEN`
   in `api/internal/ws/hub.go`.
10. All database migrations have an up and a down.
11. Prompt content is never stored or logged when `capture_prompts=false`.
    This is a hard rule. No exceptions.
12. Every analytics chart must have a working group-by control.
13. The global time range picker applies to all charts simultaneously.
14. Provider terminology is preserved exactly. Anthropic uses `system` +
    `messages`; OpenAI uses `messages`-only. No cross-provider
    normalization.
15. Modality content capture parity: every modality with a request /
    response payload supports `capture_prompts` across every supported
    framework. Modalities that ship without capture ship a documented
    gap.
