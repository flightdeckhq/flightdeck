# Phase 4 Audit — Agent Communication Coverage Hardening

Closes the "we observe what we claim to observe" gap before release. Covers
embeddings, comprehensive streaming semantics, LLM API errors as first-class
structured events, and session-lifecycle edge cases.

Branch: `feat/phase-4-comms-coverage` (cut from main at `9383653`, includes
PR #27).

---

## Plan-of-record decisions

Answers to the 8 V-pass open questions:

| # | Question | Decision |
|---|---|---|
| Q-FW | bifrost + LangChain scope | **Indirect** for both. LangChain remains transitively covered by the Anthropic + OpenAI patches. bifrost is covered by users pointing the OpenAI client at bifrost's OpenAI-compatible `base_url`; the coverage matrix notes this and a dedicated bifrost smoke test is scaffolded but optional. No new per-framework interceptor file for either in this phase. |
| Q-ASYNC-STREAM | async streaming for Anthropic + OpenAI | **In scope.** Lift `NotImplementedError`, add `GuardedAsyncStream`, same TTFT/chunk/abort semantics as sync. |
| Q-LITELLM-STREAM | resolve KI26 in Phase 4 | **Out of scope.** Keep litellm streaming as 🔨 Planned; close the streaming-semantics gap for the SDKs that already stream. |
| Q-VOYAGE | dedicated Voyage SDK interceptor | **Out of scope.** Supported path is Voyage-via-litellm; LangChain-direct-Voyage is 🔨 Planned. |
| Q-CLOCK-SKEW | timestamp bounds at ingestion | **Enforced.** Reject `occurred_at < NOW() - 48h` or `occurred_at > NOW() + 5m` with 400. Bound widened from the V-pass proposal of 24h to 48h to accommodate the E2E `aged-closed` fixture (28h old by design) plus realistic retry-after-long-outage windows. Bounds are constants; can become env vars in a later phase. |
| Q-STALENESS-CONFIG | env-var tuning of stale/lost thresholds | **Out of scope** for Phase 4. |
| Q-THEMES-CSS | new `--event-embeddings` + `--event-error` tokens | **Approved** (Rule 15). Per-theme values in `styles/themes.css`. |
| Q-MAKE-SMOKE-NAME | `test-smoke` vs new `smoke-*` | Rename existing `test-smoke` → `test-smoke-playground`. New `smoke-<framework>` per framework, `smoke-all` runs the per-framework set. |

---

## Coverage matrix (target state after Phase 4 merges)

Legend: ✅ supported · ⚠️ partial · ❌ N/A · 🔨 planned (explicitly deferred).

| Framework | Chat (baseline) | Embeddings | Streaming semantics (TTFT/chunks/abort) | Error events (structured) | Smoke file | Integration coverage |
|---|---|---|---|---|---|---|
| Anthropic SDK | ✅ | ❌ N/A (native; recommend litellm→Voyage) | ✅ sync + async | ✅ | `tests/smoke/test_smoke_anthropic.py` | `test_*_events.py` |
| OpenAI SDK | ✅ | ✅ emits `event_type="embeddings"` | ✅ sync + async | ✅ | `tests/smoke/test_smoke_openai.py` | same |
| litellm | ✅ | ✅ (new module-level patch on `embedding`/`aembedding`) | 🔨 KI26 (non-stream only today) | ✅ | `tests/smoke/test_smoke_litellm.py` | same |
| Claude Code plugin | ✅ | ❌ N/A (observational) | ❌ N/A (observational) | ⚠️ partial (emits `stream_error` only when transcript shows an unexpected termination — low priority) | `tests/smoke/test_smoke_claude_code.py` | — |
| LangChain | ✅ (via #1 + #2) | ✅ via OpenAI; 🔨 via Voyage | inherits #1 + #2 | inherits #1 + #2 | `tests/smoke/test_smoke_langchain.py` | same |
| bifrost | ✅ (indirect via OpenAI patch) | ✅ (indirect) | ✅ (indirect) | ✅ (indirect) | `tests/smoke/test_smoke_bifrost.py` (optional) | — (piggybacks on OpenAI integration tests) |

---

## Error taxonomy

14-entry `error_type` enum, each entry mapped to its OTel `gen_ai.error.type`
counterpart for future export compatibility:

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
| `overloaded` | 529 / 503 | Anthropic 529, OpenAI "engine overloaded" | `overloaded_error` | ✅ |
| `timeout` | — | Client-side timeout before response | `timeout_error` | ✅ |
| `stream_error` | — | Mid-stream error after a 200 response | `stream_error` | ⚠️ case-by-case |
| `other` | — | Fallback for unknown | `other` | ❌ |

---

## Session-lifecycle edge cases (V5 inventory)

Locked cases (Decision D) + discovered cases from V-pass research:

| # | Case | Current behaviour | Phase 4 fix |
|---|---|---|---|
| D1 | Orphan session_start | Ages active → stale (2m) → lost (30m) via reconciler | No code change; add integration test |
| D2 | Orphan session_end | Silent FK-drop via Nak/DLQ path | Pre-FK detection in `HandleSessionEnd`; WARN log + `dropped_events_total{reason="orphan_session_end"}` increment; ACK the NATS message (nothing to recover) |
| D3 | Duplicate session_end | Already idempotent | No code change; add integration test |
| D4 | Mid-stream disconnect | No signal; observed via event silence | Sensor emits `llm_error{error_type="stream_error",abort_reason="client_aborted"}` on HTTP exception during streaming (V4 work) |
| D5 | Out-of-order session_end before session_start | Same as D2 | Folds into D2 fix |
| D6 | Out-of-order post_call before session_start | Already handled via D106 lazy-create + COALESCE upgrade | No change |
| D7 | Past timestamp (> 48h ago) | Accepted verbatim | Ingestion rejects with 400 "timestamp too old" |
| D8 | Future timestamp (> 5m ahead) | Accepted verbatim (session freezes in active) | Ingestion rejects with 400 "timestamp in future" |
| D9 | Re-attach to already-active session | Already idempotent | No change |
| D10 | Malformed session_id | Accepted; fails later at Postgres cast | Ingestion regex-validates (same pattern as `agent_id`) |
| D11 | FK on agent deletion | Not currently reachable without direct DB manipulation | No change; runbook note |
| D14 | No `dropped_events_total` metric | Doesn't exist | Add counter with `reason` label; expose via `/metrics` |
| D15 | Negative / nonsensical `tokens_*` | Stored verbatim | Ingestion rejects `tokens_* < 0` with 400 |
| D16 | Thin worker unit-test coverage | Two mock tests | Expand to cover new paths |

---

## Rule 40d (new, added to CLAUDE.md in this PR)

> Any phase that adds framework support OR changes framework-emission behaviour
> MUST include:
>
> 1. **Real-provider smoke tests** per affected framework (manual, NOT in CI —
>    they cost money and need live API credentials). Scaffolded under
>    `tests/smoke/` with pytest-skip when the relevant env var is missing.
>    Run via `make smoke-<framework>`. Results documented in the phase's
>    audit doc before PR merge.
> 2. **Integration tests** per framework × behaviour combo, mock-free (or
>    lightly mocked at the network boundary), running in CI via the existing
>    Integration job.
>
> V-pass for such a phase MUST enumerate the smoke and integration tests that
> will be added before implementation starts. Skipping either is a phase-gate
> failure.

Applies to this phase and every subsequent framework-touching phase.

---

## Smoke-test results

Run against the local dev stack on **2026-04-25** with real provider
API keys loaded into the operator's shell env (Anthropic + OpenAI).
Cost across all five targets: **<$0.01**.

| Framework | Tests | Events observed | Anomalies |
|---|---|---|---|
| Anthropic SDK | 4 / 4 ✅ | session_start, post_call (chat + sync stream + async stream with streaming sub-object), llm_error (`error_type=not_found`, classifier hit), session_end | 2 sensor bugs surfaced + fixed (see below); 4 smoke-scaffolding bugs surfaced + fixed |
| OpenAI SDK | 5 / 5 ✅ | post_call (chat, sync + async stream w/ streaming sub-object), embeddings (event_type promoted), llm_error (`error_type=authentication`) | 1 sensor bug surfaced + fixed (async-create + stream returned non-awaitable); same scaffolding bugs covered above |
| litellm | 4 / 4 ✅ | post_call via OpenAI + Anthropic backends, embeddings, llm_error | None — Phase 4 shapes round-tripped cleanly through the litellm patch |
| LangChain | 3 / 3 ✅ | post_call via ChatAnthropic + ChatOpenAI, embeddings via OpenAIEmbeddings | Pydantic V1 / Python 3.14 deprecation warning surfaces from upstream LangChain (not a sensor issue) |
| Claude Code plugin | 1 / 1 ✅ | CLI presence sanity (scripted full-session harness deferred — covered by FOLLOWUPS) | None |
| bifrost | (optional, not run) | — | Skipped per Q-FW decision; coverage rides on the OpenAI patch |

### Sensor bugs caught by Rule 40d

Two production-impacting Phase 4 bugs that mock-only unit tests
missed; both fixed on this branch with the smoke target as the
regression guard going forward.

1. **`AsyncOpenAI.chat.completions.create(stream=True)` returned a
   non-awaitable `GuardedAsyncStream`.** Native OpenAI returns a
   coroutine that resolves to `AsyncStream`; the sensor wrapper
   was missing the awaitable wrapping, so `await
   client.chat.completions.create(stream=True)` raised `TypeError:
   GuardedAsyncStream object can't be awaited`. Async stream users
   on Phase 4 would have been completely broken. Fix: inline
   `async def` wrap in `SensorCompletions.create`, plus
   `GuardedAsyncStream.__aenter__` now awaits a coroutine `_real_fn`
   return for the OpenAI pattern.

2. **`capture_prompts=True` + streaming = silent post_call drop.**
   The post_call drain panicked with `Object of type AsyncStream
   is not JSON serializable` because `extract_content` walked the
   raw stream object's `__dict__` and the JSON encoder choked on
   nested httpx state. Anthropic now calls
   `response.get_final_message()` when available (returns the
   accumulated `Message` pydantic model with a clean `model_dump`);
   both providers' `__dict__` fallback now per-field-filters via
   `json.dumps` so non-serialisable fields drop without poisoning
   the whole event.

### Smoke scaffolding bugs caught alongside

Four `tests/smoke/` scaffolding bugs that combined into a silent-
pass failure mode (every target ran in <1s and asserted against
empty event lists). Fixed via shared `make_sensor_session` helper
in `conftest.py`:

* `init(SensorConfig(...))` was the wrong signature — public
  `init` takes kwargs, never a config object.
* No `flightdeck_sensor.patch()` call, so raw `Anthropic` /
  `OpenAI` constructors returned unwrapped clients.
* `fetch_events_for_session` omitted the required `from` query
  param; the API 400'd and the helper swallowed it as "no events".
* `init()` is no-op on second call; subsequent tests in a module
  reused the first test's session_id, polluting assertions.

Helper now `teardown()`s before each `init()`, sets `AGENT_FLAVOR`,
calls `patch()`, and the events fetch poll-waits for the specific
event types each test asserts on (`expect_event_types`).

---

## V6 S-UI rich rendering (Phase 4 polish, post-merge addition)

The contract-level dashboard rendering shipped in PR #28's initial
push: `EventType` union extended with `embeddings` + `llm_error`,
badge config + `--event-embeddings` / `--event-error` theme tokens
landed, structured `LLMErrorPayload` + `StreamingMetrics` interfaces
defined. The V-pass scoped V6 S-UI surfaces (rich drawer rendering,
streaming indicators, ERROR TYPE facet) out of the initial ship to
keep the contract-level PR reviewable; this section covers their
post-merge addition.

### S-UI-1 — Embeddings drawer row

* Timeline circle: cyan `--event-embeddings` colour + lucide
  `Database` glyph (distinct from `post_call`'s lightning).
* Drawer event row: typed `embeddings-event-row-<id>` testid,
  EMBED badge, detail string `<model> · <N> tok in · <Mms>` (no
  completion-token segment — embeddings have no generation step).
* Drawer expanded grid: Model + Tokens input + Latency rows only
  (no Tokens output / Total tokens — those would mislead).

### S-UI-2 — Streaming indicators on `post_call`

* Detail string: `TTFT <n>ms` segment inserted ahead of tokens +
  total latency when `payload.streaming` is present. Non-streaming
  post_calls keep the original three-part shape.
* `<StreamingPill/>`: inline pill alongside the detail text.
  `STREAM` (muted lavender) on `final_outcome="completed"`,
  `ABORTED` (red) on `final_outcome="aborted"`. Native `title`
  attribute carries `chunks=N · p50=Xms · p95=Yms · max_gap=Zms`,
  plus `abort_reason=<...>` on the aborted variant.
* Expanded grid grows TTFT, Chunks, Inter-chunk, and Stream
  outcome rows when streaming is present.

### S-UI-3 part 1 — `llm_error` event rendering

* Timeline circle: red `--event-error` colour + lucide
  `CircleAlert` glyph (distinct from `policy_block`'s `XCircle`).
* Drawer event row: typed `error-event-row-<id>` testid, detail
  string `<error_type> · <provider_error_code|provider>`.
* Drawer expanded grid: Model + Error type + Provider + HTTP
  status + Provider code + Message rows (HTTP status omitted on
  client-side timeouts where it's null).
* New `<ErrorEventDetails/>` accordion (separate file, owns its
  own expand/collapse state): request_id, retry_after as `<n>s`,
  is_retryable as a `Retryable` / `Not retryable` pill, plus
  abort_reason + partial_chunks/tokens on stream-error variants.
  Per-field testids `error-event-detail-<field>-<id>` for granular
  E2E targeting.

### S-UI-3 part 2 — Investigate ERROR TYPE facet + session-row dot

* Backend extension: `SessionListItem` carries `error_types: []string`
  aggregated server-side via correlated subquery
  (`SELECT DISTINCT payload->'error'->>'error_type' FROM events
  WHERE event_type='llm_error' AND session_id=s.session_id`).
  Mirrors the `frameworks[]` JSONB-array surfacing shape.
  Always-present (empty array when no errors) so the dashboard
  treats it as non-nullable.
* URL state: `?error_type=` (repeatable) round-trips via
  `parseUrlState` / `buildUrlParams`; `CLEAR_ALL_FILTERS_PATCH`
  zeroes it; `buildActiveFilters` emits `error_type:<value>` chips
  with onRemove. Aux fetch in `doFetch` strips the filter so the
  facet stays sticky when an error_type is active.
* Sidebar: ERROR TYPE facet rendered last (after the existing
  state/agent/flavor/agent-type/model/framework/scalar-context
  groups), hidden when no visible session has any llm_error
  events. Per-pill testid `investigate-error-type-pill-<value>`.
* Session table: red 7px dot inline-left of the StateBadge in the
  STATE column when `error_types.length > 0`. Tooltip lists the
  distinct values. Test id
  `session-row-error-indicator-<session_id>`.

## E2E methodology fix (Phase 3 P1/P2 violation, now corrected)

T01 / T05 / T06 / T09 — four specs shipped in Phase 3 — failed
locally against any non-sterile dev DB. Root cause: each assumed
the canonical `e2e-test-*` fixtures would render at the top of the
Fleet swimlane on initial paint. Under realistic data volume (the
dev DB accumulates hundreds of agents from prior test runs and
integration suites) the swimlane's IntersectionObserver-backed
virtualizer keeps off-screen rows as placeholders without their
`data-testid`, and the alphabetical IDLE ordering buries the
canonical fixtures behind random-suffix `e2e-XXXX` agents. The
specs were only green on a freshly-reset DB.

This violated Phase 3 resilience patterns:

* **P1 (find-my-fixture, not assume-first-row).** T01/T05/T06
  used `findSwimlaneRow(name)` and asserted visibility without a
  scroll-into-view step.
* **P2 (paginate / scroll until found).** T09 counted
  `[data-testid^="swimlane-agent-row-${E2E_PREFIX}"]` against the
  virtualizer's currently-mounted-rows window — counts were a
  fraction of the actual fixture count.

Fix shipped on this branch:

* New `bringSwimlaneRowIntoView(page, agentName)` helper in
  `dashboard/tests/e2e/_fixtures.ts`. Walks the swimlane's
  closest scroll-overflow ancestor in chunked `stepPx` increments
  (default 600 px), polls the DOM after each step, returns the
  row's locator the moment it mounts.
* Companion `bringTableRowIntoView` walks `next-page` clicks in
  the agent table view (capped at 10 pages = 500 rows of
  headroom).
* `waitForFleetReady` no longer asserts on a *specific* fixture
  — it waits for any swimlane or table row to mount, then leaves
  fixture-by-fixture lookup to the bring-into-view helpers.
* T01 / T05 / T06 / T09 refactored to use the helpers. T05 also
  bumps its expected expanded-body session count from 4 to 5 to
  match the Phase 4 polish addition of the `error-active` role on
  the coding agent.

Verification: 48/48 E2E pass under both neon-dark and clean-light,
twice in a row, against the existing polluted dev DB (no
dev-reset). Real fleet topology test for the first time — the
previous specs were sterile-environment-only.

This is a Phase 3 methodology miss we're correcting now. Lesson:
under virtualization, "find by testid" is not the same as "find by
testid that's currently in the DOM". Future phases adding new
E2E specs against virtualized lists must either use a
bring-into-view helper from the start or assert against a
deterministically-sized API filter that bounds the result set
before the test interacts with the rendering.

## Per-framework embeddings content capture (Phase 4 polish, S-EMBED-1..8)

Phase 4 polish closes the embedding-modality content capture gap that
shipped without coverage in the initial Phase 4 contract. Pre-fix the
sensor emitted ``event_type=embeddings`` with metadata only -- the
request's ``input`` parameter (a string or list of strings, the
content the embedding model actually saw) was never captured even
with ``capture_prompts=True``. Chat completions captured the
equivalent content; embeddings did not. Communication-modality parity
gap caught during Chrome walkthrough.

### Coverage matrix

| Framework | Native embeddings | Capture path | Smoke status |
|---|---|---|---|
| Anthropic SDK | ❌ N/A | Anthropic has no native embeddings API; users route via litellm → Voyage | N/A — no smoke scenario |
| OpenAI SDK | ✅ supported | Direct patch in ``interceptor/openai.py``; provider's ``extract_content`` branches on ``event_type=EMBEDDINGS`` to capture ``request_kwargs["input"]`` | smoke-openai +2 (single-string + list-of-strings) ✅ |
| litellm | ✅ supported | Module-level patch on ``litellm.embedding`` / ``litellm.aembedding``; same content shape as OpenAI | smoke-litellm +1 (routes to OpenAI) ✅ |
| Claude Code plugin | ❌ N/A | Observational; plugin doesn't see embeddings even if the user's agent performs them | N/A — no smoke scenario |
| LangChain | ✅ supported via OpenAI transitively; ⚠️ partial via Voyage direct | ``OpenAIEmbeddings.embed_*`` rides through the OpenAI patch (no dedicated LangChain interceptor needed); ``VoyageAIEmbeddings`` direct path remains uncovered per Phase 4 V-pass Q-VOYAGE | smoke-langchain +1 (transitive via OpenAI) ✅; Voyage-direct: ⚠️ deferred |

Wire shape: ``PromptContent.input: str \| list[str] \| None`` lands
in the existing ``payload.content`` blob and survives ingestion →
worker → Postgres ``event_content.input`` JSONB column → ``GET
/v1/events/:id/content`` → dashboard's ``EmbeddingsContentViewer``.
Three render branches (single-string, list, no-content) covered by
vitest, T14 E2E, and per-framework smoke.

### Communication modality content capture parity (methodology
principle, locked here for future phases)

> Every modality that has a request/response payload should support
> content capture gated by the ``capture_prompts`` flag (or
> modality-specific variants where genuinely needed). Modalities
> that ship without content capture ship a documented gap that
> must be called out in the coverage matrix and fixed before
> launch.
>
> Phase 4 applied this retroactively to embeddings across all 5
> supported frameworks when the gap surfaced in Chrome walkthrough.
> Future phases adding new modalities must include content capture
> in the initial V-pass spec across ALL supported frameworks, not
> as a retrofit or narrowed to a subset.

## Framework attribution Phase 1 oversight (parallel finding, fixed)

Pre-fix ``Session.record_framework`` had zero callers across the
sensor codebase, so every event emitted by the live sensor flow
carried ``framework=null``. Confirmed against the smoke-langchain
run on the dev stack: chat AND embeddings AND session_start all
read ``framework=null``. The dashboard's FRAMEWORK facet, the
analytics ``group_by=framework``, and the ``/v1/sessions
?framework=`` filter were all silently misbehaving. A Phase 1
oversight surfaced when the embeddings work made framework
attribution parity load-bearing.

Fix shipped on this branch:

1. **Sensor init wires record_framework.** In
   ``flightdeck_sensor.__init__.init`` after ``_collect_context()``
   populates ``frameworks[]``, take the first detected entry,
   strip the ``/<version>`` suffix, and call
   ``Session.record_framework`` with the bare name. Versioned form
   stays in ``context.frameworks[]`` for diagnostic detail; the
   per-event field uses the bare analytics dimension.
2. **LangChain classifier extended.** ``BaseClassifier.module``
   accepts a tuple of aliases; ``LangChainClassifier`` now lists
   ``("langchain", "langchain_core")`` so modern split-package
   installs (``langchain_openai``, ``langchain_anthropic``) that
   don't import the umbrella ``langchain`` module are still
   detected via the always-present core package. Pre-fix the
   classifier silently missed every modern LangChain install.
3. **/v1/sessions?framework= OR-combines lookups.** The legacy SQL
   only consulted ``context.frameworks[]`` (versioned strings);
   the new bare-name path needs ``s.framework = ANY($1::text[])``
   too. Fix OR-combines both so callers can filter on either bare
   names (``langchain``) or versioned strings
   (``langchain/0.3.27``) without behavioural surprise.

### Locked design principle

> When a higher-level framework is detected (LangChain, LangGraph,
> CrewAI, etc.) it wins over the SDK transport that handled the
> call. A LangChain pipeline routing through litellm routing
> through OpenAI reports ``framework="langchain"`` because that's
> the user's mental model. Phase 5 (MCP) and beyond inherit this
> rule: MCP calls routed through any framework attribute to the
> framework, not ``"mcp"`` as a framework itself.

### Verification

* Sensor unit suite 233/233 (5 new framework-attribution tests + 7
  new embeddings-capture tests).
* Integration suite 7/7 (1 new content-roundtrip test + 1 new
  framework-filter test, plus the existing 5 Phase 4 tests).
* Vitest 509/509 (6 new EmbeddingsContentViewer tests).
* E2E 48/48 across both themes twice in a row (T14 extended to
  cover the three EmbeddingsContentViewer branches).
* All 5 smoke targets green: anthropic 4/4, openai 7/7, litellm
  5/5, langchain 4/4, claude-code 1/1.
* FRAMEWORK facet behaviour Chrome-verified: existing context-
  array sourcing now populated for langchain sessions (positive
  surprise per supervisor's risk check), no double-counting.

## Out of scope (deferred, with rationale)

- **Image generation events** — out-of-band surface, separate phase.
- **Audio events** — same.
- **Moderation endpoints** — same; covered by content_filter error class
  when triggered during a chat completion.
- **Batch / fine-tuning jobs** — lifecycle is async-days, not session-scoped;
  separate phase.
- **Vector DB query events** — not a provider-native LLM surface.
- **Raw HTTP traffic capture** — proxy / gateway territory; out of scope for v1
  per "What Is Out of Scope" list in CLAUDE.md.
- **Filesystem observation** — out of scope.
- **Dedicated Voyage SDK interceptor** — Q-VOYAGE decision; Voyage-via-litellm
  is the supported capture path.
- **litellm streaming** (KI26) — Q-LITELLM-STREAM decision; non-streaming
  remains the only litellm path this phase closes.
- **bifrost dedicated interceptor** — Q-FW decision; indirect via OpenAI
  patch.
- **Async streaming for litellm** — follows KI26.
- **Direct LangChain Voyage embeddings** — follows Q-VOYAGE.

---

## Docs Updated (PR #28 docs commits)

Six commits, ~665 lines net additive across the docs surface. The
delta is recorded here so the audit closes with a single docs map
that future phases can audit against.

| Doc | Change |
|---|---|
| ``ARCHITECTURE.md`` | Restructured by system topic (per Supervisor methodology correction) — phase-tag-removal pass + structural reorg from "Phase 1-5 deliverables" framing to "what the system IS" topical sections (Identity model, Sensor, Event types, Ingestion, Worker, Database, API, Dashboard, Communication modality content capture, Deployment & ops, Testing). Phase ancestry, war stories, "pre-fix did X", forward-looking Phase 5 Helm section all removed. D-numbers preserved as durable references to DECISIONS.md. |
| ``README.md`` | 5-framework × 4-modality coverage matrix (Anthropic / OpenAI / litellm × chat / embeddings / streaming / errors). LangChain / LangGraph / LlamaIndex / CrewAI / Claude Code plugin / bifrost transitive coverage table. Per-event ``framework`` field explanation. New "What Flightdeck is NOT" section with seven explicit non-goals. KI21 closed inline; KI26 (litellm streaming) reframed as roadmap. Roadmap rewritten as Phase 5-9 sequencing (MCP first-class → sub-agents → landing/agent-detail → framework verification matrix → launch polish). |
| ``CHANGELOG.md`` | New v0.5.0 entry ("Agent communication coverage hardening") covering everything since v0.4.0 Phase 1 — Phase 2 agents API, Phase 3 E2E foundation, admin reconciler, Phase 4 + Phase 4 polish. Keep-a-Changelog structure with component-prefixed bullets (Sensor / Ingestion / Worker / API / Dashboard / Tests / CI). |
| ``CLAUDE.md`` | Rule 41 strengthened with explicit "ARCHITECTURE describes what the system IS, not how it got there" + "phase references go in CHANGELOG or audit docs, never ARCHITECTURE" + DECISIONS.md role. Rule 40e added (pre-push lint hard rule, sibling to 40a-40d). Rule 51 added (no-defer discipline) per Supervisor's verbatim spec — codifies the principle applied ad-hoc through PR #28. Rule 50 (API documentation) keeps its slot. |
| ``FOLLOWUPS.md`` | Boundary clarification at the top — three valid categories, not a "things I noticed" bucket. Phase 4 polish dashboard rendering + embedding modality parity + framework attribution null + V-DRAWER dead-end struck through (closed by PR #28). New entry: orphan-agent reconciler (post-launch follow-up to the V-DRAWER companion fix). |
| ``audit-phase-4.md`` | This Docs Updated section + Methodology lessons section below. |

---

## Methodology lessons (Phase 1-3 drift, dead-end UX class, modality parity retroactive fix, V-pass finding pre-existing bugs)

Four lessons surfaced during PR #28's audit pass that weren't in the
original Phase 4 V-pass spec. Recording them here so future phases
inherit the corrections rather than rediscovering them.

### Lesson 1 — Phase 1-3 docs drift accumulated because no phase explicitly updated docs

ARCHITECTURE.md grew 4074 lines as the project moved through Phases
1-4 + 4.5. Each phase added "Phase N Additions" sections describing
what was new instead of integrating the new behaviour into the
topical sections that already described related topics. The result:
``Phase 4.5 Additions`` (lines 1839-2348) and ``Phase 4.5 -- Subsequent
Additions`` (2349-2782) accumulated ~944 lines of present-tense
system descriptions misframed as historical change-log entries. A
new contributor reading top-to-bottom encountered a mix of "what is"
and "what changed" without a way to tell them apart.

The fix: ARCHITECTURE describes what the system IS, not how it got
there. Phase references move to CHANGELOG / audit-phase-N.md /
DECISIONS.md. Rule 41 strengthened with this explicit principle so
future phases inherit the discipline.

The deeper lesson: phase-gate methodology (Rule 41/42) made each
phase responsible for "update docs before merging code" but didn't
specify *which* docs in *what shape*. Phase 4 polish surfaced
that the docs the rule pointed at had drifted into change-log
shape, which violated the rule's own intent. Future phases need a
docs audit step in V-pass that reads ARCHITECTURE end-to-end and
flags any temporal qualifiers ("was added in", "previously",
"pre-fix", "in Phase X") that crept in.

### Lesson 2 — Dead-end UX is a recurring regression class (KI20, KI22, V-DRAWER)

PR #28's V-DRAWER fix is the third instance of the same UX bug
class:

- **KI20** (closed pre-v0.4.0): phantom rows in the swimlane that
  rendered an empty event row when no events fell inside the visible
  window. Dead-end: "this row is here but there's nothing to see".
- **KI22** (closed pre-v0.4.0): font-mono global override broke the
  light theme on a specific drawer subtree. Dead-end: "the drawer
  rendered but the content was invisible against background".
- **V-DRAWER** (closed in PR #28): expanded swimlane drawer read
  "No sessions to display for this agent" when the agent's only
  sessions were older than the API's default 7-day window. Dead-end:
  "the agent is in the fleet but the drawer says it has no sessions".

The shared shape: a unit/component test passed because the component
rendered correctly given its inputs. The user-facing failure was
that the *inputs* were wrong (windowed to 7 days, missing context
field, computed under wrong CSS scope). Mock-only unit tests can't
catch this class because the test author already knows the input
shape.

The fix: any user-facing surface that renders "empty" / "no data"
copy must have a regression guard E2E test that exercises the
specific shape — agent with no sessions, agent with sessions outside
the default window, session with no events in the visible time
range. T5b is the regression guard for V-DRAWER's specific shape;
T01-T16 cover the broader fleet/investigate journey but pre-T5b
none of them asserted on the "drawer must not show dead-end copy"
negative.

The deeper lesson: regression guards are negative assertions. A test
that says "expect non-empty list" is not the same as "expect to NOT
see the dead-end copy". The latter is what fails when the empty-state
copy is the bug. Future UI phases adding empty-state copy must add
a corresponding negative assertion E2E test as part of the V-pass.

### Lesson 3 — Modality parity is a load-bearing principle, not a polish item

Phase 4's initial V-pass shipped ``embeddings`` as a new event type
with metadata only. ``capture_prompts=True`` captured chat
completions but not embedding inputs. The gap surfaced during a
Chrome walkthrough — the operator looked for "what did the embedding
model see?" and the EmbeddingsContentViewer showed nothing because
the sensor never captured the request's ``input`` field.

The fix shipped retroactively in S-EMBED-1..8 across all 5 supported
frameworks. ``PromptContent.input`` round-trips through
``payload.content.input`` → ``event_content.input`` JSONB →
``GET /v1/events/:id/content`` → ``<EmbeddingsContentViewer>``. New
column (migration 000016), new dataclass field, new content-viewer
component, per-framework smoke coverage, T14 E2E coverage.

The locked principle (now in ARCHITECTURE under Communication
modality content capture):

> Every modality that has a request/response payload supports
> content capture gated by the ``capture_prompts`` flag (or
> modality-specific variants where genuinely needed). Modalities
> that ship without content capture ship a documented gap that
> must be called out in the coverage matrix and fixed before
> launch.

The deeper lesson: "we observe what we claim to observe" needs to
be true at the modality × framework matrix level, not the
modality level. Phase 5 (MCP) and beyond inherit this rule —
when MCP lands, ``capture_prompts=True`` MUST capture MCP request
payloads across every framework that emits MCP calls, not as a
follow-up.

### Lesson 4 — V-pass findings include pre-existing bugs the phase didn't introduce

Three of PR #28's surfaced bugs predate Phase 4 entirely:

- ``Session.record_framework`` had zero callers. Every event since
  the framework attribution feature shipped (Phase 1, ~6 months
  ago) carried ``framework=null``. Surfaced during embeddings
  smoke verification when the operator looked for
  ``framework=langchain`` in the event payload and saw ``null``.
- ``T01 / T05 / T06 / T09`` E2E specs (shipped in Phase 3)
  failed locally against any non-sterile dev DB. Each assumed
  canonical fixtures would render at the top of the Fleet
  swimlane on initial paint; under realistic data volume the
  virtualizer kept off-screen rows as placeholders without their
  ``data-testid`` and the alphabetical ordering buried the
  fixtures. The specs were green only on a freshly-reset DB.
- ``LangChainClassifier.module = "langchain"`` missed every modern
  split-package install (``langchain_openai`` / ``langchain_anthropic``
  that don't import the umbrella ``langchain`` module). Pre-fix
  no LangChain user got correct framework attribution.

The original Phase 4 V-pass scope was "agent communication coverage
hardening — embeddings, streaming, errors, lifecycle". A strict
reading would have deferred the framework attribution null bug
("not in scope, file as KI") and the T01/T05/T06/T09 P1/P2
violations ("Phase 3 issue, file as follow-up"). Per Rule 51 (added
in this PR), the default answer for findings that fit the phase's
intent is "address now". Framework attribution parity was load-bearing
for the embeddings work (the EmbeddingsContentViewer needed correct
``framework=`` filtering on the Investigate page); the E2E P1/P2
fix was a hard prerequisite for the new T14/T15/T16/T5b specs to
run reliably. Both fit the phase's intent and landed in PR #28.

The deeper lesson: V-pass scoping isn't a contract that limits what
the phase can fix. It's a starting point. Findings that fit the
phase's intent — even if they're pre-existing bugs the phase didn't
introduce — land in the phase's PR. Findings that don't fit go to
FOLLOWUPS.md or get declined explicitly. "Defer with no owner" is
not a third option. Rule 51 codifies this so future phases inherit
the discipline by default.

### Lesson 5 — Content-fidelity vs product-fidelity verification

PR #28's V-pass started as a content-fidelity audit (do enum values
match between docs and code? do declared event types appear in the
sensor / API / dashboard?). That class of audit catches typo-class
drift — the right things named the right way. It does NOT catch
features that are *named correctly everywhere* but never actually
fire end-to-end.

PR #28 surfaced THREE such product-fidelity gaps:

1. **Embeddings content capture.** Sensor declared the event type
   and the dashboard rendered it; the request's ``input`` parameter
   (the content the embedding model actually saw) was never captured
   even with ``capture_prompts=True``. Closed by S-EMBED-1..8.
2. **Framework attribution.** ``Session.record_framework`` had zero
   callers across the sensor codebase; every event silently emitted
   ``framework=null``. The dashboard FRAMEWORK facet, analytics
   ``group_by=framework``, and ``/v1/sessions?framework=`` filter
   were all silently lying about session attribution. Closed by
   wiring at ``init()`` from ``FrameworkCollector``.
3. **Policy enforcement events.** ``EventType.POLICY_WARN`` was in
   the sensor enum and the dashboard had full event rendering wired
   for ``policy_warn`` / ``policy_block`` / ``policy_degrade``. The
   sensor's ``_pre_call`` emitted ZERO policy events on any decision
   (BLOCK raised, DEGRADE swapped silently, WARN log-only); the
   ``_apply_directive(DEGRADE)`` path emitted only ``DIRECTIVE_RESULT``
   not ``POLICY_DEGRADE``; ``POLICY_BLOCK`` and ``POLICY_DEGRADE``
   were missing from the enum entirely. Closed by S-POLICY-EV-1..7.

The locked methodology principle (now in CLAUDE.md Rule 51 + this
audit doc):

> Content-fidelity verification (do enum values match between doc
> and code?) catches typo-class drift. Product-fidelity verification
> (does the documented behavior actually happen end-to-end?)
> catches deeper gaps.
>
> V-pass MUST include end-to-end behavior verification for any
> documented feature, not just "the code references exist."
> Specifically: for any event type the doc claims exists, trace the
> emission path from sensor condition → event queue → NATS →
> worker → events table → ``GET /v1/events``. If any hop is
> missing, that's a product gap to fix in the phase that surfaces
> it.

The deeper observation: every product-fidelity gap closed in PR #28
was an instance of "wired everywhere except where the sensor
actually decides to emit." The sensor is the ONLY place where a
declared event becomes a live event. Future audits that focus
exclusively on the API + dashboard surfaces will keep missing
this class of bug. The first stop on the trace must be the
sensor's emit site — if it's not enqueueing the event, the rest
of the pipeline is theatre.
