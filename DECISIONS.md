# Flightdeck Decision Log

Every significant decision made during the design and build of Flightdeck is recorded
here, including the reasoning and alternatives that were rejected. When a decision is
reversed, that reversal is recorded -- not deleted.

**This is a living document.** As implementation progresses, plans change. Every
pivot belongs here immediately -- before the code is written, not after. The entry
format is: what was planned, what changed, why, what was rejected. A codebase
without a matching DECISIONS.md is a codebase future contributors cannot trust.

New contributors: read this before asking "why is it done this way?"

---

## D001 -- Sensor pattern over proxy/gateway pattern

**Decision:** flightdeck-sensor runs in-process and reports out-of-band over HTTP.
It does not sit in the path of LLM traffic.

**Reasoning:** A proxy/gateway pattern (agentgateway, Helicone) routes all LLM traffic
through an intermediary. If the gateway goes down, the entire agent fleet loses access
to LLM providers simultaneously. The sensor pattern has no SPOF. If the control plane
goes down, agents fall back to their configured unavailability policy and LLM calls
are unaffected.

**Rejected alternative:** Proxy/gateway pattern.

---

## D002 -- NATS JetStream over RabbitMQ

**Decision:** NATS JetStream as the message queue between ingestion API and workers.

**Reasoning:** Kubernetes-native, smaller operational footprint than RabbitMQ,
at-least-once delivery, persistent streams. OpenFaaS uses the same pattern.
RabbitMQ adds operational complexity that makes the Helm chart harder to self-host.

**Rejected alternative:** RabbitMQ (used in AI Ranger -- works well but heavier).

---

## D003 -- Two-identity model: AGENT_FLAVOR + SESSION_ID

**Decision:** Every agent session has a persistent identity (AGENT_FLAVOR) and an
ephemeral identity (SESSION_ID).

**Reasoning:** AGENT_FLAVOR is what the agent is -- its role, its policy attachment
point, its place in the fleet view. SESSION_ID is one running instance. Policies
attach to flavors, not sessions. The fleet view shows flavors. The timeline shows
sessions. Mirrors Kubernetes Deployments (persistent) vs Pods (ephemeral).

---

## D004 -- Identity injected via env vars from Helm

**Decision:** AGENT_FLAVOR and AGENT_TYPE are environment variables injected by the
Helm chart. Developers do not set them in agent code.

**Reasoning:** Platform engineer controls identity centrally. A developer who forgets
gets AGENT_FLAVOR=unknown, which appears flagged in the fleet view. This is shadow
AI detection by default -- not an error condition.

---

## D005 -- Directive delivery via HTTP response envelope

**Decision:** Control plane directives are delivered in the HTTP response body of
normal event POST calls.

**Reasoning:** Agents already POST events on every LLM call. The response is free
bandwidth. Delivering directives via this channel requires no additional connection,
no WebSocket from the agent side, no polling. The kill switch fires on the next
natural LLM call checkpoint -- typically within seconds for active agents.

**Rejected alternatives:** Long polling, agent-side WebSocket, polling endpoint.

---

## D006 -- Five session states

**Decision:** Sessions have five states: active, idle, stale, closed, lost.

**Reasoning:** Simple active/inactive is not enough. An agent can be alive but not
making LLM calls (idle). An agent can stop reporting without closing cleanly (stale).
An agent can exit cleanly (closed) or be killed without warning (lost). These
distinctions matter for the dashboard -- stale is different from lost, both are
different from healthy idle.

---

## D007 -- Configurable unavailability policy: continue or halt

**Decision:** When the control plane is unreachable, each deployment is configured
with either `continue` (run ungoverned) or `halt` (block until restored).

**Reasoning:** Different organizations have different risk tolerances. A startup with
revenue-critical agents cannot halt on a control plane blip. A regulated enterprise
cannot tolerate ungoverned agents even briefly. Both are valid operational postures.

**Third option considered and rejected:** "Continue but alert." Requires notification
infrastructure not present in v1. Removed as an option.

---

## D008 -- Postgres only in v1, TimescaleDB in v2

**Decision:** v1 uses plain Postgres for both fleet state and event time series.
TimescaleDB is added in v2.

**Reasoning:** TimescaleDB is Postgres-compatible and adds time series optimization.
Adding it in v1 complicates the Helm chart with no real benefit at early scale.
Once event volume grows and analytics queries become slow, the migration is
straightforward since TimescaleDB uses the same wire protocol. Analytics page works
on plain Postgres -- just slower at very large scale.

---

## D009 -- Token counts only in v1, dollar conversion in v2

**Decision:** v1 tracks token counts precisely. Dollar costs are not calculated in v1.

**Reasoning:** Provider pricing changes without notice. No machine-readable pricing
API exists. A dollar figure from a stale table is less trustworthy than the raw token
count from the provider response. Organizations apply their own pricing manually in v1.
Configurable pricing tables per provider/model are planned for v2.

---

## D010 -- Monorepo

**Decision:** All Flightdeck components in one GitHub repository.

**Reasoning:** Sensor, ingestion, workers, query API, dashboard, plugin, and Helm
chart are tightly coupled on schema and API contracts. A monorepo makes it easier
for Claude Code to maintain context across components, run cross-component integration
tests, and keep documentation synchronized.

---

## D011 -- Docker Compose as primary getting-started path

**Decision:** Docker Compose for evaluation. Helm chart for production.

**Reasoning:** Hacker News readers and individual engineers will not deploy a Helm
chart to evaluate a tool. Docker Compose is the 10-minute path. The Helm chart is
for platform engineers deploying to production clusters. Both run the same services.

---

## D012 -- shadcn/ui over MUI, Ant Design, or Chakra

**Decision:** Dashboard uses shadcn/ui as the base component library.

**Reasoning:** shadcn/ui copies components into the project as owned TypeScript files.
No dependency conflicts, no breaking changes on upgrade. Full control for customization.
Built on Radix UI for accessibility. The visual output matches the aesthetic target
(Raycast, Linear, Vercel) in a way that Material Design or Ant Design does not.

**Hard rule:** MUI, Ant Design, and Chakra are never introduced into the codebase.

---

## D013 -- Custom timeline component

**Decision:** The primary timeline surface is a custom React component.
D3 is used for time scale calculations only. React owns the DOM entirely.

**Reasoning:** No existing library ships a real-time swim-lane agent timeline matching
Flightdeck's visual requirements. D3 DOM manipulation conflicts with React's rendering
model. D3 is limited to `d3-scale` and `d3-time` -- the math, not the rendering.

---

## D014 -- Two first-class themes: neon dark and clean light

**Decision:** Flightdeck ships two themes, both production-quality.

**Reasoning:** Neon dark is the signature theme -- visually striking, drives organic
sharing. Clean light exists for engineers in bright environments and stakeholder demos.
A half-finished light mode is worse than no light mode. Both themes required at all times.

---

## D015 -- flightdeck-sensor built on tokencap foundation

**Decision:** flightdeck-sensor inherits tokencap's token counting implementation.

**Reasoning:** tokencap already solves accurate token counting across Anthropic and
OpenAI including streaming, async clients, and framework interception. Rebuilding
from scratch wastes effort and introduces regressions. The sensor extends tokencap
with control plane connection, identity model, heartbeat, directive handling, and
session lifecycle.

---

## D016 -- Tests required on every task

**Decision:** Every Claude Code task that produces code must produce tests.
A task with no tests is not complete.

**Reasoning:** Tests written alongside code are more reliable and serve as
specification. The phase audit process depends on tests being present to verify
correctness. AI Ranger and tokencap both showed that after-the-fact tests drift.

---

## D017 -- Go for ingestion API and workers

**Decision:** Ingestion API and Go workers are written in Go.

**Reasoning:** The ingestion API is on the hot path of every agent event. Go's
concurrency model handles high-throughput HTTP and NATS consumption cleanly without
Python's GIL limitations. Workers process a high volume of events concurrently.
Go goroutines are the right tool.

---

## D018 -- Claude Code plugin follows agents-observe hook pattern

**Decision:** The Claude Code plugin uses the same hook mechanism as agents-observe.
It is a dumb pipe that reformats events and POSTs to the Flightdeck ingestion API.

**Reasoning:** agents-observe proved the Claude Code hook mechanism works reliably.
Rather than invent a new integration pattern, Flightdeck adopts the proven approach.
The plugin is intentionally simple -- all logic lives in the control plane.

---

## D019 -- Prompt capture is opt-in, off by default

**Decision:** Prompt content (messages, system prompt, tool definitions, response)
is never captured unless explicitly enabled via `capture_prompts=True` or
`FLIGHTDECK_CAPTURE_PROMPTS=true`. Default is always off.

**Reasoning:** Prompts often contain sensitive business context, PII, proprietary
instructions, or confidential data. A platform that captures this by default would
fail security reviews at every serious enterprise. Opt-in means the platform engineer
or developer makes an explicit, deliberate choice. The default path is always safe.

The README, Helm values.yaml, and CLAUDE.md all make this explicit. The hard rule
in CLAUDE.md: prompt content is never stored or logged when capture is off.

**Rejected alternative:** Capture by default, opt-out to disable. Rejected because
it puts the burden of protecting sensitive data on the user, which is the wrong
default for a platform handling production agent workloads.

---

## D020 -- Separate event_content table for prompt storage

**Decision:** Prompt content is stored in a separate `event_content` table, not
inline in the `events` table.

**Reasoning:** A single LLM call with a large context window (100k+ tokens) can
produce 50-200KB of JSON content. Storing this inline in the events table would
make the table extremely wide, degrade query performance for all event queries
(even those that don't need content), and complicate archival/deletion. The separate
table means:

- Event metadata queries are always fast regardless of capture settings
- Content can be archived, compressed, or deleted independently
- Content is fetched on demand via `GET /v1/events/:id/content`
- The events table schema is stable regardless of capture configuration

**Rejected alternative:** Inline JSONB column in events table. Rejected because of
performance and storage implications at scale.

---

## D021 -- Analytics page with flexible dimension switching

**Decision:** The analytics page provides default charts that answer the most
valuable questions immediately, but every chart has a group-by control that lets
the user switch dimensions without navigating away.

**Default charts rationale:**

- Token consumption over time grouped by flavor: flavor is the most actionable
  dimension for an engineering leader -- it maps to a team or workload, not a
  technical detail like model name
- Top N by token consumption: answers "where is my budget going" immediately
- Sessions per day by agent type: shows production vs developer usage ratio,
  a useful signal for governance
- Model distribution donut: enables cost optimization decisions (which models are
  being used, could we swap one for a cheaper model?)
- Policy events over time: an upward trend is a warning signal

**Available dimensions for any chart:** flavor, model, framework, host, agent_type, team.
Available metrics: tokens, sessions, latency_avg, policy_events.

A single `GET /v1/analytics` endpoint with query parameters powers all charts.
The frontend calls it with different `metric` and `group_by` parameters per chart.

**Rejected alternative:** Fixed charts with no dimension switching. Rejected because
different organizations have different fleet structures -- a company with 50 flavors
needs to group by team, not flavor. The flexible approach works for all org sizes.

---

## D022 -- Analytics page in Phase 4, TimescaleDB in Phase 5 (v2)

**Decision:** The analytics page ships in Phase 4 with plain Postgres queries.
TimescaleDB is migrated in Phase 5.

**Reasoning:** The analytics page is valuable immediately even with plain Postgres.
Time series GROUP BY queries on plain Postgres are fast enough for most orgs at
launch-scale (tens of thousands of events per day). Adding TimescaleDB as a Phase 4
dependency would block the analytics page on infrastructure work. When event volume
grows and queries slow down, the TimescaleDB migration is a drop-in swap. The
analytics page code does not change -- only the storage engine underneath.

---

## D024 -- Anthropic cache tokens included in input token total

**Decision:** `AnthropicProvider.extract_usage()` sums `cache_read_input_tokens`
and `cache_creation_input_tokens` into the input token total.

**Reasoning:** Cache tokens are real tokens consumed and billed by Anthropic.
Excluding them would cause the sensor to undercount actual usage for agents using
prompt caching, which would make token enforcement fire later than intended and
give the fleet dashboard inaccurate consumption numbers. The total must reflect
what the provider actually processed.

---

## D025 -- Windows SIGINT handler skipped

**Decision:** SIGINT handler registration is skipped on Windows
(`os.name == "nt"`). SIGTERM is still registered. atexit covers clean shutdown
on all platforms.

**Reasoning:** Python on Windows does not support SIGINT in signal handlers the
same way Unix does. Attempting to register it raises an error. The atexit handler
provides equivalent clean shutdown coverage on Windows. This is a platform
constraint, not a design choice.

---

## D023 -- Provider terminology preserved in prompt capture

**Decision:** Prompt content is stored and displayed using the provider's own
terminology. No normalization into a common schema.

**Reasoning:** Anthropic uses `system` as a separate parameter alongside `messages`.
OpenAI embeds the system instruction as a message with `role: "system"` inside the
`messages` array. Normalizing these into a common format would lose information (the
structural distinction matters for debugging) and require ongoing maintenance as
providers evolve their APIs. Preserving provider terminology means the developer sees
exactly what was sent -- no translation layer to reason about.

The `PromptViewer` component in the dashboard handles provider-specific rendering:
Anthropic shows system separately, OpenAI shows all messages in sequence.

---

## D026 -- NATS pull-based subscription

**Decision:** Consumer uses pull-based JetStream subscription (`PullSubscribe`
with `Fetch(1)`) rather than push-based.

**Reasoning:** Pull-based gives explicit backpressure control. Each worker
goroutine fetches one message at a time and only proceeds after ack/nack. This
is the standard JetStream pattern for durable consumers. Push-based subscriptions
can overwhelm slow consumers and require more complex flow control logic.

---

## D027 -- Directive lookup covers session and flavor scope in one query

**Decision:** `LookupPending` checks `session_id = X OR flavor = (SELECT flavor
FROM sessions WHERE session_id = X)` in a single query.

**Reasoning:** Both session-specific and fleet-wide directives must be picked up
on each sensor POST. A single query is more efficient and avoids a race condition
between two separate lookups where a directive could be inserted between the
session-scoped and flavor-scoped reads.

---

## D028 -- GuardedStream.__exit__ returns None

**Decision:** `GuardedStream.__exit__` returns `None` instead of `bool`.

**Reasoning:** mypy strict requires `Literal[False]` or `None` for `__exit__`
methods that never suppress exceptions. `None` is equivalent to `False` at
runtime and satisfies the type checker without requiring a cast or `Literal`
import.

---

## D029 -- Go 1.22 stdlib ServeMux over third-party router

**Decision:** Used Go 1.22 `net/http` ServeMux method routing syntax
(`mux.Handle("POST /v1/events", ...)`) instead of adding chi or gorilla/mux.

**Reasoning:** Stdlib routing is sufficient for the number of routes in each
service. Keeping dependencies minimal reduces the attack surface and simplifies
the Go module graph. Go 1.22 added method-aware routing to the standard library,
eliminating the primary reason third-party routers were previously needed.

---

## D030 -- StartReconciler delegated through Processor

**Decision:** `Processor` exposes `StartReconciler()` which delegates to
`SessionProcessor.StartReconciler()`. `main.go` only knows about `Processor`.

**Reasoning:** Keeps `main.go` decoupled from internal processor types. The
wiring stays clean without requiring the entry point to import internal
packages directly.

---

## D031 -- WebSocket exponential backoff over fixed 3s interval

**Decision:** `useWebSocket.ts` uses exponential backoff starting at 1s,
doubling each attempt, capped at 30s.

**Reasoning:** A fixed 3s reconnect interval causes a thundering herd if
many clients disconnect simultaneously (e.g. control plane restart).
Exponential backoff spreads reconnect load. The shorter initial interval
(1s vs 3s) also means faster recovery for transient blips.

---

## D032 -- Handler interfaces for testability (ingestion)

**Decision:** Introduced `TokenValidator`, `EventPublisher`, and
`DirectiveLookup` interfaces in ingestion handlers so handlers can accept
mocks in tests. Concrete implementations (`auth.Validator`, `nats.Publisher`,
`directive.Store`) implement these implicitly via Go duck typing. A
`directiveAdapter` in `cmd/main.go` bridges the `directive.Directive` to
`handlers.DirectiveResponse` type gap.

**Reasoning:** Go's interface-based dependency injection is the idiomatic
pattern for testable HTTP handlers. Without interfaces, handlers require
real NATS and Postgres connections to test.

---

## D033 -- Store Querier interface (api)

**Decision:** Introduced `store.Querier` interface so api handlers accept
either the real Postgres-backed store or a mock. `WrapStore()` is a
pass-through helper.

**Reasoning:** Same rationale as D032 -- idiomatic Go testability pattern.
Handlers should not depend on a concrete type.

---

## D034 -- Go version pinned to 1.26

**Decision:** All Go modules use `go 1.26` in go.mod. Dockerfiles use
`golang:1.26-alpine`. CI uses `go-version: "1.26"`. golangci-lint v2
installed via `go install` to match.

**Progression:** 1.22 (original ARCHITECTURE.md) → 1.24 (attempted
golangci-lint v1 compat) → 1.25 (go mod tidy auto-set on 1.26 toolchain)
→ 1.26 (final pin matching installed toolchain). The 1.24 attempt failed
because pgx v5.9.1 requires go >= 1.25. The 1.25 attempt failed because
golangci-lint v1.64.8 was built with Go 1.24 and rejected go 1.25 modules.
Pinning to 1.26 with golangci-lint v2 resolved all incompatibilities.

**Reasoning:** Using a fixed version matching the development toolchain
ensures `go mod tidy` doesn't drift the directive. All Dockerfiles,
go.mod files, CI, and docker-compose.dev.yml are updated.

---

## D035 -- init() local limit is WARN-only

**Decision:** The `limit`, `warn_at`, and `degrade_to` parameters accepted by
`init()` only ever fire warnings. They never block or degrade model calls.
Hard enforcement (BLOCK, DEGRADE) is exclusively a server-side policy concern
configured in the dashboard.

**Reasoning:** A developer setting a local limit in a script is expressing
intent and wanting visibility, not writing infrastructure policy. A silent
block that stops an agent mid-flight because of a local `init()` param would
be confusing and harmful. Platform engineers retain full control over hard
enforcement via server policy.

Most-restrictive-wins applies across local and server thresholds: if `init()`
warns at 80% of 50k and the server warns at 70% of 100k, both fire at their
respective thresholds. Neither suppresses the other.

---

## D036 -- policy_warn events carry a source field

**Decision:** `policy_warn` events include a `source` field with value
`"local"` (fired from `init()` limit) or `"server"` (fired from server-side
policy). Both are stored in the events table and shown in the dashboard
PolicyEventList with distinct labels.

**Reasoning:** Platform engineers need to distinguish between developers
self-imposing limits and agents breaching server-enforced budgets. Without
the source field both look identical in the dashboard.

---

## D037 -- Event posting moved off LLM call hot path

**Decision:** Introduced `EventQueue` in `transport/client.py`. The interceptor
calls `enqueue()` which puts the event on a `threading.Queue` and returns
immediately. A background daemon thread drains the queue and calls
`post_event()`. `Session.end()` calls `flush()` to drain remaining events
before exit.

**Reasoning:** The previous design called `post_event()` synchronously from
`interceptor/base.py._post_call()`, which is on the LLM call return path.
A slow or unreachable control plane could block the agent for up to 35 seconds
(3 retries × 10s timeout + backoff). This violated the sensor's core design
principle: never add meaningful latency to the agent's hot path.

---

## D038 -- Postgres NOTIFY listener auto-reconnects

**Decision:** `ListenNotify()` in `api/internal/ws/hub.go` wraps the listen
logic in a reconnection loop. On any error it waits 3 seconds and re-acquires
a connection + re-LISTENs. The loop exits cleanly on context cancellation.

**Reasoning:** The previous implementation returned on any error with no
reconnection. A transient Postgres connection drop permanently silenced the
real-time dashboard until the API process was restarted. The reconnection
loop ensures the dashboard recovers automatically.

---

## D039 -- SIGKILL phantom session state (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. SIGKILL bypasses all handlers. Session never transitions
to closed. Worker reconciler marks it stale after 2min, lost after 10min.
Up to 12min of phantom "active" state.

**Mitigation:** SIGKILL is untrappable by design. The reconciler handles
this case. The staleness window should be documented in operator runbooks.

**Address in:** Phase 3 (operator documentation).
**Code location:** `sensor/flightdeck_sensor/core/session.py:_register_handlers`

**Resolved in:** Phase 3.
**Resolution:** Documented staleness window. No code fix possible -- SIGKILL is
untrappable by design. Sessions affected by SIGKILL transition to stale after 2
minutes and lost after 10 minutes via the background reconciler.

---

## D040 -- PolicyCache empty on first call (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. PolicyCache is empty until the first directive arrives
in a response envelope. First LLM call always runs ungoverned.

**Mitigation:** Add a preflight `GET /v1/policy` call during `init()` to
populate the cache before the first call.

**Address in:** Phase 2.
**Code location:** `sensor/flightdeck_sensor/core/session.py:Session.start`

**Resolved in:** Phase 2.
**Resolution:** Added preflight GET /v1/policy call in Session.start() before
returning. PolicyCache is populated before the first LLM call.

---

## D041 -- NATS event loss on unavailability (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. If NATS is temporarily down, `Publish()` returns an error.
The sensor retries 3 times then drops the event (continue policy).

**Mitigation:** Add a local WAL/buffer that stores events when NATS is
down and replays them on reconnect.

**Address in:** Phase 2.
**Code location:** `ingestion/internal/nats/publisher.go:Publish`

**Resolved in:** Phase 4.
**Resolution:** Exponential backoff retry (3 attempts: 100ms, 200ms, 400ms).
On persistent failure: log the loss with slog.Error and return nil to avoid
blocking the ingestion response. Lost event counter tracked in memory.

---

## D042 -- No session state transition guards (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. A replayed event could resurrect a lost or closed session.
No guard against impossible state transitions.

**Mitigation:** Reject events for sessions in terminal states (`closed`,
`lost`). Check current state before any upsert.

**Address in:** Phase 2.
**Code location:** `workers/internal/processor/session.go:HandleSessionStart`

**Resolved in:** Phase 2.
**Resolution:** Added isTerminal() helper in workers/internal/processor/session.go.
All handler methods reject events for closed and lost sessions.

---

## D043 -- Per-event policy Postgres query (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. Policy evaluation runs a Postgres query on every
`post_call` event. At 100 events/second, that is 100 queries/second.

**Mitigation:** Cache policy in worker memory, refresh only on
`policy_update` directive. Avoid per-event database queries.

**Address in:** Phase 2.
**Code location:** `workers/internal/processor/policy.go:Evaluate`

**Resolved in:** Phase 2.
**Resolution:** PolicyEvaluator now uses an in-memory cache keyed by scope.
Postgres is queried only on cache miss or TTL expiry (5 minutes). Cache is
invalidated on policy_update directive.

---

## D044 -- WebSocket broadcast fan-out (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. Every NOTIFY broadcasts to all connected dashboard clients
regardless of what they are viewing. At 500 users × 10k events/min this
is 5M messages/min.

**Mitigation:** Clients subscribe to specific flavors. Only broadcast
relevant updates per client.

**Address in:** Phase 2.
**Code location:** `api/internal/ws/hub.go:Broadcast`

**Resolved in:** Phase 4.
**Resolution:** Non-blocking select per client in Broadcast(). Slow clients with
full send buffers are closed and removed immediately rather than blocking delivery
to other clients.

---

## D045 -- GET /v1/fleet no pagination (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Medium. `GET /v1/fleet` loads all non-lost sessions into memory.
No pagination. At 100k sessions this is a large response and a full table scan.

**Mitigation:** Add pagination (`?limit=100&offset=0`) and composite index
on `(state, flavor)`.

**Address in:** Phase 2.
**Code location:** `api/internal/handlers/fleet.go:FleetHandler`

**Resolved in:** Phase 3.
**Resolution:** Added limit/offset pagination to GET /v1/fleet. `total_session_count`
added to top-level response. Default limit=50, max=200.

---

## D046 -- SHA256 token auth without salt (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Low. If the `api_tokens` table is leaked, short tokens (like
`tok_dev`) can be brute-forced. SHA256 without salt provides no key
stretching.

**Mitigation:** Use bcrypt or argon2 for production tokens. SHA256 is
acceptable for the dev seed token only.

**Address in:** Phase 5 (production hardening).
**Code location:** `ingestion/internal/auth/token.go:Validate`

**Resolved in:** Phase 5
**Resolution:** Replaced with opaque `ftd_` tokens stored as
`SHA256(salt || raw_token)` with a 16-byte per-token salt. The
hardcoded `tok_dev` seed is now only accepted when the service reads
`ENVIRONMENT=dev`; production deployments must mint real tokens via
the Settings UI. See D095.

---

## D047 -- No NATS auth in dev compose (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Low. NATS has no authentication in the dev Docker Compose. Any
process on the Docker network can publish to the FLIGHTDECK stream.

**Mitigation:** Add NATS token auth or NKey in the Helm chart and
`docker-compose.prod.yml`. Dev compose is acceptable without auth.

**Address in:** Phase 5 (production hardening).
**Code location:** `docker/docker-compose.yml:nats`

---

## D048 -- Token validation and rate limiting not cached (accepted trade-off)

**Decision:** Accepted as known trade-off for Phase 1.

**Risk:** Low. Token validation hits Postgres on every request with no caching.
No rate limiting on the ingestion API.

**Mitigation:** Add in-memory LRU cache with 60s TTL for token validation.
Add per-token rate limiting middleware.

**Address in:** Phase 2.
**Code locations:** `ingestion/internal/auth/token.go:Validate`,
`ingestion/internal/handlers/events.go:EventsHandler`

**Resolved in:** Phase 4.
**Resolution:** 60s in-memory cache for valid token hashes, max 1000 entries
(KI03). Per-token sliding window rate limit: 1000 requests/minute, returns
429 with Retry-After header on breach (KI04). Invalid tokens never cached.

---

## D049 -- Directive lookup added to heartbeat handler

**Decision:** `HeartbeatHandler` now accepts `DirectiveLookup` and returns a
directive envelope in its response, identical to the events handler pattern.
This ensures idle agents (heartbeat only, no LLM calls) receive kill switch
directives within one heartbeat interval (30s worst case).

**Reasoning:** Without this fix, an idle agent with no LLM calls would never
receive a kill switch directive, making the kill switch useless for any agent
in idle state. The heartbeat is the only regular communication from an idle
agent to the control plane.

---

## D050 -- swaggo/swag for OpenAPI documentation

**Decision:** Use swaggo/swag to generate OpenAPI 3.0 documentation from
structured Go comments on handlers. Swagger UI served at `/docs` on both
ingestion API (port 8080) and query API (port 8081). Accessible via nginx
at `/ingest/docs` and `/api/docs`.

**Reasoning:** Machine-readable API docs are a requirement for any platform
tool used by engineering teams. swaggo/swag is the most widely adopted Go
OpenAPI generation tool, requires no runtime dependency, and integrates
cleanly with stdlib ServeMux. The spec is generated at build time and
committed to the repo so it is always in sync with the code.

**Rejected alternative:** Hand-written OpenAPI YAML. Rejected because
hand-written specs drift from code.

---

## D051 -- Smoke test deferred to Phase 5

**Decision:** The end-to-end smoke test will be written after Phase 5 closes
when all product features exist.

**Reasoning:** A smoke test for a platform is only meaningful when the platform
is feature-complete. Writing it incrementally per phase creates maintenance
overhead and tests a hollow product. The script will be written once and cover
the full workflow: instrument an agent, observe in fleet, set policy, enforce,
kill switch, prompt capture, analytics. Inspired by tokencap's smoke_test.py
pattern but adapted for a platform product rather than a standalone library.

**Address in:** Phase 5.

---

## D052 -- Policies table renamed to token_policies

**Decision:** The `policies` table is renamed to `token_policies` in all SQL,
Go store queries, and schema documentation.

**Reasoning:** The name `policies` is too generic. As Flightdeck grows, other
policy types (access policies, routing policies) may be added. `token_policies`
makes the purpose explicit and avoids future naming collisions. API endpoint
paths (`/v1/policies`) remain unchanged -- they refer to the resource name, not
the table name.

---

## D053 -- Delete confirmation uses Dialog not AlertDialog

**Decision:** PolicyTable delete confirmation uses the existing shadcn/ui Dialog
component rather than AlertDialog from `@radix-ui/react-alert-dialog`.

**Reasoning:** AlertDialog would require adding a new package dependency. The
existing Dialog achieves the same UX without new dependencies. Constraint 4
(no new UI libraries) applies.

---

## D054 -- Nav bar added to App.tsx

**Decision:** A minimal 40px nav bar with Fleet and Policies links was added to
App.tsx. Fleet.tsx was updated from `h-screen` to `h-full` to accommodate the
nav bar height.

**Reasoning:** The Policies page required navigation between dashboard pages.
A minimal top nav is the simplest solution that works with the existing routing
structure. ARCHITECTURE.md App.tsx description updated to reflect this.

---

## D055 -- Self-contained CI coverage gates

**Decision:** Coverage enforced via per-component thresholds in CI with no
external service. Coverage HTML reports uploaded as GitHub Actions artifacts
per run (14 day retention). No Codecov or external coverage service.

Thresholds:
- Sensor: 70% hard fail (full package, baseline 72.4%)
- API: 66% hard fail (handlers only, baseline 71.4%)
- Ingestion: 67% hard fail (handlers only, baseline 72.0%)
- Workers: report only, no threshold

**Reasoning:** External coverage services add operational dependencies and
require secret management. Self-contained thresholds give the same CI gate
with zero external dependencies.

API and ingestion thresholds measure `./internal/handlers/...` only, not
`./internal/...`. The store layer (postgres.go, analytics.go, search.go) and
infrastructure (config.go, server.go) require a real Postgres connection and
are covered by integration tests. Measuring them against unit coverage produces
a misleading 0% that drags the total below any meaningful threshold.
Handler-only coverage is the correct scope for unit test gates.

Handler baselines: API 71.4%, Ingestion 72.0%. Thresholds set at baseline
minus 5% as regression floors. Writing unit tests solely to hit a coverage
number produces coverage theater -- tests that execute lines without asserting
behavior, which is worse than no tests.

Workers threshold omitted -- unit coverage is structurally low because SQL
paths only run in integration tests. Integration tests cover what unit tests
cannot.

**Rejected:** 100% target -- forces trivial tests that mock away all
interesting behavior.
**Rejected:** Codecov -- external dependency, requires secret management.

---

## D056 -- golang-migrate for schema migrations

**Decision:** Use golang-migrate to manage all schema changes via versioned SQL
files in `docker/postgres/migrations/`. Workers run migrations on startup before
processing events. `init.sql` is reduced to seed data only.

**Reasoning:** The previous `init.sql` approach cannot apply schema changes to
existing deployments without destroying data. Every new column required
`make dev-reset`. golang-migrate provides versioned, reversible migrations that
can be applied to running deployments safely.

**Rejected:** ORM-based migration tools (GORM, sqlboiler). Rejected because the
project uses raw pgx SQL (D034) and ORM tools require ORM model definitions.
golang-migrate works with plain SQL files and is ORM-agnostic.

---

## D057 -- Heartbeat removed from sensor

**Decision:** The sensor no longer sends periodic heartbeat POSTs to the
ingestion API.

**Reasoning:** The heartbeat served two purposes: (1) updating last_seen_at for
stale session detection -- already handled by post_call events for active agents;
the reconciler correctly marks truly idle agents as stale after 2 minutes which
is the right behavior. (2) delivering directives to idle agents -- this use case
is not supported. Directives are delivered on the next LLM call. Platform
engineers are informed of this via the kill switch confirmation dialog.

The heartbeat added a background thread, polling loop, extra HTTP load, and
teardown complexity for no justified benefit.

The `POST /v1/heartbeat` ingestion endpoint remains to avoid breaking changes
but the sensor no longer calls it.

---

## D058 -- shutdown_flavor fans out to per-session directives

**Decision:** When `POST /v1/directives` receives `action=shutdown_flavor`, the
handler immediately queries all active and idle sessions of that flavor and
inserts one directive per session.

**Reasoning:** The `LookupPending` query in ingestion atomically marks a directive
as delivered on first pickup. A single flavor-scoped directive would be delivered
to only the first session to make an LLM call after issuance. Fan-out at creation
time ensures every active session receives exactly one directive regardless of
which session calls the ingestion API first.


---

## D059 -- Phase 4.5 UI redesign

**Decision:** Fleet timeline redesigned to flavor → session → event hierarchy.
Events are color+icon coded circles positioned on a shared time axis. Analytics
rebalanced to include latency and agent type distribution, reducing token-heavy
focus. Dense layout adopted throughout.

**Changes:**
- Event visual system: 7 CSS variable colors for event types (LLM, tool, warn,
  block, degrade, directive, lifecycle) with icon characters per type
- Fleet timeline: swim lanes with flavor headers (28px), session rows (32px),
  time range selector (5m/15m/30m/1h/6h), flavor filter via sidebar click
- Session drawer: 480px width, dense event list with expand-to-JSON,
  event-type colored icons
- Analytics: Row 1 full-width token time series, Row 2 top consumers + latency,
  Row 3 sessions-by-model + policy events + agent type (3-column)
- FleetPanel: tighter spacing (11px/13px fonts), clickable flavor filter

**Reasoning:** The original UI was spacious but sparse -- too few data points
visible without scrolling. Engineering dashboards need density. Every pixel should
communicate status. The event color system provides instant visual classification
without reading labels.


---

## D060 -- Custom directives

**Decision:** Decorator-based registration at import time. SHA256+base64 fingerprint
for versioning. Sync at init() -- sensor sends fingerprints, server returns unknown
fingerprints, sensor registers full schema for unknown only. Known fingerprints get
last_seen_at bumped. Execution in _apply_directive() before next LLM call, 5s timeout,
fail open on error or timeout. Results posted as directive_result events in the session
timeline.

**Rejected:** YAML-only approach -- decorator is the primary interface. YAML is a
future alternative for teams that cannot modify agent code.
**Rejected:** Execution in a separate thread -- sensor is a library wrapper not an
OS agent (rule 32).


---

## D061 -- Pydantic for sensor schema validation

**Decision:** Pydantic v2 added to sensor runtime dependencies for validation of
directive payloads, policy responses, and sync responses from the control plane.

**Reasoning:** Manual `.get()` parsing has no type checking and silently accepts
malformed payloads from the server. Pydantic gives clear ValidationError with
field-level detail and fail-open behavior on parse failure. Go API handlers keep
manual validation -- the existing approach is idiomatic and already well-tested.

Parse sites using Pydantic:
1. `transport/client.py _parse_directive()` — DirectiveResponseSchema
2. `transport/client.py sync_directives()` — SyncResponseSchema
3. `core/session.py _execute_custom_directive()` — DirectivePayloadSchema
4. `core/session.py _preflight_policy()` — PolicyResponseSchema


---

## D062 -- Fleet redesign: flavor expand-in-place with dual view modes

**Decision:** Fleet timeline redesigned from flat swimlanes to a flavor-centric
expand-in-place model with two view modes (swimlane and bar).

**Changes:**
- Each flavor is a single collapsed row (48px). Click expands inline to show
  individual session rows below. Only one flavor expanded at a time.
- Swimlane mode: event circles positioned on a shared D3 time scale. 20px circles
  in collapsed flavor rows, 24px circles in expanded session rows.
- Bar mode: 24 equal-width time buckets, stacked bars showing event type distribution
  (LLM, tool, policy, directive).
- Fleet header bar (40px) with view mode toggle, time range selector (5m/15m/30m/1h/6h),
  and live indicator.
- Left sidebar redesigned: 240px, section headers (uppercase 11px tracked), session
  state counts as large numbers (20px/700), flavor list with active border + accent glow.

**Reasoning:** The flat swimlane layout showed all sessions simultaneously, which
doesn't scale past 5-10 agents. The expand-in-place model keeps the fleet overview
compact while allowing drill-down into any flavor. Bar mode gives a quick activity
histogram when individual events are less important than volume patterns.

---

## D063 -- Geist font for UI and monospace

**Decision:** Geist (sans) for UI text, GeistMono for identifiers, timestamps,
and code. Installed via npm package `geist`.

**Reasoning:** Free and open source (Vercel). Superior readability at small sizes
(11-13px) compared to Inter. GeistMono has consistent character widths ideal for
session IDs, token counts, and timestamps. Both fonts ship together in one package.

---

## D064 -- Live event feed

**Decision:** Fixed 240px height live feed below the fleet timeline. Driven by
existing fleet store and WebSocket NOTIFY. Cap at 500 events. Auto-scroll with
manual pause detection. Clicking a row opens EventDetailDrawer for single-event
detail including Prompts tab if capture enabled.

**Reasoning:** The swimlane/bar views show temporal patterns. The feed shows the raw
chronological log. Together they answer two complementary questions: what is the
pattern, and what exactly happened. The EventDetailDrawer is independent from the
SessionDrawer — both can be open simultaneously. The 500-event cap prevents memory
growth in long-running dashboard sessions.

---

## D065 -- Event type filter bar

**Decision:** Single-select pill filter above the time axis. Filters both swimlane
circles and live feed rows simultaneously. Event types grouped into 5 semantic
categories: LLM Calls (post_call, pre_call), Tools (tool_call), Policy
(policy_warn, policy_block, policy_degrade), Directives (directive, directive_result),
Session (session_start, session_end).

**Reasoning:** A fleet with many agents produces hundreds of events per minute.
Without filtering, the swimlane becomes a dense wall of circles and the feed
scrolls too fast. Grouping by semantic category (not by raw event_type) matches
how engineers think: "show me the LLM calls" not "show me post_call and pre_call".
Opacity-based hiding in the swimlane preserves x position so layout does not shift
when toggling filters. Inspired by agent-observe's filter bar.

---

## D066 -- Bulk events endpoint replaces per-session fetches

**Decision:** `GET /v1/events` loads all events for a time range in one request.
`eventsCache` is populated client-side by grouping events by session_id. Zero
per-session HTTP requests after initial bulk load. WebSocket handles all real-time
updates after load. Live feed and swimlane share the same data source.

**Reasoning:** The original architecture fetched `GET /v1/sessions/:id` for each
session individually — 10 sessions = 10 HTTP requests. With `useSessionEvents`
called from both aggregated flavor rows and session rows, this doubled to ~20
requests. The bulk endpoint reduces this to 1 request that returns all events
within the selected time range. Client-side grouping by session_id populates the
same `eventsCache` that the swimlane reads from. Time range changes re-fetch.
Pagination via `offset` supports loading older events.

---

## D067 -- FeedEvent type with arrivedAt

**Decision:** Live feed uses `FeedEvent` wrapper type with `arrivedAt:
number` (`Date.now()` at WebSocket message receipt). Default display
order is `arrivedAt` descending (newest first) via `sort()` with
`arrivedAt` as the sort key. Column sorting is supported -- clicking
any column header sorts by that column's value; clicking TIME returns
to `arrivedAt` descending. Non-TIME sorts auto-pause the feed.
`arrivedAt` is the canonical ordering field and the fallback when sort
is reset.

**Reasoning:** Sorting by `occurred_at` produced inconsistent results
when events arrived out of order due to WebSocket batching. `arrivedAt`
is monotonically increasing and reflects exactly when the dashboard
received the event. Column sorting adds investigative value --
engineers can sort by flavor or event type to find patterns.

---

## D068 -- Pause queue model for the live feed

**Decision:** Pausing the fleet view freezes the D3 time scale at
`pausedAt` and buffers incoming WebSocket events in a `pauseQueue:
FeedEvent[]` capped at `PAUSE_QUEUE_MAX_EVENTS` (1000). Two resume paths:

- **Resume**: drains the queue in FIFO order into `feedEvents` and shows
  a 500ms `catchingUp` flag for the visual fade.
- **Return to live**: discards the queue entirely and snaps the time
  range back to live.

The queue cap indicator is amber (`var(--status-idle)`) under the cap and
orange (`var(--status-stale)`) at the cap, with text reading
"Paused · N events buffered (oldest dropped)".

**Reasoning:** Engineers investigating an incident need to freeze the
view without losing events. The queue ensures no events are dropped
during investigation. The cap prevents unbounded memory growth if the
user pauses and walks away from the dashboard. Two resume paths cover
the two real cases: "I'm done investigating, replay what I missed" and
"I'm done investigating, snap me back to now".

**Rejected alternative:** Unbounded queue -- unbounded memory.
**Rejected alternative:** Drop events while paused -- loses information
during the most important moment for an incident investigation.

---

## D069 -- SessionDrawer Mode 1 / Mode 2 derived from props

**Decision:** `SessionDrawer` has two modes. Mode 1 (default) is the
session event list. Mode 2 is single-event detail with back navigation.
The active detail event is computed every render from props plus
internal state:

```ts
activeDetailEvent =
  directDismissed
    ? internalDetailEvent
    : (directEventDetail ?? internalDetailEvent);
```

`directEventDetail` is set by the parent (e.g. swimlane event click).
`internalDetailEvent` is set by clicking "Open full detail" within the
drawer. The Back button calls `onClearDirectEvent` so the parent knows
the prop-fed detail was dismissed. Mode is rendered directly from
`activeDetailEvent` truthiness.

**Reasoning:** A race condition existed when copying the prop into state
via `useEffect` -- the drawer rendered Mode 1 for one frame before
`directEventDetail` was copied into state, causing a visible flash and
sometimes never showing Mode 2 at all if the drawer mounted before the
prop arrived. Deriving the mode directly from props eliminates the race.

**Rejected alternative:** `useEffect` to copy `directEventDetail` into
state -- racy.

---

## D070 -- Provider logo and model registry

**Decision:** `dashboard/src/lib/models.ts` is the single source of
truth for all known model names, split by provider into
`ANTHROPIC_MODELS: Set<string>` and `OPENAI_MODELS: Set<string>`.
`getProvider(model)` does a Set lookup first (`O(1)`, exact match) with
prefix fallback (`claude-`, `gpt-`, `o1`, `o3`, `o4`) for models not yet
in the registry. `ProviderLogo` renders the brand SVG inline with brand
colors -- not CSS variables, brand colors are fixed.

**Reasoning:** The policy degrade dropdown, `PromptViewer`,
`SessionDrawer`, `LiveFeed`, and the analytics legend all needed
provider detection. A single registry prevents divergence (e.g. Anthropic
appearing under one logo in the feed and another in analytics). Inline
SVGs avoid an extra network round-trip and CSP complications.

**Rejected alternative:** Per-component provider detection -- diverges.
**Rejected alternative:** Fetched logos from a CDN -- CSP risk and adds
network latency to dashboard startup.

---

## D071 -- Bulk events load strategy

**Decision:** Extends D066. After the dashboard loads, there are zero
per-session HTTP requests. `useHistoricalEvents` fetches `GET /v1/events`
on mount and on every `timeRange` change. The result is grouped by
`session_id` to populate `eventsCache`, and is also used to seed
`feedEvents` so the live feed is not empty on page load. After the
initial bulk load, all real-time updates flow through the WebSocket
into the same caches.

**Reasoning:** D066 introduced the bulk endpoint. This decision records
the matching client-side strategy: one historical fetch per time-range
change, never per session, and the live feed is hydrated from the same
data so the user never sees an empty "Live Feed" panel on page load.
This also means new tabs do not generate a thundering herd of session
fetches.

---

## D072 -- Directive acknowledgement events in the sensor

**Decision:** Before acting on a `shutdown`, `shutdown_flavor`, or
`degrade` directive, the sensor enqueues a `directive_result` event with
`directive_status="acknowledged"` and an action-specific result dict
(e.g. `from_model`/`to_model` for degrade, `reason` for shutdown). For
shutdown variants the sensor calls `EventQueue.flush()` synchronously
before raising the shutdown flag, so the acknowledgement is not lost
when the process exits. Degrade does not need `flush()` because the
agent continues running and the queue drains normally.

**Reasoning:** Without acknowledgement events, a shutdown directive
would send the agent away with no visible confirmation in the fleet
view. Platform engineers issuing a kill switch need to see "the agent
received this and acted" -- the RESULT ✓ circle in the swimlane is that
confirmation. Without it, a stuck agent and a successfully killed agent
look identical in the dashboard for the staleness window.

**Rejected alternative:** Server-side ack on next sensor POST -- only
works if the agent successfully posts another event after the directive,
which is exactly what does not happen for shutdown.

---

## D073 -- Stopgap auth on sensor registration endpoints

**Decision:** `POST /v1/directives/sync` and `POST /v1/directives/register`
require a valid bearer token (validated against the `api_tokens` table
via the existing SHA-256 hash lookup) as a stopgap until full Phase 5
JWT auth lands. The validator lives in `api/internal/auth/token.go`
and is wired in `api/internal/server/server.go` only on those two
routes via `auth.Middleware`. All other query API endpoints (GET
/v1/fleet, GET /v1/sessions, GET /v1/events, POST /v1/directives,
etc.) remain unauthenticated, matching the pre-Phase 4.5 posture.

**Reasoning:** Phase 4.5 introduced two endpoints that the sensor
calls automatically with a bearer token (the same token it uses for
ingestion). Leaving them unauthenticated would let any caller on the
network register arbitrary custom directives or shadow legitimate
handler names. The full JWT auth refactor is a Phase 5 deliverable
and out of scope for the audit fix pass. Reusing the existing
`api_tokens` validator gives us defence-in-depth on the new
sensor-only routes today without changing the posture of the
already-unauthenticated GET routes.

The unit test handler suite mounts handlers directly without the
server wrapper, so the existing handler tests are unaffected. The
integration suite has two new tests (`test_sync_endpoint_requires_auth`
and `test_register_endpoint_requires_auth`) that exercise the 401
path on the live API.

**Resolved in:** Phase 5 (full JWT auth on every query API endpoint
will replace this stopgap).

---

## D074 -- Runtime context auto-collection at sensor init()

**Decision:** The sensor collects a runtime environment snapshot once
at `init()` time via a pluggable collector chain in
`sensor/flightdeck_sensor/core/context.py` and attaches it to the
`session_start` event payload. The control plane stores it in a new
`sessions.context` JSONB column with set-once semantics (the worker
writer deliberately omits `context` from the `ON CONFLICT DO UPDATE`
clause). The API exposes facets via `GetContextFacets()` aggregating
`jsonb_each_text(context)` across non-terminal sessions, and the
dashboard renders them as a CONTEXT sidebar filter panel plus a
collapsible RUNTIME panel in the session drawer.

The collector chain is split into three phases:

1. **Process / system** -- ProcessCollector, OSCollector, UserCollector,
   PythonCollector, GitCollector. All run, results merge into the dict.
2. **Orchestration** -- KubernetesCollector, DockerComposeCollector,
   DockerCollector, AWSECSCollector, CloudRunCollector. Run in priority
   order, **first match wins** (the loop breaks). This avoids ambiguous
   "kubernetes AND docker" results inside k8s pods that also have
   `/.dockerenv`.
3. **Other** -- FrameworkCollector. Inspects `sys.modules` for known AI
   frameworks (crewai, langchain, llama_index, autogen, haystack, dspy,
   smolagents, pydantic_ai). It NEVER imports anything new -- if a
   framework was not loaded by the agent before `init()` ran, we do not
   claim it is in use.

Every collector inherits from `BaseCollector`, whose `collect()` wraps
`_gather()` in a try/except. The top-level `collect()` orchestrator
wraps each collector call in a *second* try/except. The two layers of
protection mean a single broken collector can never crash the sensor
or block `init()`.

The `GitCollector` shells out to `git` with a 500 ms timeout, strips
embedded credentials from the remote URL via
`re.sub(r"https?://[^@]+@", "https://", remote)`, and falls back
silently when git is missing or the cwd is not a repo (the broad
`except Exception` in `_run` also catches `FileNotFoundError` on
Windows where `git.exe` may not be on PATH).

**Reasoning rejected alternatives:**

- *Per-event context* -- runtime environment is essentially static for
  the lifetime of a process. Sending it on every event would bloat
  payloads, increase NATS throughput, and force the worker writer to
  re-evaluate "did anything change?" on every insert. Once at init() is
  the right cardinality.
- *Mutable context (UPDATE on conflict)* -- session reconnects can race
  with stale collector data. Set-once means whatever the agent saw at
  startup is the canonical record for that session, which is what
  operators expect when filtering by k8s namespace or git commit.
- *Update existing UpsertSession to recompute facets server-side* --
  facets are an aggregation across many sessions and must scale with
  fleet size, so they belong in their own query. The worker writer's
  job is to write a single row, not to recompute global state.
- *Eagerly importing frameworks to detect them* -- this would cause
  side effects (FastAPI route registration, lazy ML model loads) and
  could break the agent's own startup. `sys.modules` inspection is the
  only safe option.
- *Failing the fleet request when GetContextFacets errors* -- the
  CONTEXT sidebar is best-effort UX. A facet aggregation failure (slow
  query, transient DB hiccup) must NOT take down the timeline. The
  handler logs a warning and returns an empty facet map.

**Migration:** `docker/postgres/migrations/000006_add_context_to_sessions.{up,down}.sql`
adds the column with `DEFAULT '{}'::jsonb` and a GIN index for facet
queries. The down migration drops both.

---

## D075 -- Bars view mode removed

**Decision:** The Timeline now has a single view mode: swimlane. The
stacked bar histogram (BarView, BarView.tsx, AggregatedBarView in
SwimLane) was removed entirely. The `ViewMode` type is now a single
literal `"swimlane"` so downstream components can keep the prop name
without re-typing every site at once.

**Reasoning:** At the fixed 900px canvas width (D076) the histogram
conveyed no information beyond the swimlane dots. The 24 stacked
buckets just compressed event density into rectangles whose heights
were dominated by the largest bucket -- which was always the same
session, making the bars effectively a noisy proxy for the session
list. The view-mode toggle button added UI complexity (one more
control to learn, one more state to remember) for no operational
value. Removing it lets the time range buttons own the timeline
header bar uncontested.

**Rejected alternative:** Keep BarView but hide the toggle behind a
feature flag. Rejected because dead code rots; if no one uses it the
maintenance burden grows over time.

---

## D076 -- Timeline fixed canvas width

**Decision:** Timeline uses a fixed 900px canvas width
(`TIMELINE_WIDTH_PX = 900`) for every time range. The xScale maps
the selected range domain to `[0, 900]`, so wider time ranges
produce denser circles. There is no horizontal scrollbar -- the
entire timeline fits the visible area at every range.

**Reasoning:** The original design tried proportional scaling
(`timelineWidth = BASE * (rangeMs / BASE_RANGE)`). At 1h the canvas
grew to 54,000px; at 6h to 324,000px. This caused cascading layout
bugs:

- Sticky-left flavor labels broke because the inner content div was
  wider than the viewport, so `position: sticky; left: 0` had no
  containing block to stick within and the labels scrolled away
  with the rest of the timeline.
- Horizontal scrollbar swallowed the time-axis labels, which had
  nowhere to anchor.
- Session row left panels lost their fixed widths inside the
  growing parent.

Fixed pixel space with denser circles is the correct trade-off: the
information density is the same, the layout is stable, and the
swimlane stays usable for historical views. The label intervals
(formatRelativeLabel via D077) adapt to the range so the labels
remain readable.

**Rejected alternative:** Proportional width scaling. Rejected due
to the cascade of layout bugs above.
**Rejected alternative:** Horizontal scroll inside the swimlane
only. Rejected because sticky-left positioning across nested scroll
contexts is brittle and the dashboard's vertical scroll context
(Fleet.tsx outer div) competed with the inner horizontal scroll.

---

## D077 -- Relative time-axis labels

**Decision:** The TimeAxis component renders 6 evenly-spaced
relative labels at fractions `[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]` of
the selected range. The label text is computed by
`formatRelativeLabel(ms)` which picks the unit suffix (`s`, `m`, or
`h`). The rightmost label is always `now`. No D3 tick generation,
no absolute timestamps.

For the 1m range: `60s 48s 36s 24s 12s now` (becomes `1m` for the
leftmost when 60s rolls over).
For the 1h range: `1h 48m 36m 24m 12m now`.

**Reasoning:** D3's `timeSecond.every(N)` and `timeMinute.every(N)`
tick generators broke at large widths -- the 6h range produced zero
ticks because the smallest tick interval `timeHour.every(1)` only
fits 6 labels and the algorithm rounded down. The fixed-fraction
relative approach guarantees exactly 6 labels at every range, the
intervals stay aligned with the grid line overlay, and the relative
unit makes "how long ago was this event" immediately obvious
without arithmetic against an absolute timestamp.

**Rejected alternative:** D3 timeSecond/timeMinute tick intervals.
Rejected because they broke at large widths (zero ticks at 6h, three
ticks at 1h).
**Rejected alternative:** Absolute timestamps (HH:MM:SS). Rejected
because operators care about "12 seconds ago" and "5 minutes ago"
when triaging an incident, not absolute wall-clock times that
require mental arithmetic.

---

## D078 -- simple-icons for platform glyphs

**Decision:** The dashboard uses the `simple-icons@^16.15.0` npm
package as a devDependency for Apple, Linux, Kubernetes, Docker,
and Google Cloud SVG paths. These five icons render via a shared
`SimpleIconSvg` helper at the package's standard `viewBox="0 0 24
24"`. Hand-crafted fallback SVGs at `viewBox="0 0 14 14"` cover
Windows (four-square grid) and AWS ECS (hexagon), which are not
available in simple-icons.

Color overrides:
- Apple uses `#909090` instead of `siApple.hex` (`#000000`) so it
  renders visibly on dark backgrounds.
- Linux uses `#E8914A` (Tux orange).
- Kubernetes uses `#326CE5`, Docker `#2496ED`, Google Cloud
  `#4285F4`, Windows `#0078D4`, AWS ECS `#FF9900`.

**Reasoning:** Hand-crafting brand SVG paths at 14px is inaccurate
-- the resulting glyphs look "off" compared to the official brand
versions. simple-icons ships pixel-perfect paths maintained by the
project. Test assertions lock in that the rendered `<path d>`
matches `siApple.path` / `siLinux.path` / etc verbatim, so any
future simple-icons upgrade that changes a brand path will fail
fast in CI rather than silently swapping the visible glyph.

Windows and AWS ECS keep hand-crafted fallbacks because:
- Windows: simple-icons removed the Microsoft logo for trademark
  reasons. No alternative entry exists.
- AWS ECS: simple-icons has no per-service AWS icons, only generic
  AWS-related entries that don't fit the ECS use case.

**Rejected alternative:** Hand-crafted paths for all icons.
Rejected because they look inaccurate at 14px next to hostnames in
the swimlane.
**Rejected alternative:** Lucide icons (square, server, box) as
generic substitutes. Rejected because they don't visually
communicate which platform the agent is running on.

---

## D079 -- Custom directives sidebar section removed

**Decision:** The Custom Directives card that previously rendered
inside `FleetPanel` (via the `DirectivesPanel` child) is removed
entirely. Its empty state ("decorate a function with
`@flightdeck_sensor.directive()` and call init() to register one")
was developer documentation, not operational UI. The DIRECTIVE
ACTIVITY section also hides its header AND body when there are no
recent events -- no more "No directive activity yet" placeholder.

Directive triggering moves to two operational locations:

1. **SessionDrawer Directives tab** -- a third tab next to Timeline
   and Prompts, conditionally rendered when the session's flavor
   has registered custom directives. The tab content is a stack of
   `DirectiveCard`s targeting that single session id.
2. **FleetPanel flavor row Directives icon button** -- a Zap icon
   button next to the Stop All icon button on each flavor row,
   conditionally rendered when the flavor has registered
   directives. Clicking opens a Dialog with one `DirectiveCard`
   per directive, each configured to fan out to every active+idle
   session of that flavor.

The shared `DirectiveCard` component lives in
`src/components/directives/DirectiveCard.tsx` and is parameterised
on `sessionId` vs `flavor` (mutually exclusive) so the same
component handles both single-session and fleet-wide triggers.

**Reasoning:** A sidebar section that mostly displays "no directives
registered, here's how to register one" is documentation occupying
prime UI real estate. The relevant operational moment for a custom
directive is "I'm looking at a specific session and want to send it
a command" or "I'm looking at a flavor and want to send the command
to every session of that flavor". Both moments are now one click
away from the relevant context, instead of being three clicks away
in a sidebar card.

The DIRECTIVE ACTIVITY section is operational (shows recent
directive results), so it's kept -- but its empty state was the
same kind of "nothing here, here's the next step" filler and is
also removed. The section now appears only when there is actual
activity to report.

**Rejected alternative:** Move the registered directive list to a
new top-level page. Rejected because the existing /directives page
already serves that role. Duplicating it under a different
navigation path would split the audience without adding value.

---

## D080 -- Context JSONB PII fields deferred to Phase 5+

**Decision:** The `sessions.context` JSONB column stores `user`,
`hostname`, `working_dir` (Claude Code plugin only), `k8s_pod`,
`k8s_namespace`, and `k8s_node` alongside the non-sensitive runtime
fields (pid, os, arch, python_version, git_commit, git_branch,
git_repo, frameworks, orchestration). In the current self-hosted v1
deployment these are visible only to the deploying organization and
present no third-party privacy or topology-leak risk -- the
operator's own engineers see their own infrastructure metadata.

In any future shared or multi-tenant Flightdeck deployment those same
fields would constitute PII (`user`, `working_dir`) or
infrastructure-topology leaks (`hostname`, `k8s_pod`, `k8s_namespace`,
`k8s_node`) crossing tenant boundaries. Before any multi-tenant Phase
is implemented, a context field scrubbing mechanism must be designed:
either an opt-out list in `init()` config, server-side field
filtering at ingestion / GetContextFacets, or a separate
anonymized context store keyed off tenant id.

**Reasoning:** v1 is explicitly self-hosted only per CLAUDE.md
("Multi-tenant SaaS (self-hosted only in v1)"). Designing a scrubber
now would be speculative scope creep and tie us to assumptions about
the tenant model that does not yet exist. Recording the deferred
concern here ensures future contributors evaluating multi-tenant work
encounter this requirement before they ship anything.

**Rejected alternative:** Strip the fields preemptively in v1.
Rejected because the fields are operationally valuable for the
self-hosted deployment use case (filter "show me everything running
in the prod k8s namespace") and removing them would degrade today's
UX in exchange for a hypothetical future tenant model.

**Rejected alternative:** Hash or anonymize the fields in v1.
Rejected because hashes break the facet-filtering UX (operators
cannot meaningfully filter by `sha256(hostname)`).

**Deferred to:** Phase 5+ (multi-tenant deployment is out of scope
for v1). Surfaced by the Phase 4.5 audit (Hat 4 -- security review).

---

## D081 -- Two-queue directive architecture (B-H)

**Decision:** The sensor's `EventQueue` runs **two** background
daemon threads instead of one. The drain thread
(`flightdeck-event-queue`) pulls events from the event queue,
calls `ControlPlaneClient.post_event`, and on a non-None directive
in the response envelope hands the directive off to a separate
**directive queue** via `put_nowait` and immediately resumes
draining. A second daemon thread
(`flightdeck-directive-queue`) drains the directive queue and
invokes the configured `directive_handler` (typically
`Session._apply_directive`) one directive at a time.

The drain thread NEVER executes directive logic. Directive
delivery latency is decoupled from event throughput. Single-
consumer directive processing gives at-most-once execution for
free.

**Reasoning -- the original B-A direct-callback approach was
unsafe under load:**

The first attempt at fixing B-A (the drain thread silently
discarding directives because it had no Session reference) wired
`Session._apply_directive` as a callback that the drain thread
invoked inline. Each event the drain processed could trigger an
arbitrary `_apply_directive` call before `task_done()` was reached.
The Phase 4.5 audit Part 1 Section C investigation found three
concrete failure modes:

1. **Slow custom handler stalls the event queue.** A handler
   running on the drain thread (e.g. `time.sleep(60)`, slow HTTP,
   blocked lock) pinned the drain. Events from other threads kept
   filling the queue via the non-blocking `enqueue`. After 1000
   queued events the overflow path silently dropped the oldest
   ones. At 100 events/sec a 60-second handler caused ~5,000 lost
   events.

2. **Shutdown ack `flush()` deadlock workaround introduced a new
   bug.** The drain thread cannot safely call `Queue.join()` on
   its own queue (it has not yet `task_done()`-ed the current
   item, so `unfinished_tasks > 0` forever). The B-A patch
   added an `is_drain_thread()` guard that **silently skipped**
   the synchronous flush from inside `_apply_directive(SHUTDOWN)`,
   trading the deadlock for an ack-loss race: if the agent
   process exited between the drain returning and the next
   iteration posting the ack, the operator's "did the agent
   acknowledge the kill switch?" query returned no row.

3. **Concurrent event throughput cratered during directive
   execution.** While the drain thread was busy applying any
   directive (custom, degrade, policy-update, anything), no other
   thread's events could reach ingestion. Token enforcement on
   the workers' side fell behind because the workers stopped
   receiving post_call events. The async-queue invariant ("the
   drain thread is always promptly available to drain the next
   item") was violated.

The two-queue refactor fixes all three:

1. The drain thread's only directive-related work is a
   single `put_nowait` (≤ 1 µs). Events keep flowing.
2. `_apply_directive` runs on the directive handler thread,
   which is **independent** of the drain thread. `flush()` from
   inside `_apply_directive` waits on the event queue's
   `Queue.join()`, the drain thread continues to drain the
   event queue, `unfinished_tasks` reaches 0, `flush()` returns
   synchronously without deadlock. The `is_drain_thread()` guard
   was removed entirely.
3. A single-consumer directive thread serialises directive
   application without contending with the drain thread for any
   shared state.

**Constraints honoured:**

- Drain thread NEVER blocks on directive logic.
- `teardown()` stops both threads cleanly via sentinels and
  `Thread.join(timeout=5)`. If a thread fails to exit within
  the timeout, `close()` logs at error level (re-audit Hat 1
  Minor finding).
- `flush()` only waits on the event queue. Waiting on the
  directive queue from inside the directive handler would
  self-deadlock by exactly the same mechanism the original
  `is_drain_thread()` guard was working around.
- A buggy custom handler that calls `sys.exit()` or raises
  `BaseException` no longer kills the directive thread silently;
  the loop wraps `directive_handler()` in `except BaseException`
  (re-audit Hat 4 Minor finding fix).

**Rejected alternative:** Direct callback on the drain thread
(B-A first attempt). Rejected for the three failure modes above.

**Rejected alternative:** Bounded thread pool consuming the
directive queue. Rejected because (a) at-most-once execution
becomes a dedup problem, (b) handler ordering is no longer
preserved, (c) custom handlers may rely on being single-threaded.

**Resolved:** Phase 4.5 audit Part 2 (after the user-flagged
unsafe-under-load investigation). Test
`tests/integration/test_sensor_e2e.py::test_slow_handler_does_not_block_event_throughput`
is the direct regression check.

---

## D082 -- `Session.record_usage` returns post-increment total (B-G)

**Decision:** `Session.record_usage(usage)` now returns the
post-increment value of `_tokens_used` as an `int`. The
increment AND the read happen inside the same `with self._lock:`
critical section. The interceptor's `_post_call` captures this
return value and passes it explicitly into `_build_payload` as
`tokens_used_session=session_total`, instead of letting
`_build_payload` re-read `self._tokens_used` after other threads
may have advanced it.

**Reasoning:** Under concurrent traffic the previous order
(build payload before incrementing) reported `tokens_used_session`
values that were either off-by-one (single-threaded case: each
event reported the pre-call total) or arbitrarily corrupted
(multi-threaded case: reported the value after other threads'
increments). The dashboard's per-session token curve was jagged
or duplicated. The fix is local: capture the post-increment
value atomically and pass it explicitly.

**Verified by:** `test_pattern_b_concurrent_calls_no_data_loss`
asserts the cumulative total in two places:
`sessions.tokens_used` (workers' counter) and
`get_status().tokens_used` (sensor's counter). Both must equal
`expected_calls * 18` after 4 threads × 5 calls.

**Rejected alternative:** Make `_build_payload` accept a
`tokens_used_session_override` kwarg that replaces the locked
read. Rejected as more invasive: explicit override at one call
site (the interceptor) is clearer than a special-case kwarg.

---

## D083 -- `directive_result` event schema rename (B-D)

**Decision:** `Session._build_directive_result_event` now emits
field names that match the worker's `consumer.EventPayload`
struct so that `BuildEventExtra` persists them into
`events.payload`:

| Old (silently dropped) | New |
|---|---|
| `directive_success: bool` | `directive_status: str` (`"success"` / `"error"`) |
| `directive_result: Any` | `result: Any` |
| `directive_error: str | None` | `error: str | None` |

The payload also gains `directive_action: "custom"` for
symmetry with the SHUTDOWN / DEGRADE acknowledgement events,
which already use this field.

**Reasoning:** Pre-fix, the worker's `BuildEventExtra` only
decoded `directive_status`, `result`, `error`, etc. The sensor
emitted `directive_success`, `directive_result`,
`directive_error` -- none of which the worker decoded. Custom
directive success flags, return values, and error messages were
silently lost at the ingestion boundary, leaving custom
directive results unobservable in the dashboard. Discovered while
strengthening `test_sensor_custom_directive_registered_and_triggered`
to assert `directive_status="success"` in the DB.

**Verified by:** `test_sensor_custom_directive_registered_and_triggered`
queries `events.payload->>'directive_status'` and asserts
`"success"`.

**Compatibility:** This is a wire change. Sensor versions
emitting the OLD field names (`directive_success` etc.) will
have their custom directive results silently dropped by current
workers, which is the same behaviour they had before the fix --
no regression. New sensors against old workers similarly drop
the new field names. Acceptable because both sides ship from
the same monorepo and are released together.

---

## D084 -- `PolicyCache._forced_degrade` flag (B-E)

**Decision:** `PolicyCache` has a new `_forced_degrade: bool`
flag that arms an unconditional DEGRADE decision in `check()`.
`set_degrade_model(model)` (called by `Session._apply_directive`
when a server DEGRADE directive arrives) sets the flag along
with `degrade_to`. `update(policy_dict)` (called for
`POLICY_UPDATE` directives) clears the flag so a fresh policy
can un-stick the forced state if the server retracts the degrade.

`check()` short-circuits at the top of the locked block: if
`_forced_degrade and degrade_to`, returns
`PolicyResult(DEGRADE, source="server")` regardless of token
thresholds.

**Reasoning:** Pre-fix, the workers' policy evaluator could
issue a DEGRADE directive based on its own server-side
cumulative count without ever populating the sensor's local
`degrade_at_pct` cache. (Preflight policy fetch can fail
silently per KI14, leaving the cache empty.) When the DEGRADE
directive eventually arrived via the response envelope, the
sensor's `set_degrade_model` only set `degrade_to` but
`check()` still required `pct >= degrade_at_pct` to return
DEGRADE -- and `degrade_at_pct` was at its default 90%, so the
swap never happened. The sensor silently kept using the
original model.

The forced flag bypasses the threshold evaluation entirely:
once the server has explicitly told the sensor to swap, the
sensor swaps on every subsequent call until told otherwise.

**Verified by:**
`test_sensor_degrade_directive_via_policy_threshold` and
`test_pattern_b_degrade_seen_by_all_threads` -- both assert
that calls AFTER the directive_result(degrade=acknowledged)
event use the degraded model.

**Rejected alternative:** Always set `degrade_at_pct = 0` when
a DEGRADE directive arrives. Rejected because it conflates
"forced by directive" with "policy threshold of 0%", confusing
operators reading the dashboard.

---

## D085 -- `DirectiveResponse.Payload` projection (B-F)

**Decision:** `ingestion/internal/handlers/events.go:DirectiveResponse`
now has a `Payload *json.RawMessage` field with
`json:"payload,omitempty" swaggertype:"object"` so the JSONB
blob attached to `action="custom"` directives in the
`directives` table makes it back to the sensor in the response
envelope. `omitempty` keeps the JSON envelope clean for
non-custom directives (shutdown / degrade / etc.) which have
no payload.

`directiveAdapter.LookupPending` in `ingestion/cmd/main.go`
projects `directive.Directive.Payload` (already a
`*json.RawMessage` in the directive store) into the new field
on the outgoing response.

**Reasoning:** Pre-fix, the adapter dropped the `Payload`
field while building the `handlers.DirectiveResponse` from
`directive.Directive`. Custom directives reached the sensor
with an empty `payload: {}` and Pydantic's
`DirectivePayloadSchema` failed validation on the missing
required `directive_name` and `fingerprint` fields. The handler
was never invoked. Discovered while strengthening
`test_sensor_custom_directive_registered_and_triggered` to
assert the handler was actually called.

**Verified by:**
`test_sensor_custom_directive_registered_and_triggered` and
`test_pattern_b_custom_directive_during_traffic` both assert
the handler ran.

---

## D086 -- KI14 and KI15 deferred to Phase 5 (KI14 resolved in Phase 4.9)

**Decision:** Two architectural limitations discovered during
the Phase 4.5 audit are deferred to Phase 5 rather than fixed
immediately. Both have TODO(KI14) / TODO(KI15) markers in code
and Open-table entries in `KNOWN_ISSUES.md`.

**KI14 -- sensor URL routing.** The sensor's
`ControlPlaneClient` builds URLs as
`f"{self._base_url}/v1/directives/sync"` (and similar for
`/register`, `/policy`). With `init(server="http://localhost:4000/ingest")`
the URL resolves to `/ingest/v1/directives/sync`, but the
ingestion service does NOT host the directives sync handler --
it lives on the api service. In dev nginx routes `/ingest/*`
straight to ingestion which 404s. The sensor's broad
`except Exception` swallows the failure and the auto-register /
preflight policy paths silently fail open.

Three possible fixes, each requiring an architectural decision:

1. Add a separate `api_url` config param to `init()`.
   Cleanest sensor-side fix; an API change for users.
2. Add nginx forwarding rules for `/ingest/v1/directives/*`
   and `/ingest/v1/policy` to the api service. Smallest change;
   couples dev infra to the bug.
3. Restructure the deployment so a single `/v1/*` root sits in
   front of both services and nginx splits by path. Cleanest
   long-term answer; bigger Helm chart change.

Deferred because all three options require the supervisor to
choose, and the existing tests work around the bug by
pre-registering directives via `POST /api/v1/directives/register`
directly.

Resolved in: Phase 4.9
Resolution: Option 1 chosen -- separate `api_url` param added to
`init()`. See D088 for full details.

**KI15 -- sensor singleton.** The sensor maintains a
process-wide singleton via the module-level `_session` global.
The second `init()` call in any thread is a no-op with a
warning. Pattern B (one init per thread, isolated Sessions)
and Pattern C (multiple agents in one process) are not
supported in v1. The `_directive_registry` global has the
same scoping limitation.

Three possible fixes, each requiring an architectural decision:

1. Session-handle API change: `init()` returns a Session object
   that callers must thread through `wrap(session, client)` and
   `patch(session)` explicitly. Breaks the existing two-line
   `init()` UX.
2. Per-thread storage via `threading.local()`. Doesn't compose
   with thread pools (the same OS thread serves multiple agent
   contexts).
3. Per-flavor map keyed by `AGENT_FLAVOR`. Couples isolation to
   environment-variable lifecycle.

Deferred because the typical multi-agent use case (CrewAI,
LangGraph, etc.) currently works fine on one Session with a
shared `AGENT_FLAVOR` -- every agent's calls flow through the
same fleet identity. Per-agent Session isolation is an
optional enhancement, not a v1 blocker. Documented as KI15.
`tests/integration/test_sensor_e2e.py::test_pattern_c_ki15_singleton_limitation`
asserts the current behaviour and is designed to fail loudly
when KI15 is resolved, signalling that the test should be
updated to verify the new isolated-Sessions semantics.

**Resolved in:** Phase 5 (both items, separate work).

---

## D087 -- Class-level SDK patching

**Decision:** `flightdeck_sensor.patch()` mutates SDK client
classes in place by replacing `functools.cached_property`
descriptors with sensor-managed descriptors. It does NOT
subclass the client, does NOT use import hooks, and does NOT
replace module attributes with factory functions.

Six classes are patched: `anthropic.Anthropic`,
`anthropic.AsyncAnthropic`,
`anthropic.resources.beta.beta.Beta`,
`anthropic.resources.beta.beta.AsyncBeta`, `openai.OpenAI`,
and `openai.AsyncOpenAI`. Five descriptor classes:

| Descriptor | Installed on | Wraps in |
|---|---|---|
| `_AnthropicMessagesDescriptor` | `Anthropic.messages`, `AsyncAnthropic.messages` | `SensorMessages` |
| `_AnthropicBetaMessagesDescriptor` | `Beta.messages`, `AsyncBeta.messages` | `SensorMessages` |
| `_OpenAIChatDescriptor` | `OpenAI.chat`, `AsyncOpenAI.chat` | `SensorChat` |
| `_OpenAIResponsesDescriptor` | `OpenAI.responses`, `AsyncOpenAI.responses` | `SensorResponses` |
| `_OpenAIEmbeddingsDescriptor` | `OpenAI.embeddings`, `AsyncOpenAI.embeddings` | `SensorEmbeddings` |

Each descriptor on first instance access (1) invokes the
original `cached_property`'s underlying function to obtain the
raw SDK resource, (2) wraps it in a sensor proxy bound to the
active session, and (3) stores the wrapped version in
`instance.__dict__[name]` so subsequent accesses bypass the
descriptor (matching `functools.cached_property` semantics).
If no sensor session is active (`_session is None`) the
descriptor returns the raw resource WITHOUT populating the
cache, so a later access after `init()` will wrap correctly.

Idempotent: a second `patch()` is a no-op. Reversible:
`unpatch()` restores the original descriptors. Per-resource
sentinels store the originals: `_flightdeck_patched` (messages
/ chat -- backward compatible with `wrap()`'s short-circuit
check), `_flightdeck_patched_responses`,
`_flightdeck_patched_embeddings`.

**Why these resources and not others:**

- `messages` / `beta.messages` (Anthropic): the only LLM
  inference entry points on the Anthropic SDK. `beta.messages`
  is where Claude 4 adaptive/extended thinking lives; it is
  now a standard inference path, not a niche beta feature.
- `chat.completions` (OpenAI): the primary LLM inference path
  for every framework tested (LangChain, LlamaIndex, CrewAI).
- `responses` (OpenAI): recommended API for all new OpenAI
  projects since March 2025. Future OpenAI features land here
  first. CrewAI supports it via `api="responses"`.
- `embeddings` (OpenAI): common in RAG-heavy agent pipelines
  and relevant for full-workflow token accounting.
- **Deliberately NOT patched**: `audio`, `images`,
  `moderations`, `files`, `fine_tuning`, legacy `completions`,
  `OpenAI.beta.chat.completions.parse`/`.stream`. These are
  utility resources (transcription, image generation, content
  classification, file management, fine-tuning jobs, structured
  output) with no LLM-inference analog relevant to agent fleet
  management. Adding them would widen the patch surface with
  no observability value. Each can be added in the future by
  creating a parallel descriptor + entry in the patch table.

**Reasoning -- the original closure-based approach was broken:**

The pre-Phase 3 implementation (`_patch_anthropic` /
`_patch_openai`) replaced the `anthropic.Anthropic` /
`openai.OpenAI` MODULE ATTRIBUTES with factory function thunks
that returned wrapped instances. This had three critical
failure modes:

1. **Phase 4.5 Finding 2 crash:** `_is_async_client` called
   `isinstance(client, AsyncAnthropic)`. After `patch()`
   replaced `anthropic.AsyncAnthropic` with a function,
   `isinstance(x, function)` raised `TypeError`. This
   crashed the sensor on every async Anthropic call.

2. **Captured-reference bypass:** `from anthropic import
   Anthropic` before `patch()` bound a reference to the real
   class. After `patch()` replaced the MODULE attribute,
   the captured reference still pointed at the original class.
   Framework code that imported `Anthropic` at module load
   time silently bypassed the patch entirely.

3. **isinstance breakage:** after the thunk replaced the
   class, `isinstance(client, anthropic.Anthropic)` returned
   `False` for every wrapped instance, breaking SDK internals
   and user code that relied on type checks.

The class-level mutation approach fixes all three by design:
`patch()` mutates the actual class object (not the module
attribute), so captured references, isinstance checks, and
type(client) all continue to work correctly. The class
identity is preserved; only one non-data descriptor per
patched resource is replaced.

**Rejected alternative A -- Subclass Anthropic/OpenAI:**
Create `FlightdeckAnthropic(anthropic.Anthropic)` with
overridden `.messages` property. Replace `anthropic.Anthropic`
with the subclass. Rejected because (a) it still replaces
the module attribute, causing the same captured-reference and
isinstance problems, (b) subclass construction is fragile
against SDK `__init__` signature changes, and (c) there is no
way to subclass `Beta` / `AsyncBeta` without also subclassing
the client that returns them, creating a chain of patched
constructors.

**Rejected alternative C -- Import hook (`sys.meta_path`):**
Install a custom `MetaPathFinder` that intercepts
`import anthropic` / `import openai` and returns a module
wrapper with patched classes. Rejected because (a) it only
works if `patch()` is called before the first import --
framework code often imports at module load before any user
code runs, (b) import hooks add debugging complexity, and
(c) the mechanism provides no advantage over direct class
mutation for the problem being solved.

**Pre-existing instance limitation:**

Instances that accessed `.messages` / `.chat` /
`.responses` / `.embeddings` BEFORE `patch()` ran have the
raw, unwrapped resource cached in `instance.__dict__`. Python
attribute lookup checks `instance.__dict__` before non-data
descriptors on the class, so the descriptor is permanently
bypassed for those instances. This is inherent to the
`functools.cached_property` protocol and is documented in
ARCHITECTURE.md. Walking arbitrary live instances to clear
their `__dict__` caches would require a gc traversal and is
not attempted. In practice, `patch()` is called at process
startup before any framework constructs LLM clients, so this
limitation does not affect production use.

Covered by
`test_pre_existing_instance_not_intercepted` in
`tests/integration/test_framework_patching.py`.

**GuardedAnthropic → SensorAnthropic rename:**

The original Phase 1 per-instance wrapper classes were named
`GuardedAnthropic`, `GuardedOpenAI`, `GuardedMessages`,
`GuardedCompletions`, `GuardedChat`, and `GuardedStream`.
"Guarded" came from the tokencap library's terminology
(budget-guarding semantics). In Phase 3, all `Guarded*`
classes were renamed to `Sensor*` to match the product
vocabulary: the component is a "sensor," not a "guard."
`GuardedStream` was retained because it IS a guard (it
reconciles tokens on context-manager exit including early
exit) and the "sensor" name would misrepresent its role.

**Resolved in:** Phase 4.9 -- KI17 closed. The
`wrap()`-without-`patch()` path previously did not intercept
`client.beta.messages` because `SensorAnthropic` had no `.beta`
property. Added `SensorBeta` wrapper plus `SensorAnthropic.beta`
`@property` so both code paths now have parity. `wrap()` covers
`messages` and `beta.messages` without requiring `patch()`.

---

## D088 -- KI14 resolved: separate api_url for control-plane calls

**Decision:** Add an `api_url` parameter to `init()` so the sensor
uses separate base URLs for ingestion (events, heartbeats) and
control-plane operations (directive registration, directive sync,
policy prefetch).

**Problem:** The sensor built all URLs against a single `_base_url`
from the `server` parameter. When `server` pointed to the ingestion
service (e.g. `http://localhost:4000/ingest`), directive and policy
calls hit `/ingest/v1/directives/*` and `/ingest/v1/policy` -- routes
that do NOT exist on the ingestion service. The handlers live on the
API service. Result: silent 404s on every directive registration and
policy prefetch at `init()` time. The broad `except Exception` in
the transport client swallowed the errors and the sensor proceeded
without registering directives or loading policy.

**Options considered:**

1. **Nginx proxy rules** forwarding `/ingest/v1/directives/*` and
   `/ingest/v1/policy` to the API service. Rejected: couples the fix
   to a specific reverse-proxy configuration, breaks in deployments
   without nginx, and muddies the architectural boundary between
   ingestion (high-throughput fire-and-forget) and API (low-frequency
   control plane).

2. **Separate `api_url` parameter on `init()`** (chosen). The sensor
   explicitly targets the correct service for each call type. Works
   in all deployment environments. Default derivation
   (`server.replace("/ingest", "/api")`) handles the common dev
   setup without configuration.

**What changed:**

- `SensorConfig` gains `api_url: str` field (`core/types.py`)
- `init()` gains `api_url: str | None = None` param; reads
  `FLIGHTDECK_API_URL` env var; defaults to
  `server.rstrip("/").replace("/ingest", "/api")`
- `ControlPlaneClient.__init__` gains `api_url: str` param; stores
  as `_api_url`; `sync_directives` and `register_directives` use
  `_api_url` instead of `_base_url`
- `Session._preflight_policy` uses `config.api_url` instead of
  `config.server`
- TODO(KI14) comment removed from `transport/client.py`

Resolved in: Phase 4.9

---

## D089 -- Smoke test suite: plain Python, real API keys

**Decision:** The smoke test suite (`tests/smoke/smoke_test.py`) uses
plain Python with no test framework (no pytest, no unittest).

**Why not pytest?** The smoke test runs real LLM API calls against a
live stack. It must be runnable in any environment without installing
test framework dependencies. A developer with `pip install
flightdeck-sensor` and API keys can run `python tests/smoke/
smoke_test.py` directly. The output is human-readable PASS/FAIL/SKIP
per check, not pytest's verbose assertion rewriting.

**Cost control:** Uses only claude-haiku-4-5-20251001 ($0.80/$4 per
1M tokens) and gpt-4o-mini ($0.15/$0.60 per 1M). All prompts are
"hi" with max_tokens=5 except where a richer response is needed
(tool use, streaming). Estimated cost per full run: < $0.05.

**KI15 workaround (multi-session, Group 11):** The sensor has a
module-level singleton. Multiple concurrent init() calls in the
same process are unreliable (second is a no-op). The smoke test
runs multi-session scenarios sequentially: init → run → teardown →
init → run → teardown. No overlapping init() calls.

**KI17 noted (Group 1f):** beta.messages is tested only via
patch(), not wrap(). wrap() does not intercept beta.messages due
to the missing SensorBeta wrapper class.

---

## D090 -- Custom directive fingerprint scoped to flavor

**Problem:** The `custom_directives` table had a global
`UNIQUE(fingerprint)` constraint. The sensor computes the fingerprint
as SHA-256 of `(name, description, parameters)` only -- flavor is not
in the hash. Two different flavors registering a directive with the
same name and schema therefore produced the same fingerprint and
clobbered each other's flavor attribution silently: the first
registration wins, subsequent flavors see their sync return
`unknown=[]` and skip registration, and the `ON CONFLICT (fingerprint)
DO UPDATE SET last_seen_at = NOW()` upsert does not overwrite the
`flavor` column either. `GET /v1/directives/custom?flavor=<new>` then
returns no rows for the later flavor even though its sensor is live.

**Decision:** Replace the global `UNIQUE(fingerprint)` with a composite
`UNIQUE(fingerprint, flavor)`. The fingerprint continues to track
schema versioning **within a flavor**; cross-flavor collision is no
longer possible. `SyncDirectives` now filters by `(fingerprint, flavor)`
so a fingerprint is only "known" if it exists for *this* flavor.
`RegisterDirectives` uses the composite key in its `ON CONFLICT`
clause and still updates `last_seen_at` on conflict.

**Rejected alternative:** Include flavor in the fingerprint hash
itself. Rejected because the fingerprint is meaningful on its own as
a schema identity -- mixing identity (flavor) and content (schema)
into one hash makes it harder to reason about schema evolution and
forces the sensor to recompute fingerprints per flavor. Keeping the
hash purely schema-derived and scoping uniqueness at the storage
layer is the cleaner separation.

**Migration:** `000007_directive_fingerprint_flavor_key.{up,down}.sql`.
Up drops the existing unique constraint on `fingerprint` and adds
`UNIQUE (fingerprint, flavor)`. Down is the exact inverse.

---

## D091 -- KI15 and KI16 closed as v1 won't-fix

**Decision:** Both deferred items are accepted as permanent v1
limitations. No code change; documentation only. Removed from the
KNOWN_ISSUES.md Open table, moved to Resolved with this entry as
the resolution record.

**KI15 -- module-level Session singleton.**

Previous framing (D086) listed three candidate fixes -- a
Session-handle API, `threading.local`, or a per-flavor map -- and
deferred to a Supervisor decision. The decision: **none of them
land in v1.** The right answer for users who genuinely need
isolated agent sessions is to run separate processes, one sensor
per process, exactly as the smoke test already demonstrates in
`tests/smoke/smoke_test.py::_scenario_5b_flavor_wide_shutdown`
(two `subprocess.Popen` workers, each with its own
`flightdeck_sensor.init()`). This works today, has zero shared
state by construction, and matches how the v1 deployment story
recommends running agents (one container = one agent =
optionally one process).

A handle-based API would change the two-line `init()` UX that the
sensor's adoption story rests on, and would force every framework
adapter (LangChain, LlamaIndex, CrewAI) to thread a Session object
through abstractions they don't expose. `threading.local` doesn't
compose with thread pools (one OS thread can serve many agent
contexts in CrewAI / asyncio executors). A per-flavor map keys
isolation to environment variables, which means env mutation at
runtime silently switches sessions.

Multi-Session-in-one-process is therefore deferred to v2 alongside
the multi-tenant SaaS work tracked in CLAUDE.md "Out of scope."
The existing test
`tests/integration/test_sensor_e2e.py::test_pattern_c_ki15_singleton_limitation`
remains as the assertion-of-current-behaviour and the canary that
will fail loudly if the singleton constraint is ever relaxed.

**KI16 -- single-POST drain thread.**

Previously framed as "Phase 4.9 may optionally add micro-batching
(50-100 events per POST)." The decision: **no micro-batching in
v1.**

Justification matches the existing TODO body: real LLM provider
latency (hundreds of ms per call) throttles event generation
naturally. Four concurrent workers fire at most ~10 events/s; the
drain thread clears each in ~5-10 ms via one HTTP POST. The
1000-slot queue only fills under pathological synthetic load (the
old respx-mocked tests at zero latency, which the suite already
mitigates with a 50 ms `side_effect` delay). Production cannot
generate enough event rate to exercise the fallback. Adding
batching would introduce a buffering window (data-loss surface on
process crash), would require ingestion-side multi-event payload
support, and would complicate the per-event response envelope used
for directive delivery (`POST /v1/events` returns a single
directive per call -- batching breaks that contract).

If a future workload demands sustained >100 events/s per process
(none in scope for v1), a separate ingestion path can be added at
that time. For now the existing behaviour is correct and the
fallback is acceptable.

---

## D094 -- Optional session_id hint in init() with backend attachment

**Problem:** Agents spawned repeatedly by orchestrators (Temporal
workflows, Airflow DAGs, cron-driven batch jobs) get a different
sensor-generated UUID on every run. The fleet view therefore
treats every re-run as a brand-new session with no relationship to
its predecessor, and operators cannot ask "how did this workflow
do last time?" or "show me the full token cost across all runs of
this pipeline" without out-of-band joins.

**Decision:** `flightdeck_sensor.init()` accepts an optional
`session_id` parameter. The caller supplies either the kwarg or
the `FLIGHTDECK_SESSION_ID` environment variable (env wins over
kwarg, matching the existing `FLIGHTDECK_SERVER` /
`AGENT_FLAVOR` pattern). When provided, the sensor uses the
caller-supplied value verbatim instead of generating a UUID and
logs a single WARNING at `init()` to make the behaviour visible:

    Custom session_id provided: '{value}'. This ID will be used
    as-is and will not be auto-generated. If a session with this
    ID already exists, the backend will attach this agent to it.

The ingestion API owns the attach decision. On arrival of a
`session_start` event, a new `ingestion/internal/session.Store`
(mirroring the existing `directive.Store` pattern) runs a
synchronous check against the `sessions` table:

- Row does not exist → no-op, `attached=false`. The worker will
  create it as usual.
- Row exists in `{closed, lost}` → state flips to `active`,
  `last_attached_at = NOW()`. `started_at` and `ended_at` are
  deliberately preserved so the original lifetime stays in the
  DB. `attached=true`.
- Row exists in `{active, idle, stale}` → `last_attached_at` is
  stamped. No state change. `attached=true`.

The ingestion response envelope gains a top-level
`"attached": boolean` field. The sensor's `ControlPlaneClient`
surfaces it alongside the parsed directive; `Session._post_event`
logs `"Attached to existing session {id}."` at INFO on the first
envelope that carries `attached=true` and latches a per-process
guard so subsequent envelopes do not duplicate the line.

The worker's `HandleSessionStart` no longer skips terminal
sessions (KI13 behaviour kept for every other event type). The
ingestion path has already committed the state flip by the time
the worker consumes the NATS message, so `UpsertSession`'s ON
CONFLICT branch runs as a regular refresh. Heartbeat, post_call,
and session_end still honour `isTerminal` -- attachment is a
session_start-only transition, not a general "un-close" for the
whole event stream.

**Schema.** Migration `000008_add_last_attached_at_to_sessions`
initially added a single `last_attached_at TIMESTAMPTZ` column on
`sessions`. **Migration `000009_session_attachments` superseded that
design** before it shipped: the column only preserved the most
recent attachment timestamp, which threw away the full history of
how often an orchestrator-driven agent had re-attached. The 000009
migration drops the column and replaces it with a dedicated
`session_attachments(id, session_id, attached_at)` table plus a
`(session_id, attached_at)` index. The ingestion attach store
now `INSERT`s one row per arrival instead of `UPDATE`ing a column,
and `GET /v1/sessions/:id` returns `attachments: []time` so the
dashboard drawer can draw one run separator per recorded
attachment rather than only the most recent. A session with zero
rows in `session_attachments` is a session that has only ever run
once.

**UUID validation.** The sensor validates `session_id` (kwarg OR
`FLIGHTDECK_SESSION_ID` env var) via `uuid.UUID(value)` at `init()`
time. On parse failure -- e.g. the caller passed a raw Temporal
workflow id -- the sensor logs a warning and falls back to
auto-generating a UUID so the agent still boots. The sessions
table column is UUID-typed, so an unvalidated non-UUID would fail
at worker time and drop every event for the agent. Callers with
string-typed identifiers (Temporal workflow_id, Airflow
dag_run_id) must hash into a deterministic UUID first, e.g.
`uuid.uuid5(FLIGHTDECK_NS, workflow_id)`. See the Temporal
example in `sensor/README.md`.

**Out of scope.** The attach flow does not support changing
flavor / agent_type / host mid-session: those columns are
`COALESCE`d by `UpsertSession` in the worker and the caller is
expected to keep them consistent across runs. Multi-tenant
session-id collisions (same UUID, different tenant) are
prevented by the existing one-tenant-per-deployment model (v1
is self-hosted).

**Risks considered and dismissed.** Clearing `ended_at` on revive
would make historical queries ambiguous about how long the prior
run took; preserving it keeps the DB truthful. Preserving
`started_at` instead of resetting keeps "session age" metrics
stable across attachments. Letting the worker (not ingestion)
decide the attach state would mean the response envelope shipped
before the decision was made, making `attached` best-effort and
unreliable. The synchronous ingestion check is worth the one
extra read+write per session_start because session_start is rare
(once per process) and the alternative leaks implementation timing
into caller visibility.

---

## D095 -- Opaque token auth with SHA256+salt replacing hardcoded tok_dev

**Problem:** KI10 -- token auth used SHA256 without a salt and relied
on a single hardcoded `tok_dev` string seeded by `init.sql`. There
was no management UI, no way to rotate credentials, and the same
value was shared across every sensor, dashboard user, and
integration test. Leaking the `api_tokens` table would expose every
token in the fleet; a stolen laptop or misconfigured dashboard
install would grant permanent access because the platform had no
way to revoke or rename a token.

**Decision:** Replace the fixed-string model with opaque tokens.

- **Token format:** `ftd_` prefix + 32 random hex chars (16 bytes
  of `crypto/rand`). The `ftd_` prefix makes tokens identifiable in
  logs and by grep; the random suffix is the secret.
- **Storage:** `api_tokens` now stores `(id, name, token_hash,
  salt, prefix, created_at, last_used_at)`. `token_hash` is
  `hex(SHA256(salt || raw_token))`; `salt` is 16 random bytes per
  token encoded as hex. Only the hash and salt are stored -- raw
  tokens are never persisted. `prefix` is the first 8 chars of the
  raw token and is used to narrow candidate rows before the
  per-row hash comparison.
- **`tok_dev` dev-mode gate:** migration `000010` reseeds the
  table with a single `Development Token` row whose raw value is
  `tok_dev`. The auth middleware accepts it only when the service
  reads `ENVIRONMENT=dev`; otherwise it returns `401` with a body
  instructing the caller to create a real token in the Settings
  page. Production deployments deliberately omit the env var so
  the seed becomes inert without having to delete the row.
- **Session attribution:** `sessions` gains `token_id` (FK to
  `api_tokens.id`, `ON DELETE SET NULL`) and `token_name` (denorm).
  The ingestion API resolves the authenticating token on every
  request and injects `(token_id, token_name)` into the NATS
  payload for `session_start` events; the worker persists them
  onto the session row. `token_name` survives revocation for
  historical auditability.
- **Dev-seed hash derivation** (reproducible):
  - `salt = "d0d0cafed00dfaceb00bba5eba11f001"` (16 bytes, hex)
  - `token_hash = hex(SHA256("d0d0cafed00dfaceb00bba5eba11f001tok_dev"))`
  - `            = 0c805243ecd4f6f59bec56235a1901d97ad8cf0771020f2d44da428827f1145e`
  - `prefix = "tok_dev_"` (literal 8-char fallback; middleware
    short-circuits on `raw == "tok_dev"` before the prefix lookup).

**Why not bcrypt/argon2?** Considered, but the validation path
runs on every sensor event and dashboard poll. bcrypt at a safe
cost parameter is milliseconds per call; SHA256+salt is
microseconds, and the secret material is 16 bytes of CSPRNG
output so key-stretching adds no practical defense against
brute force. The threat model here is DB exfiltration, which a
per-token salt already neutralizes for randomly-generated tokens.

**Why not JWT?** JWTs carry claims we don't need (no RBAC in v1),
require key management the platform doesn't have, and make
revocation harder rather than easier. Opaque DB-backed tokens
revoke by deleting a row.

**Why denormalize `token_name` onto `sessions`?** Two reasons.
First, the session drawer wants to render "Created via: $NAME"
without a join against `api_tokens` -- that join becomes
expensive once production fleets have many tokens and many
sessions. Second, revoking a token (`DELETE FROM api_tokens`) is
a normal operator action; `ON DELETE SET NULL` on `token_id`
preserves the historical label so we can still show "Created via:
Staging K8s (revoked)" in the UI months after the token was
deleted.

**Phase 5 split:**

- Part 1a (this change): schema + auth middleware + session
  wiring + KI10 resolution.
- Part 1b: `/v1/tokens` CRUD endpoints, Settings UI on the
  dashboard, sensor integration with user-created tokens.

**Resolves:** KI10.
**Code locations:**

- `docker/postgres/migrations/000010_api_tokens.up.sql`
- `docker/postgres/migrations/000011_sessions_token.up.sql`
- `ingestion/internal/auth/token.go`
- `api/internal/auth/token.go`
- `ingestion/internal/handlers/events.go`
- `workers/internal/processor/session.go`
- `workers/internal/writer/postgres.go`

---

## D096 -- Rename "token" to "access token" for auth credentials

**Problem:** After Phase 5 D095 shipped, the term "token" in the
codebase and UI became ambiguous. Flightdeck already tracks LLM
input/output tokens (`tokens_input`, `tokens_output`, `tokens_used`,
`token_limit`, policy `warn_at_pct`/`degrade_at_pct`/`block_at_pct`
thresholds in LLM tokens), and the D095 auth credentials are also
called "tokens". Operators reading "token" in a log line or a policy
threshold could not tell which kind was meant without context.

**Decision:** Consistently rename the auth-credential concept to
**access token** throughout the codebase.

**Renamed:**

- Database table: `api_tokens` → `access_tokens` (migration 000012).
  The FK column `sessions.token_id` and the denormalized
  `sessions.token_name` column deliberately keep their names --
  renaming would ripple through every reader with no semantic gain,
  and the FK still points at the renamed table by OID.
- Go types: `TokenRow`, `CreatedTokenResponse`, `TokenValidator`
  (sentinel errors too) → `AccessTokenRow`,
  `CreatedAccessTokenResponse`, etc. Store methods
  (`ListTokens`/`CreateToken`/`DeleteToken`/`RenameToken`) and
  handlers (`TokensListHandler` ...) gained the `Access` infix.
- API routes: `/v1/tokens` → `/v1/access-tokens` (all four verbs).
- Dashboard: the `API_TOKEN` constant in `lib/api.ts` is now
  `ACCESS_TOKEN`; the `WS_TOKEN_QUERY` helper is `WS_ACCESS_TOKEN_QUERY`.
- Files: `api/internal/store/tokens.go` →
  `api/internal/store/access_tokens.go` (same for the handler file).

**Not renamed** (deliberate):

- `sensor.init(token=...)` kwarg and the `FLIGHTDECK_TOKEN` env var.
  These are public surface on the sensor SDK; renaming would break
  every existing integration for no internal benefit. The init()
  docstring now clarifies that the value is a Flightdeck access
  token (ftd_...), not an LLM token count.
- The NATS payload fields `token_id` / `token_name` emitted by the
  ingestion API for session_start events. The worker consumes them
  under the same names when populating `sessions.token_id` /
  `sessions.token_name`, and renaming would require a coordinated
  schema change across ingestion and workers for zero semantic gain.
- LLM token fields: `tokens_input`, `tokens_output`, `tokens_used`,
  `token_limit`, `tokens_total`, `token_policies`, `token_hash`,
  `token_limit_session` (NATS payload). These are correct already --
  they refer to LLM tokens.

**Code locations:**

- `docker/postgres/migrations/000012_rename_access_tokens.up.sql`
- `api/internal/auth/token.go`, `ingestion/internal/auth/token.go`
- `api/internal/store/access_tokens.go`
- `api/internal/handlers/access_tokens.go`
- `api/internal/server/server.go`
- `dashboard/src/lib/api.ts`, `dashboard/src/hooks/useFleet.ts`
- `sensor/flightdeck_sensor/__init__.py` (docstring clarification)

---

## D097 -- CONTEXT facets cover all session states, not just live

**Problem:** `GetContextFacets` (store/postgres.go) restricted the
aggregation to `WHERE state IN ('active', 'idle', 'stale')`. The
CONTEXT sidebar on the Fleet page therefore disappeared the moment
every session on the box closed -- which is the normal resting
state of a dev stack between smoke test runs. Operators opening
the dashboard after a batch of runs found no framework / OS / git
branch breakdown at all, even though the underlying data was
still in the `sessions` table.

**Decision:** Drop the state restriction. The CONTEXT panel now
aggregates every session whose `context` JSONB is non-empty,
regardless of state (matches `GetFleet`, which excludes only
`lost`; closed sessions remain visible in the fleet list, and
their context data remains useful for composition questions like
"what frameworks has this install ever seen"). `{}::jsonb` rows
are still excluded because they have no values to facet on.

**Why this is correct rather than a regression:** the CONTEXT
panel is a description of **fleet composition**, not a live-ness
indicator. The Fleet view itself shows closed sessions (grey
state pills, historical tokens), so having the sidebar hide the
moment those are the only rows left is a UX defect. The
state-based live-ness filter belongs on the flavor row state
column and the event feed, not on context aggregation.

**Time windowing:** GetFleet has no time window filter, so
GetContextFacets does not add one either -- the goal per the
Phase 5 task brief is "same session population that the Fleet
view shows". If a time window is later introduced on the Fleet
endpoint, GetContextFacets should gain the matching parameter.

**Code locations:**

- `api/internal/store/postgres.go::GetContextFacets`
- `api/internal/store/postgres_test.go::TestGetContextFacetsUnnestArrayValues`
  (test SQL mirrored to match)

---

## D098 -- Analytics `provider` dimension via SQL `CASE` on model name

**Problem:** Analytics v2 wants a provider breakdown (anthropic /
openai / google / xai / mistral / meta / other). The `events` table
has `model` but no `provider` column. The `event_content.provider`
column is populated only when `capture_prompts=true` (D094 opt-in)
and is therefore sparse or empty in most deployments -- not suitable
as the authoritative provider source.

**Options considered:**
1. Add `events.provider TEXT NOT NULL DEFAULT 'unknown'` via a new
   migration, have the sensor set it from the intercepted client
   class (Anthropic / OpenAI SDK), plus a one-off backfill that
   infers provider from `model` for historical rows.
2. Derive provider at query time via a SQL `CASE` expression over
   `model`.

**Decision:** Option 2 for v1. The query-time CASE expression is
added to `validGroupByColumns` in `api/internal/store/analytics.go`
alongside the other whitelisted group-by columns, and keyed as
`"provider"`. The mapping is also mirrored in
`dashboard/src/lib/models.ts::getProvider` for client-side UI work
(provider logos, colours) -- both must stay in sync when a new
model family lands.

**Tradeoff:** The mapping lives in two places (SQL + TS). A future
improvement (not v1) is to add a real `events.provider` column,
have the sensor populate it at `post_call` time, and drop the SQL
CASE branch. Until then, rolling out a new provider family (e.g.
Cohere) requires editing both the SQL expression and the TS helper.

**Code locations:**

- `api/internal/store/analytics.go::validGroupByColumns["provider"]`
- `dashboard/src/lib/models.ts::getProvider`

---

## D099 -- Analytics `estimated_cost` metric with static pricing table

**Problem:** Operators want a "how much are we spending" view.
Computing this server-side needs per-model pricing. We do not
want a live pricing feed (no upstream contract, no refresh
schedule) and we do not want per-customer discount tables
(self-hosted v1 has no tenant model).

**Decision:** Ship a static, hand-maintained pricing map in
`api/internal/store/pricing.go` keyed by exact model name. Values
are `(input_per_mtok, output_per_mtok)` in USD, taken from public
list prices as of the commit date. The query builds a SQL `CASE`
from the map and computes
`SUM(tokens_input * input_rate + tokens_output * output_rate)` per
time bucket. Models missing from the map contribute $0; the API
response exposes a `partial_estimate` flag so the dashboard can
show a disclaimer.

**UI disclosure:** The Analytics page renders an amber-toned
disclaimer above the cost chart stating the numbers are based on
public list prices and exclude volume discounts, enterprise
commitments, and cached-token rebates.

**Tradeoff:** Accuracy decays as providers change prices. The
pricing table is a normal source file -- it moves with commits,
not a service restart. A quarterly refresh is the expected
maintenance cadence. Treat reported figures as approximate and
never as billable.

**Code locations:**

- `api/internal/store/pricing.go` (new)
- `api/internal/store/analytics.go::QueryAnalytics` (cost metric path)

---

## D100 -- Cache token columns on events + Claude Code emits real tokens

**Date:** 2026-04-17
**Phase:** 5

**Context.** The Claude Code plugin reported every LLM call with
`tokens_input=0`, `tokens_output=0`, `tokens_total=0`, `model=null`. The
plugin docstring claimed Claude Code hooks could not expose token counts.
That claim is incomplete: hooks receive `transcript_path` on every
invocation, and the JSONL transcript carries the full Anthropic API
response envelope for every assistant turn, including the `usage` object
and the model name. "Tokens = 0" was a plugin limitation, not a platform
constraint. Meanwhile the Python sensor's `AnthropicProvider.extract_usage`
folded `cache_read_input_tokens` and `cache_creation_input_tokens` into
`tokens_input`, erasing the cache breakdown from analytics even for the
sensors that did report tokens.

**Decision.**

1. Add two columns to `events`: `tokens_cache_read BIGINT NOT NULL
   DEFAULT 0` and `tokens_cache_creation BIGINT NOT NULL DEFAULT 0`.
   Migration `000013_cache_tokens_on_events`. Default 0 is safe for
   every existing row; every caller now writes both.
2. Keep `tokens_input` as the full-input sum (uncached + cache_read +
   cache_creation) so existing analytics and token-budget enforcement
   stay numerically identical. The new columns are additive visibility.
3. Update the Python sensor's `TokenUsage` dataclass to carry both new
   fields and update `AnthropicProvider.extract_usage` to populate them
   from the Anthropic response's `cache_read_input_tokens` and
   `cache_creation_input_tokens` attributes.
4. The Claude Code plugin tails the JSONL transcript on every `Stop`
   hook, groups assistant records by `message.id`, and emits a
   `post_call` event carrying model, token counts (all four fields),
   and per-turn latency. This makes Claude Code sessions first-class in
   analytics, cost estimation, policy enforcement, and latency metrics
   with no special-casing on the backend.

**Rejected alternatives.**

- **Emit a new event_type for Claude Code LLM turns.** Rejected: the
  Python sensor's `pre_call`/`post_call` contract already fits
  perfectly, and adding a new event_type would require analytics,
  policy, and dashboard changes that would not otherwise be needed.
- **Change `tokens_input` to mean uncached-only.** Rejected: every
  historical row would need backfill, analytics queries would report
  lower numbers than before the migration, and policy budgets tuned
  against the old definition would silently become more permissive.
- **Put cache fields in the events.payload JSONB.** Rejected: cache
  economics are high-value analytics; JSONB is for per-event-type
  metadata that does not deserve a column. A query like "show me cache
  hit rate by flavor" should not need `payload ->> 'tokens_cache_read'`.

**Plugin side-effects resolved in the same phase.**

- `Stop` hook mapping was `session_end`, which is incorrect: Claude
  Code's `Stop` fires after every assistant turn, not at session
  teardown. `Stop` now maps to `post_call`. Real session teardown
  comes from `SessionEnd`.
- Synthetic first-hook `session_start` replaced by the real
  `SessionStart` hook. Source (`startup` / `resume` / `clear` /
  `compact`) and `model` now come from the hook payload.
- `SubagentStart` and `SubagentStop` hooks emit child `session_start`
  and `session_end` events with `parent_session_id`, so Task
  sub-agents appear as proper child sessions in the fleet.

**Code locations.**

- `docker/postgres/migrations/000013_cache_tokens_on_events.{up,down}.sql`
- `sensor/flightdeck_sensor/core/types.py::TokenUsage`
- `sensor/flightdeck_sensor/providers/anthropic.py::extract_usage`
- `sensor/flightdeck_sensor/core/session.py::_build_payload`
- `sensor/flightdeck_sensor/interceptor/base.py::_post_call`
- `workers/internal/consumer/nats.go::EventPayload`
- `workers/internal/writer/postgres.go::InsertEvent`
- `workers/internal/processor/event.go::Process`
- `api/internal/store/postgres.go::Event`
- `plugin/hooks/scripts/observe_cli.mjs::{transcriptReader, EVENT_MAP}`

---
