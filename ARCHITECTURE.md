# Flightdeck Architecture

> **For Claude Code:** Read this entire document before writing any code. This
> is the single source of truth for all architectural decisions. When in
> doubt, refer back here. Every component has a Makefile. If you are writing
> a component that does not have one, stop and create it first.
>
> **This is a living document.** When implementation reveals that a design
> here is wrong or has drifted from reality, update this document before
> merging code. Record the reason in DECISIONS.md. ARCHITECTURE describes
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
  of code (`init()` + `patch()`).
- A central control plane (ingestion + workers + Postgres + API + dashboard)
  that aggregates every event into a fleet view.
- A token budget enforcer: warn, degrade, block — applied at call time
  inside the agent, configured centrally.
- A kill switch: stop any agent or every agent of a flavor from a dashboard
  click.
- A prompt and embedding-input recorder, opt-in via `capture_prompts`.
- A Claude Code observer via a hook plugin (observation-only, no
  enforcement).
- An analytics surface across tokens, sessions, latency, policy events, and
  estimated cost — flexible group-by across `flavor`, `model`, `framework`,
  `host`, `agent_type`, `team`, `provider`.

**IS NOT:**

- Not a proxy. Never intercepts LLM traffic on the network.
- Not a content inspector by default. Prompt capture is opt-in
  (`capture_prompts=False` is the default; D019).
- Not an orchestrator. Never tells agents what to do.
- Not a billing system. `estimated_cost` approximates from public list
  prices (D099); actual invoices differ.
- Not a notification platform. No Slack, email, or PagerDuty.
- Not multi-tenant SaaS. Self-hosted only.
- Not an LLM gateway. No model substitution, no caching, no retries
  injected by Flightdeck.

---

## System Architecture

```
┌─────────────────────┐          ┌──────────────────────────┐
│   Agent Process     │          │   React Dashboard :3000  │
│                     │          │                          │
│  flightdeck-sensor  │          │  Fleet, Investigate,     │
│  Session + Policy   │          │  Session drawer,         │
│  Interceptor        │          │  Analytics, Search       │
└────────┬────────────┘          └────────┬─────────────────┘
         │                                │
         │ POST /ingest/v1/events         │ REST  /api/*
         │ GET  /api/v1/policy            │ WS    /api/v1/stream
         │                                │ GET   / (SPA static)
         ▼                                ▼
┌──────────────────────────────────────────────────────────┐
│                    nginx :4000                           │
│                                                          │
│  /ingest/*  → ingestion:8080  (strips prefix)            │
│  /api/*     → api:8081        (strips prefix)            │
│  /          → dashboard:3000                             │
│  /api/v1/stream  → api:8081   (WebSocket upgrade)        │
└───────┬──────────────────────────────┬───────────────────┘
        │                              │
        ▼                              ▼
┌──────────────────────┐    ┌──────────────────────────────┐
│ Ingestion API :8080  │    │     Query API :8081          │
│                      │    │                              │
│ POST /v1/events      │    │ GET /v1/fleet                │
│ POST /v1/heartbeat   │    │ GET /v1/sessions(/:id)       │
│ GET  /health         │    │ GET /v1/agents(/:id)         │
│ GET  /docs/          │    │ GET /v1/events               │
│                      │    │ GET /v1/events/:id/content   │
│ Auth: validates      │    │ GET /v1/policy               │
│   bearer token       │    │ GET/POST/PUT/DELETE          │
│   (access_tokens)    │    │   /v1/policies               │
│                      │    │ POST /v1/directives          │
│ Directive: reads +   │    │ GET /v1/directives/custom    │
│   marks delivered    │    │ POST /v1/directives/sync     │
│                      │    │ POST /v1/directives/register │
│                      │    │ GET /v1/analytics            │
│                      │    │ GET /v1/search               │
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
           ▼                           ▼
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
│    Workers send NOTIFY after every event write           │
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
    NOTIFY flightdeck_fleet (after every event write)

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
├── DECISIONS.md                # Why decisions were made, alternatives rejected
├── CLAUDE.md                   # Standing rules for Claude Code sessions
├── CONTRIBUTING.md             # Contributor guide: setup, tests, PR process
├── RELEASING.md                # How to cut a release: version bump, tag, verify
├── METHODOLOGY.md              # Supervisor/Executor build methodology
├── CHANGELOG.md                # Version history (Keep-a-Changelog)
├── README.md                   # User-facing documentation
├── Makefile                    # Root Makefile -- orchestrates all components
│
├── sensor/                     # flightdeck-sensor Python package (PyPI)
│   ├── Makefile
│   ├── pyproject.toml
│   ├── flightdeck_sensor/
│   │   ├── __init__.py         # Public API: init(), wrap(), patch(), get_status(), teardown(), directive()
│   │   ├── py.typed            # PEP 561 marker
│   │   ├── core/
│   │   │   ├── types.py        # SessionState, EventType, DirectiveAction, SensorConfig, PromptContent
│   │   │   ├── session.py      # Session: lifecycle, identity, atexit/signal handlers, runtime context
│   │   │   ├── policy.py       # PolicyCache: local token enforcement, threshold evaluation
│   │   │   ├── context.py      # Pluggable runtime context collectors + framework classifiers
│   │   │   ├── schemas.py      # Pydantic v2 control-plane envelope validation
│   │   │   ├── agent_id.py     # D115 5-tuple → deterministic agent_id derivation
│   │   │   └── exceptions.py   # BudgetExceededError, DirectiveError, ConfigurationError
│   │   ├── transport/
│   │   │   ├── client.py       # ControlPlaneClient + EventQueue (drain + directive threads)
│   │   │   └── retry.py        # Exponential backoff, unavailability policy enforcement
│   │   ├── interceptor/
│   │   │   ├── base.py         # call(), call_async(), call_stream(): provider-agnostic intercept
│   │   │   ├── anthropic.py    # SensorAnthropic + descriptor-based class-level patch
│   │   │   ├── openai.py       # SensorOpenAI + chat / responses / embeddings descriptors
│   │   │   └── litellm.py      # SensorLitellm: module-level completion / embedding patch
│   │   └── providers/
│   │       ├── protocol.py     # Provider Protocol: token estimation, usage extraction, content extraction
│   │       ├── anthropic.py    # AnthropicProvider: handles system, messages, tools, response
│   │       └── openai.py       # OpenAIProvider: handles messages, tools, response, embeddings input
│   └── tests/
│       ├── unit/
│       │   ├── test_session.py
│       │   ├── test_policy.py
│       │   ├── test_interceptor.py
│       │   ├── test_transport.py
│       │   ├── test_providers.py
│       │   ├── test_prompt_capture.py
│       │   ├── test_context.py
│       │   ├── test_framework_attribution.py
│       │   └── test_agent_id.py
│       └── conftest.py         # Mock control plane + provider fixtures
│
├── ingestion/                  # Ingestion API (Go)
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/main.go             # Entry, config, server startup, graceful shutdown
│   ├── docs/                   # Generated by swaggo/swag (D050)
│   ├── internal/
│   │   ├── config/config.go    # Config struct: env-driven
│   │   ├── server/server.go    # HTTP server, routes, recovery middleware, request logging
│   │   ├── handlers/
│   │   │   ├── events.go       # POST /v1/events: validate, publish NATS, return directive
│   │   │   ├── heartbeat.go    # POST /v1/heartbeat
│   │   │   ├── health.go       # GET /health
│   │   │   └── (Swagger UI route)
│   │   ├── auth/token.go       # Bearer token validation against access_tokens
│   │   ├── nats/publisher.go   # JetStream publisher (event_type → subject routing)
│   │   ├── session/store.go    # Synchronous attach-on-session_start (D094 writer)
│   │   └── directive/store.go  # Pending directive lookup (atomic UPDATE...RETURNING)
│   └── tests/handler_test.go
│
├── workers/                    # Go event processing workers (no HTTP port)
│   ├── Makefile
│   ├── Dockerfile
│   ├── cmd/main.go             # Entry, NATS consumer pool, graceful shutdown
│   ├── internal/
│   │   ├── config/config.go
│   │   ├── consumer/nats.go    # JetStream consumer goroutine pool, ack handling
│   │   ├── processor/
│   │   │   ├── event.go        # Route incoming event to session, writer, policy evaluator
│   │   │   ├── session.go      # State machine: active/idle/stale/closed/lost + reconciler
│   │   │   └── policy.go       # Threshold evaluation, directive emission
│   │   ├── writer/
│   │   │   ├── postgres.go     # Upsert agents, sessions, events, event_content via pgx
│   │   │   └── notify.go       # Postgres NOTIFY after each write (real-time dashboard push)
│   │   └── models/             # Go structs mirroring all Postgres tables
│   └── tests/processor_test.go
│
├── api/                        # Query API (Go)
│   ├── Makefile                # build target runs swag init before go build
│   ├── Dockerfile
│   ├── cmd/main.go
│   ├── docs/                   # Generated by swaggo/swag
│   ├── internal/
│   │   ├── config/config.go
│   │   ├── server/server.go    # Router, CORS, auth middleware, withRESTTimeout
│   │   ├── handlers/
│   │   │   ├── fleet.go            # GET /v1/fleet
│   │   │   ├── sessions.go         # GET /v1/sessions, GET /v1/sessions/:id
│   │   │   ├── agents.go           # GET /v1/agents/:id
│   │   │   ├── content.go          # GET /v1/events/:id/content
│   │   │   ├── search.go           # GET /v1/search
│   │   │   ├── directives.go       # POST /v1/directives
│   │   │   ├── custom_directives.go# POST /v1/directives/sync, /register; GET /v1/directives/custom
│   │   │   ├── policies.go         # GET/POST /v1/policies, GET /v1/policy
│   │   │   ├── analytics.go        # GET /v1/analytics
│   │   │   ├── events_list.go      # GET /v1/events (bulk, paginated)
│   │   │   ├── access_tokens.go    # /v1/access-tokens CRUD
│   │   │   ├── admin_reconcile.go  # POST /v1/admin/reconcile-agents
│   │   │   ├── stream.go           # WS /v1/stream
│   │   │   └── health.go
│   │   ├── store/
│   │   │   ├── postgres.go         # Fleet, session, event, agents queries via pgx
│   │   │   ├── analytics.go        # GROUP BY queries across all dimensions
│   │   │   ├── pricing.go          # Static pricing table for estimated_cost (D099)
│   │   │   ├── events.go           # Bulk events query
│   │   │   ├── sessions.go         # Listing + filters (framework, error_type)
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
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js      # CSS variable-based theme colors
│   ├── eslint.config.js
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/              # Fleet, Investigate, Session, Analytics, Policies, Directives, Settings
│   │   ├── components/
│   │   │   ├── timeline/       # Timeline, SwimLane, SessionEventRow, EventNode, TimeAxis
│   │   │   ├── fleet/          # FleetPanel, SessionStateBar, PolicyEventList, LiveFeed,
│   │   │   │                   # EventDetailDrawer, EventFilterBar
│   │   │   ├── session/        # SessionDrawer, SessionTimeline, EventDetail, PromptViewer,
│   │   │   │                   # EmbeddingsContentViewer, ErrorEventDetails, TokenUsageBar
│   │   │   ├── analytics/      # KpiRow, DimensionChart, TimeSeries, Ranking, Donut, DimensionPicker
│   │   │   ├── search/         # CommandPalette, SearchResults
│   │   │   ├── policy/         # PolicyEditor, PolicyTable
│   │   │   ├── directives/     # DirectiveCard
│   │   │   └── ui/             # shadcn/ui components (owned, copied into project)
│   │   ├── hooks/              # useFleet, useSession, useAnalytics, useSearch, useWebSocket,
│   │   │                       # useHistoricalEvents
│   │   ├── store/fleet.ts      # Zustand: fleet state, session map, WebSocket stream
│   │   ├── lib/                # api, time, types, utils, events, models, constants, directives
│   │   └── styles/             # globals.css, themes.css
│   └── tests/                  # unit (Vitest + RTL), e2e (Playwright)
│
├── plugin/                     # Claude Code hook plugin
│   ├── Makefile
│   ├── package.json
│   ├── .claude-plugin/plugin.json
│   ├── hooks/
│   │   ├── hooks.json          # SessionStart, UserPromptSubmit, PostToolUse,
│   │   │                       # PostToolUseFailure, Stop, SessionEnd, PreCompact,
│   │   │                       # SubagentStart, SubagentStop
│   │   └── scripts/observe_cli.mjs
│   └── skills/flightdeck.md    # /flightdeck skill
│
├── playground/                 # Working examples per supported framework
│   ├── _helpers.py             # init_sensor() with required flavor + capture defaults
│   └── *.py                    # one script per framework / scenario
│
├── helm/                       # Kubernetes Helm chart
│   ├── Makefile                # lint / template / install / upgrade — each gates on sync-migrations
│   ├── templates/              # ConfigMap consumes migrations/ via .Files.Glob at chart-render time
│   └── migrations/             # Build artifact (gitignored, D136); populated by `make sync-migrations`
│                               # from docker/postgres/migrations/. Single source of truth lives there.
├── docker/                     # docker-compose.{yml,dev.yml,prod.yml}, nginx, postgres/migrations
├── tests/
│   ├── integration/            # Full-pipeline pytest suite (real NATS + Postgres)
│   └── e2e-fixtures/           # Canonical seed dataset for Playwright dev-stack runs
└── .github/workflows/          # ci.yml, release.yml
```

---

## Sensor

The sensor is a Python library that runs in-process inside the agent. `init()`
resolves configuration; `patch()` installs class-level descriptors on the
Anthropic and OpenAI client classes; every LLM call passes through the sensor
synchronously. The event POST itself is offloaded onto a background queue
drain thread (D037) so it does not sit in the hot path, but the LLM call
waits for the sensor's response-envelope parsing before returning control to
user code.

Because the sensor sits in the call path, it can act on directives returned
in the response envelope. Shutdown, warn, degrade, custom handlers, and
token-budget enforcement all depend on this interception loop. The sensor
reads the directive from the POST response and applies it before the next
LLM call returns: the kill switch works because the sensor decides whether
the next `client.messages.create()` call raises `BudgetExceededError` or
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
event throughput (D081).

Heartbeats, polling loops, and additional daemon threads do not belong in
the sensor. Features that require independent background activity belong in
a sidecar container or system service.

### Public API

```python
def init(
    server: str,
    token: str,
    api_url: str | None = None,      # control-plane base URL (D088)
    capture_prompts: bool = False,   # opt-in (D019)
    quiet: bool = False,
    limit: int | None = None,        # local WARN-only token threshold (D035)
    warn_at: float = 0.8,
    session_id: str | None = None,   # optional session-id hint (D094)
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

    Reads from environment (override init() params):
        FLIGHTDECK_API_URL            -- control-plane base URL
        FLIGHTDECK_SESSION_ID         -- session-id hint
        AGENT_FLAVOR / FLIGHTDECK_AGENT_NAME -- persistent agent label
        AGENT_TYPE / FLIGHTDECK_AGENT_TYPE   -- "coding" or "production" (D114/D115)
        FLIGHTDECK_HOSTNAME           -- override socket.gethostname()
        FLIGHTDECK_UNAVAILABLE_POLICY -- "continue" (default) or "halt"
        FLIGHTDECK_CAPTURE_PROMPTS    -- "true" to enable

    When capture_prompts=False (default):
        Event payloads contain token counts, model, latency, tool names only.
        No message content, no system prompts, no tool inputs/outputs.

    When capture_prompts=True:
        Event payloads include full messages array, system prompt, tool
        definitions, completion response, and embedding input. Content is
        stored in event_content table, NOT inline in events.
    """

def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap a single Anthropic or OpenAI client. init() must be called first."""

def patch(
    quiet: bool = False,
    providers: list[str] | None = None,
) -> None:
    """Class-level monkey-patch of SDK constructors. Works with frameworks
    that build their own clients internally."""

def unpatch() -> None: ...
def get_status() -> StatusResponse: ...
def teardown() -> None: ...

def directive(
    name: str,
    description: str,
    parameters: list[Parameter] | None = None,
) -> Callable:
    """Decorator that registers a custom directive handler at module load
    time. The function registers with the control plane on init() and is
    callable from the dashboard."""

# `Parameter` is an alias of `DirectiveParameter` exposed in __all__.
```

`AGENT_TYPE` accepts only `coding` or `production`. Any other value raises
`ConfigurationError` at `init()` (D114). The Claude Code plugin emits
`coding`; production agents emit `production`.

### Provider Protocol

```python
class Provider(Protocol):

    def estimate_tokens(self, request_kwargs: dict) -> int:
        """Estimate tokens before the call. Never raises."""

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from response. Never raises."""

    def extract_content(
        self,
        request_kwargs: dict,
        response: Any,
        event_type: EventType = EventType.POST_CALL,
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
        Anthropic and OpenAI shapes (Rule 20).
        """

    def get_model(self, request_kwargs: dict) -> str:
        """Extract model name from request kwargs. Returns "" on failure."""
```

### `PromptContent` dataclass

```python
@dataclass
class PromptContent:
    """Raw content extracted from a single LLM call or embeddings request."""
    system: str | None              # Anthropic system param; None for OpenAI
    messages: list[dict]            # Full messages array verbatim
    tools: list[dict] | None        # Tool definitions if provided
    response: dict                  # Full response as dict
    input: str | list[str] | None   # Embeddings input (None for chat)
    provider: str                   # "anthropic" or "openai"
    model: str
    session_id: str
    event_id: str
    captured_at: str                # ISO 8601 UTC
```

`AnthropicProvider.estimate_tokens` uses the Anthropic SDK
`count_tokens` if available, falls back to `char // 4`.
`OpenAIProvider.estimate_tokens` uses `tiktoken` when installed, falls back to
`char // 4`. Token reconciliation in `_post_call` always trusts
`extract_usage` over the pre-call estimate.

### Class-level patching

`patch()` works by replacing the `cached_property` descriptors for a fixed
set of resource slots on the SDK client classes with sensor descriptors.
Any code path that accesses one of these resources is intercepted, including
code paths inside agent frameworks that build their own SDK clients
internally. The class-level patch handles captured references (`from
anthropic import Anthropic` BEFORE `patch()`) because the descriptor mutates
the actual class object in place.

The patched resource slots are:

- **Anthropic** — `Anthropic.messages`, `AsyncAnthropic.messages`,
  `Beta.messages`, `AsyncBeta.messages` (the `Beta` class lives at
  `anthropic.resources.beta.beta`; patching its `messages` cached_property
  is the leaf-level fix for `client.beta.messages.create` / `.stream` used
  by Claude 4 adaptive-thinking).
- **OpenAI** — `OpenAI.chat`, `AsyncOpenAI.chat`, `OpenAI.responses`,
  `AsyncOpenAI.responses`, `OpenAI.embeddings`, `AsyncOpenAI.embeddings`.
  `responses` is OpenAI's recommended API for new projects;
  `embeddings` is common in RAG-heavy pipelines.

Five descriptor types in total across both interceptor files:

- `_AnthropicMessagesDescriptor` (Anthropic, AsyncAnthropic)
- `_AnthropicBetaMessagesDescriptor` (Beta, AsyncBeta)
- `_OpenAIChatDescriptor` (OpenAI, AsyncOpenAI)
- `_OpenAIResponsesDescriptor` (OpenAI, AsyncOpenAI)
- `_OpenAIEmbeddingsDescriptor` (OpenAI, AsyncOpenAI)

The OpenAI patch infrastructure uses an `_OPENAI_PATCH_RESOURCES` table
driving a shared `_patch_one_resource` helper so all three OpenAI resources
use the same code path. Per-resource idempotency sentinels:
`_flightdeck_patched` (chat), `_flightdeck_patched_responses`,
`_flightdeck_patched_embeddings`.

Idempotency: a `_flightdeck_patched` sentinel on each patched class stores
the original `cached_property`. Safe across multiple `patch()` / `unpatch()`
cycles.

Pre-existing instance limitation: instances that accessed `.messages` /
`.beta.messages` / `.chat` / `.responses` / `.embeddings` BEFORE `patch()`
have the raw resource cached in `instance.__dict__` and bypass the
descriptor permanently. New instances and new accesses are wrapped
correctly. Practical implication: call `init()` + `patch()` at the top of
the entrypoint, before any framework or user code constructs a client.

### Module-level patching: litellm

`SensorLitellm` (in `interceptor/litellm.py`) covers `litellm.completion`,
`litellm.acompletion`, `litellm.embedding`, and `litellm.aembedding`.
litellm exposes its API as module-level functions, so the descriptor pattern
above does not apply; the interceptor wraps the module functions directly
with idempotency sentinels on the module object. Streaming via
`litellm.completion(stream=True)` is not yet covered by the sensor's TTFT /
chunk / abort accounting.

### Patch surface — out of scope

The class-level patch deliberately does NOT intercept:

| Code path | Why not |
|---|---|
| `OpenAI.beta.chat.completions.parse` / `.stream` | Structured-output path on a separate `OpenAI.beta` `cached_property`. Not yet observed in any framework's default flow. |
| `OpenAI.audio.*`, `images.*`, `moderations.*`, `files.*`, `fine_tuning.*`, `completions.*` (legacy) | Utility resources unrelated to LLM inference events. |
| `Anthropic.completions.*` | Legacy completions API; superseded by `messages` / `beta.messages`. |
| Frameworks that bypass the SDK entirely (raw httpx, boto3 bedrock-runtime, vertexai) | No SDK class to patch. |

Extending the patch surface to a new resource is one descriptor + one entry
in the OpenAI resource table (or one `_patch_one_class` call for Anthropic).

### Framework support

After `init()` + `patch()`, frameworks that build Anthropic or OpenAI
clients internally are intercepted without user-side wrapping.

| Framework | Path covered |
|---|---|
| LangChain | `ChatAnthropic.invoke` (langchain-anthropic), `ChatOpenAI.invoke` (langchain-openai), `OpenAIEmbeddings.embed_*` (transitive) |
| LangGraph | Transitive via LangChain — graphs routing through `ChatAnthropic` / `ChatOpenAI`, including `langgraph.prebuilt.create_react_agent` tool loops |
| LlamaIndex | `llama-index-llms-anthropic.complete`, `llama-index-llms-openai.complete` |
| CrewAI 1.14+ | `LLM(model=...).call()` via the native Anthropic and OpenAI provider classes. Model strings without a native-provider prefix (e.g. `openrouter/`, `deepseek/`) fall through to litellm |
| litellm | `litellm.completion` / `acompletion` chat path; `embedding` / `aembedding` |
| Claude Code plugin | Observational hook-based path; emits the same event shape as the sensor |
| bifrost | Multi-protocol gateway. Point the openai SDK at bifrost's `base_url` and the OpenAI interceptor fires; point the anthropic SDK at bifrost and the Anthropic interceptor fires. Both protocols are supported as deployment topologies |

### Framework attribution

Every event carries a bare-name `framework` field (`langchain`, `crewai`,
`langgraph`, ...). The value is populated at sensor `init()` from
`FrameworkCollector` via `Session.record_framework`, then propagated to
every emitted event.

Higher-level framework wins over SDK transport: a LangChain pipeline
routing through litellm routing through OpenAI reports
`framework=langchain` because that's the user's mental model. The
versioned form (`langchain/0.3.27`) lives in `context.frameworks[]` for
diagnostic detail; the bare name lives on the per-event `framework` field.

`BaseClassifier.module` accepts a tuple of aliases. `LangChainClassifier`
lists `("langchain", "langchain_core")` so split-package installs
(`langchain_openai`, `langchain_anthropic` without the umbrella) are still
detected via the always-present core package.

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
(see Identity model above). Three mechanisms are covered (D126):

| Mechanism | parent_session_id source | agent_role source | Interceptor |
|---|---|---|---|
| Claude Code Task subagent | hook payload `session_id` | hook payload `agent_type` (e.g. `"Explore"`) | `plugin/hooks/scripts/observe_cli.mjs` (`SubagentStart` / `SubagentStop`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute | `sensor/.../interceptor/crewai.py` (context manager around `Agent.execute()`) |
| LangGraph node execution | parent runner's session | node name | `sensor/.../interceptor/langgraph.py` (agent-bearing nodes only — node body invokes a patched LLM client OR matches `langgraph_agent_node_pattern` regex) |

Direct Anthropic / OpenAI SDK calls and litellm calls outside a
multi-agent framework emit root sessions with
`parent_session_id=null` and `agent_role=null`; the existing 5-tuple
identity (D115) is unchanged for those paths.

Sub-agent coverage tracks the LLM-interception coverage matrix above
— a framework lands here only after Flightdeck observes its plain
LLM calls. AutoGen support is on the Roadmap (LLM-call interception
plus sub-agent observability for both the 0.4 rewrite and the 0.2
legacy package).

Cross-agent message capture rides on the same
`capture_prompts` gate as LLM prompt content (D019). Each
interceptor extracts the parent's input to the child at child
context entry and stamps it on the child `session_start` payload as
`incoming_message`; the child's response back lands on the child
`session_end` payload as `outgoing_message`. Bodies route through
the existing `event_content` table — small bodies inline, large
bodies through the D119 overflow path (8 KiB inline / 2 MiB hard
cap). `capture_prompts=false` produces neither field.

Sub-agent emission failure (the framework's `Agent.execute()` or
equivalent raises an exception inside the interceptor's context
manager) emits child `session_end` with `state=error` plus a
structured error block following the `llm_error` taxonomy. The
dashboard surfaces failures via the row-level red-dot pattern on
the child session row in Investigate, the child agent row in
Fleet AgentTable, and the child agent's swimlane left panel —
mirroring the existing `error_types` (`llm_error`) and
`mcp_error_types` indicators.

### Runtime context auto-collection

`sensor/flightdeck_sensor/core/context.py` runs a pluggable collector chain
on `init()` and attaches the resulting dict to the `session_start` event
payload via `Session.set_context()`.

`ContextCollector` Protocol: `applies() -> bool`, `collect() ->
dict[str, Any]`. Both must never raise. `BaseCollector` wraps `_gather()`
in a try/except; the top-level `collect()` orchestrator wraps each
collector call in a *second* try/except. Two layers of protection mean a
single broken collector cannot crash the sensor or block `init()`.

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
   for known AI frameworks (crewai, langchain, langgraph, llama_index,
   autogen, haystack, dspy, smolagents, pydantic_ai). Never imports
   anything new — if a framework was not loaded by the agent before
   `init()` ran, the collector does not claim it is in use.

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

`Session.start()` calls `_sync_directives(registry)`: POST every registered
fingerprint to `{api_url}/v1/directives/sync`. For each unknown fingerprint
returned, POST the full schema to `{api_url}/v1/directives/register`.

`Session._execute_custom_directive(directive)` validates payload via
`DirectivePayloadSchema`, looks up the handler in `_directive_registry`,
verifies fingerprint match, runs the handler with a 5-second timeout via
`_run_handler_with_timeout()`, and enqueues a `directive_result` event with
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

Acknowledgement events: in `_apply_directive()`, before acting on
`SHUTDOWN`, `SHUTDOWN_FLAVOR`, or `DEGRADE`, the sensor enqueues a
`directive_result` event with `directive_status="acknowledged"` and an
action-specific result dict (e.g. `from_model` / `to_model` for degrade,
`reason` for shutdown). For shutdown variants the sensor calls
`EventQueue.flush()` synchronously before raising the shutdown flag so the
acknowledgement is not lost when the process exits. The synchronous flush
is safe because `_apply_directive` runs on the dedicated directive handler
thread, not the drain thread; `Queue.join()` on the event queue makes
progress without self-deadlock.

`EventQueue.flush(timeout=5.0)` synchronously drains pending events up to a
deadline (event queue only). Used by `Session.end()` and the shutdown /
shutdown_flavor branches. The directive queue is intentionally NOT waited
on: `flush()` is typically called from inside `_apply_directive` running on
the directive handler thread, and `Queue.join()` on the directive queue
would self-deadlock because the current item has not had `task_done()`
called on it. The directive queue is internal control flow; the event
queue is the externally observable state operators care about flushing
before shutdown (D081).

### Token race / forced degrade

`Session.record_usage` returns the post-increment `_tokens_used` total
atomically (return type is `int`). The increment AND the read happen inside
the same `with self._lock:` critical section so a concurrent caller cannot
read the value after another thread's increment has bled into it.

`_post_call` order of operations: (1) `record_usage` returns the
post-increment total atomically, (2) `record_model`, (3)
`_build_payload(..., tokens_used_session=session_total, ...)` with the
captured value passed explicitly. This guarantees `tokens_used_session`
reports the correct total under both single-threaded and concurrent use
(D082).

`PolicyCache._forced_degrade` is a boolean flag that arms a forced DEGRADE
decision in `check()`. Set by `set_degrade_model(model)` when the sensor
receives a DEGRADE directive from the server. Cleared by
`update(policy_dict)` (called for `POLICY_UPDATE` directives) so a fresh
policy can un-stick the forced state if the server retracts the degrade.

`check()` short-circuits at the top of the locked block: if
`_forced_degrade and degrade_to`, returns `PolicyResult(DEGRADE,
source="server")` regardless of token thresholds. Required because the
worker's policy evaluator may issue a DEGRADE directive based on its own
cumulative count without populating the sensor's local `degrade_at_pct`
cache (preflight policy fetch can fail silently). See D084.

### Pydantic schemas

`sensor/flightdeck_sensor/core/schemas.py` carries Pydantic v2 models for
control plane envelopes. All use `model_validate()` and fail open on
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
sensor a process-wide singleton. The second `init()` call in any thread is
a no-op with a warning. Pattern B (one init per thread, isolated Sessions)
and Pattern C (multiple agents in one process, each with its own Session)
are not supported in the current model. See DECISIONS.md D086 / D091.

---

## Plugin (Claude Code)

The plugin is a set of hook scripts registered in
`plugin/hooks/hooks.json`. Claude Code invokes each hook as a short-lived
detached child process; the plugin reads the hook event from stdin,
resolves session identity, builds an event payload, POSTs to
`/ingest/v1/events`, and exits. No in-process interception, no background
threads, no shared state across hook invocations beyond a small set of
marker files in `$TMPDIR/flightdeck-plugin/` (session id, per-turn dedup,
cached model).

Because the plugin is observation-only, a directive returned in the POST
response envelope has nowhere to go: the plugin already exited and Claude
Code has moved on. The plugin payload sets
`context.supports_directives = false` on `session_start` so the dashboard
hides the Stop Agent button and the Fleet Stop All control skips these
sessions. This is the observer-session class (D109).

### Session identity

`getSessionId()` resolves in this order (D113):

1. `CLAUDE_SESSION_ID` / `ANTHROPIC_CLAUDE_SESSION_ID` env vars.
2. RFC 4122 v5 UUID derived from `(user, hostname, repo remote, branch)`
   so same-laptop + same-repo + same-branch Claude Code spawns converge on
   one session row.
3. A marker file at
   `$TMPDIR/flightdeck-plugin/session-${sha256(cwd)[:16]}.txt` that caches
   whichever candidate was picked on first run.
4. `hookEvent.session_id` as a demoted safety net.
5. `sha256(cwd)[:32]`.

The marker file exists because every hook invocation runs as a separate
Node child process — pid-based fallbacks would create one session row per
tool call. Branch is part of identity: switching branches produces a
distinct session.

### `session_start` with context

`ensureSessionStarted()` uses a file-marker dedup so the `session_start`
event is sent exactly once per session id (marker file is
`$TMPDIR/flightdeck-plugin/started-${sessionId}.txt`). The payload carries
the `collectContext()` dict.

`collectContext()` is the Node.js parallel of the Python sensor's
`context.py`: pid, process_name, os (Windows / Darwin / Linux), arch,
hostname, user, node_version, working_dir, git_commit / git_branch /
git_repo (each in its own try/catch with a 500ms execSync timeout,
credential-stripped remote URL), and orchestration detection (kubernetes >
docker-compose). Each probe is independently best-effort.

### Tool input sanitisation

`sanitizeToolInput(input)` is a strict whitelist that keeps ONLY:
`file_path`, `command` (truncated to 200 chars), `query`, `pattern`,
`prompt` (truncated to 100 chars). Everything else (content, message
bodies, sub-agent contexts) is dropped. Returns `null` if no whitelisted
field was present. Raw file bodies written by `Write` / `Edit` are never
forwarded.

`is_subagent_call: toolName === "Task"` is emitted on the wire so the
dashboard can distinguish sub-agent spawns from regular tool calls.
Consumed alongside `parent_session_id` (D126) by the dashboard's
swimlane connectors and the SessionDrawer Sub-agents tab to render
the parent's spawn event as the anchor for child rows.

### Subagent hooks

Two hooks bracket every Claude Code Task subagent invocation
(D126):

- `SubagentStart` — emitted when Claude Code spawns a Task subagent.
  The plugin emits a child `session_start` whose `parent_session_id`
  carries the outer session's id and whose `agent_role` carries the
  hook payload's `agent_type` (e.g. `"Explore"`). When
  `capturePrompts=true`, the Task tool's `prompt` argument is
  captured as `incoming_message` on the child's `session_start`
  payload.
- `SubagentStop` — emitted when the Task subagent returns. The
  plugin emits a child `session_end` and (when capture is on) the
  tool's response as `outgoing_message`. `SubagentStop` is the
  canonical end-of-life signal for the child (D126).

`PostToolUseFailure` on a Task tool emits the parent's `tool_call`
event with the structured error block; it does NOT emit a child
`session_end` (D126 disambiguation). Subagent crashes that never
reach a clean `SubagentStop` fall through the worker's existing
state-revival path (D105 / D106): the child session ages from
`active` to `stale` to `lost`, and the next event for the
`session_id` (or the reconciler) closes the loop.

### Per-turn flush

`flushPostCallTurns` (D107) emits `post_call` events on every PostToolUse
hook with `markEmittedTurn` per-messageId disk-marker dedup so mid-turn LLM
activity surfaces in real time instead of batching at Stop.

`latency_ms` for `PostToolUse` events is `Date.now() - startTime`, where
`startTime` is stamped at hook script invocation. This is hook PROCESSING
time, not actual tool execution time — Claude Code does not expose tool
start/end timestamps to hooks.

`main()` returns naturally instead of calling `process.exit(0)`. Two
consecutive fetches in a single script invocation crash Node on Windows
with `STATUS_STACK_BUFFER_OVERRUN` (`0xC0000409`) if `process.exit` fires
while undici is mid-cleanup; letting `main()` return lets the connection
pool drain.

Sessions carry `flavor=claude-code`, `agent_type=coding`, and
`client_type=claude_code` (D115 identity).

---

## Identity model

Every event payload carries a 5-tuple identity (D115). Sub-agent
sessions extend the derivation with a conditional 6th input,
`agent_role` (D126).

| Field | Vocabulary | Source |
|---|---|---|
| `agent_id` | UUID | Deterministically derived from the other identity fields via `core/agent_id.py` |
| `agent_type` | `coding` \| `production` | Sensor `init()` kwarg or `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE` env (D114). Plugin always emits `coding` |
| `client_type` | `claude_code` \| `flightdeck_sensor` | Sensor literal or plugin literal |
| `agent_name` | string | Sensor `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` env. Default `{user}@{hostname}`. Plugin uses the user's chosen flavor |
| `user` | string | Resolved from `getpass.getuser()` (sensor) or `process.env.USER` (plugin) |
| `agent_role` (optional 6th, D126) | string \| null | Framework-driven on sub-agent sessions. CrewAI: `Agent.role`. LangGraph: node name. Claude Code Task: hook payload `agent_type`. Null on root sessions and direct-SDK sessions |

Plus `hostname` (separate field, not part of the agent_id derivation).

Ingestion returns 400 if any of the core 5-tuple fields are missing or
outside their vocabulary (D116). `agent_role` is optional; both
absent on the wire and explicit-null are accepted.

`agent_id` is stable across process restarts: same identity tuple →
same UUID. When `agent_role` is null or empty (after `.strip()`), the
derivation collapses to the D115 5-tuple — root and direct-SDK
sessions on a given host produce the same agent_id whether or not
the platform supports sub-agent emission. When `agent_role` is set,
it joins the input tuple, so a CrewAI Researcher and a CrewAI Writer
running on the same host land under distinct agent_ids despite
sharing the rest of the 5-tuple. The same laptop running the sensor
against multiple repos or branches still converges to ONE root agent
because `agent_name` defaults to `{user}@{hostname}`. Branch / repo
distinctions land in `context.git_branch` / `context.git_repo`, not
in identity.

### Sub-agent sessions

Sub-agent sessions (Claude Code Task subagents, CrewAI agent turns,
LangGraph agent-bearing nodes) carry two paired columns on
`sessions` (D126):

- `parent_session_id uuid` — references `sessions(session_id)`, set to
  the outer session's id.
- `agent_role text` — the framework-supplied role label.

Both columns are nullable. Both are populated only on sub-agent
sessions; both are null on root sessions. The reverse (role set,
parent unset) is a sensor bug — the sensor emits both together or
neither (D126).

`GET /v1/sessions` listing rows carry a derived `child_count int`
field — the count of sessions whose `parent_session_id` equals
this row's `session_id`. Always present; zero on lone agents and
on pure children (sub-agents that have no descendants of their
own). Populated server-side via a correlated subquery on the
listing query so the dashboard's parent-row pill (`→ N`)
renders without a per-row follow-up fetch. Hits the
`sessions_parent_session_id_idx` partial index.

`GET /v1/sessions` accepts an `include_pure_children` boolean
filter (D126 UX revision). When omitted or `true` the listing
returns every session matching the other filters (existing
behaviour). When `false` the listing excludes pure children
(rows whose `parent_session_id IS NOT NULL` AND no other
session references this row as parent), returning only
parents-with-children + lone sessions. The Investigate page
sends `include_pure_children=false` as its default scope so
deep sub-agent trees don't drown root activity in the table; the
"Is sub-agent" facet flips to `is_sub_agent=true` to surface
children-only.

The `parent_session_id` FK is enforced. Forward references (a child
`session_start` arriving before its parent is in the DB) are handled
by a parent-stub variant of the worker's lazy-create path that
extends D106: when a child arrives with a `parent_session_id` that
isn't in `sessions`, the worker INSERTs a stub row with
`flavor="unknown"` / `agent_type="unknown"` / placeholder identity
sentinels and a synthetic `started_at` matching the child's. The
child INSERT then satisfies the FK. When the real parent's
`session_start` arrives later, `UpsertSession ON CONFLICT` upgrades
the stub's `"unknown"` sentinels to real values via the existing
write-once-but-upgrade-from-`"unknown"` branch (D106). See D126 for
the full pseudocode.

### Re-attachment

When the sensor (or plugin) restarts and emits a `session_start` for a
`session_id` that already exists in `sessions`, the ingestion API attaches
the new execution to the prior row instead of creating a duplicate (D094).
The response envelope sets `attached: true`. The session drawer renders a
"New execution attached · {timestamp}" separator per recorded attachment.

### `agents` rollup

The `agents` table is keyed on `agent_id` and carries denormalized
`total_sessions`, `total_tokens`, `first_seen_at`, `last_seen_at` columns
maintained by the worker. Drift between the rollup and ground truth is
healed on demand by `POST /v1/admin/reconcile-agents` which recomputes
the columns from the sessions table.

---

## Ingestion API

### `POST /v1/events`

Every event payload carries the D115 identity 5-tuple, plus session-level
fields. Sub-agent sessions (D126) additionally carry
`parent_session_id` and `agent_role`. The canonical shape:

```json
{
  "session_id":           "uuid",
  "agent_id":             "uuid",
  "agent_name":           "research-bot-1",
  "agent_type":           "production",
  "client_type":          "flightdeck_sensor",
  "user":                 "alice",
  "hostname":             "worker-node-3",
  "flavor":               "research-agent",
  "event_type":           "post_call",
  "host":                 "worker-node-3",
  "framework":            "crewai",
  "model":                "claude-sonnet-4-6",
  "tokens_input":         1240,
  "tokens_output":        387,
  "tokens_total":         1627,
  "tokens_cache_read":    0,
  "tokens_cache_creation": 0,
  "tokens_used_session":  42180,
  "token_limit_session":  100000,
  "latency_ms":           1840,
  "tool_name":            null,
  "tool_input":           null,
  "tool_result":          null,
  "has_content":          false,
  "content":              null,
  "parent_session_id":    null,
  "agent_role":           null,
  "timestamp":            "2026-04-07T10:00:00Z"
}
```

Sub-agent `session_start` events set `parent_session_id` to the
outer session's id and `agent_role` to the framework-supplied role.
Cross-agent message capture (D126): when `capture_prompts=true`,
the child `session_start` payload carries an `incoming_message`
field with the parent's input to the child, and the child
`session_end` payload carries an `outgoing_message` field with the
child's response back. Bodies route through the existing
`event_content` table (no schema change) — small bodies inline,
bodies above 8 KiB use the D119 overflow path with a 2 MiB hard
cap. When `capture_prompts=false` both fields are absent and
`has_content=false`.

When `capture_prompts=true`, the `content` field contains a `PromptContent`
object. The worker stores it in `event_content` and sets `has_content=true`
on the event row.

`session_start` events additionally carry an optional top-level `context`
field with the runtime context dict (orchestration, git, frameworks, etc.).
Other event types omit it. The worker writes it once to `sessions.context`
via `UpsertSession ON CONFLICT` deliberately omitting `context` on
subsequent writes (set-once semantics).

### Validation rules

The ingestion handler rejects events with 400 when:

- `agent_id` is missing or not a UUID (D116).
- `agent_type` is outside `{coding, production}` (D114).
- `client_type` is outside `{claude_code, flightdeck_sensor}` (D116).
- `session_id` does not match the UUID regex (D10).
- `occurred_at` is more than 48h in the past (`maxClockSkewPast`, D7) OR
  more than 5m in the future (`maxClockSkewFuture`, D8). The 48h past
  bound accommodates retry-after-long-outage windows.
- Any `tokens_*` field is negative (D15).
- `event_type=session_end` arrives for a `session_id` Flightdeck has never
  seen (orphan session_end, D2). The handler logs a warning, increments
  `dropped_events_total{reason="orphan_session_end"}`, and ACKs the NATS
  message (nothing to recover).

`dropped_events_total{reason}` is exposed via `/metrics` (D14).

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

1. **Sensor — `init()` accepts `session_id`.** The caller passes a stable
   ID via the kwarg OR exports `FLIGHTDECK_SESSION_ID`. The env var wins
   over the kwarg, same precedence as `FLIGHTDECK_SERVER` / `AGENT_FLAVOR`.
2. **Ingestion — synchronous attachment check on `session_start`.** On
   arrival of a `session_start` event the ingestion API calls
   `session.Store.Attach(session_id)` against Postgres BEFORE publishing
   the NATS envelope. If the row exists in `{closed, lost}` the store
   flips state to `active` and stamps `last_attached_at = NOW()`. If the
   row exists in `{active, idle, stale}` the store only stamps
   `last_attached_at`. `started_at` and `ended_at` are never touched. If
   the row does not exist the store is a no-op and the worker creates it
   downstream.
3. **Response envelope — `attached: true` when the row pre-existed.**
4. **Sensor — INFO log on the first attached response.** Per-process
   guard so subsequent envelopes do not duplicate the log.
5. **Dashboard — run separator per recorded attachment.**
   `GET /v1/sessions/:id` returns an `attachments: []time` array. The
   session drawer walks the array in order and draws a horizontal rule
   labeled "New execution attached · {timestamp}" for each entry.

The race between step 2 (synchronous) and the worker's
`HandleSessionStart` (asynchronous, via NATS) is bounded: the ingestion
API locks the answer in the HTTP response the instant the attach commits.
By the time the worker consumes the event, the row is already `active`,
and the worker's `UpsertSession ON CONFLICT` branch is a no-op refresh.

### Heartbeat and health

`POST /v1/heartbeat` is reserved for transports that need to advance
`last_seen_at` without an event payload. Currently unused by the sensor
(post_call events provide the same signal at the cadence the sensor
produces them).

`GET /health` returns `{"status":"ok","service":"ingestion"}`.
`GET /metrics` exposes Prometheus counters and gauges including
`dropped_events_total{reason}` and request-latency histograms.
`GET /docs/index.html` serves the Swagger UI.

---

## Worker / Event Processing

The worker has no HTTP surface. It connects to NATS, consumes events from
the `FLIGHTDECK` stream, processes them through the session state machine
and policy evaluator, writes to Postgres, and emits `flightdeck_fleet`
NOTIFY events.

### NATS consumer

`workers/internal/consumer/nats.go::Consumer` connects to NATS and starts
`WorkerPoolSize` goroutines consuming from the stream. Each goroutine
acks on success, naks on error (up to `MaxDeliver` retries before dead
letter).

The ingestion API publishes one subject per event type — `events.<type>`
where `<type>` mirrors the sensor's `EventType` enum value. Concrete
subjects in use:

`events.session_start`, `events.session_end`, `events.pre_call`,
`events.post_call`, `events.tool_call`, `events.embeddings`,
`events.llm_error`, `events.policy_warn`, `events.policy_degrade`,
`events.policy_block`, `events.directive_result`.

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
      ──▶  active ──▶ idle ──▶ stale ──▶ lost
                ▲                 │         │
                │                 │         │
                └─────────────────┴─────────┘
                  any event  (D105 revive)

   any event for unknown session_id
                │
                ▼
        lazy-create (active)   (D106)

   closed + any event → skipped with warn log (handleSessionGuard)
```

**Thresholds.** 2 min silence after the last signal triggers `active →
stale`; 30 min total silence triggers `stale → lost`. The 30 min lost
threshold accommodates interactive Claude Code user-think-time windows
(D105). The reconciler in `workers/internal/processor/session.go` sweeps
every 60 s and applies both transitions in a single pass.

**Terminal-state handling.** `closed` is terminal and final. `session_end`
at any non-closed state transitions directly to `closed`;
`handleSessionGuard` skips any subsequent event for a closed session with
a warn log. Revival on `stale` / `lost` is a correctness fix; reviving a
`closed` session would contradict the user's explicit end signal.

### Handlers

`workers/internal/processor/session.go` exposes:

- `HandleSessionStart()`: upsert agent, insert session with state=active.
- `HandlePostCall()`: update tokens_used, advance last_seen_at, evaluate
  policy thresholds, emit directive when crossed.
- `HandleToolCall()`, `HandleEmbeddings()`, `HandleLlmError()`: write the
  event, advance last_seen_at.
- `HandleSessionEnd()`: set state=closed, set ended_at.
- `HandleHeartbeat()`: advance last_seen_at.

Every non-`session_start` handler runs `handleSessionGuard` before its
write: `closed` sessions are skipped with a warn log; `stale` and `lost`
sessions are revived to `active` with `last_seen_at` advanced; unknown
`session_id`s are lazy-created (D106) so the event lands instead of
FK-violating at `InsertEvent`. The event's normal side effects then
proceed.

SIGKILL bypasses all handlers. Affected sessions transition to stale
after 2 minutes and lost after 30 minutes via the background reconciler;
the next event from any re-attached process revives the session (or
lazy-creates one if the re-attach ended up on a fresh `session_id`). This
is untrappable by design (D039, D105, D106).

### Revive / create trio

Four code sites know how to ensure a session is usable for an incoming
event. They mirror rather than consolidate; a unified primitive would need
a 4-axis config surface (writes_attachment, refreshes_identity,
creates_if_missing, allowed_prior_states) which is harder to read than
four focused functions:

1. **`ingestion/internal/session/store.go::Attach`** (D094 only).
   Synchronous on `session_start` so the HTTP response can report
   `attached=true`. Closed/lost → active; writes one
   `session_attachments` row per arrival; clears `ended_at` on revive.
   The only writer of `session_attachments` rows; the only path that
   clears `ended_at` on revive.
2. **`workers/internal/writer/postgres.go::UpsertSession`** (D094, D106).
   Called on every `session_start`. Refreshes identity columns from the
   event payload; COALESCE and CASE branches let a lazy-created row
   absorb the real session_start data when it arrives. Real values are
   write-once; only the `"unknown"` sentinel is upgradable.
3. **`workers/internal/writer/postgres.go::ReviveIfRevivable`** (D105).
   State flip only: `{stale, lost} → active` plus `last_seen_at = NOW()`.
   Called by `handleSessionGuard` before any non-`session_start` side
   effects run. No identity refresh, no attachment row.
4. **`workers/internal/writer/postgres.go::ReviveOrCreateSession`** (D106).
   Delegates to `ReviveIfRevivable` when the row exists; INSERTs a new
   row with best-effort identity + `"unknown"` / NULL sentinels when it
   does not.

Any change to the revival contract (columns touched, state predicate)
must be applied to all four sites. The cross-reference comment on
`ReviveIfRevivable` enumerates the list.

### Three revival scenarios

D094's attachment flow is one of three concrete applications of a single
conceptual primitive — ensure the session row matches the incoming
event's assumption. Three scenarios, three code paths:

- **Attach-on-terminal** (D094). A `session_start` for a session already
  in `{closed, lost}` revives to `active` and records an attachment row.
  Drives orchestrator-re-run attribution.
- **Revive-on-any-event** (D105). Any non-`session_start` event for a
  session in `{stale, lost}` revives to `active` and advances
  `last_seen_at`. Drives interactive Claude Code sessions that pause
  during user think-time without being treated as lost by the reconciler.
- **Create-on-unknown** (D106). Any non-`session_start` event for a
  `session_id` Flightdeck has never seen creates the row lazily from the
  event payload with `state=active`, `started_at = event.occurred_at`,
  and `"unknown"` sentinels on fields the event doesn't carry (typically
  `flavor`, `agent_type`).
- **Create-parent-stub** (D126, extends D106). A child `session_start`
  whose `parent_session_id` does not yet exist in `sessions` triggers
  a parent-stub INSERT before the child is written, so the new
  `sessions.parent_session_id` FK is satisfied. The stub uses the
  same `"unknown"` sentinel pattern as create-on-unknown plus
  `started_at = child.started_at` as a placeholder. When the real
  parent's `session_start` arrives later, `UpsertSession ON CONFLICT`
  upgrades the stub's sentinels to real values via the existing
  write-once-but-upgrade branch (D106). Same primitive as
  create-on-unknown, different trigger (FK satisfaction vs
  unknown-session-id event).

### Policy evaluator

`workers/internal/processor/policy.go::PolicyEvaluator` runs after each
post_call event:

- Look up the active policy in scope precedence: session → flavor → org →
  no-limit.
- Compare cumulative `tokens_used` against `warn_at_pct`,
  `degrade_at_pct`, `block_at_pct`.
- When a threshold is crossed, write a directive row to `directives`
  (`action=warn`, `degrade`, `block`). The directive lives in Postgres;
  delivery happens via the ingestion API on the sensor's next POST.
- Platform engineers cannot POST `degrade` / `warn` / `policy_update`
  directly; only `shutdown`, `shutdown_flavor`, and `custom` are
  user-creatable.

Bias: dedup on `(action, scope_value)` before writing so a single
threshold crossing in a flavor with N sessions does not write N
directives.

### Notify

`workers/internal/writer/notify.go::NotifyFleetChange(session_id,
event_type, event_id)` issues a Postgres NOTIFY on `flightdeck_fleet`
after each event write. The wire payload is `{session_id, event_type,
event_id}`. The hub fetches the exact event via PK lookup, eliminating
the O(N) `GetSessionEvents + tail` race on paired writes (D108).

---

## Database

### `agents` (D115)

```sql
CREATE TABLE agents (
    agent_id        UUID PRIMARY KEY,
    agent_type      TEXT NOT NULL CHECK (agent_type IN ('coding', 'production')),
    client_type     TEXT NOT NULL CHECK (client_type IN ('claude_code', 'flightdeck_sensor')),
    agent_name      TEXT NOT NULL,
    user_name       TEXT NOT NULL,         -- wire field is "user"; column avoids the SQL reserved word
    hostname        TEXT,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_sessions  BIGINT NOT NULL DEFAULT 0,
    total_tokens    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX agents_agent_name_idx  ON agents (agent_name);
CREATE INDEX agents_last_seen_idx   ON agents (last_seen_at DESC);
CREATE INDEX agents_agent_type_idx  ON agents (agent_type);
CREATE INDEX agents_client_type_idx ON agents (client_type);
```

`total_sessions` / `total_tokens` are denormalized rollups maintained by the
worker. Healed by `POST /v1/admin/reconcile-agents` on demand.

### `sessions`

```sql
CREATE TABLE sessions (
    session_id           UUID PRIMARY KEY,
    agent_id             UUID NOT NULL REFERENCES agents(agent_id),
    agent_name           TEXT NOT NULL,             -- denorm from agents
    agent_type           TEXT NOT NULL,             -- denorm from agents
    client_type          TEXT NOT NULL,             -- denorm from agents
    flavor               TEXT NOT NULL,             -- legacy label
    framework            TEXT,                      -- bare name (e.g. "langchain")
    host                 TEXT,
    model                TEXT,
    state                TEXT NOT NULL CHECK (state IN ('active','idle','stale','lost','closed')),
    tokens_used          BIGINT NOT NULL DEFAULT 0,
    tokens_input         BIGINT NOT NULL DEFAULT 0,
    tokens_output        BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read    BIGINT NOT NULL DEFAULT 0,
    tokens_cache_creation BIGINT NOT NULL DEFAULT 0,
    token_limit          BIGINT,
    started_at           TIMESTAMPTZ NOT NULL,
    ended_at             TIMESTAMPTZ,
    last_seen_at         TIMESTAMPTZ NOT NULL,
    last_attached_at     TIMESTAMPTZ,
    context              JSONB DEFAULT '{}'::jsonb,
    token_id             UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
    token_name           TEXT,
    parent_session_id    UUID REFERENCES sessions(session_id),  -- D126
    agent_role           TEXT                                   -- D126
);

CREATE INDEX sessions_agent_id_idx          ON sessions (agent_id);
CREATE INDEX sessions_state_idx             ON sessions (state);
CREATE INDEX sessions_last_seen_idx         ON sessions (last_seen_at DESC);
CREATE INDEX sessions_flavor_idx            ON sessions (flavor);
CREATE INDEX sessions_framework_idx         ON sessions (framework);
CREATE INDEX sessions_started_at_idx        ON sessions (started_at DESC);
CREATE INDEX sessions_context_gin           ON sessions USING GIN (context);
CREATE INDEX sessions_parent_session_id_idx ON sessions (parent_session_id)
    WHERE parent_session_id IS NOT NULL;       -- D126 partial
```

`agent_name`, `agent_type`, and `client_type` are denormalized from
`agents` so list endpoints can avoid a join. The worker populates them on
`UpsertSession`.

`framework` is the bare-name analytics dimension. The full
`context.frameworks[]` JSONB array carries versioned strings
(`langchain/0.3.27`) for diagnostic detail.

`parent_session_id` and `agent_role` are paired sub-agent columns
(D126). Both nullable, both populated only on sub-agent sessions
(Claude Code Task, CrewAI agent turn, LangGraph agent-bearing
node). The FK on `parent_session_id`
references `sessions(session_id)` and is enforced at write time;
forward references where the child's `session_start` arrives before
the parent's are handled by the worker's parent-stub lazy-create
path that extends D106 (see Three revival scenarios above and
D126). The partial index excludes the null-majority root sessions
so the index stays small while supporting fast lookups for the
`?has_sub_agents` / `?is_sub_agent` / `?parent_session_id` filters
and the `agent_role` analytics dimension.

### `session_attachments` (D094)

```sql
CREATE TABLE session_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX session_attachments_session_id_idx ON session_attachments (session_id, attached_at DESC);
```

One row per re-attachment (subsequent `session_start` for an existing
`session_id`). The first `session_start` does NOT write an attachment
row — only re-attachments. Drives the session drawer's "New execution
attached" separators.

### `events` (metadata only — no prompt content inline)

```sql
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    framework       TEXT,                              -- bare name, denorm from sensor payload
    model           TEXT,
    tokens_input    BIGINT,
    tokens_output   BIGINT,
    tokens_total    BIGINT,
    tokens_cache_read    BIGINT,
    tokens_cache_creation BIGINT,
    latency_ms      BIGINT,
    tool_name       TEXT,
    has_content     BOOLEAN NOT NULL DEFAULT FALSE,
    payload         JSONB,                             -- type-specific extras (streaming, error, directive)
    occurred_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX events_session_id_idx   ON events (session_id, occurred_at);
CREATE INDEX events_event_type_idx   ON events (event_type);
CREATE INDEX events_occurred_at_idx  ON events (occurred_at DESC);
```

`payload` JSONB carries event-type-specific extras: streaming sub-object on
`post_call`, error taxonomy fields on `llm_error`, `directive_name` /
`fingerprint` / `parameters` on `directive`, etc.

### `event_content` (prompt storage — separate table, fetched on demand)

```sql
CREATE TABLE event_content (
    event_id    UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    session_id  UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    model       TEXT,
    "system"    TEXT,                  -- Anthropic system prompt
    messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
    tools       JSONB,
    response    JSONB NOT NULL,
    "input"     JSONB,                 -- embeddings input (string or list of strings)
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX event_content_session_id_idx ON event_content (session_id);
```

`event_content` is fetched on demand via `GET /v1/events/:id/content`,
which returns 404 when capture was off for that session. The events table
never carries content inline (Rule 19).

### `token_policies`

```sql
CREATE TABLE token_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           TEXT NOT NULL CHECK (scope IN ('org', 'flavor', 'session')),
    scope_value     TEXT,
    token_limit     BIGINT NOT NULL,
    warn_at_pct     INT,
    degrade_at_pct  INT,
    degrade_to      TEXT,
    block_at_pct    INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX token_policies_scope_idx ON token_policies (scope, scope_value);
```

Lookup precedence: session > flavor > org > no-limit. Workers join against
`sessions` to find the matching policy row.

### `directives`

```sql
CREATE TABLE directives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID,                            -- NULL for flavor-wide
    flavor          TEXT,                            -- NULL for session-scoped
    action          TEXT NOT NULL,                   -- shutdown / shutdown_flavor / degrade / warn / custom / policy_update
    reason          TEXT,
    grace_period_ms INT,
    degrade_to      TEXT,
    payload         JSONB,                           -- custom directive parameters
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX directives_session_id_idx ON directives (session_id) WHERE delivered_at IS NULL;
CREATE INDEX directives_flavor_idx     ON directives (flavor)     WHERE delivered_at IS NULL;
```

`LookupPending(sessionID)` does an atomic UPDATE...RETURNING that combines
lookup and mark-delivered in a single operation: any pending directive
for the session is returned and stamped `delivered_at = NOW()` so it is
not re-delivered on subsequent POSTs.

### `custom_directives`

```sql
CREATE TABLE custom_directives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint   TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    JSONB,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives (flavor);
CREATE INDEX custom_directives_fp_idx     ON custom_directives (fingerprint);
```

The sensor registers handlers via `/v1/directives/sync` (which lookups by
fingerprint and bumps `last_seen_at` for known ones, returning unknown
fingerprints) and `/v1/directives/register` (which upserts the schema on
fingerprint conflict). On register, the same transaction issues
`pg_notify('flightdeck_fleet', 'directive_registered')` so the dashboard
hub broadcasts a fleet update and the Directives page / FleetPanel
sidebar refresh in real time when the sensor registers a brand new
flavor's directives via `init()`.

### `access_tokens`

```sql
CREATE TABLE access_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,  -- hex(SHA256(salt || raw_token))
    salt         TEXT NOT NULL,         -- 16 random bytes as hex
    prefix       TEXT NOT NULL,         -- first 8 chars of raw_token
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX access_tokens_prefix_idx ON access_tokens (prefix);
```

Salted SHA-256 storage with per-token salt. The raw token is returned to
the caller exactly once via `POST /v1/access-tokens`. The dev-seed
`tok_dev` row is non-deletable and non-renameable via the API; it is
disabled by unsetting `ENVIRONMENT=dev` in production deployments
(D095, D096).

### Migrations

All schema changes use `golang-migrate` numbered up/down pairs in
`docker/postgres/migrations/`. Schema is never modified via `init.sql`
(seed data only). Existing migrations are never modified; new changes
always create a new numbered migration.

| # | Description |
|---|---|
| 000001 | Initial schema (agents, sessions, events, event_content, directives, token_policies) |
| 000002 | `events.source` column |
| 000003 | `directives.degrade_to` column |
| 000004 | `custom_directives` table |
| 000005 | `directives.payload` JSONB column |
| 000006 | `sessions.context` JSONB + GIN index |
| 000010 | Salted `access_tokens` schema (D095) |
| 000011 | `sessions.token_id` FK + `token_name` column (D095) |
| 000012 | Rename `api_tokens` → `access_tokens` (D096) |
| 000014 | Normalize legacy `agent_type` values |
| 000015 | Drop and recreate `agents` table with `agent_id` PK (D115) |
| 000016 | `event_content.input` JSONB column for embeddings capture |
| 000017 | `sessions.parent_session_id` FK + `sessions.agent_role` text + partial index (D126) |
| 000018 | `mcp_policies` + `mcp_policy_entries` + `mcp_policy_versions` + `mcp_policy_audit_log` tables + indexes (D128) |

---

## API

### Endpoint inventory

Each endpoint carries full swaggo annotations on the handler; the Swagger
UI at `/api/docs/index.html` (and `/ingest/docs/index.html`) is the
authoritative parameter-level reference.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/fleet` | Fleet summary: agents with state rollup, total sessions, total tokens, context_facets |
| `GET` | `/v1/sessions` | Paginated session listing; filters: `agent_id`, `flavor`, `framework`, `state`, `error_type`, `from`, `to`, `q`, `parent_session_id`, `is_sub_agent`, `has_sub_agents`, `agent_role[]`, `include_pure_children`; returns `error_types[]` and `child_count` per session |
| `GET` | `/v1/sessions/:id` | Session detail: metadata + chronological events + attachments array |
| `GET` | `/v1/agents/:id` | Single agent's identity record (backs Investigate AGENT facet identity-cache resolver) |
| `GET` | `/v1/events` | Bulk events query: `from` (required), `to`, `flavor`, `event_type`, `session_id`, `limit` (max 2000), `offset` |
| `GET` | `/v1/events/:id/content` | Event prompt content; 404 when capture was off for the session |
| `GET` | `/v1/policy` | Sensor preflight: returns the policy applicable to a flavor + session_id |
| `GET` | `/v1/policies` | List all token policies (org + flavor + session scopes) |
| `POST` | `/v1/policies` | Create a policy; validates `warn < degrade < block` |
| `PUT` | `/v1/policies/:id` | Update a policy |
| `DELETE` | `/v1/policies/:id` | Delete a policy |
| `POST` | `/v1/directives` | Create a `shutdown`, `shutdown_flavor`, or `custom` directive |
| `GET` | `/v1/directives/custom` | List registered custom directives; optional `flavor` filter |
| `POST` | `/v1/directives/sync` | Sensor uploads its registered fingerprints; returns unknowns |
| `POST` | `/v1/directives/register` | Sensor uploads full directive schemas for unknown fingerprints |
| `GET` | `/v1/analytics` | Flexible breakdown query; see Analytics |
| `GET` | `/v1/search` | Cross-entity search (agents, sessions, events) |
| `GET` | `/v1/access-tokens` | List access tokens (no hash, no salt, no plaintext) |
| `POST` | `/v1/access-tokens` | Mint a new token; raw token returned ONCE |
| `DELETE` | `/v1/access-tokens/:id` | Revoke (dev-seed row protected: 403) |
| `PATCH` | `/v1/access-tokens/:id` | Rename (dev-seed row protected: 403) |
| `POST` | `/v1/admin/reconcile-agents` | Recompute `agents.total_sessions`/`total_tokens`/`first_seen_at`/`last_seen_at` from sessions ground truth |
| `GET` | `/v1/mcp-policies/global` | Global MCP protection policy + entries (D128) |
| `GET` | `/v1/mcp-policies/:flavor` | Flavor MCP protection policy + entries |
| `GET` | `/v1/mcp-policies/resolve` | Sensor / plugin preflight resolve (D135); query params `flavor`, `server_url`, `server_name` |
| `POST` | `/v1/mcp-policies/:flavor` | Create a flavor MCP policy |
| `PUT` | `/v1/mcp-policies/global` | Replace global MCP policy state; auto-versions and audits |
| `PUT` | `/v1/mcp-policies/:flavor` | Replace flavor MCP policy state; auto-versions and audits |
| `DELETE` | `/v1/mcp-policies/:flavor` | Delete a flavor MCP policy (audit-log row preserved) |
| `GET` | `/v1/mcp-policies/:flavor/versions` | List version metadata |
| `GET` | `/v1/mcp-policies/:flavor/versions/:version_id` | Full historical snapshot |
| `GET` | `/v1/mcp-policies/:flavor/diff` | Structured diff between two versions; query params `from`, `to` |
| `GET` | `/v1/mcp-policies/:flavor/audit-log` | Mutation audit log |
| `GET` | `/v1/mcp-policies/global/audit-log` | Global mutation audit log |
| `POST` | `/v1/mcp-policies/:flavor/dry_run` | Replay last N hours of `mcp_tool_call` events against proposed policy (D137) |
| `GET` | `/v1/mcp-policies/:flavor/metrics` | Aggregated `policy_mcp_warn` / `policy_mcp_block` events; `?period=24h\|7d\|30d` |
| `POST` | `/v1/mcp-policies/:flavor/import` | Replace policy from YAML body |
| `GET` | `/v1/mcp-policies/:flavor/export` | Serialize current policy as YAML |
| `GET` | `/v1/mcp-policies/templates` | List shipped templates (D138) |
| `POST` | `/v1/mcp-policies/:flavor/apply_template` | Apply a named template to a flavor policy |
| `WS` | `/v1/stream` | Real-time WebSocket fleet updates |
| `GET` | `/health` | Liveness check |
| `GET` | `/metrics` | Prometheus exposition |
| `GET` | `/docs/` | Swagger UI |

### Authentication

Every authenticated request carries a Bearer token. Tokens are opaque
strings minted by the platform; they carry no claims and are validated by
hash lookup against `access_tokens` (D095).

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

#### Endpoint auth scope

Every `/v1/*` route on the Query API is wrapped in the auth middleware,
except `/health`, `/metrics`, and `/docs/`. The WebSocket `/v1/stream`
accepts the token via `?token=` because browsers cannot set
`Authorization` on the upgrade handshake.

The Ingestion API authenticates `POST /v1/events` and `POST /v1/heartbeat`
with the same middleware against the same `access_tokens` row.

`/v1/admin/*` endpoints are operator-grade. They use the same Bearer-token
auth but are intended to be exposed only on internal interfaces (firewall
/ ingress level). Token-based scoping (admin vs read-only) is not
implemented; treat any production token as full-access.

### Real-time push: NOTIFY → Hub → WebSocket

Event propagation from Postgres to the dashboard is a four-step LISTEN /
NOTIFY chain, fully decoupled from REST paths.

1. **Worker INSERT + capture id.** On each event,
   `workers/internal/writer/postgres.go::InsertEvent` INSERTs into `events`
   and RETURNS the generated UUID primary key.
2. **NOTIFY publish.**
   `workers/internal/writer/notify.go::NotifyFleetChange` sends a Postgres
   NOTIFY on the `flightdeck_fleet` channel with payload `{session_id,
   event_type, event_id}`.
3. **Hub LISTEN + single-row fetch.** The API hub
   (`api/internal/ws/hub.go::listenOnce`) holds one pgx connection
   permanently subscribed to `flightdeck_fleet`. On each notification it
   parses the payload, fetches the session row via
   `store.GetSession(session_id)`, and fetches the triggering event via
   `store.GetEvent(event_id)` — a PK lookup on `events.id`.
4. **WebSocket broadcast.** The hub wraps the session + event into a
   `fleetUpdate` envelope and broadcasts it to every WebSocket client
   connected to `/api/v1/stream`.

The hub runs in O(1) per NOTIFY: PK lookup on `events.id`. When
`GetSession` returns an error (e.g. session deleted between notify and
read), the hub logs a warning and continues rather than exiting the
listener loop.

The session drawer renders events via `GET /v1/sessions/:id`, which calls
`GetSessionEvents` once on drawer-open and returns the full ordered list.
No race window: the query runs once after the user has already scrolled
to the session, not once per incoming event.

#### Wire contract

`workers/internal/writer/notify.go::fleetNotifyPayload` is the
authoritative definition. The hub's `notifyPayload` struct in
`api/internal/ws/hub.go` must stay field-compatible. Adding fields is
backward compatible (`json.Unmarshal` silently drops extras); removing or
renaming fields is not.

### Analytics endpoint

`GET /v1/analytics` accepts:

- `metric` (required): one of `tokens`, `sessions`, `latency_avg`,
  `latency_p50`, `latency_p95`, `policy_events`, `estimated_cost`,
  `parent_token_sum`, `child_token_sum`, `child_count`,
  `parent_to_first_child_latency_ms`. The four sub-agent-aware
  metrics (D126) operate over the parent / child relationship:
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
  preserve the pre-D126 wire shape exactly; the per-series payload
  contains a flat `data: [{date,value}]` array. Two-dim queries
  return per-series payloads of shape `data: [{date, breakdown:
  [{key, value}]}]` where `key` is the secondary-axis bucket value.
  Allowed dimension values (in either position): `flavor`, `model`,
  `framework`, `host`, `agent_type`, `team`, `provider`,
  `agent_role`, `parent_session_id`. `provider` is derived at query
  time via SQL CASE over `model` (D098). `agent_role` (D126) groups
  by the framework-supplied role string; sessions with null
  `agent_role` bucket as `(root)`. `parent_session_id` (D126)
  groups by parent session UUID; sessions without a parent (root
  sessions and direct-SDK sessions) bucket as `(root)`. The two-dim
  shape is supported for any pair where both dimensions resolve to
  the standard query path; the canonical pair is
  `parent_session_id,agent_role` driving the dashboard's per-parent
  stacked breakdown chart.
- `range` (optional): `7d`, `30d`, `90d`, or `custom`.
- `from` / `to` (ISO 8601, used when `range=custom`).
- `granularity`: `hour`, `day`, `week`.
- `filter_flavor`, `filter_model`, `filter_agent_type`, `filter_framework`,
  `filter_host` (optional).
- `filter_parent_session_id`, `filter_is_sub_agent`,
  `filter_has_sub_agents` (optional, D126). Filter analytics scope to
  the children of a specific parent session, to children only, or to
  parents only.

Returns a series array with per-dimension totals and time-series data.
GROUP BY queries are built dynamically with parameterized inputs; no raw
string interpolation.

Dimensions that live on `sessions` (`framework`, `host`, `agent_type`,
`agent_role`) are accessed via a JOIN against `sessions` when the
metric's base table is `events`, so event-based metrics can group by
session-level attributes. `framework` accepts both bare names
(`langchain`) and versioned strings via `context.frameworks[]`; the
SQL OR-combines both sources.

Latency aggregates use `events.latency_ms` and fall back to 0 via
`COALESCE` when no events fall in the bucket.

`parent_token_sum` uses a recursive CTE walking
`parent_session_id` to aggregate the parent and every descendant in
the same scope. The recursion is bounded by the actual tree depth
(typically 1-2 levels in practice); query cost grows roughly with
the size of the parent's descendant set. The traversal is accurate
but unindexed at the deep-recursion frontier, so analytics over
large historical windows on parents with many descendants pay a
seq-scan-like cost on the recursive step. See D126 for the
known-performance-characteristic note.

### Cost estimation

`estimated_cost` is a derived analytics metric (D099). The per-event
formula:

```
(tokens_input - tokens_cache_read - tokens_cache_creation) * input_price
  + tokens_cache_read     * input_price * 0.10
  + tokens_cache_creation * input_price * 1.25
  + tokens_output         * output_price
```

Cache ratios follow Anthropic's published structure (90% discount on
reads, 25% premium on writes) and apply uniformly to every model that
reports cache tokens. OpenAI and other providers that don't report cache
tokens contribute 0 to the cache terms, so the formula collapses to
`tokens_input * input_price + tokens_output * output_price`.

Pricing data lives in `pricing.yaml` at the repo root and is loaded at API
startup via `api/internal/store/pricing.go`. Update the YAML when provider
list prices change; it is read-only at runtime.

### Search

`GET /v1/search?q=term` searches agents (`agent_name`), sessions
(`session_id`, `host`, `flavor`, context JSONB fields), and events
(`tool_name`, `model`). Results are grouped: max 5 per group, total max
20. Implemented as parallel ILIKE queries via `errgroup`. Powers the
Cmd+K command palette.

### Bulk events

`GET /v1/events` runs the COUNT and SELECT inside a single
`pgx.BeginTx` with `pgx.TxIsoLevel("repeatable read")`. Without the
explicit isolation level, a worker INSERT between the COUNT and SELECT
could leave `total` stale relative to `events`, breaking pagination math
(`offset + len(events) > total`). Repeatable read pins both reads to the
same snapshot.

### Server timeouts

`withRESTTimeout` middleware wraps every REST handler in a
`context.WithTimeout(15s)` so a slow store query cannot hold an HTTP
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

---

## Dashboard

React + TypeScript + Vite + Zustand. shadcn/ui and custom components
only — never MUI / Ant / Chakra (Rule 13).

### Pages

- `/` (Fleet) — primary view. Sidebar + fleet header + timeline.
- `/investigate` — session search and filtering surface. URL-driven
  facets: `state`, `agent`, `flavor`, `agent_type`, `model`, `framework`,
  `error_type`, scalar context fields.
- `/session/:id` — full session drilldown (drawer-based via deep-link).
- `/analytics` — flexible breakdown charts.
- `/policies` — token policy CRUD.
- `/directives` — custom directive registry + trigger forms.
- `/settings` — access token CRUD.

### Fleet view

`dashboard/src/pages/Fleet.tsx` composes the FleetPanel sidebar (240px),
fleet header (time range, live indicator), timeline (swimlane view),
and live feed.

`pauseQueue: FeedEvent[]` state buffers WebSocket events when `isPaused`
is true. New events are appended; if the queue length reaches
`PAUSE_QUEUE_MAX_EVENTS` the oldest entry is dropped (FIFO). `pausedAt:
Date | null` freezes the D3 time scale. "Resume" drains the queue;
"Return to live" discards it and snaps back.

`sortFlavorsByActivity(flavors)` sorts agents by activity priority so
flavors with active or idle sessions float to the top of the swimlane and
stale / closed / lost ones sink to the bottom. Stable secondary order is
alphabetical.

`sessionStateCounts` is computed via `useMemo` from the live `flavors`
array on every render and passed down to `SessionStateBar` as a prop.

The fleet store filters out `total_sessions=0` orphan agents — they
exist in the `agents` table from prior runs but have no live or recent
sessions.

### Investigate view

`dashboard/src/pages/Investigate.tsx`. URL-driven facet sidebar +
session table + session drawer (Mode 2 deep-link via `?session=<id>`).

`buildActiveFilters` emits filter chips with onRemove. URL state
round-trips via `parseUrlState` / `buildUrlParams`; `CLEAR_ALL_FILTERS_PATCH`
zeroes all filters at once. The aux fetch in `doFetch` strips the active
filter so the matching facet stays sticky when the filter is applied.

The AGENT facet is keyed on `agent_id` with `agent_name` display labels.
Two agents with the same `agent_name` but different `client_type` (e.g.
plugin and SDK both running as `omria@laptop`) are disambiguated by a
small uppercase pill (`CC` for `claude_code`, `SDK` for
`flightdeck_sensor`) appended next to the agent name in the facet row.

The ERROR TYPE facet is rendered last (after state / agent / flavor /
agent_type / model / framework / scalar context groups). Hidden when no
visible session has any `llm_error` events.

### Session drawer

`dashboard/src/components/session/SessionDrawer.tsx` — slide-in right
panel (520px). Two modes:

- **Mode 1** (default): session event list, token usage bar, Prompts tab.
- **Mode 2**: single-event detail (back-button to Mode 1), Details tab
  and Prompts tab for the focused event.

The active detail event is derived from props every render:
`activeDetailEvent = directDismissed ? internalDetailEvent :
(directEventDetail ?? internalDetailEvent)`.

`directEventDetail` is set by the parent when the user clicks an event
circle in the swimlane. `internalDetailEvent` is set by clicking "Open
full detail" inside the drawer. `onClearDirectEvent` is called by the
Back button so the parent knows the prop-fed event was dismissed. Mode is
rendered directly from `activeDetailEvent` truthiness (D069).

The drawer header carries session ID + state badge, metadata bar, and a
collapsible RUNTIME panel (only renders when `session.context` is
non-empty; combines git / kubernetes / compose / frameworks fields).
Tabs: Timeline, Prompts, Directives (conditional). The Directives tab
only appears when `flavorDirectives.length > 0` (filtered from the fleet
store's `customDirectives` slice by the session's flavor).

The Prompts tab loads `PromptViewer` for chat events with
`event.has_content`, `EmbeddingsContentViewer` for embeddings events
with content, otherwise the capture-disabled message. Provider
terminology is preserved exactly (Rule 20) — Anthropic sessions display
`system`, `messages`, `tools`, and `response` as separate fields; OpenAI
sessions display `messages` (system role included), `tools`, and
`response`.

Streaming `post_call` rows render TTFT in the detail string and a
`<StreamingPill>` (`STREAM` for completed, `ABORTED` for aborted). The
expanded grid grows TTFT, Chunks, Inter-chunk, and Stream outcome rows.

`llm_error` rows render an `<ErrorEventDetails>` accordion with
request_id, retry_after as `<n>s`, is_retryable as a `Retryable` /
`Not retryable` pill, plus abort_reason and partial chunks/tokens on
stream-error variants.

The expanded swimlane drawer covers full session history. `loadExpandedSessions`
passes `from = new Date(0).toISOString()` so all-time sessions return.
Real pagination via `loadMoreExpandedSessions` with
`EXPANDED_DRAWER_PAGE_SIZE = 25`. The footer carries an adaptive count
preamble, "Show older sessions" load-more button, and "View in
Investigate →" deep-link.

### Event detail drawer

`dashboard/src/components/fleet/EventDetailDrawer.tsx` — standalone
right-slide drawer (520px) for a single event opened from the live
feed (independent of `SessionDrawer`). Tabs: Details, Prompts. The
Details tab shows a metadata grid plus the JSON payload via the shared
`<SyntaxJson>` component. The Prompts tab loads `PromptViewer` /
`EmbeddingsContentViewer` if `event.has_content`.

### Live feed

`dashboard/src/components/fleet/LiveFeed.tsx` renders `FeedEvent[]`
capped at `FEED_MAX_EVENTS` from the back, then optionally filtered by
`activeFilter`.

Columns: Flavor, Session, Type, Detail, Time. Default sort is `time desc`.
Clicking any non-time column header changes the sort and auto-pauses the
feed via `onPause()`.

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

`dashboard/src/hooks/useHistoricalEvents.ts` calls `fetchBulkEvents({
from, limit: 500, offset })` (which hits `GET /v1/events`) and returns
the chronological list. Fleet groups the result by `session_id` to
populate `eventsCache` and seeds `feedEvents` from the historical data
so the live feed is not empty on page load. After the initial load, no
per-session HTTP fetches happen — WebSocket events flow into the same
caches (D066, D071).

### Timeline

`dashboard/src/components/timeline/Timeline.tsx` composes flavor rows
with expand-in-place, a shared time axis, and a resizable left panel.

`leftPanelWidth: number` state initialises from
`localStorage[LEFT_PANEL_WIDTH_KEY]` clamped to `[LEFT_PANEL_MIN_WIDTH,
LEFT_PANEL_MAX_WIDTH]`. Default is `LEFT_PANEL_DEFAULT_WIDTH` (320).
A 6px-wide drag handle is rendered absolutely on the right edge of the
time-axis row's sticky left spacer; the time-axis row is `position:
sticky; top: 0` against Fleet.tsx's outer scroller, so the handle stays
visible regardless of vertical scroll position. Mouse drag attaches
`mousemove` + `mouseup` handlers to `document` and clamps the new width
on every move; the resulting width is written to localStorage on every
drag update.

`leftPanelWidth` flows down as a prop through `SwimLane` →
`SessionEventRow`. Both components include `leftPanelWidth` in their
`React.memo` comparators so a drag invalidates every row immediately.

Fixed-width canvas: `TIMELINE_WIDTH_PX = 900`. The xScale maps the
selected range domain to `[0, 900]` for every time range. Wider ranges
produce denser circles, which is the correct trade-off: fixed pixel
space, no horizontal scrollbar, label intervals adapt to the range
(D076).

`TimeAxis.tsx` renders 6 evenly-spaced relative labels (e.g.
`48s 36s 24s 12s now` for a 1-minute range) at fractions
`[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]`. The `formatRelativeLabel(ms)` helper
picks the unit suffix: `s`, `m`, or `h`. No D3 tick generation — D3 is
used for `d3-scale` and `d3-time` math only (Rule 16, D077).

A vertical grid line overlay on Timeline.tsx renders 6 thin vertical
lines at the same fractions as the time-axis labels, dropping from the
top of the inner content div to the bottom of the last flavor row. The
rightmost line is highlighted as the "now" line in `var(--accent)`; the
rest are `var(--border)` at low opacity. Constrained to the right-panel
area only (`left: leftPanelWidth, width: timelineWidth`).

### SwimLane

`dashboard/src/components/timeline/SwimLane.tsx` — flavor row: collapsed
(48px, aggregated events) + expanded (session sub-rows), chevron toggle.

`SessionEventRow.tsx` — session row (40px): pulsing dot, ID, state
badge, tokens, events on time axis.

`EventNode.tsx` — event circles: 24px (session rows), 20px (flavor
rows), lucide icons, CSS tooltip, hover scale.

`SwimLane`, `SessionEventRow`, and `EventNode` are wrapped in
`React.memo` with custom comparators that explicitly include
`activeFilter` and `leftPanelWidth`. Time-scale updates use
`requestAnimationFrame` throttling so the swimlane redraws at most once
per frame instead of once per WebSocket message. `EventNode` opacity is
driven by React state (`isVisible && mounted`) so the fade-in transition
is reproducible.

### Fleet panel sidebar

`dashboard/src/components/fleet/FleetPanel.tsx` (240px) renders
section headers (uppercase tracked), fleet overview, session states
(large counts), flavor list (active border), policy events, directive
activity, and CONTEXT facets.

CONTEXT facets render one filterable group per `context_facets` key
with 2+ values (single-value facets are skipped); click-to-toggle with
`onContextFilter`; clear-all `X` in the header when filters are
active.

Per-flavor `Directives` icon button appears alongside the `Stop All`
icon button when a flavor has registered custom directives. Both
buttons are icon-only (Zap and OctagonX from lucide-react) so they
don't push the flavor name to truncate at the 240px sidebar width.
Clicking opens a Dialog with one `DirectiveCard` per directive.

DIRECTIVE ACTIVITY section shows the 5 most recent `directive` and
`directive_result` events with a colored status dot (green for
`directive_result`, purple for `directive`), `flavor · truncated session
id`, and timestamp. Hides BOTH header and body when the recent-activity
buffer is empty.

`applyUpdate(update: FleetUpdate)` snapshots whether the session's
flavor is already in the store BEFORE mutating flavors. If
`update.type === "session_start"` and the flavor is new, the store
fires `fetchCustomDirectives()` and patches the result into the
`customDirectives` slice. The new `FlavorItem` picks up the resulting
Directives icon button automatically because `FleetPanel` reads
`customDirectives` via a `useFleetStore` selector. Best-effort —
failures are swallowed.

### Directives page

`dashboard/src/pages/Directives.tsx` — dedicated page. Header + flavor
`Select` + search input. Renders one `DirectiveCard` per known custom
directive (loaded from `GET /v1/directives/custom`).

`DirectiveCard` is shared with the FleetPanel flavor-row dialog and the
SessionDrawer Directives tab. Renders the directive name, description,
parameter inputs (string / int / float / bool / select via Radix
Select), and a Run button. The button targets either a single session
(`sessionId` prop) or every active+idle session of a flavor (`flavor`
prop). Mutually exclusive: the session drawer never passes `flavor` and
the FleetPanel never passes `sessionId`.

### Settings page

`dashboard/src/pages/Settings.tsx` carries the access token CRUD UI.
List, create, revoke, rename. Plaintext is shown once at creation and
never recoverable afterwards. Token name badge renders on sessions in
Fleet, Investigate, and the session drawer so operators can trace
which access token opened each session.

### Theme system

Two themes shipped: neon dark and clean light. Defined entirely in
`dashboard/src/styles/themes.css` via CSS variables. The `useTheme`
hook toggles a class on the `html` element and persists to
`localStorage[THEME_STORAGE_KEY]`.

`globals.css` and `themes.css` are never casually edited (Rule 15).
Tests run under both theme projects via Playwright's `projects` config
(Rule 40c.3) and assertions are theme-agnostic.

### Constants

`dashboard/src/lib/constants.ts` is the single source of truth for
tunable magic numbers:

| Constant | Value | Purpose |
|---|---|---|
| `FEED_MAX_EVENTS` | 500 | Live feed display buffer cap |
| `PAUSE_QUEUE_MAX_EVENTS` | 1000 | Pause queue cap |
| `FEED_INITIAL_LOAD` | 100 | Initial fleet store load size |
| `FEED_MIN_HEIGHT` | 120 | Live feed resize lower bound |
| `FEED_MAX_HEIGHT` | 600 | Live feed resize upper bound |
| `FEED_DEFAULT_HEIGHT` | 240 | Initial feed height |
| `FEED_HEIGHT_STORAGE_KEY` | `flightdeck-feed-height` | localStorage key |
| `FEED_COL_WIDTHS_KEY` | `flightdeck-feed-col-widths` | localStorage key |
| `FEED_COL_DEFAULTS` | `{flavor:120, session:80, type:96, detail:400, time:80}` | Default column widths |
| `LEFT_PANEL_MIN_WIDTH` | 200 | Resizable swimlane left panel lower bound |
| `LEFT_PANEL_MAX_WIDTH` | 500 | Upper bound |
| `LEFT_PANEL_DEFAULT_WIDTH` | 320 | Initial width if no localStorage value |
| `LEFT_PANEL_WIDTH_KEY` | `flightdeck-left-panel-width` | localStorage key |
| `SESSION_ROW_HEIGHT` | 48 | Two-line session row height |
| `TIMELINE_WIDTH_PX` | 900 | Fixed event-circles canvas width |
| `TIMELINE_RANGE_MS` | `{1m: 60_000, 5m: 300_000, 15m: 900_000, 30m: 1_800_000, 1h: 3_600_000}` | Range labels → ms |
| `THEME_STORAGE_KEY` | `flightdeck-theme` | Theme persistence key |
| `EXPANDED_DRAWER_PAGE_SIZE` | 25 | Swimlane expanded-drawer pagination |

### Models registry

`dashboard/src/lib/models.ts`:

- `ANTHROPIC_MODELS: Set<string>` — exact known Anthropic model IDs.
- `OPENAI_MODELS: Set<string>` — exact known OpenAI model IDs.
- `getProvider(model): "anthropic" | "openai" | "unknown"` — O(1) Set
  lookup with prefix fallback (`claude-`, `gpt-`, `o1`, `o3`, `o4`).

Single source of truth for provider detection used by the policy
degrade dropdown, PromptViewer, session drawer, live feed rows, and
analytics legend.

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
session map, WebSocket stream, customDirectives slice, expanded-drawer
session pagination.

`dashboard/src/hooks/useWebSocket.ts` reconnects with exponential
backoff: 1s → 2s → 4s, capped at 30s.

---

## Event Types

`sensor/flightdeck_sensor/core/types.py::EventType` enum lists every
event the sensor emits. Inbound directives are NOT event types — they
arrive in the response envelope of `POST /v1/events` (see Directives
section); the sensor's acknowledgement is the `DIRECTIVE_RESULT`
event.

17 emitted event types:

`SESSION_START`, `SESSION_END`, `PRE_CALL`, `POST_CALL`, `TOOL_CALL`,
`EMBEDDINGS`, `LLM_ERROR`, `POLICY_WARN`, `POLICY_DEGRADE`,
`POLICY_BLOCK`, `DIRECTIVE_RESULT`, `MCP_TOOL_LIST`, `MCP_TOOL_CALL`,
`MCP_RESOURCE_LIST`, `MCP_RESOURCE_READ`, `MCP_PROMPT_LIST`,
`MCP_PROMPT_GET`.

### `session_start`

Carries the D115 identity 5-tuple plus `flavor`, `framework`, `model`,
`agent_type`, and an optional `context` dict (orchestration, git,
frameworks, hostname, OS, Python version, k8s details). Set-once: the
worker's `UpsertSession ON CONFLICT` deliberately omits `context` on
subsequent writes.

### `session_end`

Marks the session terminal with `state=closed`, stamps `ended_at`. Orphan
`session_end` for a session_id Flightdeck has never seen is rejected at
ingestion (D2).

### `pre_call`

Optional pre-call event emitted before the LLM request goes out. Carries
the estimated token count for budget-tracking observability. Many
sensor configurations omit this and rely on `post_call` only.

### `post_call`

The primary LLM-call event. Carries `tokens_input`, `tokens_output`,
`tokens_total`, `tokens_cache_read`, `tokens_cache_creation`,
`latency_ms`, `model`, and `framework`. When `stream=true` on the
underlying request, the payload also carries:

```json
"streaming": {
  "ttft_ms":         142,
  "chunk_count":     38,
  "inter_chunk_ms":  {"p50": 12, "p95": 47, "max": 109},
  "final_outcome":   "completed",
  "abort_reason":    null
}
```

`final_outcome` is `"completed"` or `"aborted"`. `abort_reason` is set
on aborted streams (`"client_aborted"`, `"provider_error"`, etc.). The
streaming sub-object is omitted entirely for non-streaming calls.

### `tool_call`

Tool-use events. For Anthropic and OpenAI tool-use messages, the sensor
emits one `tool_call` per tool invocation in the response. Carries
`tool_name`, optionally `tool_input` (when `captureToolInputs=true` for
the plugin or `capture_prompts=true` for the sensor), `tool_result` (when
the next assistant turn shows the tool's output and capture is on).

### `embeddings`

Emitted by `client.embeddings.create` (OpenAI), `litellm.embedding` /
`litellm.aembedding`, and `LangChain.OpenAIEmbeddings.embed_*`
transitively. Anthropic has no native embeddings API; routing through
litellm → Voyage is the supported path.

Token accounting carries input tokens only (`tokens_output=0`). When
`capture_prompts=true`, `payload.content.input` carries the request's
`input` parameter (string or list of strings) which round-trips into
`event_content.input`.

### `llm_error`

Structured error event with a 14-entry taxonomy:

| `error_type` | HTTP | Description | OTel mapping | `is_retryable` |
|---|---|---|---|---|
| `rate_limit` | 429 | Request-rate limit exceeded | `rate_limit_error` | ✅ |
| `quota_exceeded` | 429 | Billing / monthly quota exceeded | `quota_exceeded_error` | ❌ |
| `context_overflow` | 400 | Input exceeded model context window | `context_length_exceeded` | ❌ |
| `content_filter` | 400 | Provider content filter blocked request | `content_filter_error` | ❌ |
| `invalid_request` | 400 | Other validation failure | `invalid_request_error` | ❌ |
| `authentication` | 401 | Missing / invalid credential | `authentication_error` | ❌ |
| `permission` | 403 | Credential lacks permission | `permission_error` | ❌ |
| `not_found` | 404 | Resource (model, endpoint) not found | `not_found_error` | ❌ |
| `request_too_large` | 413 | Request body too large | `request_too_large_error` | ❌ |
| `api_error` | 500 | Provider internal error | `api_error` | ✅ |
| `overloaded` | 529 / 503 | Anthropic 529, OpenAI engine overloaded | `overloaded_error` | ✅ |
| `timeout` | — | Client-side timeout before response | `timeout_error` | ✅ |
| `stream_error` | — | Mid-stream error after a 200 response | `stream_error` | ⚠ case-by-case |
| `other` | — | Fallback for unknown | `other` | ❌ |

Plus `provider`, `http_status`, `provider_error_code`, `request_id`,
`retry_after`, `is_retryable`. Mid-stream aborts emit
`error_type=stream_error` with `partial_chunks` and `partial_tokens_*`
so token accounting reflects work done before the failure.

### `policy_warn`

Emitted when token-budget enforcement crosses the warn threshold.
Two emission paths:

- **Local** — sensor `init(limit=...)` threshold crossed. `_pre_call`
  emits with `source="local"`, the call proceeds. Local thresholds
  fire WARN only — never BLOCK or DEGRADE (D035). Fires once per
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
receives. Decision event with `source="server"` (D035 — local never
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
Sensor calls `EventQueue.flush()` synchronously to ensure the event
lands before the process exit, then raises `BudgetExceededError`. The
caller's call never reaches the provider.

Payload fields: `source` (always `"server"` — D035), `threshold_pct`
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

### MCP event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`)

First-class observability for Model Context Protocol (MCP) traffic. The
sensor patches `mcp.client.session.ClientSession` directly (D116) so
every framework that mediates MCP through the official SDK
(LangChain via `langchain-mcp-adapters`, LangGraph via the same,
LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`,
plus the raw mcp SDK) routes through one patch surface and emits
the same six event types.

The Claude Code plugin emits **only** `MCP_TOOL_CALL` (D1 in PR #29
— `mcp__<server>__<tool>` is the only MCP namespace visible from
the hook surface; resource reads, prompt fetches, and list
operations are below the hook layer). Both surfaces share the same
wire schema for tool calls so the dashboard renders identically
across origin.

**Lean payload** (D2). MCP events drop the LLM-baseline fields
(`tokens_input`, `tokens_output`, `tokens_total`, `tokens_cache_*`,
`model`, `latency_ms`, `tool_input`, `tool_result`, `has_content`)
and carry only MCP-specific fields:

| Field | List events | tool_call | resource_read | prompt_get |
|---|---|---|---|---|
| `server_name` | ✓ | ✓ | ✓ | ✓ |
| `transport` | ✓ | ✓ | ✓ | ✓ |
| `duration_ms` | ✓ | ✓ | ✓ | ✓ |
| `count` | ✓ | — | — | — |
| `tool_name` (top-level) | — | ✓ | — | — |
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

**Server fingerprint at session level**. `ClientSession.initialize()`
is patched to capture the `InitializeResult` and stamp an
`MCPServerFingerprint` onto the sensor session. When the sensor's
session_start ships AFTER the initialize call, `context.mcp_servers`
carries the full fingerprint list — name, transport, protocol_version
(str | int, preserved verbatim per Override 5), version, capabilities,
instructions — which the worker writes once into `sessions.context`.
For servers initialised AFTER `session_start` (the common case for
late-attaching MCP frameworks), the sensor emits a wire event
`mcp_server_attached` carrying the same fingerprint plus an
`attached_at` timestamp; the worker projects it into
`sessions.context.mcp_servers` via an idempotent UPSERT-with-dedup
keyed on `(name, server_url)` (D140). The dashboard's SessionDrawer
re-fetches the session detail when an `mcp_server_attached` event
arrives on the matching session over the existing fleet WebSocket,
so the MCP SERVERS panel populates within 2-3s of the attach for
in-flight sessions. Emission is fire-and-forget per Rule 27 —
failure to emit never breaks the agent's hot path.

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

`MCP_TOOL_CALL` and `MCP_PROMPT_GET` use per-field truncation
markers in `payload.extras` rather than has_content routing, since
their captured shapes are smaller and inlining is always cheap.

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
whose `payload.error` is populated so failures surface without
expanding the row. The session detail drawer's MCP SERVERS panel
lists every fingerprint from `context.mcp_servers`.

### Per-event `framework` field

Every event carries a bare-name `framework` field (`langchain`,
`crewai`, `langgraph`, ...) populated at sensor `init()` from
`FrameworkCollector` via `Session.record_framework`. Higher-level
framework wins over SDK transport. The versioned form
(`langchain/0.3.27`) lives in `context.frameworks[]` for diagnostic
detail; the bare name lives on the per-event field.

`framework=null` is valid and means no classifier matched at sensor
init. The Claude Code plugin emits `framework=null` because it
observes Claude Code itself, which is the agent runtime, not a Python
framework.

---

## Content Capture

Event payloads carry two classes of captured content, each gated by an
independent knob (D019, D103). The two-knob split is deliberate: the
privacy calculus and the safe handling differ per class, and a single
knob would either strip too much or too little for the developer use case
the plugin targets.

### `captureToolInputs` — tool-call arguments

Governs tool-call arguments: file paths, command strings, query strings,
search patterns, and prompt strings on tools that accept one.

Every tool_input passes through the sanitiser before emission. The
sanitiser is a strict whitelist implemented in
`plugin/hooks/scripts/observe_cli.mjs::sanitizeToolInput`:

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
embedding inputs, and the output of each tool the LLM invoked.

No sanitiser applies. Outputs can carry arbitrary prompt-like content
(model-generated text, tool-fetched web pages, search results) and a
whitelist cannot express "keep the parts that are safe" without mangling
the structure or leaking the content it was trying to protect. The knob
is all-or-nothing per session.

When `capture_prompts=false`, every content field on every event type is
zeroed: `has_content=false`, `content=null`. The event still ships, so
the dashboard shows the session, token counts, and metadata; only the
bodies are absent. The Prompts tab renders "Prompt capture is not
enabled for this deployment."

Plugin default: ON (D103). A developer running `claude` locally is
observing their own conversation; an empty Prompts tab would make the
feature useless without improving privacy. Python sensor default: OFF
(D019). The sensor runs inside production agents where content may carry
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
empty data. Not 403. 404 — the resource does not exist (Rule 37).

---

## Directives

### Built-in actions

| Action | Source | Sensor behaviour |
|---|---|---|
| `shutdown` | Operator (`POST /v1/directives` with `session_id`) | Raises `DirectiveError` after `grace_period_ms`; triggers `session.teardown()` |
| `shutdown_flavor` | Operator (`POST /v1/directives` with `flavor`, fans out via `GetActiveSessionIDsByFlavor`) | Same as `shutdown` per session |
| `degrade` | Worker policy evaluator | Sets `_forced_degrade` + `degrade_to`; subsequent `check()` returns `DEGRADE` |
| `warn` | Worker policy evaluator | Fires `WARN` callback once per session at `warn_at_pct` (fire-once rule) |
| `policy_update` | Operator | Calls `PolicyCache.update(policy_dict)`; clears `_forced_degrade` |
| `custom` | Operator (with registered fingerprint) | Validates payload via `DirectivePayloadSchema`, looks up handler, runs with timeout, emits `directive_result` |

`degrade` / `warn` / `policy_update` are NOT user-creatable via
`POST /v1/directives` — they are server-side directives written by the
worker's policy evaluator when a session crosses a threshold, OR by the
policy admin endpoints. The only way to trigger a `degrade` is to create
a token policy and let the worker fire it on the next `post_call` event.

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
For shutdown variants the sensor calls `EventQueue.flush()` synchronously
before raising the shutdown flag so the acknowledgement is not lost when
the process exits. Custom handlers emit `directive_result` with
`directive_status` of `success` or `error` after handler return.

### Observer-session class

Plugin payloads set `context.supports_directives=false` on
`session_start`. The dashboard hides the Stop Agent button for observer
sessions and gates the Fleet Stop All control on at least one
directive-capable session in the flavor. `isClaudeCodeSession` fallback
covers rows whose payload omitted the explicit `supports_directives`
flag (D109).

---

## MCP Protection Policy

The MCP Protection Policy gates which Model Context Protocol servers an
agent is allowed to talk to. It rides on the same `ClientSession` patch
surface that powers MCP first-class observability (D117) — the policy
machinery evaluates each `call_tool` against a fingerprinted server
identity and emits warn / block decisions through the standard event
pipeline. The policy is fetched once per session at sensor `init()`
(Python) or `SessionStart` (Claude Code plugin) and cached for the
session's lifetime; mid-session policy updates apply at the next
`session_start`.

### Identity model

Server identity is the pair `(URL, name)`. The URL is the security key
— two servers with the same URL but different declared names are the
same enforcement target. The name is the display label and the
tamper-evidence axis: when an agent declares a server with a known URL
under a new name, the sensor emits a `mcp_server_name_changed` event so
operators can see drift, but the policy decision still resolves on the
URL (D127).

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
The first 16 hex characters are the display fingerprint; the full hash
is the storage key. The 0x00 separator prevents
`("https://a.com", "bservice")` and `("https://a.combservice", "")`
from colliding.

### Two-scope policy model

One **global** policy plus zero or more **per-flavor** policies. The
global policy carries the **mode** (allowlist or blocklist) and a list
of entries; per-flavor policies carry only allow / deny entry deltas
against whatever the global resolves to. A flavor policy never carries
its own mode (D134).

On install the platform auto-creates an empty global policy in
`blocklist` mode with zero entries — fully permissive by default. No
operator action is required for MCP traffic to keep flowing on a fresh
deployment; locking down a flavor is opt-in.

### Per-server resolution

For an `(URL, name)` evaluated against `(global, flavor)`:

1. If the per-flavor policy has an entry whose canonical URL matches,
   use that entry's enforcement decision (allow / deny + warn / block /
   interactive).
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
- `interactive` — Claude Code plugin only. The plugin's `SessionStart`
  hook prompts the user via `PermissionRequest` for unknown servers in
  `allowlist` mode. The sensor's per-call path never sees `interactive`
  (the plugin resolves the prompt before the session starts; resolved
  decisions become standard allow / deny entries on the policy or are
  remembered locally — see Plugin remembered decisions below).

`block_on_uncertainty` is a per-flavor boolean toggle, default false,
only meaningful in `allowlist` mode. When true, the resolution
algorithm's step 3 fallback becomes "block + emit `policy_mcp_block`"
instead of the standard allowlist-mode block. The semantic difference
is auditing: `block_on_uncertainty=true` means "I want a block decision
recorded against this URL the first time it's seen so I can promote it
to a deliberate allow." Under `blocklist` mode the toggle is ignored
because the mode default is already permissive.

### Storage schema

> **Binding contract.** The schema below is the spec for migration
> `000018_mcp_protection_policy.{up,down}.sql`. The migration ships
> under `docker/postgres/migrations/` only; the Helm chart picks it
> up via `helm/Makefile sync-migrations` per D136. Step 2 implements
> the schema byte-for-byte. Any deviation — column rename, type
> change, additional or removed constraint, index difference —
> requires a new `DECISIONS.md` entry recording the pivot per
> Rule 42 BEFORE the migration is written.

```sql
CREATE TABLE mcp_policies (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                 TEXT NOT NULL CHECK (scope IN ('global', 'flavor')),
    scope_value           TEXT,                                 -- NULL for global, flavor name for flavor
    mode                  TEXT CHECK (mode IN ('allowlist', 'blocklist')),  -- NULL on flavor rows
    block_on_uncertainty  BOOLEAN NOT NULL DEFAULT FALSE,
    version               INT NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((scope = 'global' AND scope_value IS NULL AND mode IS NOT NULL)
        OR (scope = 'flavor' AND scope_value IS NOT NULL AND mode IS NULL))
);

CREATE UNIQUE INDEX mcp_policies_scope_idx
    ON mcp_policies (scope, COALESCE(scope_value, ''));

CREATE TABLE mcp_policy_entries (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id             UUID NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE,
    server_url_canonical  TEXT NOT NULL,
    server_name           TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,        -- 16-char hex (display); full sha256 not stored
    entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('allow', 'deny')),
    enforcement           TEXT CHECK (enforcement IN ('warn', 'block', 'interactive')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX mcp_policy_entries_policy_fp_idx
    ON mcp_policy_entries (policy_id, fingerprint);
CREATE INDEX mcp_policy_entries_url_idx
    ON mcp_policy_entries (server_url_canonical);

CREATE TABLE mcp_policy_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id   UUID NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE,
    version     INT NOT NULL,
    snapshot    JSONB NOT NULL,                 -- full policy + entries at this version
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID REFERENCES access_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX mcp_policy_versions_policy_version_idx
    ON mcp_policy_versions (policy_id, version);

CREATE TABLE mcp_policy_audit_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id    UUID REFERENCES mcp_policies(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN (
        'policy_created', 'policy_updated', 'policy_deleted',
        'mode_changed', 'entry_added', 'entry_removed',
        'block_on_uncertainty_changed'
    )),
    actor        UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mcp_policy_audit_log_policy_idx
    ON mcp_policy_audit_log (policy_id, occurred_at DESC);
```

The audit log table records **policy mutations only** — actor + diff
of operator-initiated changes. Sensor-observed system state (name
drift, decision events) ships through the standard event pipeline as
typed event rows, not as audit log entries (D131).

`mcp_policies.version` is bumped on every PUT; the prior snapshot is
written to `mcp_policy_versions` so an operator can diff or roll back.
Soft-delete is intentionally not implemented — a deleted flavor policy
means the global takes over, and the deletion event is preserved in
the audit log.

### Fetch and cache lifecycle

**Sensor (Python).** The control-plane client fetches the active
policy at `init()` synchronously, alongside the existing token policy
preflight. Result is cached on the `Session` object for the session's
lifetime. A `policy_update` directive received in a response envelope
refreshes the cache in place; the new policy applies at the next
`session_start` (in-flight sessions keep the policy that was active at
their start). Fail-open per Rule 28: if the control plane is
unreachable AND `FLIGHTDECK_UNAVAILABLE_POLICY=continue` AND
`block_on_uncertainty` is not in force on a relevant flavor, the agent
proceeds with no enforcement.

**Plugin (Claude Code).** The `SessionStart` hook fetches the policy
applicable to the active flavor. Cached on disk at
`~/.claude/flightdeck/mcp_policy_cache.json`, keyed by token. TTL
defaults to one hour; subsequent `SessionStart` invocations reuse the
cache until the TTL expires, at which point the next start re-fetches.
Cache miss + control plane unreachable produces the same fail-open
behaviour as the sensor.

**Dashboard.** Direct REST against the new policy endpoints (see
Enforcement contracts below). No client-side cache beyond the standard
React-Query window.

### Enforcement contracts

**Sensor.** The MCP interceptor's `call_tool` patch (D117) calls
`PolicyCache.evaluate_mcp(server_url, server_name, tool_name)` before
invoking the wrapped method. The result is one of `allow` / `warn` /
`block`. On `warn` the sensor emits `policy_mcp_warn` and proceeds. On
`block` the sensor emits `policy_mcp_block`, flushes the event queue
synchronously (so the block lands at the dashboard before the agent
sees the failure), and raises `flightdeck.MCPPolicyBlocked` — a typed
exception that frameworks surface as a tool-call failure to the
agent's reasoning loop (D130). The exception carries `server_url`,
`server_name`, `fingerprint`, `policy_id`, and `decision_path` so the
agent (or its surrounding harness) can render an actionable failure
message.

**Plugin.** Enforcement is split across three Claude Code hooks
(D139). The plugin uses one dispatcher script
(`plugin/hooks/scripts/observe_cli.mjs`) registered against
multiple hook events; the script branches on `hook_event_name`.

- **`SessionStart`** — reads `.mcp.json` (the existing
  `loadMcpServerFingerprints(cwd)` helper handles
  `~/.claude.json` overrides), fingerprints each declared server,
  and batch-fetches global + flavor policies in parallel via
  `Promise.all` against `GET /v1/mcp-policies/global` +
  `GET /v1/mcp-policies/{flavor}`. Cached to a per-session marker
  file at `$TMPDIR/flightdeck-plugin/mcp-policy-<session_id>.json`
  so subsequent `PreToolUse` invocations don't repeat the HTTP
  fetch on the agent hot path. SessionStart additionally emits
  `policy_mcp_warn` / `policy_mcp_block` events for any
  non-`allow` decision so operators see fleet-level enforcement
  activity at session boot. Fail-open per Rule 28: any HTTP error
  produces an empty cache and per-call evaluation falls through
  to mode-default.
- **`PreToolUse`** — the per-call gate. When `tool_name` matches
  the `mcp__<server>__<tool>` shape: parse the server segment,
  resolve to a fingerprint, read the per-session policy cache AND
  read the remembered-decisions file fresh (NOT cached at
  `SessionStart` — concurrent Claude Code sessions on the same
  machine see each other's remembered decisions in real time),
  and emit a hook decision:
  - **block** decision → return `{decision: "deny", reason:
    "..."}`. Claude Code surfaces the failure to the agent reasoning
    loop. Block in plugin context is the per-call deny rather than
    a session-wide unreachability flag, mirroring the sensor's
    architecture of "block at call_tool" rather than "block at
    initialize" (D130).
  - **unknown-allowlist + interactive** decision → return
    `{decision: "ask"}`. Claude Code's built-in approval flow
    prompts the user yes / no.
  - **allow** / **warn** / **remembered allow** → return
    normally; Claude Code proceeds.
- **`PostToolUse`** — the de-facto-approval write path. When
  an `mcp__<server>__<tool>` call succeeded AND the server was
  unknown-allowlist on this session AND no remembered decision
  exists yet for the active token: write the
  remembered-decisions file AND emit
  `mcp_policy_user_remembered` event. Reactive yes-and-remember
  per D139 — Claude Code's `ask` flow returns yes/no only with
  no built-in "remember" affordance, so the plugin treats a
  successful post-`ask` call as evidence of de-facto approval.
- **`Stop`** — cleans up the per-session policy marker file.

Operator-side deny entries always override remembered allows.
A remembered "yes" the user gave on day 1 stops applying the
moment the operator pushes a flavor deny entry for that server
— the next `SessionStart` re-fetches the policy and `PreToolUse`
sees the deny first.

**Control-plane API.** All 17 endpoints live under `/v1/mcp-policies`
(kebab-plural, matching the `/v1/access-tokens` convention).
Authentication uses the standard Bearer-token middleware that
covers the rest of the API. Endpoints carry one of two scope
designations:

- **Read-only (sensor / plugin hot path).** Accept any valid bearer
  token. Idempotent and cacheable. Used by sensors at `init()` and
  by the Claude Code plugin at `SessionStart`.
- **Admin-grade.** Same `gate()` middleware as token-policy CRUD —
  there is no separate admin-scope middleware in the codebase
  (token-based admin scoping is documented as not implemented;
  treat any production token as full-access). Operators are
  expected to firewall mutation routes at the ingress layer if
  separation-of-duties matters. The designation is descriptive and
  documented per endpoint so a future scoped-admin middleware can
  enforce it without contract change.

#### Read + resolve (read-only scope)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/mcp-policies/global` | Fetch the global policy + entries. Always returns 200 (auto-created at API boot per D133) |
| `GET` | `/v1/mcp-policies/:flavor` | Fetch the flavor policy + entries. 404 when no flavor policy exists |
| `GET` | `/v1/mcp-policies/resolve` | Sensor / plugin preflight. Query params `flavor`, `server_url`, `server_name`; returns the resolved decision (`allow` / `warn` / `block`) and the `decision_path` that produced it (`flavor_entry` / `global_entry` / `mode_default`). GET-only — idempotent, safe, cacheable |

#### Write (admin-grade)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mcp-policies/:flavor` | Create a new flavor policy. The global is auto-created on install and cannot be POST'd. 409 if the flavor policy already exists |
| `PUT` | `/v1/mcp-policies/global` | Replace global policy state — mode, entries, `block_on_uncertainty`. Bumps `version`, writes a `mcp_policy_versions` snapshot, writes an audit-log entry. All four operations atomic in one transaction |
| `PUT` | `/v1/mcp-policies/:flavor` | Replace flavor policy state — entries, `block_on_uncertainty` (mode is global-only per D134). Same auto-version + audit semantics as the global PUT |
| `DELETE` | `/v1/mcp-policies/:flavor` | Delete a flavor policy. Global cannot be deleted. The audit-log entry survives via `ON DELETE SET NULL` on `policy_id`; the deletion event is preserved |

#### History (admin-grade)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/mcp-policies/:flavor/versions` | List version metadata (no full snapshots) for the flavor policy. `?limit=` (max 200, default 50), `?offset=` |
| `GET` | `/v1/mcp-policies/:flavor/versions/:version_id` | Full snapshot of one historical version |
| `GET` | `/v1/mcp-policies/:flavor/diff` | Structured diff between two versions. Query params `from=<version>` and `to=<version>` (integer version numbers, not UUIDs). Server computes the diff so consumers don't reimplement |
| `GET` | `/v1/mcp-policies/:flavor/audit-log` | Mutation history for the flavor policy. Query params `from` (ISO 8601), `to`, `event_type`, `limit`, `offset` |
| `GET` | `/v1/mcp-policies/global/audit-log` | Same as above, scoped to the global policy |

#### Power features (admin-grade)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mcp-policies/:flavor/dry_run` | Replay last N hours of `mcp_tool_call` events against the proposed policy in the request body. Returns per-server `would_allow` / `would_warn` / `would_block` / `unresolvable` counts. `?hours=` defaults to 24, max 168 (7 days). Does NOT mutate state. See "Dry-run engine" below |
| `GET` | `/v1/mcp-policies/:flavor/metrics` | Aggregated `policy_mcp_warn` + `policy_mcp_block` events scoped to the flavor's policy. `?period=` accepts `24h` / `7d` / `30d`. Returns empty buckets until step 4 ships the events |
| `POST` | `/v1/mcp-policies/:flavor/import` | Replace flavor policy state from YAML body (`Content-Type: application/yaml`). Same atomic version + audit semantics as PUT; audit log payload carries `via=import` |
| `GET` | `/v1/mcp-policies/:flavor/export` | Serialize the current flavor policy state as YAML (`Content-Type: application/yaml`). Use the version-fetch endpoint for historical snapshots |
| `GET` | `/v1/mcp-policies/templates` | List shipped templates. Read-only; no auth scope required beyond bearer token |
| `POST` | `/v1/mcp-policies/:flavor/apply_template` | Apply a named template (`{"template": "strict-baseline"}` body) to the flavor policy. Same atomic version + audit semantics as PUT; audit log payload carries `applied_template=<name>` |

#### YAML schema (import / export)

Both import and export use the same shape, matching the README
quickstart example byte-for-byte:

```yaml
scope: flavor                     # or "global" on global export
scope_value: production           # omitted on global
mode: allowlist                   # global only; per-flavor exports
                                  # don't carry mode (D134)
block_on_uncertainty: true
entries:
  - server_url: "https://maps.example.com/sse"
    server_name: "maps"
    entry_kind: allow             # "allow" | "deny"
    enforcement: block            # "warn" | "block" | "interactive"
                                  # — only meaningful on deny entries
                                  # in a blocklist mode + on allow
                                  # entries that explicitly upgrade
                                  # an unlisted server's default
```

Import is idempotent-by-PUT-replace: the entire policy + entries
are replaced atomically with the imported content. Bumps version.
Writes audit-log entry with `event_type='policy_updated'` and
`payload.via='import'`.

#### Boot-time auto-create

`store.EnsureGlobalMCPPolicy(ctx)` runs at API boot per D133. The
SQL is an idempotent INSERT:

```sql
INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
SELECT 'global', NULL, 'blocklist', false
WHERE NOT EXISTS (SELECT 1 FROM mcp_policies WHERE scope = 'global');
```

Race-safe under read-committed because the unique index
`(scope, COALESCE(scope_value, ''))` rejects a concurrent second
insert; on `pgconn.PgError.Code = '23505'` (unique_violation) the
caller treats it as "already created" and proceeds. API startup
logs `INFO ensure global mcp policy at boot complete` on first
boot and continues silently on subsequent boots.

#### Dry-run engine

The dry-run endpoint replays historical MCP traffic against a
proposed policy. The replay strategy (D137) joins the events
table to `sessions.context.mcp_servers` to recover the server
URL + fingerprint per event:

```
SELECT events.id, events.payload->>'server_name' AS server_name,
       (sessions.context->'mcp_servers')::jsonb AS server_fingerprints
  FROM events
  JOIN sessions ON sessions.session_id = events.session_id
 WHERE events.event_type = 'mcp_tool_call'
   AND events.occurred_at >= NOW() - $1 * INTERVAL '1 hour'
 ORDER BY events.occurred_at DESC
 LIMIT 10000
```

For each row the handler walks `server_fingerprints` looking for
a name match, recovers the canonical URL, and evaluates against
the proposed policy via the same per-server resolution algorithm
the live `ResolveMCPPolicy` uses. Events whose session lacks
`context.mcp_servers` (older sessions, sessions where flightdeck
init ran AFTER MCP init) bucket as `unresolvable_count` rather
than silently skipping. The 10000-row hard cap bounds replay cost
on high-volume fleets; query results are sampled descending by
time so the most recent events always weigh.

When the proposed policy's `block_on_uncertainty=true` AND the
mode is `allowlist`, fall-through cases (URL not in any entry)
count toward `would_block` rather than `would_allow` — the dry-
run preview matches what the live enforcement would do.

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
reflect well-known MCP server endpoints as of the v0.6 release;
operators are expected to verify against their provider's current
documentation before relying on them in production. The other two
templates ship with no embedded URLs and carry no equivalent
warning.

`POST :flavor/apply_template` replaces the flavor policy state
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
(D135 step 1 / 2 winning over the local merge). The remembered
file is a private convenience for the user; the policy cache
fetched at `SessionStart` is the authoritative source. When the
operator pushes a flavor deny entry, the next `SessionStart`
re-fetches the policy and the next `PreToolUse` returns deny
regardless of what's in the remembered file.

When the user approves an unknown-allowlist server, the plugin
also emits `mcp_policy_user_remembered` to the standard event
pipeline (D139). This is operator-visibility, not policy
mutation — the dashboard shows "alice approved server X on her
dev machine" so a security team can decide whether to promote
to a real flavor allow entry. The remembered file does NOT
synchronise back to the control plane via PUT; the operator
makes the policy change deliberately if they want fleet-wide
effect.

### Event taxonomy

Four event types extend the sensor's `EventType` enum and the
worker's `events.<type>` NATS subject routing. All ride the
standard event pipeline; none are audit-log entries (D131, D140).

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
  policy decision still resolves on URL (D131).
- **`mcp_server_attached`** — emitted by the sensor every time an
  MCP server is initialised after `session_start`. Payload:
  `fingerprint`, `server_url_canonical`, `server_name`, `transport`,
  `protocol_version`, `version`, `capabilities`, `instructions`,
  `attached_at`. The worker projects it into
  `sessions.context.mcp_servers` via an idempotent UPSERT-with-dedup
  on `(name, server_url)`; the dashboard's SessionDrawer re-fetches
  the session detail when one arrives so the MCP SERVERS panel
  populates live for in-flight sessions (D140).

### Audit and versioning

Every successful mutation through `POST` / `PUT` / `DELETE
/v1/mcp-policies` writes one row to `mcp_policy_audit_log` with the
`actor` resolved from the request token, the `event_type` from the
mutation kind, and a `payload` JSONB carrying the diff (added /
removed entries, mode change, `block_on_uncertainty` flip). Every PUT
additionally bumps `mcp_policies.version` and snapshots the resulting
state into `mcp_policy_versions` so operators can diff or roll back.

The audit log is the authoritative record of operator-initiated
changes — it answers "who changed this and when." Observed system
state (decision events, name drift) lives in the events pipeline and
is queried via the standard event endpoints.

The mutation transaction is single-shot: PUT does (1) `SELECT FOR
UPDATE` of the current row + entries, (2) `UPDATE mcp_policies`
with `version = version + 1` and `updated_at = NOW()`, (3) `DELETE
mcp_policy_entries WHERE policy_id = ?` followed by `INSERT` of
the new entries, (4) `INSERT mcp_policy_versions` carrying the
resulting state as a JSONB snapshot, (5) `INSERT
mcp_policy_audit_log`, all in one `BEGIN ... COMMIT` block. Failure
of any step rolls the whole mutation back. `SELECT FOR UPDATE`
prevents version-bump races between concurrent PUTs.

The diff endpoint (`GET /v1/mcp-policies/:flavor/diff`) returns:

```json
{
  "from_version": 3,
  "to_version": 5,
  "from_snapshot": {...},
  "to_snapshot": {...},
  "diff": {
    "mode_changed": null,
    "block_on_uncertainty_changed": {"from": false, "to": true},
    "entries_added":   [{...}],
    "entries_removed": [{...}],
    "entries_changed": [{"fingerprint": "...", "before": {...}, "after": {...}}]
  }
}
```

`mode_changed` is null on flavor-policy diffs (mode is global-only
per D134) and on global-policy diffs where mode didn't move. Each
entry diff carries the full row shape so consumers don't need a
second fetch to render the diff. Server-side computation keeps the
diff logic in one place and out of every dashboard / CLI consumer.

### Soft-launch transition

The policy machinery ships in two phases to limit the blast radius of
a misconfigured allowlist on a real fleet (D133):

- **v0.6.** Sensor and plugin enforcement paths hard-code warn-only
  behaviour regardless of the configured `enforcement` value. The
  policy machinery (storage, API, dashboard, events, fingerprinting)
  ships complete; only the block path is suppressed at the agent
  boundary. `policy_mcp_warn` events fire normally; `policy_mcp_block`
  is replaced with `policy_mcp_warn` at emission with a
  `would_have_blocked=true` payload field so operators can preview
  what a real enforcement would do.
- **v0.7.** The hard-coded warn-only override is removed. Configured
  `block` enforcement raises `MCPPolicyBlocked` and emits
  `policy_mcp_block`.

`FLIGHTDECK_MCP_POLICY_DEFAULT` is the operator escape hatch. Values:
`warn` (force warn-only regardless of release) or `enforce` (honor
configured enforcement regardless of release). Documented for
operators who need to opt out (v0.7+) or opt in early (v0.6).

### Dashboard surfaces

The MCP Protection Policy management UI lives at
`/mcp-policies` as a top-level page distinct from the existing
`/policies` page (which manages token-budget policies — a
different feature). Cohabitation rather than unification keeps
each feature's mental model honest; an operator never has to
context-switch between LLM-call cost gating and MCP-server
access gating in the same screen.

#### Layout

A dismissible soft-launch banner sits at the top of the page
when `SOFT_LAUNCH_ACTIVE` is true (v0.6 default; flips to false
in v0.7). Banner copy reads "Soft launch: policy decisions
downgraded to warn-only until v0.7. Set
`FLIGHTDECK_MCP_POLICY_DEFAULT=enforce` to opt in early."
Dismissal persists per-token in `localStorage`.

Below the banner sits a tabbed scope picker — one tab per scope
the operator can edit. The Global tab is always present; one
additional tab per flavor policy the operator has access to.
Each tab shows that scope's own state. The mode toggle is
editable on the Global tab only (D134 enforced in UI; on flavor
tabs the global mode is rendered read-only as context). The
`block_on_uncertainty` toggle is editable on every tab — it's a
per-policy boolean.

Tabs preserve scroll position on switch; the URL carries the
active tab as a query param (`?tab=global` / `?tab=flavor:prod`)
so deep-links work and browser back / forward survive.

#### Per-tab panels

- **Mode toggle** (segmented control, allowlist / blocklist).
  Global tab only. Visually dominant — operators read mode
  before per-entry enforcement, so the toggle sits above the
  entry table at full width with a one-sentence explanation.
- **`block_on_uncertainty` toggle** (Switch component). Per-
  flavor + global. Only meaningful in allowlist mode; rendered
  with a low-key visual treatment when the global mode is
  blocklist (the toggle is a no-op there per D134).
- **Entry table.** Search by URL / name, sort columns,
  multi-select for bulk delete, status pill per row (allow /
  deny + enforcement override). Click a row to open the edit
  dialog. Skeleton rows during load (not bare spinner).
  Empty state copy teaches the next action: "Add your first
  allow rule to start gating this flavor" (allowlist mode) or
  "Add your first deny rule to block specific servers"
  (blocklist mode).
- **Add / edit dialog.** Form fields URL (raw), Name, kind
  (allow/deny), enforcement (warn/block/interactive/none).
  Live fingerprint preview via debounced (300ms) `GET
  /v1/mcp-policies/resolve` so the operator sees the exact
  fingerprint the server will store. Validation per the
  storage schema CHECKs (D128); errors render inline next to
  the offending field.
- **Resolve preview panel** (collapsible card at the bottom
  of each tab). Two inputs (server URL, server name) + Resolve
  button. Renders the API's `MCPPolicyResolveResult` as a
  decision-color pill matching the Fleet sidebar chroma family
  (allow=neutral, warn=amber, block=red) plus decision_path,
  scope, fingerprint. Educational — operators verify their
  policy's effective behavior before they save.
- **Version history.** Calls `GET /:flavor/versions`. Table:
  version, timestamp, actor token name, summary of changes
  derived from the corresponding audit-log row. Click a row
  to load the diff viewer. Empty state on a fresh policy:
  "Version history will appear after your first save."
- **Diff viewer.** Calls `GET /:flavor/diff?from=&to=`.
  Server-computed structural diff renders as: mode_changed
  badge (when set), block_on_uncertainty_changed badge,
  entries_added / entries_removed / entries_changed sections.
  Both snapshots accessible via expandable raw-JSON trees
  (existing `<SyntaxJson>` component).
- **Dry-run preview.** Calls `POST /:flavor/dry_run` with the
  current draft + an hours selector (24h / 7d default,
  168h max per D137). Recharts stacked-bar per server:
  would_allow / would_warn / would_block segments + an
  unresolvable_count callout. Reading: "this is what the new
  policy would have done over the last N hours."
- **Real-time metrics panel.** Calls `GET /:flavor/metrics?
  period=24h|7d|30d`. Per-server sparkline (recharts
  `<LineChart>`). Empty state pre-step-4-emission: "No
  enforcement events recorded yet for this period."
- **Bulk YAML import / export.** Plain `<textarea>` editor
  for import; submit posts to `POST /:flavor/import` and
  surfaces the API's 400 error inline next to the YAML body
  on validation failure. Export button fetches `GET
  /:flavor/export` and triggers a Blob-based download.
- **Templates picker.** Calls `GET /templates`. Three
  shipped templates (D138) render as cards with name,
  description, recommended_for. The `strict-with-common-
  allows` card surfaces the URL-maintenance warning
  prominently. Apply triggers a confirmation dialog ("This
  replaces your current policy. Continue?") before posting
  to `/apply_template`.
- **Audit trail.** Calls `GET /:flavor/audit-log`. Paginated
  table with filters by event_type, actor, date range. Each
  row expands to reveal the full payload JSON.

#### Tooltips

Non-obvious fields carry shadcn `<Tooltip>` content lifted
verbatim from this document. Specifically: identity model
canonical form rules (sub-section "Identity model"), mode
semantics (sub-section "Two-scope policy model" + "Per-server
resolution"), and soft-launch behavior (sub-section
"Soft-launch transition"). Verbatim then trimmed only when the
sentence is too long to fit a tooltip — never paraphrased.

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
    not enforcement; operator visibility only per D139).

  Result: amber/red = "policy fired" axis, purple = "FYI"
  axis. No new theme tokens (Rule 15); chromas reuse existing
  CSS variables already declared in `themes.css`.
- **Investigate event-type filter.** The existing Investigate
  page's event-type chip picker gains four chips for the new
  event types. No new dimension on the analytics axis (Rule
  25 lock); the new types are filterable but not group-by-
  able. Locked deliberately: an analytics breakdown by user-
  remembered events is interesting but not core to v1.
- **Session drawer MCP servers panel.** The existing
  `MCPServersPanel` in `SessionDrawer.tsx` lists each
  declared MCP server. Extended to render a per-row policy
  decision pill: allow (neutral) / warn (amber) / block
  (red) / unknown (low-contrast neutral with a tooltip
  explaining "no policy entry — using mode default").
  Decision derived by calling `GET /resolve` for each server
  in parallel via `Promise.all`. Loading state shows
  skeleton pills.

### D-number cross-references

D127 (identity canonical form), D128 (storage schema), D129 (fetch +
cache contract), D130 (sensor block contract), D131 (event types),
D132 (plugin remembered decisions), D133 (soft-launch default), D134
(mode lives on global only), D135 (precedence), D136 (helm migration
source-of-truth refactor), D137 (dry-run replay binds via
`sessions.context.mcp_servers`, not a dedicated event field),
D138 (three locked templates), D139 (plugin yes-and-remember:
local cache + emit event, no policy mutation). Underlying:
D117 (MCP `ClientSession` patch surface), D119 (lean MCP wire
payload), D125 (Provider enum — no member added; rides existing
`Provider.MCP`).

---

## Operational Concerns

### Deployment

Two deployment targets are supported:

**Docker Compose (single host).** `make dev` brings up all 7 services
(nginx, postgres, nats, ingestion, workers, api, dashboard) on the
internal compose network. nginx exposes port 4000. The production
overlay (`docker-compose.prod.yml`) terminates TLS at nginx on 443,
redirects 80 → 443, and unsets `ENVIRONMENT=dev` so the seed `tok_dev`
row is rejected.

**Helm chart (Kubernetes).** A Chart at `helm/` ships a values file
covering image tags, replicas, HPA bounds, NATS JetStream PVC sizes,
ingress configuration, and an `externalUrl` escape hatch for managed
Postgres. The bundled Postgres StatefulSet is fine for small
deployments; production should provide an external HA Postgres via
`postgres.externalUrl`.

The Docker Compose and Helm targets are feature-equivalent (Key
Constraint #4).

### Environment variables

**Ingestion API:**

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `POSTGRES_URL` | Postgres DSN |
| `NATS_URL` | NATS connection URL |
| `ENVIRONMENT` | `dev` enables `tok_dev` token; any other value rejects it with 401 |
| `SHUTDOWN_TIMEOUT_SECS` | Graceful shutdown deadline |

**Workers:**

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | DSN |
| `NATS_URL` | NATS URL |
| `WORKER_POOL_SIZE` | NATS consumer goroutine count |
| `SHUTDOWN_TIMEOUT_SECS` | Graceful shutdown deadline |

**Query API:**

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8081) |
| `POSTGRES_URL` | DSN |
| `ENVIRONMENT` | Same `tok_dev` semantics as ingestion |
| `CORS_ORIGIN` | `Access-Control-Allow-Origin`; lock to dashboard origin in prod |

**flightdeck-sensor (agent environment):**

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_SERVER` | Ingestion base URL |
| `FLIGHTDECK_TOKEN` | Access token |
| `FLIGHTDECK_API_URL` | Control-plane base URL (derived from server if unset) |
| `FLIGHTDECK_SESSION_ID` | Stable session UUID for orchestrator re-runs |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` to enable full payload capture |
| `FLIGHTDECK_UNAVAILABLE_POLICY` | `continue` (default) or `halt` |
| `FLIGHTDECK_HOSTNAME` | Override `socket.gethostname()` |
| `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` | Persistent agent label; default `{user}@{hostname}` |
| `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE` | `coding` or `production` (D114). Any other value raises `ConfigurationError` |

**Postgres:** standard Postgres environment plus the optional
`POSTGRES_PASSWORD` / `POSTGRES_USER` / `POSTGRES_DB` for the bundled
StatefulSet.

### Health checks

Every service except `workers` exposes `GET /health` returning
`{"status":"ok","service":"<name>"}`. The compose health check polls
this endpoint at 5s intervals; nginx waits for `service_healthy` before
serving traffic. `workers` has no HTTP surface — its readiness is
derived from successful NATS subscription, surfaced via container
liveness probe.

### Metrics

Ingestion API and Workers expose Prometheus exposition at `/metrics`:

- `dropped_events_total{reason}` — orphan session_end, validation
  failure, NATS publish failure, etc.
- `events_received_total{event_type}`
- `events_processed_total{event_type, status}`
- `event_processing_duration_seconds` (histogram, per event_type)
- `nats_consumer_lag_seconds` (gauge, per consumer)
- HTTP request latency histograms.

The Query API exposes the same shape: per-handler latency and
per-endpoint request counts.

### Admin scope

`/v1/admin/*` endpoints share the same Bearer-token auth as user-facing
endpoints. They are intended for operator interfaces (firewall / ingress
restricted) rather than the dashboard. Token-based admin scoping is not
implemented; any production token has full admin access.

`POST /v1/admin/reconcile-agents` recomputes `agents.total_sessions`,
`total_tokens`, `first_seen_at`, and `last_seen_at` from the sessions
table on demand. Orphan-row cleanup (agent rows with no current
sessions) is out of scope.

### Makefile structure

The root `Makefile` orchestrates per-component Makefiles. Common
targets:

| Target | Effect |
|---|---|
| `make dev` | Boot the dev stack via docker-compose.dev.yml |
| `make test` | Per-component unit tests (sensor, ingestion, workers, api, dashboard) |
| `make test-integration` | Run pytest against the dev stack |
| `make playground-<script>` | Live-API regression demo for `<script>` (Rule 40d) |
| `make playground-all` | All playground demos, skip those without API keys |
| `make lint` | Per-component lint (ruff, golangci-lint, ESLint, mypy) |
| `make build` | Docker images for ingestion, workers, api, dashboard |
| `make release VERSION=vX.Y.Z` | Validate, bump version, tag, push (release pipeline) |

Each component (`sensor/`, `ingestion/`, `workers/`, `api/`,
`dashboard/`, `docker/`, `helm/`, `plugin/`) has its own Makefile with
`build`, `test`, `lint`, `clean` targets at minimum. `ingestion/Makefile`
and `api/Makefile` run `swag init -g cmd/main.go -o docs` before
`go build` so the Swagger UI matches the latest annotations (Rule 50,
D050).

---

## Testing strategy

### Unit tests

- **Sensor (Python):** pytest under `sensor/tests/unit/`. No real API
  calls. Mock control plane and provider clients. Covers session
  lifecycle, policy enforcement, transport unavailability, provider
  token estimation, content extraction, framework attribution, runtime
  context, agent_id derivation. mypy `--strict` clean.
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
- `test_enforcement.py` — WARN, DEGRADE, BLOCK threshold crossings
- `test_killswitch.py` — single-agent + flavor-wide directive delivery
- `test_prompt_capture.py` — `event_content` round-trip
- `test_analytics.py` — analytics GROUP BY queries
- `test_phase4_event_shapes.py` — embeddings, llm_error, streaming,
  framework filter, `error_types[]` listing
- `test_sensor_e2e.py` — end-to-end sensor lifecycle including
  acknowledgement events and singleton behaviour

### Manual playground demos (Rule 40d)

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
projects via Playwright's `projects` config (Rule 40c.3). Tests do not
hardcode theme-specific selectors or computed colour values.

`_fixtures.ts` provides `bringSwimlaneRowIntoView(page, agentName)` and
`bringTableRowIntoView` helpers for the virtualized swimlane and
paginated agent table — under realistic data volume the
IntersectionObserver-backed virtualizer keeps off-screen rows as
placeholders without their `data-testid`, so specs must scroll/paginate
to find their fixture before asserting.

`waitForFleetReady` waits for any swimlane or table row to mount, then
leaves fixture-by-fixture lookup to the bring-into-view helpers.

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
11. Prompt content is never stored or logged when `capture_prompts=false`.
    This is a hard rule. No exceptions. See DECISIONS.md D019.
12. Every analytics chart must have a working group-by control.
13. The global time range picker applies to all charts simultaneously.
14. Provider terminology is preserved exactly. Anthropic uses `system` +
    `messages`; OpenAI uses `messages`-only. No cross-provider
    normalization.
15. Modality content capture parity: every modality with a request /
    response payload supports `capture_prompts` across every supported
    framework. Modalities that ship without capture ship a documented
    gap.
