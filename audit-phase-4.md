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
| Q-CLOCK-SKEW | timestamp bounds at ingestion | **Enforced.** Reject `occurred_at < NOW() - 24h` or `occurred_at > NOW() + 5m` with 400. Bounds are constants; can become env vars in a later phase. |
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
| D7 | Past timestamp (> 24h ago) | Accepted verbatim | Ingestion rejects with 400 "timestamp too old" |
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

_(Populated by the "Pre-push verification" task in this phase before PR merge.
Tests not run yet — all API keys required are not loaded in the local
environment as of plan-of-record.)_

| Framework | Run date | Events observed | Anomalies |
|---|---|---|---|
| Anthropic SDK | — | — | — |
| OpenAI SDK | — | — | — |
| litellm | — | — | — |
| LangChain | — | — | — |
| Claude Code plugin | — | — | — |
| bifrost | — | — | — (optional run) |

---

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
