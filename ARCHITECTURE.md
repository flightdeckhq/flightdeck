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
├── CONTRIBUTING.md             # Contributor guide
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
│   │   │   ├── session.py      # Session: lifecycle, identity, heartbeat thread, atexit/signal handlers
│   │   │   ├── policy.py       # PolicyCache: local token enforcement, threshold evaluation
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
│       │   ├── test_session.py         # Session lifecycle, state transitions, heartbeat
│       │   ├── test_policy.py          # Token enforcement, threshold evaluation
│       │   ├── test_interceptor.py     # wrap(), patch(), call interception
│       │   ├── test_transport.py       # HTTP client, directive parsing, unavailability
│       │   ├── test_providers.py       # Token estimation, usage extraction
│       │   └── test_prompt_capture.py  # Prompt capture on/off, content extraction per provider
│       └── conftest.py                 # Shared fixtures: mock control plane, mock providers
│
├── ingestion/                  # Ingestion API (Go) -- receives sensor events, publishes to NATS
│   ├── Makefile
│   ├── Dockerfile
│   ├── cmd/
│   │   └── main.go             # Entry point: config loading, server startup, graceful shutdown
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go       # Config struct: all values from environment variables
│   │   ├── server/
│   │   │   └── server.go       # HTTP server setup, routes, middleware (logging, recovery)
│   │   ├── handlers/
│   │   │   ├── events.go       # POST /v1/events: validate, publish NATS, return directive
│   │   │   ├── heartbeat.go    # POST /v1/heartbeat: validate, publish NATS
│   │   │   └── health.go       # GET /health: liveness check
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
│   │       └── policy.go       # Policy struct (mirrors policies table)
│   └── tests/
│       └── processor_test.go   # Unit tests: event processing, state machine, policy eval
│
├── api/                        # Query API (Go) -- serves dashboard, WebSocket, search, analytics
│   ├── Makefile
│   ├── Dockerfile
│   ├── cmd/
│   │   └── main.go             # Entry point: config, router, graceful shutdown
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
│   │   │   ├── policies.go     # GET/PUT /v1/policies: policy management
│   │   │   ├── analytics.go    # GET /v1/analytics: flexible breakdown queries
│   │   │   ├── stream.go       # WS /v1/stream: real-time WebSocket fleet updates
│   │   │   └── health.go       # GET /health: liveness check
│   │   ├── store/
│   │   │   ├── postgres.go     # Fleet, session, event queries via pgx
│   │   │   └── analytics.go    # Analytics GROUP BY queries across all dimensions
│   │   └── ws/
│   │       └── hub.go          # WebSocket hub: client registry, broadcast on PG NOTIFY
│   └── tests/
│       └── handler_test.go     # Unit tests for all HTTP and WebSocket handlers
│
├── dashboard/                  # React frontend (TypeScript + Vite)
│   ├── Makefile
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx             # Root: theme provider, router, WebSocket init
│   │   ├── pages/
│   │   │   ├── Fleet.tsx       # Primary view: timeline + fleet health panel
│   │   │   ├── Session.tsx     # Session drill-down (opened from timeline node click)
│   │   │   ├── Analytics.tsx   # Analytics page: flexible breakdown charts
│   │   │   └── Policies.tsx    # Policy management
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
│   │   │   │   ├── PolicyEditor.tsx
│   │   │   │   └── PolicyTable.tsx
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
│   │   │   ├── useFleet.ts       # Fleet state: WebSocket + REST initial load
│   │   │   ├── useSession.ts     # Session event history + prompt content
│   │   │   ├── useAnalytics.ts   # Analytics queries with dimension/metric/range params
│   │   │   ├── useSearch.ts      # Debounced search query
│   │   │   └── useWebSocket.ts   # WebSocket with auto-reconnect (3s)
│   │   ├── store/
│   │   │   └── fleet.ts          # Zustand: fleet state, session map, WebSocket stream
│   │   ├── lib/
│   │   │   ├── api.ts            # Typed fetch wrappers for all endpoints
│   │   │   ├── time.ts           # Time scale helpers (d3-scale + d3-time math only)
│   │   │   └── types.ts          # TypeScript types mirroring all backend schemas
│   │   └── styles/
│   │       ├── globals.css       # CSS variables for both themes -- NEVER casually edit
│   │       └── themes.css        # Neon dark + clean light theme definitions
│   └── tests/
│       ├── unit/
│       │   ├── Timeline.test.tsx
│       │   ├── CommandPalette.test.tsx
│       │   ├── SessionDrawer.test.tsx
│       │   ├── FleetPanel.test.tsx
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
│   │   ├── manifest.json
│   │   └── marketplace.json
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
│   │   └── init.sql            # Schema + dev seed data
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
│   └── release.sh
│
└── .github/
    └── workflows/
        ├── ci.yml
        └── release.yml
```

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          AGENT PROCESS                                  │
│                                                                          │
│  flightdeck_sensor.init(server="...", token="...",                       │
│                          capture_prompts=False)  # off by default        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │   Session lifecycle  │  Interceptor  │  PolicyCache              │   │
│  │   heartbeat (30s)    │  wrap()/      │  warn/degrade/block       │   │
│  │   atexit/SIGTERM     │  patch()      │  pulled from CP           │   │
│  └──────────────────────┴──────┬────────┴───────────────────────────┘   │
│                                 │                                        │
│                      ┌──────────▼──────────┐                            │
│                      │  Transport (HTTP)    │                            │
│                      │  fire-and-forget     │                            │
│                      │  reads directive     │                            │
│                      └──────────┬───────────┘                            │
└─────────────────────────────────┼──────────────────────────────────────  │
                                  │ POST /v1/events
                                  │ {event, tokens, [content if enabled]}
                                  │ ← {"status":"ok","directive":...}
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Ingestion API → NATS JetStream → Go Workers → PostgreSQL                │
│                                                                          │
│  workers write:                                                          │
│    agents table       (upsert on flavor)                                 │
│    sessions table     (upsert on session_id, state machine)              │
│    events table       (insert, metadata only)                            │
│    event_content table (insert only when capture_prompts=true)           │
│    directives table   (insert when policy threshold crossed)             │
│    NOTIFY api on every write                                             │
│                                                                          │
│  Query API:                                                              │
│    REST endpoints for fleet, sessions, events, search, analytics         │
│    GET /v1/events/:id/content  (returns 404 when capture disabled)       │
│    GET /v1/analytics           (flexible GROUP BY across all dims)       │
│    WS /v1/stream               (real-time fleet state via NOTIFY)        │
└───────────────────────────────────────────────────────────────────────── │
                    │
                    ▼
     ┌─────────────────────────────────────┐
     │         React Dashboard             │
     │                                     │
     │  Fleet view    -- real-time ops     │
     │  Analytics     -- aggregate views   │
     │  Session drawer -- full history     │
     │  Search (Cmd+K) -- find anything    │
     └─────────────────────────────────────┘
```

---

## Component Interfaces

### flightdeck-sensor Public API

```python
def init(
    server: str,
    token: str,
    capture_prompts: bool = False,   # opt-in only -- see DECISIONS.md D019
    quiet: bool = False,
) -> None:
    """
    Initialize the sensor.

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
    policy_id       UUID REFERENCES policies(id)
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
    metadata        JSONB
);

CREATE INDEX sessions_flavor_idx    ON sessions(flavor);
CREATE INDEX sessions_state_idx     ON sessions(state);
CREATE INDEX sessions_last_seen_idx ON sessions(last_seen_at);
CREATE INDEX sessions_started_idx   ON sessions(started_at);
```

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

### policies

```sql
CREATE TABLE policies (
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
│  Top by token        │  Sessions per day   │
│  consumption         │                     │
│  [Group by: Flavor▾] │  [Group by: Type ▾] │
│  horizontal bar      │  stacked area       │
└──────────────────────┴─────────────────────┘

┌──────────────────────┬─────────────────────┐
│  Model distribution  │  Policy events      │
│  [Group by: Model ▾] │  over time          │
│  donut chart         │  [Group by: Flavor▾]│
│                      │  line chart         │
└──────────────────────┴─────────────────────┘
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
├── test_policy.py           # Policy propagation via directive
├── test_session_states.py   # All five state transitions
├── test_prompt_capture.py   # Content stored when on, not stored when off
└── test_analytics.py        # GROUP BY queries return correct aggregates
```

Run: `make test-integration`

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

**Deliverables:**

`sensor/flightdeck_sensor/core/types.py`
- `SessionState` enum: ACTIVE, IDLE, STALE, CLOSED, LOST
- `EventType` enum: SESSION_START, SESSION_END, HEARTBEAT, PRE_CALL, POST_CALL, TOOL_CALL
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
- `start()`: fires SESSION_START event, starts heartbeat daemon thread (30s interval)
- `end()`: fires SESSION_END event, stops heartbeat thread
- `_heartbeat_loop()`: daemon thread, fires HEARTBEAT every 30s, stops on teardown event
- `_register_handlers()`: registers atexit + SIGTERM + SIGINT handlers

`sensor/flightdeck_sensor/core/policy.py`
- `PolicyCache` class: holds token_limit, warn_at_pct, degrade_at_pct, block_at_pct, degrade_to
- `check(tokens_used, estimated)`: returns PolicyDecision (allow/warn/degrade/block)
- `update(policy_dict)`: replace cache from directive payload
- `fire_once` tracking: WARN fires once per session, not on every call after threshold

`sensor/flightdeck_sensor/transport/client.py`
- `ControlPlaneClient` class
- `post_event(payload: dict) -> Directive | None`: HTTP POST to /v1/events, parses response envelope
- `post_heartbeat(session_id: str) -> Directive | None`: HTTP POST to /v1/heartbeat
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
- `init(server, token, capture_prompts=False, quiet=False)`: creates global Session and ControlPlaneClient
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
- Heartbeat thread starts on session start, stops on teardown
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
- Heartbeat fires correct payload format

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

`ingestion/internal/config/config.go`
- `Config` struct: Port, PostgresURL, NatsURL, Env, ShutdownTimeoutSecs
- `Load() Config`: reads all fields from environment, fails fast on missing required vars

`ingestion/internal/server/server.go`
- HTTP server setup, routes registration, recovery middleware, request logging

`ingestion/internal/handlers/events.go`
- `POST /v1/events`: validate Bearer token, parse payload, publish to NATS, look up pending directive, return 200
- Returns `{"status":"ok","directive":null}` or `{"status":"ok","directive":{...}}`
- Returns 401 on invalid token, 400 on invalid payload, never 500 to caller

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
- Response: `{flavors: [{flavor, session_count, active_count, tokens_used_total, sessions: [...]}]}`

`api/internal/handlers/sessions.go`
- `GET /v1/sessions/:id`: returns session metadata + all events in chronological order

`api/internal/handlers/health.go`
- `GET /health`: returns `{"status":"ok","service":"api"}`

`api/internal/store/postgres.go`
- `GetFleet() ([]FlavorSummary, error)`
- `GetSession(sessionID string) (*Session, error)`
- `GetSessionEvents(sessionID string) ([]Event, error)`
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

`dashboard/src/App.tsx` -- router, theme provider, WebSocket init
`dashboard/src/pages/Fleet.tsx` -- primary view layout
`dashboard/src/components/timeline/Timeline.tsx` -- primary surface
`dashboard/src/components/timeline/SwimLane.tsx`
`dashboard/src/components/timeline/EventNode.tsx`
`dashboard/src/components/timeline/TimeAxis.tsx`
`dashboard/src/components/fleet/FleetPanel.tsx`
`dashboard/src/components/fleet/SessionStateBar.tsx`
`dashboard/src/components/fleet/PolicyEventList.tsx`
`dashboard/src/components/session/SessionDrawer.tsx`
`dashboard/src/components/session/SessionTimeline.tsx`
`dashboard/src/components/session/EventDetail.tsx`
`dashboard/src/components/session/TokenUsageBar.tsx`
`dashboard/src/hooks/useFleet.ts`
`dashboard/src/hooks/useSession.ts`
`dashboard/src/hooks/useWebSocket.ts`
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
* Adding two lines to a test agent script causes the agent to appear in the timeline
  within 5 seconds of starting
* Session state updates to active → idle → stale → lost/closed correctly
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
* sensor unit test count: minimum 30 tests covering session lifecycle,
  policy cache, interceptor paths, transport, and both providers
* Go unit test count: minimum 20 tests across ingestion, workers, api
* Timeline renders swim lanes for each unique AGENT_FLAVOR in fleet
* SessionDrawer opens on node click and shows chronological event list
* FleetPanel shows live counts updated via WebSocket
* Both neon dark theme renders without errors (light theme is Phase 4)
* `.github/workflows/ci.yml` exists and triggers on pull_request to main
* CI runs sensor, Go, and dashboard test jobs in parallel

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

`api/internal/store/postgres.go` (extend)
- `CreateDirective(directive Directive) error`
- `GetPendingDirective(sessionID string) (*Directive, error)` -- also checks flavor-wide
- `MarkDelivered(directiveID string) error`

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
* Fleet-wide kill stops all sessions of a flavor within one heartbeat
  interval (integration test)
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
