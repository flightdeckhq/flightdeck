# Flightdeck Architecture

> **For Claude Code:** Read this entire document before writing any code. This is the
> single source of truth for all architectural decisions. When in doubt, refer back here.
> Every component has a Makefile. If you are writing a component that does not have one,
> stop and create it first.
>
> **This is a living document.** Plans change as implementation progresses. When
> reality diverges from what is written here, update this document before merging
> code. Record the reason in DECISIONS.md. A codebase that contradicts its
> architecture document is worse than no document at all.

---

## Executive Summary

Flightdeck is an open source agent control platform. It gives engineering teams
real-time visibility into every AI agent running across their organization -- what it
is, what it is doing, what it has done, and how many tokens it has consumed. It also
provides runtime enforcement: token budget policy applied centrally and enforced at
call time, plus a kill switch that can stop any agent or an entire fleet of agents
of a given type from a single dashboard action.

Flightdeck is not a proxy. It does not sit in the path of LLM traffic. It uses a
sensor-and-control-plane architecture. The sensor (`flightdeck-sensor`) runs in-process
inside the agent, reports out-of-band over HTTP, and receives directives back in HTTP
response envelopes. There is no single point of failure introduced into the agent's
execution path.

---

## What This System Does (And Deliberately Does Not Do)

**Does:**

- Run as a sensor inside any Python AI agent with two lines of code
- Track token usage per session, per agent flavor, per team, org-wide
- Enforce token budgets at call time: warn, degrade model, block
- Report all agent events to a central control plane in real time
- Capture full prompt messages and system context per call (opt-in only)
- Show a live fleet view of every running agent across the org
- Allow platform engineers to stop individual agents or entire fleets from a dashboard
- Provide analytics with flexible breakdown across all dimensions
- Detect shadow AI agents (agents running without a registered identity)
- Connect Claude Code developer sessions to the same fleet view via a plugin

**Does NOT:**

- Proxy or intercept LLM traffic at the network layer
- Capture prompt content unless explicitly enabled per deployment
- Calculate dollar costs (token counts only in v1)
- Send notifications via Slack, email, or PagerDuty (v2)
- Orchestrate or tell agents what to do

---

## Repository Structure

```
flightdeck/
├── ARCHITECTURE.md             # This file -- read before writing any code
├── DECISIONS.md                # Why decisions were made, alternatives rejected
├── CLAUDE.md                   # Standing rules for Claude Code sessions
├── CONTRIBUTING.md             # Contributor guide: setup, tests, PR process
├── RELEASING.md                # How to cut a release: version bump, tag, verify
├── METHODOLOGY.md              # Supervisor/Executor build methodology
├── CHANGELOG.md                # Version history
├── README.md                   # User-facing documentation
├── Makefile                    # Root Makefile -- orchestrates all components
│
├── sensor/                     # flightdeck-sensor Python package (published to PyPI)
│   ├── Makefile
│   ├── pyproject.toml          # Package metadata, optional deps, build config
│   ├── flightdeck_sensor/
│   │   ├── __init__.py         # Public API: init(), wrap(), patch(), get_status(), teardown()
│   │   ├── py.typed            # PEP 561 marker
│   │   ├── core/
│   │   │   ├── types.py        # SessionState, EventType, DirectiveAction, SensorConfig -- pure dataclasses
│   │   │   ├── session.py      # Session: lifecycle, identity, atexit/signal handlers, runtime context
│   │   │   ├── policy.py       # PolicyCache: local token enforcement, threshold evaluation
│   │   │   ├── context.py      # Pluggable runtime context collectors (process, OS, git, orchestration, framework)
│   │   │   └── exceptions.py   # BudgetExceededError, DirectiveError, ConfigurationError
│   │   ├── transport/
│   │   │   ├── client.py       # ControlPlaneClient: HTTP POST, directive envelope parsing
│   │   │   └── retry.py        # Exponential backoff, unavailability policy enforcement
│   │   ├── interceptor/
│   │   │   ├── base.py         # call(), call_async(), call_stream(): provider-agnostic intercept
│   │   │   ├── anthropic.py    # GuardedAnthropic: wraps sync + async Anthropic clients
│   │   │   └── openai.py       # GuardedOpenAI: wraps sync + async OpenAI clients
│   │   └── providers/
│   │       ├── protocol.py     # Provider Protocol: token estimation, usage extraction, content extraction
│   │       ├── anthropic.py    # AnthropicProvider: handles system, messages, tools, response
│   │       └── openai.py       # OpenAIProvider: handles messages (all roles), tools, response
│   └── tests/
│       ├── unit/
│       │   ├── test_session.py         # Session lifecycle, directive application, shutdown flag
│       │   ├── test_policy.py          # Token enforcement, threshold evaluation
│       │   ├── test_interceptor.py     # wrap(), patch(), call interception
│       │   ├── test_transport.py       # HTTP client, directive parsing, unavailability
│       │   ├── test_providers.py       # Token estimation, usage extraction
│       │   ├── test_prompt_capture.py  # Prompt capture on/off, content extraction per provider
│       │   └── test_context.py         # Runtime context collectors, never-raises guarantee, k8s priority
│       └── conftest.py                 # Shared fixtures: mock control plane, mock providers
│
├── ingestion/                  # Ingestion API (Go) -- receives sensor events, publishes to NATS
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/
│   │   └── main.go             # Entry point: config loading, server startup, graceful shutdown
│   ├── docs/                   # Generated by swaggo/swag (see D050)
│   │   ├── docs.go
│   │   ├── swagger.json
│   │   └── swagger.yaml
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go       # Config struct: all values from environment variables
│   │   ├── server/
│   │   │   └── server.go       # HTTP server setup, routes, middleware (logging, recovery)
│   │   ├── handlers/
│   │   │   ├── events.go       # POST /v1/events: validate, publish NATS, return directive
│   │   │   ├── heartbeat.go    # POST /v1/heartbeat: validate, publish NATS
│   │   │   ├── health.go       # GET /health: liveness check
│   │   │   └── GET /docs/*     # Swagger UI (swaggo/http-swagger)
│   │   ├── auth/
│   │   │   └── token.go        # Bearer token validation (hashed lookup in Postgres)
│   │   ├── nats/
│   │   │   └── publisher.go    # NATS JetStream publisher: routes events to correct subject
│   │   └── directive/
│   │       └── store.go        # Fast directive lookup: pending directives for a session_id
│   └── tests/
│       └── handler_test.go     # Unit tests for all HTTP handlers (mock NATS + Postgres)
│
├── workers/                    # Go event processing workers
│   ├── Makefile
│   ├── Dockerfile
│   ├── cmd/
│   │   └── main.go             # Entry point: config, NATS consumer pool, graceful shutdown
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go       # Config struct: all values from environment variables
│   │   ├── consumer/
│   │   │   └── nats.go         # NATS JetStream consumer goroutine pool, ack handling
│   │   ├── processor/
│   │   │   ├── event.go        # Route incoming event to session, writer, policy evaluator
│   │   │   ├── session.go      # Session state machine: active/idle/stale/closed/lost
│   │   │   └── policy.go       # Policy evaluation: check thresholds, write directive if needed
│   │   ├── writer/
│   │   │   ├── postgres.go     # Upsert agents, sessions, events, event_content via pgx
│   │   │   └── notify.go       # Postgres NOTIFY after each write (real-time dashboard push)
│   │   └── models/
│   │       ├── agent.go        # Agent struct (mirrors agents table)
│   │       ├── session.go      # Session struct (mirrors sessions table)
│   │       ├── event.go        # Event struct (mirrors events table)
│   │       ├── event_content.go # EventContent struct (mirrors event_content table)
│   │       ├── policy.go       # Policy struct (mirrors token_policies table)
│   │       └── directive.go    # Directive struct (mirrors directives table, split per D032)
│   └── tests/
│       └── processor_test.go   # Unit tests: event processing, state machine, policy eval
│
├── api/                        # Query API (Go) -- serves dashboard, WebSocket, search, analytics
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/
│   │   └── main.go             # Entry point: config, router, graceful shutdown
│   ├── docs/                   # Generated by swaggo/swag (see D050)
│   │   ├── docs.go
│   │   ├── swagger.json
│   │   └── swagger.yaml
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go       # Config struct: all values from environment variables
│   │   ├── server/
│   │   │   └── server.go       # HTTP server, router, CORS, auth middleware
│   │   ├── handlers/
│   │   │   ├── fleet.go        # GET /v1/fleet: current fleet state
│   │   │   ├── sessions.go     # GET /v1/sessions/:id: full event history
│   │   │   ├── agents.go       # GET /v1/agents/:flavor: all sessions for a flavor
│   │   │   ├── content.go      # GET /v1/events/:id/content: prompt content (when enabled)
│   │   │   ├── search.go       # GET /v1/search: cross-entity full-text search
│   │   │   ├── directives.go   # POST /v1/directives: issue kill switch or directive
│   │   │   ├── policies.go     # GET /v1/policy, GET/POST /v1/policies, PUT/DELETE /v1/policies/{id}
│   │   │   ├── analytics.go    # GET /v1/analytics: flexible breakdown queries
│   │   │   ├── events_list.go  # GET /v1/events: bulk events with time range, filters, pagination
│   │   │   ├── stream.go       # WS /v1/stream: real-time WebSocket fleet updates
│   │   │   └── health.go       # GET /health: liveness check
│   │   ├── store/
│   │   │   ├── postgres.go     # Fleet, session, event queries via pgx
│   │   │   ├── analytics.go    # Analytics GROUP BY queries across all dimensions
│   │   │   ├── events.go       # GetEvents() bulk event query with time range, filters, pagination
│   │   │   └── search.go       # Search() parallel ILIKE across agents, sessions, events via errgroup
│   │   └── ws/
│   │       └── hub.go          # WebSocket hub: client registry, broadcast on PG NOTIFY
│   └── tests/
│       └── handler_test.go     # Unit tests for all HTTP and WebSocket handlers
│
├── dashboard/                  # React frontend (TypeScript + Vite)
│   ├── Makefile
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── index.html              # Root HTML, theme class on html element
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── postcss.config.js       # Tailwind + Autoprefixer
│   ├── tailwind.config.js      # CSS variable-based theme colors
│   ├── eslint.config.js        # ESLint 9 flat config
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx             # Root: router, theme provider, nav bar with Fleet and Policies links
│   │   ├── pages/
│   │   │   ├── Fleet.tsx       # Primary view: timeline + fleet health panel
│   │   │   ├── Session.tsx     # Session drill-down (opened from timeline node click)
│   │   │   ├── Analytics.tsx   # Analytics page: flexible breakdown charts
│   │   │   └── Policies.tsx    # Policy management: list, create, edit, delete via PolicyEditor dialog
│   │   ├── components/
│   │   │   ├── timeline/
│   │   │   │   ├── Timeline.tsx        # Primary surface: swim lanes, real-time scrolling
│   │   │   │   ├── SwimLane.tsx        # One row per agent flavor
│   │   │   │   ├── EventNode.tsx       # Individual event: color, label, hover glow, pulse
│   │   │   │   └── TimeAxis.tsx        # Horizontal time axis (D3 scale, React rendering)
│   │   │   ├── fleet/
│   │   │   │   ├── FleetPanel.tsx      # Left panel: counts, by-flavor, recent policy events
│   │   │   │   ├── SessionStateBar.tsx # Active/idle/stale/lost with live counts
│   │   │   │   └── PolicyEventList.tsx # Last 10 violations/enforcements/kill switches
│   │   │   ├── session/
│   │   │   │   ├── SessionDrawer.tsx   # Slide-in right panel (Framer Motion)
│   │   │   │   ├── SessionTimeline.tsx # Chronological event list inside drawer
│   │   │   │   ├── EventDetail.tsx     # Expandable event: payload, tokens, latency
│   │   │   │   ├── PromptViewer.tsx    # Messages/context display when capture enabled
│   │   │   │   └── TokenUsageBar.tsx   # Used/limit with warn/degrade/block markers
│   │   │   ├── analytics/
│   │   │   │   ├── KpiRow.tsx          # Top headline numbers (Tremor BarList/Cards)
│   │   │   │   ├── DimensionChart.tsx  # Reusable chart with group-by control
│   │   │   │   ├── TimeSeriesChart.tsx # Token/session over time (Tremor AreaChart)
│   │   │   │   ├── RankingChart.tsx    # Top N by dimension (Tremor BarChart horizontal)
│   │   │   │   ├── DonutChart.tsx      # Distribution (Tremor DonutChart)
│   │   │   │   └── DimensionPicker.tsx # Group by selector: flavor/model/framework/host/team
│   │   │   ├── search/
│   │   │   │   ├── CommandPalette.tsx  # Cmd+K palette (shadcn Command + cmdk)
│   │   │   │   └── SearchResults.tsx   # Grouped results: Agents, Sessions, Events, Policy
│   │   │   ├── policy/
│   │   │   │   ├── PolicyEditor.tsx    # Form component for create/edit policy in Dialog
│   │   │   │   └── PolicyTable.tsx     # Sortable table with scope badges and delete confirmation
│   │   │   └── ui/                     # shadcn/ui components (owned, copied into project)
│   │   │       ├── button.tsx
│   │   │       ├── card.tsx
│   │   │       ├── command.tsx
│   │   │       ├── dialog.tsx
│   │   │       ├── drawer.tsx
│   │   │       ├── badge.tsx
│   │   │       ├── select.tsx
│   │   │       ├── tooltip.tsx
│   │   │       └── ...
│   │   ├── hooks/
│   │   │   ├── useFleet.ts       # Fleet state: WebSocket init, REST initial load, live updates
│   │   │   ├── useSession.ts     # Session event history + prompt content
│   │   │   ├── useAnalytics.ts   # Analytics queries with dimension/metric/range params
│   │   │   ├── useSearch.ts      # Debounced search query
│   │   │   └── useWebSocket.ts   # WebSocket with auto-reconnect (exponential backoff: 1s→2s→4s, cap 30s)
│   │   ├── store/
│   │   │   └── fleet.ts          # Zustand: fleet state, session map, WebSocket stream
│   │   ├── lib/
│   │   │   ├── api.ts            # Typed fetch wrappers for all endpoints
│   │   │   ├── time.ts           # Time scale helpers (d3-scale + d3-time math only)
│   │   │   ├── types.ts          # TypeScript types mirroring all backend schemas
│   │   │   └── utils.ts          # cn() helper (clsx + tailwind-merge)
│   │   ├── vite-env.d.ts         # Vite client type reference
│   │   └── styles/
│   │       ├── globals.css       # CSS variables for both themes -- NEVER casually edit
│   │       └── themes.css        # Neon dark + clean light theme definitions
│   └── tests/
│       ├── unit/
│       │   ├── Timeline.test.tsx
│       │   ├── CommandPalette.test.tsx
│       │   ├── SessionDrawer.test.tsx
│       │   ├── FleetPanel.test.tsx
│       │   ├── PolicyEditor.test.tsx    # 6 tests: create mode, edit mode, threshold validation, scope_value required
│       │   ├── PolicyTable.test.tsx     # 4 tests: scope badges, empty state, delete confirmation, onDelete callback
│       │   ├── TokenUsageBar.test.tsx   # 3 tests: markers at correct positions, null thresholds, no-limit path
│       │   ├── DimensionChart.test.tsx  # Group-by switching, chart re-render
│       │   └── PromptViewer.test.tsx    # Prompt display, provider terminology
│       └── e2e/
│           ├── fleet.spec.ts
│           ├── search.spec.ts
│           ├── killswitch.spec.ts
│           └── analytics.spec.ts        # Dimension switching, time range, chart updates
│
├── plugin/                     # Claude Code hook plugin
│   ├── Makefile
│   ├── package.json
│   ├── .claude-plugin/
│   │   └── manifest.json
│   ├── hooks/
│   │   ├── hooks.json          # PreToolUse, PostToolUse, Stop, SubagentSpawn hooks
│   │   └── scripts/
│   │       └── observe_cli.mjs # Reads stdin, reformats to Flightdeck schema, POSTs
│   └── skills/
│       └── flightdeck.md       # /flightdeck skill: open dashboard, check status
│
├── helm/                       # Helm chart for Kubernetes production deployment
│   ├── Makefile
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── values.prod.yaml
│   └── templates/
│       ├── _helpers.tpl
│       ├── ingestion/
│       │   ├── deployment.yaml
│       │   ├── service.yaml
│       │   └── hpa.yaml
│       ├── workers/
│       │   ├── deployment.yaml
│       │   └── service.yaml
│       ├── api/
│       │   ├── deployment.yaml
│       │   └── service.yaml
│       ├── dashboard/
│       │   ├── deployment.yaml
│       │   └── service.yaml
│       ├── nats/
│       │   └── statefulset.yaml
│       ├── postgres/
│       │   └── statefulset.yaml
│       ├── configmap.yaml
│       ├── secret.yaml
│       ├── ingress.yaml
│       └── rbac.yaml
│
├── docker/
│   ├── Makefile
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   ├── docker-compose.prod.yml
│   ├── nginx/
│   │   ├── nginx.dev.conf
│   │   └── nginx.prod.conf
│   ├── postgres/
│   │   ├── migrations/
│   │   │   ├── 000001_initial_schema.up.sql
│   │   │   ├── 000001_initial_schema.down.sql
│   │   │   ├── 000002_add_source_to_events.up.sql
│   │   │   ├── 000002_add_source_to_events.down.sql
│   │   │   ├── 000003_add_degrade_to_directives.up.sql
│   │   │   └── 000003_add_degrade_to_directives.down.sql
│   │   └── init.sql            # Seed data only (no schema)
│   └── .env.example
│
├── tests/
│   └── integration/
│       ├── conftest.py
│       ├── test_pipeline.py
│       ├── test_enforcement.py
│       ├── test_killswitch.py
│       ├── test_policy.py
│       ├── test_session_states.py
│       ├── test_prompt_capture.py  # Capture on/off, content stored/not stored
│       └── test_analytics.py       # GROUP BY queries return correct aggregates
│
├── scripts/
│   ├── install-deps/
│   │   ├── linux.sh
│   │   ├── macos.sh
│   │   └── windows.ps1
│   └── release.sh              # Validate, bump version, tag, push → triggers CI
│
└── .github/
    └── workflows/
        ├── ci.yml              # Test + lint on every PR (all components in parallel)
        ├── release.yml         # On version tag: publish PyPI + Docker Hub + GitHub release
```

---

## System Architecture

```
┌─────────────────────┐          ┌──────────────────────────┐
│   Agent Process     │          │   React Dashboard :3000  │
│                     │          │                          │
│  flightdeck-sensor  │          │  Fleet, Policies,        │
│  Session + Policy   │          │  Session drawer,         │
│  Interceptor        │          │  Analytics, Search       │
└────────┬────────────┘          └────────┬─────────────────┘
         │                                │
         │ POST /ingest/v1/events         │ REST  /api/*
         │ GET  /api/v1/policy            │ WS    /api/v1/stream
         │                                │ GET   / (SPA static)
         │                                │
         ▼                                ▼
┌──────────────────────────────────────────────────────────┐
│                    nginx :4000                           │
│                                                          │
│  /ingest/*  → ingestion:8080  (strips prefix)           │
│  /api/*     → api:8081        (strips prefix)           │
│  /          → dashboard:3000                            │
│  /api/v1/stream  → api:8081   (WebSocket upgrade)       │
└───────┬──────────────────────────────┬───────────────────┘
        │                              │
        ▼                              ▼
┌──────────────────────┐    ┌──────────────────────────────┐
│ Ingestion API :8080  │    │     Query API :8081          │
│                      │    │                              │
│ POST /v1/events      │    │ GET /v1/fleet                │
│ POST /v1/heartbeat   │    │ GET /v1/sessions/:id         │
│ GET  /health         │    │ GET /v1/policy               │
│ GET  /docs/          │    │ GET/POST/PUT/DELETE          │
│                      │    │   /v1/policies               │
│ Auth: validates      │    │ POST /v1/directives          │
│   bearer token       │    │ GET /v1/analytics            │
│   (reads api_tokens) │    │ WS  /v1/stream               │
│                      │    │ GET /docs/                   │
│                      │    │                              │
│                      │    │ LISTEN flightdeck_fleet      │
│ Directive: reads +   │    │   (reconnects every 3s)      │
│   marks delivered    │    │   → broadcasts to WS clients │
│   (directives table) │    │                              │
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
│  Durable: flightdeck │               │
│    -workers          │               │
└──────────┬───────────┘               │
           │                           │
           │ PULL events.>             │
           │ Ack/Nak/Term             │
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
           ▼                           ▼
┌──────────────────────────────────────────────────────────┐
│                PostgreSQL :5432                          │
│                                                          │
│  Written by Workers:                                    │
│    agents          sessions        events               │
│    event_content   directives                           │
│                                                          │
│  Written by Query API:                                  │
│    token_policies                                       │
│                                                          │
│  Seed data only:                                        │
│    api_tokens                                           │
│                                                          │
│  NOTIFY channel: flightdeck_fleet                       │
│    Workers send NOTIFY after every event write          │
│    Query API hub receives via LISTEN                    │
└──────────────────────────────────────────────────────────┘

Data flows:

  Ingestion API → Postgres:
    READ  api_tokens      (auth on every request)
    READ  sessions        (directive flavor lookup)
    READ+WRITE directives (lookup pending + mark delivered)

  Workers → Postgres:
    WRITE agents, sessions, events, event_content, directives
    READ  sessions        (terminal check, token count)
    READ  token_policies  (policy evaluation)
    READ  directives      (shutdown dedup check)
    NOTIFY flightdeck_fleet (after every event write)

  Query API → Postgres:
    READ  sessions, events, event_content
    READ  directives (pending directive check)
    READ+WRITE token_policies (CRUD)
    WRITE directives (POST /v1/directives)
    LISTEN flightdeck_fleet (real-time push to dashboard)
```

---

## Sensor Design Principles

The sensor is a library wrapper, not an OS agent.

It has no background threads, no polling loops, and no network activity
independent of LLM calls. It runs when called and returns when done. The
application is fully in control of when the sensor does anything.

The one exception is the event queue drain thread, which offloads HTTP POSTs
off the LLM call hot path. This is a performance optimization that is invisible
to the application, not a control plane concern.

Never add heartbeat-like behavior, polling loops, or daemon threads to the
sensor. If a feature requires background activity, it belongs in a sidecar
container or system service, not in a library that runs inside an application
process.

---

## Component Interfaces

### flightdeck-sensor Public API

```python
def init(
    server: str,
    token: str,
    capture_prompts: bool = False,   # opt-in only -- see DECISIONS.md D019
    quiet: bool = False,
    limit: int | None = None,        # local WARN-only token threshold -- see D035
    warn_at: float = 0.8,            # fire WARN at this fraction of limit
) -> None:
    """
    Initialize the sensor.

    limit sets a local WARN-only token threshold. Never blocks. Never degrades.
    Most restrictive threshold wins when both local and server policies are active.
    See DECISIONS.md D035.

    Reads from environment (override init() params):
        AGENT_FLAVOR                  -- persistent identity, e.g. "research-agent"
        AGENT_TYPE                    -- "autonomous", "supervised", or "batch"
        FLIGHTDECK_UNAVAILABLE_POLICY -- "continue" (default) or "halt"
        FLIGHTDECK_CAPTURE_PROMPTS    -- "true" to enable (overrides capture_prompts param)

    When capture_prompts=False (default):
        Event payloads contain token counts, model, latency, tool names only.
        No message content, no system prompts, no tool inputs/outputs.

    When capture_prompts=True:
        Event payloads also include the full messages array, system prompt,
        tool definitions, and the completion response.
        Content is stored in event_content table, NOT inline in events.
    """

def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap an Anthropic or OpenAI client. init() must be called first."""

def patch(
    quiet: bool = False,
    providers: list[str] | None = None,
) -> None:
    """Monkey-patch SDK constructors. Works with all major frameworks."""

def unpatch() -> None: ...
def get_status() -> StatusResponse: ...
def teardown() -> None: ...
```

### Provider Protocol (`sensor/flightdeck_sensor/providers/protocol.py`)

```python
class Provider(Protocol):

    def estimate_tokens(self, request_kwargs: dict) -> int:
        """Estimate tokens before the call. Never raises."""

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from response. Never raises."""

    def extract_content(self, request_kwargs: dict, response: Any) -> PromptContent | None:
        """
        Extract prompt content for storage when capture_prompts=True.
        Returns None when capture_prompts=False.
        Never raises.

        For Anthropic: extracts system, messages array, tools list, response message.
        For OpenAI: extracts messages array (all roles), tools list, response choice.
        Provider terminology is preserved exactly -- no normalization.
        """

    def get_model(self, request_kwargs: dict) -> str:
        """Extract model name from request kwargs. Returns "" on failure."""
```

### PromptContent dataclass

```python
@dataclass
class PromptContent:
    """
    Raw content extracted from a single LLM call.
    Provider terminology preserved: Anthropic uses 'messages', OpenAI uses 'messages'.
    System prompt field name varies: Anthropic uses 'system', OpenAI embeds in messages.
    """
    system: str | None           # Anthropic system param, or None for OpenAI
    messages: list[dict]         # Full messages array as-is from request_kwargs
    tools: list[dict] | None     # Tool definitions if provided
    response: dict               # Full response as dict
    provider: str                # "anthropic" or "openai"
    model: str
    session_id: str
    event_id: str
    captured_at: str             # ISO 8601 UTC
```

---

## Event Payload Schema

### Sensor → Ingestion API (`POST /v1/events`)

```json
{
  "session_id":          "uuid",
  "flavor":              "research-agent",
  "agent_type":          "autonomous",
  "event_type":          "post_call",
  "host":                "worker-node-3",
  "framework":           "crewai",
  "model":               "claude-sonnet-4-6",
  "tokens_input":        1240,
  "tokens_output":       387,
  "tokens_total":        1627,
  "tokens_used_session": 42180,
  "token_limit_session": 100000,
  "latency_ms":          1840,
  "tool_name":           null,
  "tool_input":          null,
  "tool_result":         null,
  "has_content":         false,
  "content": null,
  "timestamp":           "2026-04-07T10:00:00Z"
}
```

When `capture_prompts=true`, the `content` field contains a `PromptContent` object.
The worker stores this in `event_content` and sets `has_content=true` on the event row.

### Ingestion API response

```json
{ "status": "ok", "directive": null }
```

```json
{
  "status": "ok",
  "directive": {
    "action": "shutdown",
    "reason": "kill_switch_activated",
    "grace_period_ms": 5000
  }
}
```

Directives are delivered in the HTTP response envelope of the sensor's next
`POST /v1/events` call. Delivery latency equals the time between LLM calls.
Idle agents (no active LLM calls) will not receive directives until they make
their next LLM call.

---

## Data Model

### agents

```sql
CREATE TABLE agents (
    flavor          TEXT PRIMARY KEY,
    agent_type      TEXT NOT NULL DEFAULT 'autonomous',
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_count   INTEGER NOT NULL DEFAULT 0,
    policy_id       UUID REFERENCES token_policies(id)
);
```

### sessions

```sql
CREATE TABLE sessions (
    session_id      UUID PRIMARY KEY,
    flavor          TEXT NOT NULL REFERENCES agents(flavor),
    agent_type      TEXT NOT NULL,
    host            TEXT,
    framework       TEXT,
    model           TEXT,
    state           TEXT NOT NULL DEFAULT 'active',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    tokens_used     INTEGER NOT NULL DEFAULT 0,
    token_limit     INTEGER,
    metadata        JSONB,
    context         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX sessions_flavor_idx      ON sessions(flavor);
CREATE INDEX sessions_state_idx       ON sessions(state);
CREATE INDEX sessions_last_seen_idx   ON sessions(last_seen_at);
CREATE INDEX sessions_started_idx     ON sessions(started_at);
CREATE INDEX sessions_context_gin     ON sessions USING GIN (context);
```

The `context` column stores the runtime environment snapshot collected
once by the sensor at `init()` time -- hostname, OS, Python version, git
commit / branch / repo, orchestration (kubernetes / compose / docker /
ECS / cloud-run), and any in-process AI frameworks. The worker writer
sets it once on session insert and deliberately does NOT update it on
conflict (set-once semantics). The API aggregates it into facets via
`GetContextFacets()` for the dashboard CONTEXT sidebar filter panel.

### events (metadata only -- no prompt content inline)

```sql
CREATE TABLE events (
    id              UUID DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(session_id),
    flavor          TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    model           TEXT,
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    tokens_total    INTEGER,
    latency_ms      INTEGER,
    tool_name       TEXT,
    has_content     BOOLEAN NOT NULL DEFAULT FALSE,
    source          TEXT,               -- "local" or "server" on policy_warn events, NULL otherwise
    payload         JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, occurred_at)
);

CREATE INDEX events_session_idx ON events(session_id, occurred_at);
CREATE INDEX events_flavor_idx  ON events(flavor, occurred_at);
CREATE INDEX events_type_idx    ON events(event_type, occurred_at);
```

### event_content (prompt storage -- separate table, fetched on demand)

```sql
CREATE TABLE event_content (
    event_id        UUID NOT NULL,
    session_id      UUID NOT NULL REFERENCES sessions(session_id),
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    system_prompt   TEXT,
    messages        JSONB NOT NULL,
    tools           JSONB,
    response        JSONB NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id)
);

CREATE INDEX event_content_session_idx ON event_content(session_id);
```

Content is never joined into event queries automatically. It is fetched explicitly
via `GET /v1/events/:id/content`. This keeps event table queries fast regardless
of prompt capture settings.

### token_policies

```sql
CREATE TABLE token_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope               TEXT NOT NULL,
    scope_value         TEXT,
    warn_at_pct         INTEGER NOT NULL DEFAULT 80,
    degrade_at_pct      INTEGER NOT NULL DEFAULT 90,
    degrade_to          TEXT,
    block_at_pct        INTEGER NOT NULL DEFAULT 100,
    token_limit         INTEGER,
    unavailable_policy  TEXT NOT NULL DEFAULT 'continue',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### directives

```sql
CREATE TABLE directives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID,
    flavor          TEXT,
    action          TEXT NOT NULL,
    reason          TEXT,
    degrade_to      TEXT,
    grace_period_ms INTEGER NOT NULL DEFAULT 5000,
    issued_by       TEXT NOT NULL DEFAULT 'platform',
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ
);

CREATE INDEX directives_session_pending_idx
    ON directives(session_id) WHERE delivered_at IS NULL;
CREATE INDEX directives_flavor_pending_idx
    ON directives(flavor) WHERE delivered_at IS NULL;
```

### custom_directives

```sql
CREATE TABLE custom_directives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint   TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    JSONB,
    registered_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives(flavor);
CREATE INDEX custom_directives_fp_idx ON custom_directives(fingerprint);
```

Custom directives are registered by the sensor at init() via fingerprint sync.
The `directives` table also has a `payload JSONB` column for custom directive
parameters (added in migration 000005).

---

## Database Migrations

Schema changes are managed by golang-migrate. Migration files live in
`docker/postgres/migrations/`. The workers service applies all pending
migrations on startup before consuming events. If migrations fail,
workers do not start.

File naming convention:

```
000NNN_description.up.sql   -- apply change
000NNN_description.down.sql -- reverse change
```

Every migration must have a down file that is the exact inverse of the
up file. Rule 33 enforces this. Never modify `init.sql` for schema
changes -- always add a new migration pair. `init.sql` contains seed
data only (and the `api_tokens` table which is needed before migrations
run).

To add a schema change:

1. Create the next numbered up/down pair in `docker/postgres/migrations/`
2. Update the Data Model section in ARCHITECTURE.md
3. Run `make dev-reset` to verify the migration applies and reverses cleanly

Makefile targets (local development only):

```bash
make migrate-local-up       # Apply pending migrations (uses FLIGHTDECK_MIGRATE_ONLY mode)
make migrate-local-status   # Show current version from schema_migrations table
make dev-reset              # Full volume wipe + restart (applies all migrations fresh)
```

Note: make targets are for local development only. In production, workers
apply migrations automatically on startup. Use `FLIGHTDECK_MIGRATE_ONLY=true`
for manual migration runs in remote environments or Kubernetes init containers.

Current migrations:

| Migration | Description |
|---|---|
| 000001 | Initial schema (all six tables + api_tokens + indexes) |
| 000002 | Add `source` column to events |
| 000003 | Add `degrade_to` column to directives |
| 000004 | Add `custom_directives` table |
| 000005 | Add `payload` JSONB column to directives |
| 000006 | Add `context` JSONB column + GIN index to sessions (D074) |

---

## Analytics API

### `GET /v1/analytics`

Flexible GROUP BY endpoint. All parameters are optional.

```
Query params:
  metric     -- "tokens", "sessions", "latency_avg", "policy_events"
               default: "tokens"
  group_by   -- "flavor", "model", "framework", "host", "agent_type", "team"
               default: "flavor"
  range      -- "7d", "30d", "90d", "custom"
               default: "30d"
  from       -- ISO 8601 (required when range=custom)
  to         -- ISO 8601 (required when range=custom)
  filter_flavor     -- filter to specific flavor
  filter_model      -- filter to specific model
  filter_agent_type -- filter to specific agent_type
  granularity       -- "hour", "day", "week" (for time series)
               default: "day"
```

Response:

```json
{
  "metric": "tokens",
  "group_by": "flavor",
  "range": "30d",
  "granularity": "day",
  "series": [
    {
      "dimension": "research-agent",
      "total": 4820000,
      "data": [
        { "date": "2026-03-08", "value": 142000 },
        { "date": "2026-03-09", "value": 198000 }
      ]
    }
  ],
  "totals": {
    "grand_total": 9240000,
    "period_change_pct": 12.4
  }
}
```

The same endpoint powers all charts on the analytics page. The frontend
calls it with different `metric` and `group_by` parameters per chart.

---

## Analytics Dashboard Layout

```
┌──────────┬──────────┬──────────┬──────────┐
│  Total   │  Active  │  Total   │  Policy  │
│  Tokens  │  Right   │  Sessions│  Events  │
│  (30d)   │  Now     │  (30d)   │  (30d)   │
└──────────┴──────────┴──────────┴──────────┘

[Time range: 7d | 30d | 90d | Custom]

┌────────────────────────────────────────────┐
│  Token consumption over time               │
│  [Group by: Flavor ▾]                      │
│  stacked area chart (Tremor AreaChart)     │
└────────────────────────────────────────────┘

┌──────────────────────┬─────────────────────┐
│  Top Consumers       │  Avg Latency Over   │
│                      │  Time               │
│  [Group by: Flavor▾] │  [Group by: Flavor▾]│
│  horizontal bar      │  stacked area       │
└──────────────────────┴─────────────────────┘

┌──────────────┬──────────────┬──────────────┐
│  Sessions by │  Policy      │  Agent Type  │
│  Model       │  Events      │  Distribution│
│  [Model ▾]   │  [Flavor ▾]  │  [Type ▾]    │
│  donut chart │  area chart  │  donut chart │
└──────────────┴──────────────┴──────────────┘
```

Every chart has:
- A `[Group by: X ▾]` dropdown in the top-right corner
- Clicking a segment/bar filters all other charts to that dimension value
- The global time range picker at the top applies to all charts

Available dimensions for any group-by: `flavor`, `model`, `framework`,
`host`, `agent_type`, `team`

Available metrics for any chart: `tokens`, `sessions`, `latency_avg`,
`policy_events`

---

## Session Drawer -- Prompt Viewer

When `capture_prompts=true` for a session, the session drawer shows a
"Prompts" tab alongside the event timeline tab.

The Prompts tab shows:

```
┌─────────────────────────────────────────────┐
│  System                                     │
│  ─────────────────────────────────────────  │
│  You are a research assistant...            │
│                                             │
│  Messages                                   │
│  ─────────────────────────────────────────  │
│  [user]  Find information about X           │
│  [assistant]  I'll search for X...          │
│  [tool_result]  { search results }          │
│  [assistant]  Based on the results...       │
│                                             │
│  Tools                                      │
│  ─────────────────────────────────────────  │
│  web_search, bash, read_file                │
└─────────────────────────────────────────────┘
```

Provider terminology is preserved exactly:
- Anthropic: shows `system` and `messages` with role labels
- OpenAI: shows `messages` with all role types (system, user, assistant, tool)

When capture is disabled for a session, the Prompts tab shows:
"Prompt capture is not enabled for this deployment."

---

## Phase 4.5 Additions

Phase 4.5 is a UI redesign and feature pass that adds custom directives,
Pydantic schema validation, a bulk events endpoint, a live event feed, a
pause/queue model, dashboard performance optimizations, and a directives
management page. This section consolidates everything new in Phase 4.5
that is not covered above. See DECISIONS.md D059-D072 for the rationale.

### Sensor -- Custom Directives and Pydantic Schemas

`sensor/flightdeck_sensor/core/schemas.py`
- Pydantic v2 models for control plane envelopes. All use
  `model_validate()` and fail open on `ValidationError`.
- `DirectivePayloadSchema`: validates the `payload` field of a custom
  directive received in a response envelope. Fields:
  `directive_name: str`, `fingerprint: str`, `parameters: dict`.
- `PolicyResponseSchema`: validates the `GET /v1/policy` response. Fields:
  `token_limit`, `warn_at_pct`, `degrade_at_pct`, `degrade_to`,
  `block_at_pct`, `unavailable_policy`.
- `DirectiveResponseSchema`: validates the `directive` object inside an
  ingestion response envelope. Fields: `action`, `reason`,
  `grace_period_ms`, `degrade_to`, `payload`.
- `SyncResponseSchema`: validates the `POST /v1/directives/sync` response.
  Fields: `unknown_fingerprints: list[str]`.
- Pydantic v2 is added to sensor runtime dependencies. Go API handlers
  keep manual validation -- this is sensor-only.

`sensor/flightdeck_sensor/__init__.py` (extend Phase 1 public API)
- `directive(name, description, parameters=None) -> Callable`: decorator
  that registers a custom directive handler at module load time.
- `Parameter`: alias of `DirectiveParameter` exposed in `__all__` for
  ergonomic decorator use.
- `_compute_fingerprint(name, description, parameters) -> str`: SHA-256
  digest of the canonical JSON of the directive schema, base64-encoded.
  Used to detect when a handler has changed since last sync.
- `_directive_registry: dict[str, DirectiveRegistration]`: module-global
  registry populated at decorator evaluation time.

`sensor/flightdeck_sensor/core/types.py` (extend Phase 1)
- `EventType.DIRECTIVE_RESULT = "directive_result"`: result of a directive
  acknowledgement or custom-directive execution.
- `DirectiveAction.CUSTOM = "custom"`: action value for custom directives.
- `DirectiveParameter`: name, type, description, options, required, default.
- `DirectiveRegistration`: name, description, parameters, fingerprint,
  handler.
- `DirectiveContext`: passed to handlers on execution. Fields:
  session_id, flavor, tokens_used, model.

`sensor/flightdeck_sensor/core/session.py` (extend)
- `_preflight_policy()`: called from `Session.start()`. Issues
  `GET /v1/policy?flavor=...&session_id=...` and populates `PolicyCache`
  before the first LLM call. Validates with `PolicyResponseSchema`.
- `_sync_directives(registry)`: called from `Session.start()`. POSTs all
  registered fingerprints to `/v1/directives/sync`. For each unknown
  fingerprint returned, POSTs the full schema to `/v1/directives/register`.
- `_execute_custom_directive(directive)`: validates payload via
  `DirectivePayloadSchema`, looks up handler in `_directive_registry`,
  verifies fingerprint match, runs handler with a 5 second timeout via
  `_run_handler_with_timeout()`, then enqueues a `directive_result` event
  with `directive_status` ("success" / "error"), `result`, and `error`.
  Never raises -- always fails open.
- `_run_handler_with_timeout(handler, ctx, params)`: SIGALRM-based timeout
  on Unix when running on the main thread. On Windows OR on any
  non-main thread the SIGALRM path is bypassed and the handler runs
  without a timeout. After the Phase 4.5 audit B-H two-queue refactor,
  custom directive handlers always run on the
  `flightdeck-directive-queue` daemon thread (never the main thread),
  so the SIGALRM timeout effectively never applies in production. A
  badly written or hung handler can therefore stall the directive
  queue indefinitely. **It cannot affect event throughput** because
  the drain thread is independent (the entire point of the two-queue
  pattern), so post_call events keep flowing to ingestion regardless
  of how slow the handler is. This is a known limitation; replacing
  SIGALRM with a `Thread + Event` based timeout is tracked for a
  future hardening pass.
- Acknowledgement events: in `_apply_directive()`, before acting on
  `SHUTDOWN`, `SHUTDOWN_FLAVOR`, or `DEGRADE`, the sensor enqueues a
  `directive_result` event with `directive_status="acknowledged"` and an
  action-specific result dict (e.g. `from_model`/`to_model` for degrade,
  `reason` for shutdown). For shutdown variants the sensor calls
  `EventQueue.flush()` synchronously before raising the shutdown flag so
  the acknowledgement is not lost when the process exits. The
  synchronous flush is safe because `_apply_directive` runs on the
  dedicated directive handler thread (B-H), not the drain thread, so
  `Queue.join()` on the event queue makes progress without
  self-deadlock.

`sensor/flightdeck_sensor/transport/client.py` (extend)
- `EventQueue` now runs **two** background daemon threads (Phase 4.5
  audit B-H two-queue pattern):
  - `flightdeck-event-queue` (drain thread): pulls events from the
    event queue, calls `ControlPlaneClient.post_event`, and on a
    non-None directive in the response envelope hands the directive
    off to the directive queue via `put_nowait`. The drain thread
    NEVER calls `_apply_directive` directly. This guarantees that a
    slow custom handler cannot back up the event queue or cause
    silent post_call event loss.
  - `flightdeck-directive-queue` (directive handler thread): drains
    the directive queue and invokes the handler one directive at a
    time. Single-consumer, so at-most-once execution is guaranteed
    without any dedup state.
  Started only when the `directive_handler` constructor argument is
  non-None (Session always passes its `_apply_directive`); unit-test
  fixtures that build `EventQueue` directly without a handler get
  the legacy "discard directives" behaviour.
- `EventQueue.flush(timeout=5.0)`: synchronously drains pending events
  up to a deadline (event queue only). Used by `Session.end()` and
  the shutdown / shutdown_flavor branches of `_apply_directive()`.
  **The directive queue is intentionally NOT waited on**: `flush()`
  is typically called from inside `_apply_directive` running on the
  directive handler thread, and `Queue.join()` on the directive
  queue would self-deadlock because the current item has not yet
  had `task_done()` called on it. The directive queue is internal
  control flow; the event queue is the externally observable state
  that operators care about flushing before shutdown. See D081.
- `ControlPlaneClient.sync_directives(flavor, directives)`: POST to
  `/v1/directives/sync`. Returns the list of unknown fingerprints from
  `SyncResponseSchema`. **KI14**: in dev this URL resolves to the
  ingestion service via `/ingest/v1/directives/sync` and 404s
  because the handler lives on the API service. The broad
  `except Exception` swallows the error and the sensor proceeds
  without auto-registration. Tests work around this by registering
  directives via `POST /api/v1/directives/register` directly. Same
  applies to `register_directives` and to `_preflight_policy`.
- `ControlPlaneClient.register_directives(flavor, directives)`: POST to
  `/v1/directives/register`. Fire-and-forget; logs failures.
- `_parse_directive(body)`: now uses `DirectiveResponseSchema`. On
  `ValidationError`, logs a warning and returns `None` (fail open).

### Sensor -- B-G token race fix and B-E forced degrade

`sensor/flightdeck_sensor/core/session.py:Session.record_usage` (extend)
- Returns the post-increment `_tokens_used` total (return type
  changed from `None` to `int`). The increment AND the read happen
  inside the same `with self._lock:` critical section so a
  concurrent caller cannot read the value after another thread's
  increment has bled into it.

`sensor/flightdeck_sensor/interceptor/base.py:_post_call` (extend)
- The order of operations is now (1) `record_usage` returns the
  post-increment total atomically, (2) `record_model`, (3)
  `_build_payload(..., tokens_used_session=session_total, ...)`
  with the captured value passed explicitly. The previous order
  built the payload before `record_usage`, which meant
  `tokens_used_session` reported the pre-call total under
  single-threaded use and reported a racy mix of all threads'
  contributions under concurrent use. See D082.

`sensor/flightdeck_sensor/core/policy.py:PolicyCache._forced_degrade`
- New boolean flag that arms a forced DEGRADE decision in
  `check()`. Set by `set_degrade_model(model)` when the sensor
  receives a DEGRADE directive from the server. Cleared by
  `update(policy_dict)` (called for `POLICY_UPDATE` directives) so
  a fresh policy can un-stick the forced state if the server
  retracts the degrade.
- `check()` short-circuits at the top of the locked block: if
  `_forced_degrade and degrade_to`, returns
  `PolicyResult(DEGRADE, source="server")` regardless of token
  thresholds. This is required because the workers' policy
  evaluator may issue a DEGRADE directive based on its own
  cumulative count without ever populating the sensor's local
  `degrade_at_pct` cache (preflight policy fetch can fail
  silently per KI14). See D084.

### Sensor -- B-D directive_result schema rename

`sensor/flightdeck_sensor/core/session.py:_build_directive_result_event`
(extend)
- Field names changed to match the worker's
  `consumer.EventPayload` schema so `BuildEventExtra` can persist
  them into `events.payload`:
  - `directive_success: bool` → `directive_status: str`
    (`"success"` or `"error"`)
  - `directive_result: Any` → `result: Any`
  - `directive_error: str | None` → `error: str | None`
- Also adds `directive_action: "custom"` to the payload for
  symmetry with the SHUTDOWN / DEGRADE acknowledgement events.
- Pre-fix the worker decoded none of these fields and silently
  dropped them at the ingestion boundary, leaving custom
  directive results unobservable in the dashboard. See D083.

### Ingestion -- B-F DirectiveResponse Payload projection

`ingestion/internal/handlers/events.go:DirectiveResponse` (extend)
- New field: `Payload *json.RawMessage \`json:"payload,omitempty" swaggertype:"object"\``.
  Carries the JSONB blob for `action="custom"` directives
  (`directive_name`, `fingerprint`, `parameters`) so the sensor's
  `DirectivePayloadSchema` can validate it and dispatch to the
  registered handler. `omitempty` keeps the JSON envelope clean
  for non-custom directives (shutdown / degrade / etc.) which
  have no payload.

`ingestion/cmd/main.go:directiveAdapter.LookupPending` (extend)
- Now projects `d.Payload` from `directive.Directive` into the
  outgoing `handlers.DirectiveResponse`. Before this fix the
  adapter dropped the payload silently and every custom directive
  reaching the sensor failed Pydantic validation with an empty
  payload. See D085.

### API -- Bulk Events Endpoint and Custom Directive Endpoints

`api/internal/handlers/events_list.go`
- `GET /v1/events`: bulk event query for the dashboard's historical load.
- Query params:
  - `from` (required, ISO 8601) -- 400 if missing or unparseable
  - `to` (optional, ISO 8601, defaults to now)
  - `flavor` (optional)
  - `event_type` (optional)
  - `session_id` (optional)
  - `limit` (optional, default 500, max 2000 -- 400 if exceeded)
  - `offset` (optional, default 0 -- 400 if negative)
- Returns `store.EventsResponse`: `events`, `total`, `limit`, `offset`,
  `has_more`. Full swaggo annotations on the handler.

`api/internal/store/events.go`
- `GetEvents(ctx, params) (*EventsResponse, error)`: builds a parameterized
  WHERE clause from the params. Runs a separate `SELECT COUNT(*)` for
  `total` and a paginated `SELECT` for `events`. All values are passed as
  parameters; no string interpolation.
- `EventsResponse` struct: `Events []Event`, `Total int`, `Limit int`,
  `Offset int`, `HasMore bool`.

`api/internal/handlers/directives.go` (extend Phase 3)
- `POST /v1/directives` now accepts `action="custom"`. Body may include
  `directive_name`, `fingerprint`, and `parameters`, packaged into the
  `payload` JSONB column on the `directives` row. Both flavor-wide and
  per-session targeting are supported and fan out via the existing
  `shutdown_flavor` mechanism (D058).

`api/internal/handlers/custom_directives.go` (new in Phase 4.5)
- `POST /v1/directives/sync`: receives a list of fingerprints from the
  sensor. Returns the list of fingerprints not present in
  `custom_directives`. For known fingerprints, bumps `last_seen_at`.
- `POST /v1/directives/register`: receives full schemas (fingerprint,
  name, description, flavor, parameters). Upserts into `custom_directives`
  on `(fingerprint)` conflict.
- `GET /v1/directives/custom?flavor=`: returns all known custom directives
  ordered by `registered_at DESC`. Optional `flavor` filter.
- All three handlers carry full swaggo annotations.

`api/internal/store/postgres.go` (extend)
- `SyncDirectives(ctx, fingerprints)`: lookup + `last_seen_at` bump in a
  single `pgx.BeginTx` transaction so the "which fingerprints are known"
  read and the bump update share one snapshot. Returns the fingerprints
  not present in `custom_directives`.
- `RegisterDirectives(ctx, directives)`: upserts each directive with
  `ON CONFLICT (fingerprint) DO UPDATE SET last_seen_at = NOW()` inside
  a single transaction. After the upserts and before commit, the same
  transaction issues `pg_notify('flightdeck_fleet', 'directive_registered')`
  so the dashboard WebSocket hub broadcasts a fleet update and the
  `Directives` page / FleetPanel sidebar refresh in real time when the
  sensor registers a brand new flavor's directives via `init()`.
- `CustomDirectiveExists(ctx, fingerprint, flavor)`: existence check
  used by `POST /v1/directives` to refuse `action="custom"` requests
  whose fingerprint is not registered. Empty `flavor` is treated as a
  wildcard so the same query works for both per-session and flavor-wide
  custom directive triggers. Without this check the dashboard could
  insert dangling directive rows that no sensor would execute.
- `GetCustomDirectives(ctx, flavor)`: list query with optional flavor
  filter.
- `CustomDirective` struct: id, fingerprint, name, description, flavor,
  parameters (JSONB), registered_at, last_seen_at.

`api/internal/server/server.go` (extend)
- New routes registered:
  - `POST /v1/directives/sync`
  - `POST /v1/directives/register`
  - `GET /v1/directives/custom`
  - `GET /v1/events`
- HTTP server `WriteTimeout` is intentionally not set so the long-lived
  WebSocket stream is not killed by a global write deadline. The WebSocket
  write pump applies its own per-message deadline. Other handlers are
  protected by request context deadlines plus the existing `ReadTimeout`
  (15s) and `IdleTimeout` (120s).

`api/internal/ws/hub.go` (WebSocket hub fix)
- When a `flightdeck_fleet` NOTIFY arrives and the subsequent
  `GetSession` lookup returns an error (e.g. session deleted between
  notify and read), the hub logs a warning and continues rather than
  exiting the listener loop.

### Data Model -- Custom Directives Table

`custom_directives` (added in migration 000004)

```sql
CREATE TABLE custom_directives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint   TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    JSONB,
    registered_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives(flavor);
CREATE INDEX custom_directives_fp_idx     ON custom_directives(fingerprint);
```

`directives.payload` JSONB column (added in migration 000005)
- Carries the parameter dict for `action="custom"` directives. NULL for
  built-in actions.

Migrations 000004 and 000005 are listed in the migrations table above.

### Dashboard -- Constants, Models, Provider Logos

`dashboard/src/lib/constants.ts`
Single source of truth for tunable magic numbers:

| Constant | Value | Purpose |
|---|---|---|
| `FEED_MAX_EVENTS` | 500 | Live feed display buffer cap, oldest dropped |
| `PAUSE_QUEUE_MAX_EVENTS` | 1000 | Pause queue cap, FIFO drop on overflow |
| `FEED_INITIAL_LOAD` | 100 | Initial fleet store load size |
| `FEED_MIN_HEIGHT` | 120 | Resize lower bound |
| `FEED_MAX_HEIGHT` | 600 | Resize upper bound |
| `FEED_DEFAULT_HEIGHT` | 240 | Initial feed height |
| `FEED_HEIGHT_STORAGE_KEY` | `flightdeck-feed-height` | localStorage key |
| `FEED_COL_WIDTHS_KEY` | `flightdeck-feed-col-widths` | Column widths key |
| `FEED_COL_DEFAULTS` | `{flavor:120, session:80, type:96, detail:400, time:80}` | Default column widths |
| `THEME_STORAGE_KEY` | `flightdeck-theme` | Theme persistence key |

> **Note:** the old fixed `LEFT_PANEL_WIDTH = 240` constant was
> removed when the swimlane left panel became resizable. See the
> "Phase 4.5 -- Subsequent Additions" section below for the full
> current constants table including the new `LEFT_PANEL_*` and
> `SESSION_ROW_HEIGHT` / `TIMELINE_WIDTH_PX` / `TIMELINE_RANGE_MS`
> entries.

`dashboard/src/lib/models.ts`
- `ANTHROPIC_MODELS: Set<string>` -- exact known Anthropic model IDs.
- `OPENAI_MODELS: Set<string>` -- exact known OpenAI model IDs.
- `getProvider(model): "anthropic" | "openai" | "unknown"` -- O(1) Set
  lookup with prefix fallback (`claude-`, `gpt-`, `o1`, `o3`, `o4`).
- This is the single source of truth for provider detection used by
  the policy degrade dropdown, PromptViewer, session drawer, live feed
  rows, and analytics legend.

`dashboard/src/components/ui/provider-logo.tsx`
- `ProviderLogo({ provider, size?, className? })`: renders the inline brand
  SVG for `anthropic`, `openai`, or a Lucide Sparkles icon for `unknown`.
  SVGs are inline -- never fetched. Brand colors are hardcoded (not CSS
  variables).

### Dashboard -- Live Feed and Pause Queue

`dashboard/src/lib/types.ts` (extend)
- `FeedEvent = { arrivedAt: number; event: AgentEvent }`. `arrivedAt` is
  the dashboard-local monotonic timestamp at WebSocket message receipt
  (via a counter in `Fleet.tsx` so same-millisecond events do not collide).
  See D067.

`dashboard/src/components/fleet/EventFilterBar.tsx`
- Single-select pill bar above the swimlane and live feed. Categories:
  All, LLM Calls, Tools, Policy, Directives, Session.
- Pills filter both swimlane circles (opacity-based hide preserves x
  position) and live feed rows simultaneously. See D065.

`dashboard/src/components/fleet/LiveFeed.tsx`
- Renders `FeedEvent[]` capped at `FEED_MAX_EVENTS` from the back, then
  optionally filtered by `activeFilter`.
- Columns: Flavor, Session, Type, Detail, Time. Default sort is `time desc`
  (newest first). Clicking any non-time column header changes the sort
  and auto-pauses the feed via `onPause()`.
- Display order is driven by `arrivedAt` (the FeedEvent field) so events
  always appear in the order the dashboard received them. The "Time"
  column shows `arrivedAt` formatted as wall-clock time.
- Column header row is `position: absolute` with `z-index: 10` to stay
  pinned above the scrollable rows.
- Header badge shows one of:
  - Live: `${filtered} of ${capped} events` when a filter is active,
    otherwise `${filtered} events`.
  - Paused (queue under cap): `Paused · ${queueLength} events waiting`
    in amber (`var(--status-idle)`).
  - Paused (queue at cap): `Paused · ${queueLength} events buffered
    (oldest dropped)` in orange (`var(--status-stale)`).
  - Catching up: `Catching up...` while a queue drain is in progress.
- "Return to live" button resets `sortCol` to `time`, `sortDir` to `desc`,
  and calls `onResume()`.
- Column widths and panel height are persisted to `localStorage` under
  `FEED_COL_WIDTHS_KEY` and `FEED_HEIGHT_STORAGE_KEY`. All rows are
  rendered directly (no virtualized window) -- this was simpler and
  faster in practice for the 500-event cap.

`dashboard/src/pages/Fleet.tsx` (extend)
- `pauseQueue: FeedEvent[]` state buffers WebSocket events when
  `isPaused` is true. New events are appended; if the queue length
  reaches `PAUSE_QUEUE_MAX_EVENTS` the oldest entry is dropped (FIFO).
- `pausedAt: Date | null` is set on pause and used to freeze the D3
  time scale.
- "Resume" handler: drains `pauseQueue` into `feedEvents` (FIFO) and
  shows a 500ms `catchingUp` flag for the visual fade.
- "Return to live" handler: discards `pauseQueue` entirely, snaps the
  time range back to live, clears `pausedAt`.
- See D068.

### Dashboard -- Session Drawer Mode 1 / Mode 2

`dashboard/src/components/session/SessionDrawer.tsx`
- Two modes:
  - **Mode 1** (default): session event list, token usage bar, Prompts tab.
  - **Mode 2**: single-event detail (back-button to Mode 1), Details tab
    and Prompts tab for the focused event.
- The active detail event is derived from props every render:
  `activeDetailEvent = directDismissed ? internalDetailEvent : (directEventDetail ?? internalDetailEvent)`.
- `directEventDetail` is set by the parent when the user clicks an event
  circle in the swimlane. `internalDetailEvent` is set by clicking
  "Open full detail" inside the drawer. `onClearDirectEvent` is called by
  the Back button so the parent knows the prop-fed event was dismissed.
- Mode is rendered directly from `activeDetailEvent` truthiness. The
  previous design copied props into state via `useEffect` and lost the
  race when `directEventDetail` arrived after the drawer opened.
  See D069.

### Dashboard -- Event Detail Drawer

`dashboard/src/components/fleet/EventDetailDrawer.tsx`
- Standalone right-slide drawer (520px) for a single event opened from
  the live feed (independent of `SessionDrawer`). Tabs: `details` and
  `prompts`. The Details tab shows a metadata grid plus the JSON
  payload. The Prompts tab loads `PromptViewer` if `event.has_content`,
  otherwise shows the capture-disabled message.

**Shared rendering between SessionDrawer Mode 2 and EventDetailDrawer**

Shared JSON rendering:
- `dashboard/src/components/ui/syntax-json.tsx` -- used by both
  `SessionDrawer` Mode 2 and `EventDetailDrawer` for JSON syntax
  highlighting.

Inline summary grid:
- Built directly inside `SessionDrawer` and `EventDetailDrawer` (not a
  separate component). Uses CSS grid `grid-cols-[140px_1fr]` with
  key/value rows per event type.

### Dashboard -- Bulk Historical Events Hook

`dashboard/src/hooks/useHistoricalEvents.ts`
- `useHistoricalEvents(timeRange) -> { events, loading, error, hasMore,
  total, loadMore }`. On mount and on every `timeRange` change, calls
  `fetchBulkEvents({ from, limit: 500, offset })` (which hits
  `GET /v1/events`) and returns the chronological list.
- Fleet.tsx groups the result by `session_id` to populate `eventsCache`
  and seeds `feedEvents` from the historical data so the live feed is
  not empty on page load. After the initial load, no per-session HTTP
  fetches happen -- WebSocket events flow into the same caches. See
  D066 and D071.

### Dashboard -- Directives Page

`dashboard/src/pages/Directives.tsx`
- Dedicated `/directives` page. Header + flavor `Select` + search input.
- Renders one `DirectiveCard` per known custom directive (loaded from
  `GET /v1/directives/custom`). Each card has expandable parameter
  details and a trigger form with target selector (session vs flavor),
  per-parameter inputs (string / int / float / bool / select), and a
  submit button that POSTs `/v1/directives` with `action="custom"`.

### Dashboard -- Fleet Panel Directive Activity

`dashboard/src/components/fleet/FleetPanel.tsx`
- New `DIRECTIVE ACTIVITY` section in the left sidebar. Shows the 5 most
  recent `directive` and `directive_result` events with a colored status
  dot (green for `directive_result`, purple for `directive`),
  flavor · truncated session id, and timestamp. Empty state:
  "No directive activity yet."

### Dashboard -- PromptViewer Redesign

`dashboard/src/components/session/PromptViewer.tsx`
- Header shows `ProviderLogo` next to the provider name and model.
- Each message is a card with a colored role badge (system gray, user
  indigo, assistant accent, tool cyan).
- Tools section renders one card per tool with name, description, and
  collapsible parameters.
- Response section has a `Pretty` / `Raw` toggle.
- Provider terminology is preserved exactly per Rule 20 -- no
  normalization between Anthropic and OpenAI shapes.

### Dashboard -- Performance Optimizations

- `SwimLane`, `SessionEventRow`, and `EventNode` are wrapped in
  `React.memo` with custom comparators that explicitly include
  `activeFilter`. The previous comparators omitted it, which caused new
  WebSocket events to bypass the active filter in the swimlane.
- Time scale updates use `requestAnimationFrame` throttling so the
  swimlane redraws at most once per frame instead of once per WebSocket
  message.
- `EventNode` opacity is driven by React state (`isVisible && mounted`)
  so the fade-in transition is reproducible. The previous design mutated
  the DOM directly, which overrode the visibility state.

### Dashboard -- Startup 502 Fix

`docker/docker-compose.dev.yml` and `docker/nginx/nginx.dev.conf`
- nginx now waits for the dashboard service to report `healthy` (via
  `depends_on: condition: service_healthy`) before serving traffic. This
  eliminates the brief startup window during which `make dev` returned
  502 from nginx because it was already up while the dashboard
  containers were still booting Vite.

---

## Phase 4.5 -- Subsequent Additions (post-merge audit pass)

This section consolidates everything added to Phase 4.5 after the
initial DECISIONS D059-D072 block: runtime context auto-collection,
the dashboard timeline + sidebar redesign that followed it, the
Claude Code plugin rewrite, and the final UI cleanup pass. See
DECISIONS.md D073-D079 for the rationale.

### Sensor -- Runtime Context Auto-Collection

`sensor/flightdeck_sensor/core/context.py` (new in this pass)
- Pluggable runtime-environment collector chain. The sensor calls
  `collect()` once at `init()` time and attaches the resulting
  dict to the `session_start` event payload via
  `Session.set_context()`.
- `ContextCollector` Protocol: `applies() -> bool`,
  `collect() -> dict[str, Any]`. Both must never raise.
- `BaseCollector` (default base): subclasses override `_gather()`
  only. `BaseCollector.collect()` wraps `_gather()` in a
  try/except. The top-level `collect()` orchestrator wraps each
  collector call in a *second* try/except. Two layers of
  protection mean a single broken collector cannot crash the
  sensor or block `init()`.
- Three collector phases:
  1. **`PROCESS_COLLECTORS`** -- `ProcessCollector` (pid,
     process_name), `OSCollector` (os, arch, hostname),
     `UserCollector`, `PythonCollector`, `GitCollector`. All
     run; results merge into the dict.
  2. **`ORCHESTRATION_COLLECTORS`** -- `KubernetesCollector`,
     `DockerComposeCollector`, `DockerCollector`,
     `AWSECSCollector`, `CloudRunCollector`. Run in priority
     order, **first match wins** (the loop breaks). This avoids
     ambiguous "kubernetes AND docker" results inside k8s pods
     that also have `/.dockerenv`.
  3. **`OTHER_COLLECTORS`** -- `FrameworkCollector`. Inspects
     `sys.modules` for known AI frameworks (crewai, langchain,
     llama_index, autogen, haystack, dspy, smolagents,
     pydantic_ai). It NEVER imports anything new -- if a
     framework was not loaded by the agent before `init()` ran,
     we do not claim it is in use.
- `GitCollector` shells out to `git` with a 500 ms `subprocess`
  timeout, strips embedded credentials from the remote URL via
  `re.sub(r"https?://[^@]+@", "https://", remote)`, and falls
  back silently when git is missing or the cwd is not a repo
  (the broad `except Exception` in `_run` also catches
  `FileNotFoundError` on Windows where `git.exe` may not be on
  PATH).

`sensor/flightdeck_sensor/core/session.py` (extend)
- `set_context(context: dict[str, Any]) -> None` -- called by
  `init()` after the collector chain runs and before
  `Session.start()` fires the `session_start` event. The context
  dict is included in the `session_start` payload's new
  `context` field. Subsequent events do not carry context (it is
  set-once on the worker side via `UpsertSession ON CONFLICT`
  deliberately omitting `context`).

`sensor/flightdeck_sensor/__init__.py` (extend)
- `init()` invokes `_collect_context()` from `core/context` and
  passes the result into `session.set_context()` before
  `session.start()`. Failures in collect() are caught and
  default to an empty dict.
- **KI15**: the `_session` and `_directive_registry` module-level
  globals make the sensor a process-wide singleton. The second
  `init()` call in any thread is a no-op with a warning. Pattern B
  (one init per thread, isolated Sessions) and Pattern C (multiple
  agents in one process, each with its own Session) are NOT
  supported in v1. Resolution requires an architectural decision
  (Session-handle API change, per-thread storage, or per-flavor
  map). Tracked for Phase 5; see `KNOWN_ISSUES.md` and D086.
  `tests/integration/test_sensor_e2e.py::test_pattern_c_ki15_singleton_limitation`
  documents the current behaviour and will fail loudly when KI15 is
  resolved, signalling that the test should be updated.

### Sensor → Ingestion -- session_start payload extension

The `POST /v1/events` payload for `event_type="session_start"`
events now includes an optional top-level `context` field:

```json
{
  "session_id":   "uuid",
  "flavor":       "research-agent",
  "agent_type":   "autonomous",
  "event_type":   "session_start",
  ...
  "context": {
    "hostname":       "k8s-prod-1",
    "user":           "ci-runner",
    "pid":            12345,
    "process_name":   "python",
    "os":             "Linux",
    "arch":           "x86_64",
    "python_version": "3.12.3",
    "git_commit":     "abc1234",
    "git_branch":     "main",
    "git_repo":       "demo-app",
    "orchestration":  "kubernetes",
    "k8s_namespace":  "agents",
    "k8s_node":       "node-1",
    "k8s_pod":        "research-1",
    "frameworks":     ["langchain/0.1.12"]
  }
}
```

The field is omitted on every other event_type. The worker
parses it via `consumer.EventPayload.Context map[string]any` and
forwards it to `UpsertSession`, which writes it once to
`sessions.context` and never updates it on conflict. Set-once
semantics: whatever the agent saw at startup is the canonical
record for that session.

### API -- Bulk events transaction + WriteTimeout / withRESTTimeout

`api/internal/store/events.go` (clarification)
- `GetEvents` runs the COUNT and SELECT inside a single
  `pgx.BeginTx` with `pgx.TxIsoLevel("repeatable read")`. Without
  the explicit isolation level, a worker INSERT between the
  COUNT and SELECT could leave `total` stale relative to
  `events`, breaking pagination math (`offset + len(events) >
  total`). Repeatable read pins both reads to the same snapshot.

`api/internal/server/server.go` (extend)
- `withRESTTimeout` middleware: wraps every REST handler in a
  `context.WithTimeout(15s)` so a slow store query cannot hold
  an HTTP goroutine forever. The WebSocket route `/v1/stream` is
  deliberately registered WITHOUT this wrapper -- the WebSocket
  pump runs for the lifetime of a client connection and applies
  its own per-message write deadline.
- `auth.Middleware(validator, ...)` is applied only to
  `POST /v1/directives/sync` and `POST /v1/directives/register`
  (the two sensor-facing custom-directive endpoints). Every
  other endpoint remains unauthenticated -- this is the D073
  stopgap until full Phase 5 JWT auth lands. The middleware
  reuses the same SHA-256 lookup against `api_tokens` that
  ingestion uses, so the sensor's existing token works without
  any extra plumbing.

### API -- GetContextFacets aggregation

`api/internal/store/postgres.go` (extend)
- `GetContextFacets(ctx)` runs:
  ```sql
  SELECT key, value, COUNT(*) AS count
  FROM sessions, jsonb_each_text(context)
  WHERE state IN ('active', 'idle', 'stale')
    AND context != '{}'::jsonb
  GROUP BY key, value
  ORDER BY key ASC, count DESC
  ```
- Returns `map[string][]ContextFacetValue` keyed by context
  field name. Empty context dicts are excluded so they do not
  pollute the facet groups with `{}` entries.
- `ContextFacetValue struct { Value string; Count int }`.

`api/internal/handlers/fleet.go`
- `GetContextFacets()` is invoked from the fleet handler. A
  failure logs a warning and returns an empty map rather than
  failing the entire `GET /v1/fleet` response -- the CONTEXT
  sidebar is best-effort UX, not a load-bearing fleet feature.

### Database -- migration 000006

`docker/postgres/migrations/000006_add_context_to_sessions.{up,down}.sql`
- Adds `context JSONB NOT NULL DEFAULT '{}'::jsonb` to
  `sessions` and `CREATE INDEX sessions_context_gin ON sessions
  USING GIN (context)` for the facet aggregation query.
- Down migration drops both.
- Listed in the migrations table at the top of this document.

### Dashboard -- constants.ts (extended table)

The complete current table:

| Constant | Value | Purpose |
|---|---|---|
| `FEED_MAX_EVENTS` | 500 | Live feed display buffer cap |
| `PAUSE_QUEUE_MAX_EVENTS` | 1000 | Pause queue cap |
| `FEED_INITIAL_LOAD` | 100 | Initial fleet store load size |
| `FEED_MIN_HEIGHT` | 120 | Live feed resize lower bound |
| `FEED_MAX_HEIGHT` | 600 | Live feed resize upper bound |
| `FEED_DEFAULT_HEIGHT` | 240 | Initial feed height |
| `FEED_HEIGHT_STORAGE_KEY` | `flightdeck-feed-height` | localStorage key |
| `FEED_COL_WIDTHS_KEY` | `flightdeck-feed-col-widths` | Column widths key |
| `FEED_COL_DEFAULTS` | `{flavor:120, session:80, type:96, detail:400, time:80}` | Default column widths |
| `LEFT_PANEL_MIN_WIDTH` | 200 | Resizable swimlane left panel lower bound |
| `LEFT_PANEL_MAX_WIDTH` | 500 | Upper bound |
| `LEFT_PANEL_DEFAULT_WIDTH` | 320 | Initial width if no localStorage value |
| `LEFT_PANEL_WIDTH_KEY` | `flightdeck-left-panel-width` | localStorage key |
| `SESSION_ROW_HEIGHT` | 48 | Two-line session row height (hostname + hash) |
| `TIMELINE_WIDTH_PX` | 900 | Fixed event-circles canvas width |
| `TIMELINE_RANGE_MS` | `{1m: 60_000, 5m: 300_000, 15m: 900_000, 30m: 1_800_000, 1h: 3_600_000}` | Range labels → ms |
| `THEME_STORAGE_KEY` | `flightdeck-theme` | Theme persistence key |

The previous fixed `LEFT_PANEL_WIDTH = 240` is removed entirely.
Every Timeline / SwimLane / SessionEventRow consumer reads the
resizable state via Timeline.tsx's `leftPanelWidth` prop.

### Dashboard -- OS and orchestration icons

`dashboard/src/components/ui/OSIcon.tsx`
- Renders one of three glyphs based on `session.context.os`:
  Darwin, Linux, Windows. Returns `null` for unknown / missing
  values so callers can render unconditionally.
- Darwin and Linux use the official brand SVG paths from the
  `simple-icons` npm package (devDependency). Windows is NOT in
  simple-icons (Microsoft trademark removal), so it falls back
  to a hand-crafted 4-square grid at viewBox 14x14.
- A shared `SimpleIconSvg` helper exported from this file
  renders simple-icons paths at viewBox 24x24 with a `<title>`
  for accessibility. `OrchestrationIcon` reuses it.
- Color overrides: Apple uses `#909090` (siApple.hex is
  `#000000`, invisible on dark backgrounds). Linux uses
  `#E8914A` (Tux orange). Windows uses `#0078D4`.

`dashboard/src/components/ui/OrchestrationIcon.tsx`
- Renders one of five glyphs based on
  `session.context.orchestration`: kubernetes, docker,
  docker-compose (reuses Docker glyph), aws-ecs, cloud-run.
  Returns `null` for unknown / missing values.
- Kubernetes, Docker, Google Cloud (used as the closest fit for
  Cloud Run since simple-icons has no standalone Cloud Run
  entry) use simple-icons paths.
- AWS ECS is NOT in simple-icons, so it falls back to a
  hand-crafted hexagon at viewBox 14x14.
- Exports `getOrchestrationLabel(orchestration)` and
  `ORCHESTRATION_LABELS` for tooltip text mapping.

`package.json`
- New devDependency: `simple-icons@^16.15.0`.

### Dashboard -- Resizable Timeline left panel

`dashboard/src/components/timeline/Timeline.tsx` (extend)
- `leftPanelWidth: number` state initialised from
  `localStorage[LEFT_PANEL_WIDTH_KEY]` clamped to
  `[LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH]`. Default is
  `LEFT_PANEL_DEFAULT_WIDTH` (320).
- A 6px-wide drag handle is rendered absolutely on the right
  edge of the time-axis row's sticky left spacer. The time-axis
  row is `position: sticky; top: 0` against Fleet.tsx's outer
  scroller, so the handle stays visible regardless of vertical
  scroll position. Hover paints `var(--accent)`. Mouse drag
  attaches `mousemove` + `mouseup` handlers to `document` and
  clamps the new width on every move; the resulting width is
  written to localStorage on every drag update.
- `leftPanelWidth` flows down as a prop through `SwimLane` →
  `SessionEventRow`. Both components include `leftPanelWidth`
  in their `React.memo` comparators so a drag invalidates every
  row immediately.

### Dashboard -- Timeline fixed width and time labels

`dashboard/src/lib/constants.ts`
- `TIMELINE_WIDTH_PX = 900`. The xScale maps the selected range
  domain to `[0, 900]` for every time range. Wider ranges
  produce denser circles, which is the correct trade-off:
  fixed pixel space, no horizontal scrollbar, label intervals
  adapt to the range. The previous proportional-width approach
  grew the canvas to 54,000px at 1h and 324,000px at 6h, which
  forced horizontal scroll, broke sticky-left layouts, and made
  historical views unusable. See D076.

`dashboard/src/components/timeline/TimeAxis.tsx`
- Renders 6 evenly-spaced relative labels (e.g. `48s 36s 24s
  12s now` for a 1-minute range) at fractions
  `[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]`. The `formatRelativeLabel(ms)`
  helper picks the unit suffix: `s`, `m`, or `h`. No D3 tick
  generation -- it broke at large widths (zero ticks at 6h).
  See D077.

`dashboard/src/components/timeline/Timeline.tsx`
- Vertical grid line overlay: 6 thin vertical lines at the same
  fractions as the time-axis labels, dropping from the top of
  the inner content div to the bottom of the last flavor row.
  The rightmost line is highlighted as the "now" line in
  `var(--accent)`; the rest are `var(--border)` at low opacity.
  Constrained to the right-panel area only (`left:
  leftPanelWidth, width: timelineWidth`) so the resizable label
  column stays clean. zIndex 1; EventNode circles use zIndex 2
  so they paint above the grid lines.

### Dashboard -- Bars mode removed

`dashboard/src/pages/Fleet.tsx`
- The `ViewMode` type is now a single literal `"swimlane"`. The
  view-mode toggle buttons are gone from the fleet header. The
  `BarView.tsx` component and the aggregated bar render path in
  SwimLane.tsx are deleted entirely. Timeline / SwimLane /
  SessionEventRow no longer accept a `viewMode` prop.
- Rationale: at the fixed 900px canvas width the stacked
  histogram conveyed no information beyond the swimlane dots
  and added UI complexity for no operational value. See D075.

### Dashboard -- Custom Directives sidebar removed

`dashboard/src/components/fleet/FleetPanel.tsx`
- The `<DirectivesPanel>` child wrapper that previously rendered
  inside the sidebar is gone. Its empty state was developer
  documentation ("decorate a function with
  `@flightdeck_sensor.directive()` and call init() to register
  one"), not operational UI. See D079.
- The DIRECTIVE ACTIVITY section now hides BOTH its header and
  body when the recent-activity buffer is empty -- no more
  "No directive activity yet" placeholder.
- Per-flavor `Directives` icon button: appears alongside the
  `Stop All` icon button when a flavor has registered custom
  directives. Both buttons are icon-only (Zap and OctagonX from
  lucide-react) so they don't push the flavor name to truncate
  at the 240px sidebar width. Clicking opens a Dialog with one
  `DirectiveCard` per directive, each configured to fan out via
  the existing `shutdown_flavor` mechanism but with
  `action="custom"` instead.

### Dashboard -- Directives tab in SessionDrawer

`dashboard/src/components/session/SessionDrawer.tsx` (extend)
- New `"directives"` value in the `DrawerTab` union. The tab
  button is conditionally rendered based on
  `flavorDirectives.length > 0` -- where `flavorDirectives` is
  derived from the fleet store's `customDirectives` slice
  filtered by the session's flavor. Sessions whose flavor has
  no registered directives never see the tab.
- Tab content renders one `DirectiveCard` per directive with
  `sessionId={session.session_id}` so the trigger targets only
  that single session. The same `DirectiveCard` component is
  shared with the FleetPanel flavor-row dialog (which passes
  `flavor` instead of `sessionId` for the fan-out path).

`dashboard/src/components/directives/DirectiveCard.tsx`
- Shared component used by both the session drawer Directives
  tab and the FleetPanel flavor-row dialog. Renders the
  directive name, description, parameter inputs (string /
  integer / float / boolean / select via Radix Select), and a
  Run button. The button targets either a single session
  (`sessionId` prop) or every active+idle session of a flavor
  (`flavor` prop). Mutually exclusive: the session drawer never
  passes `flavor` and the FleetPanel never passes `sessionId`.

### Dashboard -- Fleet sort and live counts

`dashboard/src/pages/Fleet.tsx`
- `sortFlavorsByActivity(flavors)` -- exported pure function.
  Sorts flavors by activity priority so flavors with active or
  idle sessions float to the top of the swimlane and stale /
  closed / lost ones sink to the bottom. Stable secondary order
  is alphabetical. Re-sorts automatically on every flavors
  update via a `useMemo`.
- `sessionStateCounts` is computed via `useMemo` from the live
  `flavors` array on every render and passed down to
  `FleetPanel.SessionStateBar` as a prop. The previous design
  recomputed counts inside `SessionStateBar` itself, which
  could leave stale counts on screen between WebSocket updates
  if `SessionStateBar` was memoized but the parent re-rendered
  for an unrelated reason.

### Dashboard -- Fleet Panel directive auto-refresh

`dashboard/src/store/fleet.ts` (extend)
- `applyUpdate(update: FleetUpdate)` snapshots whether the
  session's flavor is already in the store BEFORE mutating
  flavors. If `update.type === "session_start"` and the flavor
  is new, the store fires `fetchCustomDirectives()` and
  patches the result into the `customDirectives` slice. The
  new `FlavorItem` picks up the resulting Directives icon
  button automatically because `FleetPanel` reads
  `customDirectives` via a `useFleetStore` selector. Best-effort
  -- failures are swallowed.
- Triggered specifically when a new agent comes online via
  WebSocket: that's the moment a sensor has just registered new
  custom directives via `init()`. Without this hook, newly
  registered directives only appeared after a manual page
  refresh.

### Plugin -- Claude Code observe_cli rewrite

`plugin/hooks/scripts/observe_cli.mjs` (rewritten in this pass)
- **Stable session ID**: `getSessionId()` prefers
  `CLAUDE_SESSION_ID` env var, then
  `ANTHROPIC_CLAUDE_SESSION_ID`, then a file-based id under
  `tmpdir/flightdeck-plugin/session-${sha256(cwd)[:16]}.txt`.
  The file fallback exists because every hook invocation runs
  as a separate Node child process spawned by Claude Code --
  pid-based fallbacks would create one session row per tool
  call. Different cwds get different sessions.
- **session_start with context**: `ensureSessionStarted()`
  uses a file-marker dedup so the session_start event is sent
  exactly once per session id (marker file is
  `tmpdir/flightdeck-plugin/started-${sessionId}.txt`). The
  payload carries the `collectContext()` dict, which the
  worker stores in `sessions.context`.
- `collectContext()` (Node.js parallel of the Python sensor's
  `context.py`): pid, process_name, os (Windows / Darwin /
  Linux), arch, hostname, user, node_version, working_dir,
  git_commit / git_branch / git_repo (each in its own
  try/catch with a 500ms execSync timeout, credential-stripped
  remote URL), and orchestration detection (kubernetes >
  docker-compose). Each probe is independently best-effort.
- `sanitizeToolInput(input)` -- whitelist that keeps ONLY
  these fields from the hook event's tool_input:
  `file_path`, `command` (truncated to 200 chars), `query`,
  `pattern`, `prompt` (truncated to 100 chars). Everything
  else (content, message bodies, sub-agent contexts) is
  dropped. Returns `null` if no whitelisted field was present.
- `is_subagent_call: toolName === "Task"` -- emitted on the
  wire so the dashboard can later distinguish sub-agent spawns
  from regular tool calls. Currently informational only; the
  worker drops the field at the boundary because no DB column
  exists.
- `latency_ms` is populated for `PostToolUse` events as
  `Date.now() - startTime`, where startTime is stamped at
  hook script invocation. This is hook PROCESSING time, not
  actual tool execution time -- Claude Code does not expose
  tool start/end timestamps to hooks. Documented in a
  comment.
- `main()` returns naturally instead of calling
  `process.exit(0)`. Two consecutive fetches in a single
  script invocation crash Node on Windows with
  STATUS_STACK_BUFFER_OVERRUN (`0xC0000409`) if `process.exit`
  fires while undici is mid-cleanup; letting `main()` return
  lets the connection pool drain.

---

## Deployment

### Docker Compose

```
docker/
├── docker-compose.yml
├── docker-compose.dev.yml
└── docker-compose.prod.yml
```

Services: nginx, postgres, nats, ingestion, workers, api, dashboard (dev only)

One command: `make dev`. Dashboard at `http://localhost:4000`.

### Kubernetes Helm Chart

```yaml
# values.yaml (key fields)
flightdeck:
  agents:
    flavor: ""
    type: "autonomous"
  unavailablePolicy: "continue"
  capturePrompts: false           # opt-in, off by default

ingestion:
  replicas: 2

workers:
  replicas: 2

api:
  replicas: 2
  auth:
    enabled: true
    jwtSecret: ""
    adminEmail: ""
    adminPassword: ""

nats:
  enabled: true
  jetstream:
    enabled: true
    fileStore:
      size: "10Gi"

postgres:
  enabled: true
  externalUrl: ""
```

---

## Environment Variables

### Ingestion API

| Variable | Default | Description |
|---|---|---|
| `FLIGHTDECK_PORT` | `8080` | HTTP listen port |
| `FLIGHTDECK_POSTGRES_URL` | required | Postgres DSN |
| `FLIGHTDECK_NATS_URL` | `nats://nats:4222` | NATS server URL |
| `FLIGHTDECK_ENV` | `development` | `development` or `production` |
| `SHUTDOWN_TIMEOUT_SECS` | `30` | Graceful shutdown timeout |

### Go Workers

| Variable | Default | Description |
|---|---|---|
| `FLIGHTDECK_POSTGRES_URL` | required | Postgres DSN |
| `FLIGHTDECK_NATS_URL` | `nats://nats:4222` | NATS server URL |
| `FLIGHTDECK_WORKER_POOL_SIZE` | `10` | NATS consumer goroutines |
| `SHUTDOWN_TIMEOUT_SECS` | `30` | Graceful shutdown timeout |

### Query API

| Variable | Default | Description |
|---|---|---|
| `FLIGHTDECK_PORT` | `8081` | HTTP listen port |
| `FLIGHTDECK_POSTGRES_URL` | required | Postgres DSN |
| `FLIGHTDECK_ENV` | `development` | `development` disables auth |
| `FLIGHTDECK_JWT_SECRET` | required in prod | JWT signing key |
| `FLIGHTDECK_ADMIN_EMAIL` | required in prod | Admin email |
| `FLIGHTDECK_ADMIN_PASSWORD` | required in prod | Admin password (hashed in memory) |
| `SHUTDOWN_TIMEOUT_SECS` | `30` | Graceful shutdown timeout |

### flightdeck-sensor (agent environment)

| Variable | Default | Description |
|---|---|---|
| `AGENT_FLAVOR` | `unknown` | Persistent identity (set via Helm values.yaml) |
| `AGENT_TYPE` | `autonomous` | Classification (set via Helm values.yaml) |
| `FLIGHTDECK_SERVER` | none | Control plane URL (alt to init() param) |
| `FLIGHTDECK_TOKEN` | none | Auth token (alt to init() param) |
| `FLIGHTDECK_UNAVAILABLE_POLICY` | `continue` | `continue` or `halt` |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `false` | `true` to enable prompt capture |

### Postgres

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | `flightdeck` | Superuser name |
| `POSTGRES_PASSWORD` | required | Superuser password |
| `POSTGRES_DB` | `flightdeck` | Database name |
| `POSTGRES_HOST` | `postgres` | Hostname |
| `POSTGRES_PORT` | `5432` | Port |

---

## Health Checks

| Service | Endpoint | Response |
|---|---|---|
| Ingestion API | `GET http://localhost:8080/health` | `{"status":"ok","service":"ingestion"}` |
| Query API | `GET http://localhost:8081/health` | `{"status":"ok","service":"api"}` |
| Postgres | `pg_isready -U flightdeck` | exit 0 |
| NATS | `nats server ping` | exit 0 |

---

## Makefile Structure

### Root `Makefile`

```makefile
.PHONY: build test test-integration lint dev dev-reset down logs release help

help:              ## Show this help
build:             ## Build all components
test:              ## Run all unit tests
test-integration:  ## Run full pipeline integration tests
lint:              ## Lint all components
dev:               ## Start full local dev environment
dev-reset:         ## Wipe all volumes and restart
down:              ## Stop local dev environment
logs:              ## Tail logs from all services
release:           ## Tag and push release
```

### Per-component Makefiles

All follow the same pattern:

```makefile
# sensor/Makefile
install build test lint clean

# ingestion/Makefile, workers/Makefile, api/Makefile
build run test lint clean

# dashboard/Makefile
install build run test test-e2e lint clean

# docker/Makefile
dev dev-reset down logs ps build
```

---

## Testing Strategy

### Unit tests

| Component | Runner | Command |
|---|---|---|
| flightdeck-sensor | pytest | `make -C sensor test` |
| Ingestion API | go test | `make -C ingestion test` |
| Go Workers | go test | `make -C workers test` |
| Query API | go test | `make -C api test` |
| Dashboard | Vitest | `make -C dashboard test` |

### Integration tests

```
tests/integration/
├── test_pipeline.py         # Full event pipeline end-to-end
├── test_enforcement.py      # Token enforcement thresholds
├── test_killswitch.py       # Single agent + fleet-wide kill
├── test_directives.py       # /v1/directives/{sync,register,custom}, fan-out, auth
├── test_session_states.py   # State transitions (active, closed)
├── test_prompt_capture.py   # Content stored when on, not stored when off
├── test_search.py           # GET /v1/search across agents/sessions/events
├── test_analytics.py        # GROUP BY queries return correct aggregates
├── test_sensor_e2e.py       # REAL flightdeck_sensor against live stack (12 base + 8 multithreading)
└── test_ui_demo.py          # Manual data-population tool, NOT part of CI (see below)
```

Run: `make test-integration`. The target invokes
`pytest -m "not manual" ...` so any test marked
`@pytest.mark.manual` is excluded from automated runs. The only
manual-marked test today is `test_ui_demo.py`, which generates
3 minutes of realistic dashboard traffic for screen recordings;
run it explicitly with
`pytest tests/integration/test_ui_demo.py -v -s` (Phase 4.5
audit Task 1).

### Sensor end-to-end tests

`tests/integration/test_sensor_e2e.py` is the only file in
`tests/integration/` that exercises the REAL `flightdeck_sensor`
library against the live `make dev` stack. Provider HTTP
(`api.anthropic.com` / `api.openai.com`) is mocked with
`respx`; everything else (sensor → ingestion → NATS → workers
→ Postgres → query API) runs for real. Run in isolation via
`make test-e2e` so a regression in the e2e harness shows up as
its own failed CI step.

The 20 tests cover four real-world deployment patterns:

| Pattern | Description | Tests |
|---|---|---|
| **A — Single-threaded agent** | One `init()`, one thread, sequential LLM calls | `test_sensor_anthropic_full_pipeline`, `test_sensor_openai_full_pipeline`, `test_sensor_capture_prompts_true`, `test_sensor_custom_directive_registered_and_triggered`, `test_sensor_shutdown_directive_delivered`, `test_sensor_degrade_directive_via_policy_threshold`, `test_sensor_server_policy_warn_fires_directive`, `test_sensor_custom_directive_unknown_fingerprint`, `test_sensor_flavor_fanout_directive`, `test_sensor_context_collected_at_init`, `test_sensor_unavailable_continue`, `test_context_facets_aggregation`, `test_pattern_a_shutdown_single_threaded` |
| **B — Multithreaded agent** | One `init()`, multiple threads sharing one patched client (web servers, async frameworks) | `test_pattern_b_concurrent_calls_no_data_loss`, `test_pattern_b_custom_directive_during_traffic`, `test_pattern_b_shutdown_during_traffic`, `test_pattern_b_degrade_seen_by_all_threads`, `test_slow_handler_does_not_block_event_throughput` (the critical B-H regression test) |
| **C — One init() per thread** | Each thread tries to call `init()` independently. Currently NOT supported -- KI15. | `test_pattern_c_ki15_singleton_limitation` (documents the limitation, asserts that the second init is a no-op) |
| **D — Long-running agent receiving directives mid-flight** | Custom directive ordering against shutdown | `test_pattern_d_custom_then_shutdown_ordering` |

`test_slow_handler_does_not_block_event_throughput` is the
direct proof that the two-queue B-H refactor is in place: it
holds a custom directive handler on a `threading.Event` and
asserts that 5 LLM call events from another thread land in the
DB *before* the handler is released. Under the pre-B-H
architecture (drain thread executing `_apply_directive` inline)
this test would fail with up to 5 lost events.

### End-to-end (Playwright)

```
dashboard/tests/e2e/
├── fleet.spec.ts
├── search.spec.ts
├── killswitch.spec.ts
└── analytics.spec.ts   # Dimension switching, time range, chart updates
```

Run: `make -C dashboard test-e2e`

---

## Phase Plan

---

### Phase 1 -- Core pipeline and fleet visibility (v0.1)

**Goal:** An engineer adds two lines to their agent, runs `make dev`, and sees
their agent appear in the live dashboard timeline in real time.

> **For Claude Code:** Do not implement anything from Phase 2 or later during
> this phase. If a task bleeds into policy enforcement, directives, kill switch,
> analytics, or prompt capture, stop and raise it with the Supervisor.

**Deliverables -- Repo documentation (create before any code is merged):**

`METHODOLOGY.md`
- Full writeup of the Supervisor/Executor methodology used to build this project
- Mirrors the structure of AI Ranger's METHODOLOGY.md
- Three roles table, external memory section, two loops, prompt examples, audit prompt

`CONTRIBUTING.md`
- How to set up the development environment
- How to run tests per component
- Commit message convention (conventional commits)
- PR process and branch naming
- How to add a new agent framework integration to the sensor

`RELEASING.md`
- Step-by-step guide for cutting a release
- How to bump the sensor version in pyproject.toml
- How to tag and push (triggers CI release pipeline)
- What the release pipeline does automatically
- How to verify the PyPI publish succeeded

`CHANGELOG.md`
- v0.0.1 entry: PyPI stub reservation
- v0.1.0 entry: Phase 1 deliverables (filled in when Phase 1 ships)

**Deliverables -- Release pipeline:**

`.github/workflows/release.yml`
- Triggers on version tag push (`v*.*.*`)
- Job 1 -- publish sensor to PyPI:
  - Uses OIDC trusted publishing (no stored API key)
  - PyPI project owner: pykul account
  - Builds with `python -m build`, uploads with twine
  - Only runs when tag is on main branch
- Job 2 -- build and push Docker images:
  - Builds ingestion, workers, api, dashboard Dockerfiles
  - Pushes to Docker Hub under `flightdeckhq/flightdeck-ingestion`,
    `flightdeckhq/flightdeck-workers`, `flightdeckhq/flightdeck-api`,
    `flightdeckhq/flightdeck-dashboard`
  - Tags: `latest` and the version tag (e.g. `v0.1.0`)
  - Uses `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets
- Job 3 -- create GitHub release:
  - Auto-generates release notes from commits since previous tag
  - Attaches nothing (binaries are on PyPI and Docker Hub)

`scripts/release.sh`
- Validates working tree is clean
- Confirms current branch is main
- Prompts for version (e.g. `v0.1.0`)
- Updates `version` in `sensor/pyproject.toml`
- Commits the version bump: `chore: release v0.1.0`
- Creates and pushes the tag
- Pushing the tag triggers `.github/workflows/release.yml`

`docker/docker-compose.yml` (update)
- Image references use `flightdeckhq/flightdeck-*:latest` so users can
  `make dev` without building from source after images are published

**Deliverables -- already listed (carry forward):**

`sensor/flightdeck_sensor/core/types.py`
- `SessionState` enum: ACTIVE, IDLE, STALE, CLOSED, LOST
- `EventType` enum: SESSION_START, SESSION_END, HEARTBEAT, PRE_CALL, POST_CALL, TOOL_CALL, POLICY_WARN
  - POLICY_WARN events carry a `source` field: `"local"` (from init() limit) or `"server"` (from server policy)
- `DirectiveAction` enum: SHUTDOWN, SHUTDOWN_FLAVOR, DEGRADE, THROTTLE, POLICY_UPDATE, CHECKPOINT
- `SensorConfig` dataclass: server, token, capture_prompts (False), unavailable_policy ("continue"), agent_flavor, agent_type, session_id
- `TokenUsage` dataclass: input_tokens, output_tokens, total property
- `StatusResponse` dataclass: session_id, flavor, agent_type, state, tokens_used, token_limit, pct_used

`sensor/flightdeck_sensor/core/exceptions.py`
- `BudgetExceededError`: carries session_id, tokens_used, token_limit
- `DirectiveError`: carries action, reason -- raised when halt policy and CP unreachable
- `ConfigurationError`: invalid init() arguments

`sensor/flightdeck_sensor/core/session.py`
- `Session` class: holds SensorConfig, manages session lifecycle
- `start()`: fires SESSION_START event, registers handlers, fetches policy
- `end()`: fires SESSION_END event, flushes event queue
- `_register_handlers()`: registers atexit + SIGTERM + SIGINT handlers

`sensor/flightdeck_sensor/core/policy.py`
- `PolicyCache` class: holds token_limit, warn_at_pct, degrade_at_pct, block_at_pct, degrade_to
- `check(tokens_used, estimated)`: returns PolicyResult with decision and source fields. Source is `"local"` for init() limit thresholds, `"server"` for control plane policy thresholds.
- `update(policy_dict)`: replace cache from directive payload
- `fire_once` tracking: WARN fires once per session, not on every call after threshold

`sensor/flightdeck_sensor/transport/client.py`
- `ControlPlaneClient` class
- `post_event(payload: dict) -> Directive | None`: HTTP POST to /v1/events, parses response envelope
- On connectivity failure + policy=continue: logs warning, returns None
- On connectivity failure + policy=halt: raises DirectiveError

`sensor/flightdeck_sensor/transport/retry.py`
- `with_retry(fn, max_attempts=3, backoff_base=0.5)`: exponential backoff for transient failures

`sensor/flightdeck_sensor/providers/protocol.py`
- `Provider` Protocol: `estimate_tokens()`, `extract_usage()`, `extract_content()`, `get_model()`
- `PromptContent` dataclass: system, messages, tools, response, provider, model, session_id, event_id, captured_at

`sensor/flightdeck_sensor/providers/anthropic.py`
- `AnthropicProvider`: implements Provider Protocol
- `estimate_tokens()`: uses anthropic SDK count_tokens if available, falls back to char//4
- `extract_usage()`: reads response.usage.input_tokens, output_tokens, cache fields
- `extract_content()`: returns None in Phase 1 (capture_prompts always False in Phase 1)
- `get_model()`: reads request_kwargs["model"]

`sensor/flightdeck_sensor/providers/openai.py`
- `OpenAIProvider`: implements Provider Protocol
- `estimate_tokens()`: uses tiktoken if installed, falls back to char//4
- `extract_usage()`: reads response.usage.prompt_tokens, completion_tokens
- `extract_content()`: returns None in Phase 1
- `get_model()`: reads request_kwargs["model"]

`sensor/flightdeck_sensor/interceptor/base.py`
- `call(real_fn, kwargs, session, provider) -> Any`: sync intercept
- `call_async(real_fn, kwargs, session, provider) -> Any`: async intercept
- `call_stream(real_fn, kwargs, session, provider) -> GuardedStream`: streaming intercept
- `GuardedStream`: context manager, reconciles on exit including early exit
- Pre-call: estimate, check PolicyCache, fire WARN/DEGRADE if needed
- Post-call: extract actual usage, reconcile, POST post_call event

`sensor/flightdeck_sensor/interceptor/anthropic.py`
- `GuardedMessages`: proxy for messages resource, intercepts create() and stream()
- `GuardedAnthropic`: proxy for Anthropic/AsyncAnthropic clients
- `.messages` as `@property` returning `GuardedMessages`
- `with_options()`, `with_raw_response`, `with_streaming_response` all return new `GuardedAnthropic`
- `__getattr__` passes everything else through

`sensor/flightdeck_sensor/interceptor/openai.py`
- `GuardedCompletions`, `GuardedChat`, `GuardedOpenAI`: same proxy pattern for OpenAI
- Streaming: inject `stream_options={"include_usage": True}` when `stream=True`

`sensor/flightdeck_sensor/__init__.py`
- `init(server, token, capture_prompts=False, limit=None, warn_at=0.8, quiet=False)`: creates global Session and ControlPlaneClient
- `wrap(client, quiet=False)`: wraps Anthropic or OpenAI client
- `patch(quiet=False, providers=None)`: monkey-patches SDK constructors
- `unpatch()`: reverses all patches
- `get_status() -> StatusResponse`
- `teardown()`: fires session_end, closes transport, resets global state
- All symbols in `__all__`

`sensor/pyproject.toml`
- Optional deps: `[anthropic]`, `[openai]` (includes tiktoken), `[dev]`
- Zero required deps beyond Python 3.9+

`sensor/Makefile`
- `install`, `build`, `test`, `lint`, `clean` targets

`sensor/tests/unit/test_session.py`
- Session start fires SESSION_START event
- Session end fires SESSION_END event
- atexit handler fires session_end on clean process exit
- SIGTERM handler fires session_end

`sensor/tests/unit/test_policy.py`
- WARN fires at configured pct, fires only once per session
- DEGRADE swaps model in call_kwargs copy, never mutates original
- BLOCK raises BudgetExceededError before call is made
- PolicyCache update() replaces all fields atomically

`sensor/tests/unit/test_interceptor.py`
- BLOCK raises BudgetExceededError before real_fn is called (verified with mock)
- DEGRADE swaps model, original kwargs not mutated
- Post-call reconciliation uses force path, never rejects
- Streaming: pre-call check runs before context manager is returned
- Streaming: token reconciliation runs on __exit__ including early exit

`sensor/tests/unit/test_transport.py`
- Successful POST returns None directive when envelope is null
- Successful POST returns Directive when envelope contains one
- Connectivity failure + continue policy: returns None, no exception
- Connectivity failure + halt policy: raises DirectiveError

`sensor/tests/unit/test_providers.py`
- Anthropic estimation within 15% of actual for fixture payloads
- OpenAI estimation within 15% of actual for fixture payloads
- extract_usage() returns TokenUsage(0,0) on any exception, never raises
- get_model() returns "" on any exception, never raises

`sensor/tests/conftest.py`
- `mock_control_plane` fixture: local HTTP server that records POSTs and returns configurable responses
- `mock_anthropic_client` fixture
- `mock_openai_client` fixture

---

`ingestion/cmd/main.go`
- Reads config from environment, starts HTTP server, handles SIGTERM gracefully
- directiveAdapter bridges directive.Directive to handlers.DirectiveResponse

`ingestion/internal/config/config.go`
- `Config` struct: Port, PostgresURL, NatsURL, Env, ShutdownTimeoutSecs
- `Load() Config`: reads all fields from environment, fails fast on missing required vars

`ingestion/internal/server/server.go`
- HTTP server setup, routes registration, recovery middleware, request logging

`ingestion/internal/handlers/events.go`
- `POST /v1/events`: validate Bearer token, parse payload, publish to NATS, look up pending directive, return 200
- Returns `{"status":"ok","directive":null}` or `{"status":"ok","directive":{...}}`
- Never exposes internal error details to callers. Returns `{"error": "internal server error"}` with the appropriate HTTP status code (401, 400, 500) depending on the failure type

`ingestion/internal/handlers/heartbeat.go`
- `POST /v1/heartbeat`: validate token, publish heartbeat to NATS, return 200

`ingestion/internal/handlers/health.go`
- `GET /health`: returns `{"status":"ok","service":"ingestion"}`

`ingestion/internal/auth/token.go`
- `ValidateToken(token string) (valid bool, err error)`: hashed lookup against Postgres tokens table
- Token hash: SHA256 of raw Bearer value

`ingestion/internal/nats/publisher.go`
- `Publisher` struct with `Publish(subject string, data []byte) error`
- Routes event_type to NATS subject: `events.session_start`, `events.post_call`, etc.

`ingestion/internal/directive/store.go`
- `LookupPending(sessionID string) (*Directive, error)`: reads directives table for undelivered directives
- Marks directive as delivered on successful return

`ingestion/Makefile`
- `build`, `run`, `test`, `lint`, `clean` targets

`ingestion/tests/handler_test.go`
- POST /v1/events with valid token: publishes to NATS, returns 200 with null directive
- POST /v1/events with pending directive: returns 200 with directive in envelope
- POST /v1/events with invalid token: returns 401
- POST /v1/events with malformed payload: returns 400
- GET /health: returns 200

---

`workers/cmd/main.go`
- Reads config, starts NATS consumer pool, handles SIGTERM, drains in-flight on shutdown

`workers/internal/config/config.go`
- `Config` struct: PostgresURL, NatsURL, WorkerPoolSize, ShutdownTimeoutSecs
- `Load() Config`

`workers/internal/consumer/nats.go`
- `Consumer` struct: connects to NATS, starts WorkerPoolSize goroutines consuming from stream
- Each goroutine: ack on success, nack on error (up to MaxDeliver retries before dead letter)

`workers/internal/processor/event.go`
- `Process(event Event) error`: routes to session processor and writer
- Handles all event_type values from the schema

`workers/internal/processor/session.go`
- `SessionProcessor`: manages session state machine in Postgres
- `HandleSessionStart()`: upsert agent, insert session with state=active
- `HandleHeartbeat()`: update last_seen_at, evaluate stale threshold
- `HandlePostCall()`: update tokens_used, update last_seen_at
- `HandleSessionEnd()`: set state=closed, set ended_at
- Background reconciler: runs every 60s, sets stale (>2min no signal), lost (>10min no close)
- SIGKILL bypasses all handlers. Affected sessions transition to stale after 2 minutes and lost after 10 minutes via the background reconciler. This is untrappable by design (see D039).

`workers/internal/processor/policy.go`
- `PolicyEvaluator`: checks token thresholds against sessions table after each post_call
- Writes to directives table when threshold crossed
- Does NOT send directive -- ingestion API picks it up on next sensor POST

`workers/internal/writer/postgres.go`
- `UpsertAgent(flavor, agent_type)`: insert or update agents table
- `UpsertSession(session)`: insert or update sessions table
- `InsertEvent(event)`: insert into events table
- `UpdateTokensUsed(session_id, delta)`: increment tokens_used atomically
- All via pgx, no ORM

`workers/internal/writer/notify.go`
- `NotifyFleetChange(session_id, event_type)`: Postgres NOTIFY `flightdeck_fleet` channel after each write

`workers/internal/models/` -- Go structs mirroring all Postgres tables

`workers/Makefile`

`workers/tests/processor_test.go`
- SessionStart creates agent and session records
- Heartbeat updates last_seen_at
- PostCall increments tokens_used correctly
- SessionEnd sets state=closed
- Background reconciler sets stale after 2min, lost after 10min
- PolicyEvaluator writes directive when block_at_pct crossed

---

`api/cmd/main.go`
`api/internal/config/config.go`
`api/internal/server/server.go`

`api/internal/handlers/fleet.go`
- `GET /v1/fleet`: returns all sessions with state != lost, grouped by flavor
- Response: `{flavors: [{flavor, session_count, active_count, tokens_used_total, sessions: [...]}], total_session_count, context_facets}`
- `context_facets` is a `map[string][]ContextFacetValue` of `{value, count}`
  rows aggregated from `sessions.context` (state IN active/idle/stale).
  GetContextFacets failure is best-effort -- the handler logs a warning
  and returns an empty map rather than failing the entire fleet request.

`api/internal/handlers/sessions.go`
- `GET /v1/sessions/:id`: returns session metadata + all events in chronological order

`api/internal/handlers/health.go`
- `GET /health`: returns `{"status":"ok","service":"api"}`

`api/internal/store/postgres.go`
- Exposes Querier interface for handler dependency injection
- `GetFleet(limit, offset int) ([]FlavorSummary, int, error)` -- selects sessions.context and unmarshals into Session.Context
- `GetSession(sessionID string) (*Session, error)` -- includes `has_pending_directive` and `context`
- `GetSessionEvents(sessionID string) ([]Event, error)`
- `GetContextFacets() (map[string][]ContextFacetValue, error)` -- jsonb_each_text aggregation across non-terminal sessions, ordered by key ASC then count DESC
- `CreateDirective(d Directive) (*Directive, error)`
- `GetActiveSessionIDsByFlavor(flavor string) ([]string, error)` -- used by shutdown_flavor fan-out
- All queries via pgx, parameterized

`api/internal/ws/hub.go`
- `Hub`: manages WebSocket client connections
- `Register(client)`, `Unregister(client)`, `Broadcast(message)`
- Listens on Postgres NOTIFY `flightdeck_fleet` channel
- On NOTIFY: broadcasts state change to all connected WebSocket clients

`api/internal/handlers/stream.go`
- `WS /v1/stream`: upgrades connection, registers with Hub, pumps messages

`api/Makefile`

`api/tests/handler_test.go`
- GET /v1/fleet returns correct session counts and states
- GET /v1/sessions/:id returns events in chronological order
- WS /v1/stream receives broadcast when Postgres NOTIFY fires
- GET /health returns 200

---

`docker/docker-compose.yml`
- All 7 services: nginx, postgres, nats, ingestion, workers, api, dashboard
- Health checks for all services
- NATS JetStream enabled via command flags

`docker/docker-compose.dev.yml`
- Source mounts for hot reload on all Go services
- Dashboard dev server on port 3000

`docker/nginx/nginx.dev.conf`
- Port 4000
- `/` → dashboard:3000
- `/api/` → api:8081 (strip prefix)
- `/ingest/` → ingestion:8080 (strip prefix)

`docker/postgres/init.sql`
- All table CREATE statements from Data Model section
- All indexes
- Dev seed: one enrollment token `tok_dev`

`docker/.env.example`
- All required env vars with dev-safe defaults

`docker/Makefile`

---

`dashboard/src/App.tsx` -- router, nav bar (44px, centered links with active border), theme toggle (Sun/Moon), search trigger
`dashboard/src/pages/Fleet.tsx` -- fleet view: sidebar + fleet header (view mode toggle, time range, live indicator) + timeline
`dashboard/src/components/timeline/Timeline.tsx` -- flavor rows with expand-in-place, shared time axis, swimlane view (the bars view mode was removed in the post-merge cleanup, see D075), resizable left panel with localStorage persistence (see "Phase 4.5 -- Subsequent Additions" → "Resizable Timeline left panel")
`dashboard/src/components/timeline/SwimLane.tsx` -- flavor row: collapsed (48px, aggregated events) + expanded (session sub-rows), chevron toggle
`dashboard/src/components/timeline/SessionEventRow.tsx` -- session row (40px): pulsing dot, ID, state badge, tokens, events on time axis
`dashboard/src/components/timeline/EventNode.tsx` -- event circles: 24px (session rows), 20px (flavor rows), lucide icons, CSS tooltip, hover scale
`dashboard/src/components/timeline/TimeAxis.tsx` -- shared time axis (28px), 6 evenly-spaced relative labels via `formatRelativeLabel(ms)`, no D3 tick generation (see D077)
`dashboard/src/pages/Directives.tsx` -- dedicated directives page: list all registered custom directives, flavor filter, search, trigger form with target selector
`dashboard/src/components/fleet/FleetPanel.tsx` -- left sidebar (240px): section headers (uppercase tracked), fleet overview, session states (large counts), flavor list (active border), policy events, directive activity, **CONTEXT facets** (renders one filterable group per `context_facets` key with 2+ values; single-value facets are skipped; click-to-toggle with `onContextFilter`, clear-all `X` in header when filters active)
`dashboard/src/components/fleet/SessionStateBar.tsx` -- session state counts: large numbers (20px/700) with status-colored labels
`dashboard/src/hooks/useTheme.ts` -- theme toggle: dark/light class on html, localStorage persistence
`dashboard/src/components/fleet/EventFilterBar.tsx` -- event type filter pills (All/LLM Calls/Tools/Policy/Directives/Session), single-select, filters swimlane + live feed simultaneously
`dashboard/src/components/fleet/PolicyEventList.tsx`
`dashboard/src/components/fleet/LiveFeed.tsx` -- live event feed (240px fixed height, 500 event cap, auto-scroll with pause, WebSocket-driven)
`dashboard/src/components/fleet/EventDetailDrawer.tsx` -- single-event detail drawer (520px, independent from SessionDrawer, Details + Prompts tabs)
`dashboard/src/components/session/SessionDrawer.tsx` -- session drawer (520px): header with session ID + state badge, metadata bar, **collapsible RUNTIME panel** (only renders when `session.context` is non-empty; combines git/kubernetes/compose/frameworks fields; documented display order with alphabetical fallback), tabs (Timeline/Prompts), event feed with type badges, expandable JSON detail
`dashboard/src/components/session/SessionTimeline.tsx`
`dashboard/src/components/session/EventDetail.tsx`
`dashboard/src/components/session/TokenUsageBar.tsx`
`dashboard/src/lib/events.ts` -- shared event helpers: badge config, detail text, summary rows, flavor color hash
`dashboard/src/components/ui/syntax-json.tsx` -- JSON syntax highlighting component (keys/strings/numbers/bools colored)
`dashboard/src/hooks/useFleet.ts` -- WebSocket init, REST initial load, live updates
`dashboard/src/hooks/useSession.ts`
`dashboard/src/hooks/useWebSocket.ts` -- exponential backoff: 1s→2s→4s, cap 30s
`dashboard/src/store/fleet.ts` -- Zustand store
`dashboard/src/lib/api.ts`
`dashboard/src/lib/time.ts`
`dashboard/src/lib/types.ts`
`dashboard/src/styles/globals.css` -- neon dark theme CSS variables
`dashboard/src/styles/themes.css`
`dashboard/src/main.tsx`
`dashboard/vite.config.ts`
`dashboard/tsconfig.json`
`dashboard/package.json`
`dashboard/Makefile`

`dashboard/tests/unit/Timeline.test.tsx` -- rendering, swim lanes, D3 scale
`dashboard/tests/unit/SessionDrawer.test.tsx` -- event list, expansion
`dashboard/tests/unit/FleetPanel.test.tsx` -- counts, state breakdown

---

`tests/integration/conftest.py`
- `stack` fixture: verifies all services healthy before any test runs
- Uses `make dev` if stack not already running

`tests/integration/test_pipeline.py`
- POST event to ingestion API → verify session appears in GET /v1/fleet
- POST multiple events → verify GET /v1/sessions/:id returns them in order
- POST heartbeat → verify last_seen_at updates in fleet response
- POST session_end → verify session state is closed in fleet response

`tests/integration/test_session_states.py`
- Session transitions to idle after no LLM calls (heartbeat only)
- Session transitions to stale after 2min no signal (mock time or wait)
- Session transitions to lost after session_end never received
- Session transitions to closed on session_end event

`Makefile` -- root, all targets
`README.md` -- already written
`ARCHITECTURE.md` -- this file
`DECISIONS.md` -- already written
`CLAUDE.md` -- already written

**Acceptance criteria for Phase 1:**

* `make dev` completes successfully and all 7 services report healthy
* Dashboard opens at `http://localhost:4000` with no console errors
* Adding two lines to a test agent script causes the agent to appear in the
  timeline within 5 seconds of starting
* Session state updates active → idle → stale → lost/closed correctly
  (verified by integration tests)
* GET /v1/fleet returns correct session counts grouped by flavor
* WS /v1/stream delivers state change within 2 seconds of the Postgres write
* `make test` passes across sensor, ingestion, workers, api, dashboard
  with zero failures
* `make test-integration` passes all tests in test_pipeline.py and
  test_session_states.py
* sensor: `mypy flightdeck_sensor/ --strict` passes with zero errors
* sensor: `ruff check flightdeck_sensor/` passes with zero errors
* ingestion: `golangci-lint run ./...` passes with zero errors
* workers: `golangci-lint run ./...` passes with zero errors
* api: `golangci-lint run ./...` passes with zero errors
* dashboard: `npm run typecheck` passes with zero errors
* dashboard: `npm run lint` passes with zero errors
* sensor unit test count: minimum 30 tests
* Go unit test count: minimum 20 tests across ingestion, workers, api
* Timeline renders swim lanes for each unique AGENT_FLAVOR in fleet
* SessionDrawer opens on node click and shows chronological event list
* FleetPanel shows live counts updated via WebSocket
* Neon dark theme renders without errors
* `.github/workflows/ci.yml` exists and triggers on pull_request to main
* CI runs sensor, Go, and dashboard test jobs in parallel
* `.github/workflows/release.yml` exists with correct PyPI OIDC config
  and Docker Hub image build/push jobs
* `scripts/release.sh` exists, validates clean tree, updates pyproject.toml
  version, commits, tags, and pushes
* `make release VERSION=v0.1.0` triggers the full release pipeline
* `METHODOLOGY.md`, `CONTRIBUTING.md`, `RELEASING.md`, `CHANGELOG.md`
  all exist with substantive content
* Docker Hub images `flightdeckhq/flightdeck-ingestion`,
  `flightdeckhq/flightdeck-workers`, `flightdeckhq/flightdeck-api`,
  `flightdeckhq/flightdeck-dashboard` are published and pullable
* `pip install flightdeck-sensor` installs the stub package (v0.0.1
  already published; v0.1.0 published by release pipeline on Phase 1 tag)

---

### Phase 2 -- Token enforcement and policy

**Goal:** Platform engineer defines a token policy centrally. Every instrumented
agent enforces it automatically without code changes.

> **For Claude Code:** Do not implement directives, kill switch, analytics,
> or prompt capture during this phase.

**Deliverables:**

`sensor/flightdeck_sensor/core/policy.py` (extend Phase 1)
- `PolicyCache.check()`: now enforces warn/degrade/block thresholds
- WARN callback fires once per session at warn_at_pct (fire-once rule enforced)
- DEGRADE swaps model in a copy of call_kwargs, never mutates original
- BLOCK raises BudgetExceededError before the LLM call is made

`sensor/flightdeck_sensor/interceptor/base.py` (extend Phase 1)
- Pre-call: check PolicyCache, apply WARN/DEGRADE/BLOCK before real_fn
- Post-call: update session tokens_used, POST event with tokens_used_session

`sensor/tests/unit/test_policy.py` (extend Phase 1)
- WARN fires at configured pct, fires only once per session
- DEGRADE swaps model in copy, original kwargs untouched, verified with mock
- BLOCK raises BudgetExceededError, real_fn never called (mock verified)
- PolicyCache update() from directive replaces all fields atomically

`workers/internal/processor/policy.go` (extend Phase 1)
- After each POST_CALL event: evaluate tokens_used against policy
- Write directive to directives table when block_at_pct crossed
- Policy lookup order: session scope → flavor scope → org scope → no limit

`api/internal/handlers/policies.go`
- `GET /v1/policies`: returns all policies (org + flavor scoped)
- `POST /v1/policies`: create new policy (org, flavor, or session scope)
- `PUT /v1/policies/:id`: update existing policy
- `DELETE /v1/policies/:id`: delete policy

`api/internal/store/postgres.go` (extend Phase 1)
- `GetPolicies() ([]Policy, error)`
- `GetPolicyForScope(scope, scope_value string) (*Policy, error)`
- `UpsertPolicy(policy Policy) error`
- `DeletePolicy(id string) error`

`dashboard/src/pages/Policies.tsx`
- List of all active policies with scope label (org / flavor name)
- Create policy button → PolicyEditor modal
- Edit and delete per row

`dashboard/src/components/policy/PolicyEditor.tsx`
- Form: scope selector, scope_value input (for flavor scope), token_limit,
  warn_at_pct, degrade_at_pct, degrade_to model, block_at_pct
- Validates that warn < degrade < block

`dashboard/src/components/policy/PolicyTable.tsx`
- Sortable table: scope, scope_value, token_limit, thresholds, created_at

`dashboard/src/components/session/TokenUsageBar.tsx` (extend Phase 1)
- Shows warn/degrade/block threshold markers on the usage bar
- Correct threshold positions when policy is active for session

`tests/integration/test_enforcement.py`
- Sensor respects WARN threshold: callback fires, call proceeds
- Sensor respects DEGRADE threshold: model swapped, call proceeds with cheaper model
- Sensor respects BLOCK threshold: BudgetExceededError raised, call never made
- Policy created via API propagates to sensor via directive envelope on next call
- Flavor-scoped policy applies to all sessions of that flavor
- Org-scoped policy applies when no flavor-scoped policy exists

**Acceptance criteria for Phase 2:**

* `make test` passes across all components with zero failures
* `make test-integration` passes test_enforcement.py with all 6 cases
* WARN fires exactly once per session at configured pct (verified by integration test)
* BLOCK raises BudgetExceededError and the mock LLM is never called
  (verified by sensor unit test with call count assertion)
* Policy CRUD endpoints return correct data and persist across container restarts
* Policy editor form validates warn < degrade < block and shows error otherwise
* Token usage bar shows threshold markers at correct positions
* All linters pass with zero errors across all components

---

### Phase 3 -- Kill switch and directives

**Goal:** Platform engineer can stop any running agent from the dashboard
with one click. Fleet-wide stop by flavor works simultaneously.

> **For Claude Code:** Do not implement analytics, prompt capture, search,
> or the Claude Code plugin during this phase.

**Deliverables:**

`api/internal/handlers/directives.go`
- `POST /v1/directives`: create directive record in Postgres
- Body: `{action, session_id (or null), flavor (or null), reason, grace_period_ms}`
- For flavor-wide: session_id is null, flavor is set
- Returns 201 with directive record
- **`action` field accepts only `shutdown`, `shutdown_flavor`, and
  `custom`.** `degrade`, `warn`, and `policy_update` are NOT valid
  values for this endpoint -- they are server-side directives
  written by the workers' policy evaluator
  (`workers/internal/processor/policy.go:Evaluate`) when a session
  crosses its `degrade_at_pct`, `warn_at_pct`, or `block_at_pct`
  threshold. Platform engineers cannot POST a degrade directive
  directly; the only way to trigger one is to create a token policy
  via `POST /v1/policies` and let the workers fire it on the next
  post_call event that crosses the threshold. Phase 4.5 audit B-C.

`api/internal/store/postgres.go` (extend)
- `CreateDirective(directive Directive) error`

Note: Directive lookup and delivery marking is handled by
`ingestion/internal/directive/store.go:LookupPending()` which was built in
Phase 1 and required no changes in Phase 3. The atomic UPDATE...RETURNING
query combines lookup and mark-delivered in a single operation.

`sensor/flightdeck_sensor/core/session.py` (extend)
- `apply_directive(directive Directive)`: handle shutdown, degrade, throttle, checkpoint
- Shutdown: raises DirectiveError after grace_period_ms, triggers teardown

`sensor/flightdeck_sensor/transport/client.py` (extend)
- Reads directive from response envelope on every POST
- Calls `session.apply_directive()` when directive is not null

`dashboard/src/components/session/SessionDrawer.tsx` (extend)
- Kill switch button: opens confirmation dialog
- On confirm: POST /v1/directives with action=shutdown, session_id

`dashboard/src/components/fleet/FleetPanel.tsx` (extend)
- Kill flavor button next to each flavor row
- Opens confirmation dialog: "Stop all N sessions of research-agent?"
- On confirm: POST /v1/directives with action=shutdown_flavor, flavor

`tests/integration/test_killswitch.py`
- Single agent kill: directive in next POST response → session terminates → state=closed
- Fleet-wide kill: all sessions of flavor receive shutdown on next POST → all closed
- Directive marked as delivered after first sensor POST that receives it
- Directive not re-delivered on subsequent POSTs

**Acceptance criteria for Phase 3:**

* `make test` passes with zero failures
* `make test-integration` passes test_killswitch.py with all 4 cases
* Kill switch button in drawer sends POST /v1/directives and session
  state changes to closed within 5 seconds (integration test)
* Fleet-wide kill stops all sessions of a flavor when they next make
  an LLM call (integration test)
* Directive is delivered exactly once -- not re-delivered on subsequent
  POSTs after the first one that received it
* All linters pass with zero errors

---

### Phase 4 -- Analytics, prompt capture, global search, Claude Code plugin

**Goal:** Engineering leaders have a flexible analytics view. Developers can
see full prompt context. Everything is findable via search. Claude Code sessions
appear in the fleet alongside production agents.

> **For Claude Code:** This phase has four independent sub-deliverables.
> Implement them in this order: analytics → prompt capture → search → plugin.
> Complete and audit each before starting the next.

**Deliverables -- Analytics:**

`api/internal/handlers/analytics.go`
- `GET /v1/analytics`: accepts metric, group_by, range, from, to, granularity,
  filter_flavor, filter_model, filter_agent_type query params
- Builds GROUP BY query dynamically from params
- Returns series array with per-dimension totals and time series data

`api/internal/store/analytics.go`
- `QueryAnalytics(params AnalyticsParams) ([]AnalyticsSeries, error)`
- All GROUP BY queries via pgx with parameterized inputs
- No raw string interpolation in SQL

`dashboard/src/pages/Analytics.tsx`
- Global time range picker (7d / 30d / 90d / custom)
- KpiRow: total tokens, active now, total sessions, policy events
- 4 DimensionCharts with defaults from ARCHITECTURE.md analytics layout
- All charts connected to useAnalytics hook

`dashboard/src/components/analytics/KpiRow.tsx` -- 4 Tremor KPI cards
`dashboard/src/components/analytics/DimensionChart.tsx`
- Accepts metric, group_by, range, filter props
- Renders correct chart type: AreaChart (time series), BarChart (ranking), DonutChart
- `DimensionPicker` dropdown changes group_by, re-fetches
`dashboard/src/components/analytics/TimeSeriesChart.tsx`
`dashboard/src/components/analytics/RankingChart.tsx`
`dashboard/src/components/analytics/DonutChart.tsx`
`dashboard/src/components/analytics/DimensionPicker.tsx`
`dashboard/src/hooks/useAnalytics.ts`

`dashboard/tests/unit/DimensionChart.test.tsx`
- Group-by switch triggers new API call with correct params
- Time range change triggers new API call for all charts
- Chart renders correct type for each default chart

`tests/integration/test_analytics.py`
- GET /v1/analytics?metric=tokens&group_by=flavor returns correct totals per flavor
- GET /v1/analytics?metric=sessions&group_by=model returns correct session counts
- Changing group_by param changes grouping in response
- Changing range param filters correctly
- filter_flavor param restricts results to that flavor only

**Deliverables -- Prompt capture:**

`sensor/flightdeck_sensor/providers/anthropic.py` (extend)
- `extract_content()`: when capture_prompts=True, extracts system, messages, tools, response
- When capture_prompts=False: returns None unconditionally

`sensor/flightdeck_sensor/providers/openai.py` (extend)
- `extract_content()`: when capture_prompts=True, extracts messages (all roles), tools, response

`sensor/flightdeck_sensor/interceptor/base.py` (extend)
- Post-call: if capture_prompts=True, call provider.extract_content()
- Include PromptContent in event payload as `content` field

`workers/internal/models/event_content.go`
`workers/internal/writer/postgres.go` (extend)
- `InsertEventContent(content EventContent) error`: inserts into event_content table
- Called only when event.has_content=true

`api/internal/handlers/content.go`
- `GET /v1/events/:id/content`: returns event_content row
- Returns 404 when capture is disabled or no content exists for this event

`dashboard/src/components/session/PromptViewer.tsx`
- "Prompts" tab in SessionDrawer alongside event timeline tab
- Shows system (Anthropic) or system message (OpenAI) separately
- Shows messages array with role labels
- Shows tools list as collapsed section
- When capture disabled: shows "Prompt capture is not enabled for this deployment."

`sensor/tests/unit/test_prompt_capture.py`
- capture_prompts=False: extract_content returns None, content field absent from payload
- capture_prompts=True: extract_content returns PromptContent with all fields populated
- Anthropic: system extracted separately, messages array intact
- OpenAI: messages array includes system role, no separate system field

`tests/integration/test_prompt_capture.py`
- capture_prompts=False: event_content table has no row for this event
- capture_prompts=True: event_content table has row, GET /v1/events/:id/content returns it
- GET /v1/events/:id/content returns 404 when capture was off

**Deliverables -- Global search:**

`api/internal/handlers/search.go`
- `GET /v1/search?q=term`: searches agents (flavor), sessions (session_id, host),
  events (tool_name, model), returns grouped results
- Maximum 5 results per group, total max 20 results
- Uses Postgres ILIKE or pg_trgm if available

`api/internal/store/postgres.go` (extend)
- `Search(query string) (*SearchResults, error)`

`dashboard/src/components/search/CommandPalette.tsx`
- Opens on Cmd+K (or Ctrl+K on Windows/Linux)
- Also triggered by header search bar click
- Debounced input: waits 200ms before firing search request
- Results grouped: Agents / Sessions / Events
- Keyboard navigable: arrow keys, Enter to select, Escape to close
- Click/Enter navigates to relevant page

`dashboard/src/components/search/SearchResults.tsx`
`dashboard/src/hooks/useSearch.ts` -- debounced, cancels in-flight requests

**Deliverables -- Claude Code plugin:**

`plugin/hooks/scripts/observe_cli.mjs`
- Reads Claude Code hook event from stdin (JSON)
- Reformats to Flightdeck event schema (AGENT_FLAVOR=claude-code, AGENT_TYPE=developer)
- POSTs to FLIGHTDECK_SERVER/ingest/v1/events with FLIGHTDECK_TOKEN
- If server unreachable: logs to stderr, exits 0 (never block Claude Code)

`plugin/hooks/hooks.json`
- PreToolUse, PostToolUse, Stop hooks defined with observe_cli.mjs script path

`plugin/.claude-plugin/manifest.json`
- Plugin name, description, version, hook definitions

`dashboard/src/pages/Fleet.tsx` (extend)
- Filter toggle: Production / Developer / All
- Developer sessions (agent_type=developer) shown with distinct node style in timeline

**Clean light theme:**
`dashboard/src/styles/themes.css` (extend)
- Clean light theme CSS variables
- Same information density as neon dark, not a washed-out inversion
- All components verified to render correctly in light theme

`dashboard/tests/e2e/analytics.spec.ts`
- Analytics page loads with all 4 default charts
- Changing group_by on one chart does not affect others
- Global time range change updates all charts
- Both neon dark and clean light themes render without errors

**Acceptance criteria for Phase 4:**

* `make test` passes with zero failures across all components
* `make test-integration` passes test_analytics.py and test_prompt_capture.py
* GET /v1/analytics with all param combinations returns correct data
  (verified by integration test with known fixture data)
* Every analytics chart has a working group-by control that changes the data
* Global time range picker updates all 4 charts simultaneously
* Prompt capture off: zero rows in event_content table for that session
  (verified by integration test)
* Prompt capture on: GET /v1/events/:id/content returns PromptContent
  with all fields (verified by integration test)
* GET /v1/events/:id/content returns 404 when capture was off
* CommandPalette opens on Cmd+K from fleet view
* Search results appear within 500ms for a simple query
* Claude Code plugin: observe_cli.mjs POSTs correctly formatted event to
  running local stack (manual verification + unit test)
* Both neon dark and clean light themes render all pages without errors
* `npm run typecheck` passes with zero errors
* Phase 4 audit: compare all Phase 4 deliverables against ARCHITECTURE.md.
  Produce discrepancy table. Resolve all before phase closes.

---

### Phase 5 -- Helm chart and production hardening

**Goal:** Platform engineer deploys Flightdeck to Kubernetes with one command.
The production deployment is secure, HA, and auditable.

> **For Claude Code:** Do not implement TimescaleDB migration, dollar cost
> conversion, or notification infrastructure during this phase.

**Deliverables:**

`helm/Chart.yaml` -- chart metadata, version, appVersion
`helm/values.yaml` -- all configurable values, documented defaults
`helm/values.prod.yaml` -- example production overrides
`helm/templates/_helpers.tpl`
`helm/templates/ingestion/deployment.yaml` -- replicas, resources, env from configmap/secret
`helm/templates/ingestion/service.yaml`
`helm/templates/ingestion/hpa.yaml` -- min 2, max 10, CPU 70%
`helm/templates/workers/deployment.yaml`
`helm/templates/workers/service.yaml`
`helm/templates/api/deployment.yaml`
`helm/templates/api/service.yaml`
`helm/templates/dashboard/deployment.yaml`
`helm/templates/dashboard/service.yaml`
`helm/templates/nats/statefulset.yaml` -- JetStream file store, 3 replicas
`helm/templates/postgres/statefulset.yaml` -- or externalUrl passthrough
`helm/templates/configmap.yaml`
`helm/templates/secret.yaml`
`helm/templates/ingress.yaml` -- optional, disabled by default
`helm/templates/rbac.yaml` -- ServiceAccount, Role, RoleBinding per component
`helm/Makefile` -- `lint`, `template`, `install`, `upgrade`, `uninstall` targets

`api/internal/server/server.go` (extend)
- JWT auth middleware: validates Authorization Bearer header in production mode
- Auth disabled entirely in development mode
- `POST /v1/auth/login`: email + password → JWT (24h) + refresh token
- `POST /v1/auth/refresh`: refresh token → new JWT

`dashboard/src/pages/Login.tsx` -- login form, shown in production mode only

`docker/docker-compose.prod.yml` -- TLS via nginx, restricted ports
`docker/nginx/nginx.prod.conf` -- port 443, port 80 redirect, HSTS header

`tests/integration/test_analytics.py` (extend)
- All previous tests still pass
- TimescaleDB placeholder: tests documented but skipped until Phase 6 migration

`dashboard/tests/e2e/fleet.spec.ts`
`dashboard/tests/e2e/search.spec.ts`
`dashboard/tests/e2e/killswitch.spec.ts`
`dashboard/tests/e2e/analytics.spec.ts`
-- All E2E tests run in both neon dark and clean light themes

`README.md` (extend)
- Production deployment section: prerequisites, TLS setup, Helm install command
- Helm values reference table

**Acceptance criteria for Phase 5:**

* `helm lint helm/` passes with zero errors or warnings
* `helm template helm/ --values helm/values.prod.yaml` produces valid Kubernetes YAML
* `helm install flightdeck helm/ --dry-run` completes without errors
* All deployments have correct resource requests, liveness probes, readiness probes
* JWT auth blocks unauthenticated requests in production mode
* JWT auth is a no-op in development mode (existing tests still pass unchanged)
* Login page renders in production mode, not in development mode
* All Playwright E2E tests pass in both themes
* `make test` passes with zero failures
* `make test-integration` passes all integration tests
* Phase 5 audit: compare all deliverables against ARCHITECTURE.md.
  Produce discrepancy table. Resolve all before phase closes.

---

## What Flightdeck Is NOT

- Not a proxy. Never intercepts LLM traffic.
- Not a content inspector by default. Prompt capture is opt-in.
- Not an orchestrator. Never tells agents what to do.
- Not a cost calculator. Token counts only. Dollar conversion is v2.
- Not a notification platform. No Slack/email/PagerDuty. That is v2.

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
9. No raw SQL outside `api/internal/store/`.
10. All database migrations have an up and a down.
11. Prompt content is never stored or logged when capture_prompts=false.
    This is a hard rule. No exceptions. See DECISIONS.md D019.
12. Every analytics chart must have a working group-by control.
    A chart without a functional dimension picker is an incomplete task.
