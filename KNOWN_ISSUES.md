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

*(None currently open. Items discovered in the rest of Phase 5 or during Phase 6 land here.)*

## Deferred to v0.4.0

Items that are real hardening work but not v0.3.0 blockers. The Supervisor
decided to ship v0.3.0 without them; each row carries the follow-up scope
so the v0.4.0 plan can pick it up directly.

| ID   | Component  | Deferral reason + follow-up scope                                                                                                                                                                                                                                                                                                                                                                                                                          | DECISIONS |
|------|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------|
| KI11 | Security   | `make dev` NATS is unauthenticated on purpose -- single-host developer loop, adding token/NKey auth just slows the feedback cycle. **v0.4.0 follow-up:** wire NATS auth (token or NKey) into `docker/docker-compose.prod.yml` and the Helm chart; dev compose stays as-is.                                                                                                                                                                                | D047      |
| KI12 | Security   | Per-IP rate limiting on the query API belongs at the nginx ingress, not in Go middleware -- nginx is the only prod entry point and `limit_req` is battle-tested. **v0.4.0 follow-up:** add `limit_req_zone` + `limit_req` on `/ingest/` (and optionally `/api/`) in `nginx.prod.conf`.                                                                                                                                                                     | D048      |
| KI20 | Sensor     | `flightdeck_sensor.init()` reads `FLIGHTDECK_SERVER` verbatim and expects the URL to already carry the `/ingest` suffix. The Claude Code plugin sets the same env var without the suffix (it appends `/ingest/v1/events` itself), so a developer with both tools on one machine hits a silent 404 when they try to run a sensor-based script. `playground/_helpers.init_sensor` normalises the URL as a workaround today. **v0.4.0 follow-up:** append `/ingest` (or raise `ConfigurationError`) inside `init()`; delete the playground normaliser once the sensor-side fix ships. | D110      |
| KI21 | Sensor     | litellm's anthropic provider (`litellm/llms/anthropic/chat/handler.py`) uses raw `httpx.Client.post()` via `litellm.llms.custom_httpx.http_handler` instead of constructing `anthropic.Anthropic()`. `flightdeck_sensor.patch()` hooks SDK-class descriptors, so litellm-routed Anthropic calls bypass interception. litellm's openai provider (`litellm/llms/openai/openai.py`) DOES instantiate `openai.OpenAI()` / `AsyncOpenAI()` and IS intercepted, so this is asymmetric by provider. Verified empirically against litellm 1.83.10 + `make dev`. **v0.4.0 follow-up:** add an httpx-level interceptor in the sensor, OR register `litellm.success_callback` once the public-API surface is confirmed. Targets litellm-direct users and any framework (current CrewAI non-native prefixes, langchain-community litellm adapter, etc.) that routes through litellm's httpx-based providers. | D112      |
| KI22 | Dashboard  | `.font-mono` in `dashboard/src/styles/globals.css:52` sets `font-size: 12px` globally, which overrides Tailwind utilities like `text-[10px]` / `text-[11px]` on mono spans (token pill, timestamps, hex IDs, hostnames, state badges, etc.). Phase 5 restored the token pill to 10px via a localised inline `fontSize: 10` on `SessionEventRow.tsx`, but that is a one-spot fix for a global problem. **v0.4.0 follow-up:** remove the `font-size: 12px` declaration from `.font-mono` in `globals.css` and audit every mono span across the dashboard (timeline row hashes + indices + badges + token pills, event-node popovers, session-drawer headers and event rows, analytics labels, Settings access-token table cells) to confirm each span's intended size still renders after the global rule goes away; set explicit per-span sizes where the old global was compensating. Revert the `fontSize: 10` override once the global is gone. | —         |
| KI23 | Dashboard  | Radix tooltip on the Fleet session-row token pill does not fire despite correct `TooltipProvider` / `TooltipTrigger asChild` wiring (`SessionEventRow.tsx:284-306`). Stays `data-state="closed"` after real hover, synthetic `pointerenter`, and hover-move-away-hover-back. Zero `[role="tooltip"]` nodes in the DOM. Removing the parent row's native `title` attribute (Phase 5 attempt) did not unblock it, so the root cause is elsewhere. **Not a v0.3.0 blocker:** token names under ~128px render fully after the 10px font fix (Phase 5 KI22 mitigation); the tooltip was only needed for long custom token names that would still ellipsis. Fallback for the edge case: open the session drawer to see the full token name in the metadata grid. **v0.4.0 follow-up:** diagnose — candidates include a missing app-root `TooltipProvider` (radix-ui requires the provider in scope for state wiring), `asChild` + `data-state` conflict on the `<span>` trigger, or parent pointer-event handlers on the sticky left panel / row-click handler swallowing the pointer events before Radix sees them. Fix, then re-enable rich hover content (e.g. full token name + "Access token:" prefix). | —         |
| KI24 | CI         | GitHub Actions on `release.yml` and `ci.yml` emit "Node.js 20 actions are deprecated" annotations for `actions/checkout@v4`, `actions/setup-python@v5`, `docker/*` actions (v3-v6), and `softprops/action-gh-release@v2`. GitHub deadlines: default Node runtime flips to Node 24 on **June 2 2026**; Node 20 actions are **hard-removed from runners September 16 2026**. Fix options (least-work first): **(a)** add `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at each job's `env:` block in the workflows — opts in ahead of the deadline with a one-line diff per job; **(b)** wait for each action's maintainer to ship a Node-24-compatible version and bump pins. **(a) is recommended.** Not blocking v0.3.x but must land before June 2 2026 or release / CI workflows start breaking. | —         |

## Resolved

| ID    | Component  | Concern                              | Resolved in | DECISIONS |
|-------|------------|--------------------------------------|-------------|-----------|
| KI13  | API        | Ingestion accepts events for closed/lost sessions -- lost branch fixed by D105 revive-on-any-event; closed branch kept as WAI via worker-authoritative handleSessionGuard | Phase 5 | D105 + D106 |
| KI18  | Plugin     | Unreachable-flag persisted for session lifetime; plugin stopped sending after any single HTTP failure | Phase 5     | D106 (server) + 4a (plugin) |
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
| KI14  | Sensor/API | sync_directives URL routing          | Phase 4.9   | D088      |
| KI15  | Sensor     | Module-level Session singleton (won't-fix v1) | Phase 4.9 | D091 |
| KI16  | Sensor/Ingestion | Single-POST drain thread (won't-fix v1)  | Phase 4.9 | D091 |
| KI17  | Sensor     | wrap() did not intercept beta.messages | Phase 4.9 | D087      |
| KI10  | Security   | SHA256 token auth without salt       | Phase 5     | D046, D095 |
