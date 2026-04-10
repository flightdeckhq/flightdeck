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
