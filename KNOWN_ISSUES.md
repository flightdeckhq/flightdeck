# Known Issues and Deferred Concerns

This file is the index of all deferred architectural concerns. The authoritative
location for each issue is the TODO comment in the code itself. This file provides
a phase-by-phase summary view.

Claude Code: at the start of every phase, run:

```bash
grep -rn "TODO(KI" . \
  --include="*.go" \
  --include="*.py" \
  --include="*.ts" \
  --include="*.yml" \
  | grep "\[Phase N\]"
```

Replace N with the current phase number. Every result must be included in the
phase plan before any feature work begins. When an item is resolved, remove its
TODO comment from the code, move it to the Resolved table below, and record the
fix in DECISIONS.md. Never leave a resolved TODO comment in the code.

---

## Open

| ID   | Component  | Concern                              | Risk   | Phase | File                                        | DECISIONS |
|------|------------|--------------------------------------|--------|-------|---------------------------------------------|-----------|
| KI10 | Security   | SHA256 token auth without salt       | Low    | 5     | auth/token.go:Validate                      | D046      |
| KI11 | Security   | No NATS auth in dev compose          | Low    | 5     | docker/docker-compose.yml:nats              | D047      |
| KI12 | Security   | REST endpoints have no per-IP rate limit | Low | 5    | api/internal/server/server.go               | D048      |
| KI13 | API        | Ingestion accepts events for closed/lost sessions | Low | 5 | ingestion/internal/handlers/events.go    | -         |
| KI14 | Sensor/API | sync_directives URL routing -- sensor targets ingestion base URL but `/v1/directives/{sync,register,custom}` and `/v1/policy` live on the API service. In dev, nginx does not forward these routes from `/ingest/*` to api, causing silent 404. The sensor's auto-register at `init()` and preflight policy fetch silently fail open. Needs architectural decision: separate `api_url` config param on `init()`, OR nginx proxy rules forwarding `/ingest/v1/directives/*` and `/ingest/v1/policy` to api, OR a single root `/v1/*` that nginx splits by path. | Medium | 4.9 | sensor/flightdeck_sensor/transport/client.py:sync_directives, sensor/flightdeck_sensor/core/session.py:_preflight_policy, docker/nginx/nginx.dev.conf | -         |
| KI15 | Sensor   | Module-level Session singleton. The sensor maintains a single `_session` global; the second `init()` call in a process is a no-op with a warning. Pattern B (one init per thread, isolated Sessions) and Pattern C (multiple agents in one process, each with its own Session) are not supported -- every thread shares the first init's flavor / token / policy cache. The `_directive_registry` is global with the same scoping limitation: two `@directive` decorators with the same name overwrite each other. Needs an architectural decision (Session-handle API change, per-thread storage, or per-flavor map keyed by AGENT_FLAVOR). Phase 4.5 audit Part 1 finding B-I/B-J. | Medium | 4.9 | sensor/flightdeck_sensor/__init__.py (`_session`, `_directive_registry`, `init`) | -         |
| KI16 | Sensor/Ingestion | The drain thread does one HTTP POST per event sequentially. Under pathological synthetic load (e.g. respx-mocked tests with zero provider latency, or any future scenario with sub-millisecond producer rate) the 1000-slot event queue can fill and the drop-oldest fallback fires. In production this cannot occur because real LLM provider latency (hundreds of ms per call) throttles event generation naturally -- four concurrent workers fire ~10 events/s, well within drain capacity. Phase 4.9 may optionally add micro-batching (50-100 events per POST in a short time window) to reduce HTTP overhead and provide headroom for future high-throughput use cases. | Low | 4.9 | sensor/flightdeck_sensor/transport/client.py:enqueue | -         |
| KI17 | Sensor | `wrap()` without `patch()` does not intercept `beta.messages` calls. `SensorAnthropic` has no `.beta` property so a user who calls `wrap(anthropic.Anthropic())` without calling `patch()` will not have `beta.messages` calls intercepted. `patch()` is the recommended path and covers `beta.messages` fully via the `_AnthropicBetaMessagesDescriptor` on the `Beta` class. Fixing requires adding a `SensorBeta` wrapper class and a `SensorAnthropic.beta` `@property` that returns it. | Low | 4.9 | sensor/flightdeck_sensor/interceptor/anthropic.py:SensorAnthropic | D087 |

## Resolved

| ID    | Component  | Concern                              | Resolved in | DECISIONS |
|-------|------------|--------------------------------------|-------------|-----------|
| KI-R1 | Sensor     | Hot path blocking on event POST      | Phase 1     | D037      |
| KI-R2 | API        | LISTEN connection no reconnect       | Phase 1     | D038      |
| KI-R3 | Ingestion  | Kill switch not delivered to idle     | Phase 1     | D049      |
| KI01  | Sensor     | PolicyCache empty on first call      | Phase 2     | D040      |
| KI05  | Workers    | No state transition guards           | Phase 2     | D042      |
| KI06  | Workers    | Per-event policy Postgres query      | Phase 2     | D043      |
| KI02  | Ingestion  | NATS event loss on unavailability    | Phase 4     | D041      |
| KI03  | Ingestion  | Token validation not cached          | Phase 4     | D048      |
| KI04  | Ingestion  | No rate limiting                     | Phase 4     | D048      |
| KI07  | API        | GET /v1/fleet no pagination          | Phase 3     | D045      |
| KI08  | API        | WebSocket broadcast fan-out          | Phase 4     | D044      |
| KI09  | Sensor     | SIGKILL phantom session state        | Phase 3     | D039      |
