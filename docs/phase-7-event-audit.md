# Phase 7 — Operator-Actionable Events: Audit

**Status.** Step 1 of N. Audit-only design doc. No code changes in
this commit; subsequent enrichment commits land against the
findings here.

**Step 2 (Phase 7) shipped 2026-05-08:** Five policy event types
(`policy_warn`, `policy_degrade`, `policy_block`, `policy_mcp_warn`,
`policy_mcp_block`) gained the shared `policy_decision` payload
block (D148) + `originating_event_id` chain (D149). Sensor-side
event-UUID minting + idempotent worker INSERT per D149.
Dashboard rendering of the new fields is deferred to Step 6 per
the locked batch plan; Step 2 ships schema acceptance only.

**Step 3 (Phase 7) shipped 2026-05-08:** MCP Protection Policy
enforcement extends from `call_tool` to all six server-access
paths (D151) — `list_tools` / `read_resource` / `get_prompt` /
`list_resources` / `list_prompts` now raise `MCPPolicyBlocked`
when the policy resolves to block. Discovery family
(`mcp_tool_list` / `mcp_resource_list` / `mcp_prompt_list`)
gains `item_names` (string[], capped at 100 with
`truncated:true` overflow flag). Dashboard rendering deferred
to Step 6.

**Step 3.b (Phase 7) shipped 2026-05-09:** D150 closes the
deferred capture-storage parity loop. `event_content` gains
dedicated `tool_input` + `tool_output` jsonb columns
(migration 000021). MCP tool capture (`mcp_tool_call`
arguments + result; `mcp_prompt_get` arguments + rendered
messages) and LLM-side `tool_call` migrate from inline
`events.payload` to the dedicated `event_content` columns.
The pre-D150 inline-vs-overflow split is removed for these
event types — capture always lives in `event_content`,
fetched on demand via `GET /v1/events/:id/content`. The
column-name semantics gymnastics (`input` overloaded across
embeddings + tool args) is gone. `mcp_resource_read` body
capture stays on the legacy `_build_overflow_event_content`
path (Q1 lock — resource bodies are blobs, not
request/response shapes). Dashboard rendering deferred to
Step 6.

**Step 4 (Phase 7) shipped 2026-05-09:** D152 lands session
lifecycle + MCP server attach/name-change enrichment.
`session_start` carries `sensor_version` (required) +
`interceptor_versions` + `policy_snapshot` for triage. The
operator's "did this run under the buggy build" question is
answerable from a single payload field. `session_end` carries
`close_reason` enum (sensor populates `normal_exit` /
`directive_shutdown` / `policy_block`; worker fills
`orphan_timeout` / `sigkill_detected` on the post-mortem
path), `policy_actions_summary` (worker-computed via events
table GROUP BY), and `last_event_id` (worker-computed for
the time-skip affordance). `mcp_server_attached` carries
`policy_decision_at_attach` — the shared D148
`policy_decision` block evaluated at attach time so operators
see what the policy says about the attached server without
joining time-windowed policy state. `mcp_server_name_changed`
carries `policy_entries_orphaned` (worker-computed via
`mcp_policy_entries` query) AND gains a dedicated
`events.ts` renderer (the pre-Step-4 missing case — rows used
to render as untyped fallback). Dashboard rendering otherwise
deferred to Step 6.

**Scope locks (from scope-out turn).** Q1 every event type covered
including "audit complete, no enrichment needed". Q2 policy/state
metadata always included regardless of `capture_prompts`; flag
gates only content. Q3 `event_content` extends to MCP tool args /
results when capture is on. Q4 inline summary + detail drawer.
Q5 facets for low-cardinality enrichments; free-text content
search out of scope. Q6 audit-first.

**Doc location.** `docs/phase-7-event-audit.md` — sibling of the
existing `docs/reconcile-agents-endpoint.md`. METHODOLOGY allows the
"workspace folder where the design doc lives" but no Phase 7
folder exists yet, and `docs/` is the established convention for
non-component-scoped design docs.

**Audit method.** Inventory derived from
`sensor/flightdeck_sensor/core/types.py::EventType` enum + grep
of every `_emit*` site + `plugin/hooks/scripts/*.mjs` event-type
strings + cross-reference against `events.event_type` distinct
values in dev DB (May 8 2026 snapshot) + ARCHITECTURE.md
§ "Event Types" (lines 2333-2589). Real-payload samples from
`SELECT jsonb_pretty(payload) FROM events WHERE event_type=$1
ORDER BY occurred_at DESC LIMIT 1` against dev stack at
HEAD `10278252`.

---

## Inventory verification

### Cross-reference of supervisor's prompt list vs. what's actually emitted

| Supervisor's name | Actual `EventType` value | Status |
|---|---|---|
| `session_start` | `session_start` | ✅ |
| `session_end` | `session_end` | ✅ |
| `llm_call (pre + post)` | `pre_call` + `post_call` | ✅ (separate types) |
| `llm_error` | `llm_error` | ✅ |
| `llm_streaming` (Phase 4) | — | **Not an event type.** Sub-payload of `post_call` when `streaming=true` ("streaming" extras object: `ttft_ms`, `chunk_count`, `inter_chunk_ms`, `final_outcome`, `abort_reason`). Mid-stream errors emit `llm_error` with `error_type=stream_error`. |
| `embedding_call` (Phase 4) | `embeddings` | ✅ (singular) |
| `mcp_tool_call` | `mcp_tool_call` | ✅ |
| `mcp_tool_list` | `mcp_tool_list` | ✅ |
| `mcp_resource_list` | `mcp_resource_list` | ✅ |
| `mcp_resource_read` | `mcp_resource_read` | ✅ |
| `mcp_prompt_list` | `mcp_prompt_list` | ✅ |
| `mcp_prompt_get` | `mcp_prompt_get` | ✅ |
| `mcp_server_attached` | `mcp_server_attached` | ✅ |
| `mcp_server_name_changed` | `mcp_server_name_changed` | ✅ |
| `policy_warn` | `policy_warn` | ✅ |
| `policy_block` | `policy_block` | ✅ |
| `policy_degrade` | `policy_degrade` | ✅ |
| `policy_mcp_warn` | `policy_mcp_warn` | ✅ |
| `policy_mcp_block` | `policy_mcp_block` | ✅ |
| `directive_received / directive_applied` | `directive_result` | **One type, two states.** No separate "received" event; `directive_result.directive_status` encodes `acknowledged` / `success` / `error` / `timeout`. Recommend the audit treats this as a single section. |
| `context_switch` | — | **Dropped from inventory** (supervisor lock 2026-05-08). Speculative entry from the original scope-out; doesn't exist in code. Design-from-scratch is not in v0.6 scope. |
| Plugin: `mcp_policy_user_remembered` | `mcp_policy_user_remembered` | ✅ (plugin-only) |
| Plugin: `subagent_start / subagent_end` | — | **Not separate types.** D126 uses `session_start` + `session_end` with `parent_session_id` + `agent_role` extras for the child sub-agent; root and sub use the same event-type schema. |

### Types in code but missing from supervisor's list

| Type | Source | Audit needed? |
|---|---|---|
| `tool_call` (LLM-side) | `interceptor/base.py:870` (Anthropic + OpenAI tool-use messages) | **Yes** — distinct from `mcp_tool_call` (D116); covers framework function-calling. 355 rows in dev DB (the most-emitted type after `post_call`). |

### Doc-drift findings (surfaced in this audit; defer fix to enrichment commits)

| Finding | Evidence |
|---|---|
| ARCHITECTURE.md § "Event Types" line 2341 says **"17 emitted event types"** and lists them — explicitly omits `POLICY_MCP_WARN`, `POLICY_MCP_BLOCK`, `MCP_SERVER_NAME_CHANGED`, `MCP_SERVER_ATTACHED` (4 newer additions). Actual count is **21 sensor types + 1 plugin-only type** = 22. | `ARCHITECTURE.md:2341-2347` vs. `sensor/flightdeck_sensor/core/types.py:21-61` |
| `embeddings` payload sampled empty in dev DB. Likely the in-tree fixtures don't exercise `OpenAIEmbeddings.embed_*` end-to-end with non-empty payload extras. | `SELECT payload FROM events WHERE event_type='embeddings'` returned NULL on the latest row. Sensor code at `interceptor/openai.py:347-362` does emit; needs a fresh playground run with real embeddings + capture to verify the wire shape. |
| `policy_mcp_warn`, `mcp_server_name_changed`, `directive_result`, `mcp_policy_user_remembered` all have **0 rows** in dev DB. Code paths exist; they just haven't fired in the current dataset. | `event_type` histogram from dev Postgres. |

---

## Audit table — per-event-type sections

Each section follows the supervisor's 9-point template. Where two
events share enrichment shape (the 5 token-budget / MCP-policy
events), the table uses the same enrichment axes; per-section
"Recommended enrichment" calls out the deltas.

---

### `session_start`

**1. Emission site.** `sensor/flightdeck_sensor/core/session.py:179` (root agent boot via `_post_event`). Sub-agent variant at `core/session.py:424:emit_subagent_session_start` (D126). Plugin emits via `plugin/hooks/scripts/agent_id.mjs` on `SessionStart` hook.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `incoming_message.body` | string | yes | sensor session ctor; D126 |
| `incoming_message.captured_at` | ISO 8601 | yes | sensor |
| `parent_session_id` | UUID | yes (root has none) | sensor / plugin |
| `agent_role` | string | yes (root has none) | sensor / plugin |
| (top-level event columns) | — | — | flavor, agent_type, model, framework, host populated by sensor envelope |
| `context` (sessions table) | jsonb | yes | sensor — orchestration, git, frameworks, hostname, OS, Python version, k8s, mcp_servers fingerprint list (D116) |

**3. Sample current payload (sub-agent).**
```json
{
  "agent_role": "Explore",
  "incoming_message": {
    "body": "Investigate the auth module and surface every place that calls AuthMiddleware.",
    "captured_at": "2026-05-07T18:36:55Z"
  },
  "parent_session_id": "8660f293-7039-5cae-9f0a-f4c3428f20d6"
}
```

**4. Operator workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | — |
| Policy/behaviour tuning | ✗ | No "starting policy snapshot" in payload — operator can't tell what budget/MCP rules were in effect at session start without joining time-windowed policy state |
| Incident triage | partial | Has parent_session_id + agent_role but no failure-correlation hint; operator must scan sibling timeline |
| Drift detection | ✗ | No fingerprint of sensor version / framework version / interceptor patch state — "did this session run under the buggy build" is unanswerable from payload |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `sensor_version` (string), `interceptor_versions` (dict per framework), `policy_snapshot` (id + version of resolved token-budget + MCP policies at session-start time, NULL if none).
- **Capture-gated:** `incoming_message.body` is already gated by D126's prompt-capture path; no change needed.

**6. Capture-gated content plan.** No change. Already routed through the existing capture path.

**7. Dashboard rendering gap.**
- Inline today: row badge "SESSION START" + agent_name; nothing from payload.
- Inline post-Q4: parent_session_id chip when sub-agent (already present in some tables); policy_snapshot chip "policy v3" linking to the policy row.
- Detail drawer: full sub-agent ancestry tree, captured incoming_message body, sensor + interceptor version table, policy snapshot detail.

**8. Investigate facet gap.** New facet: `sensor_version` (low-cardinality, valuable for "rule out the buggy build" during incident triage).

**9. Cross-cutting.** No backwards-compat tax (pre-v0.6 schema bumps are free per memory). Sensor + worker + dashboard touched.

---

### `session_end`

**1. Emission site.** `sensor/flightdeck_sensor/core/session.py:204` (root); `core/session.py:468:emit_subagent_session_end` (D126). Plugin via `agent_id.mjs` on `Stop` hook.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `outgoing_message.body` | string | yes | sensor — D126 sub-agent return |
| `outgoing_message.captured_at` | ISO 8601 | yes | sensor |
| `agent_role` | string | yes | sensor |
| (top-level) `tokens_used` (cumulative) | int | yes | sessions table — final tally |

**3. Sample.**
```json
{
  "agent_role": "Explore",
  "outgoing_message": {
    "body": "Found 4 callers in src/api/auth.py; the entry point is server.go:142.",
    "captured_at": "2026-05-07T18:37:25Z"
  }
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | No close-reason taxonomy — can't distinguish clean exit vs. SIGKILL vs. orphan-detection close. Sessions table `state` flips to `closed` for all three. |
| Policy tuning | partial | No policy_actions_summary (count of warns/blocks/degrades fired during session) on payload — operator must run a separate query |
| Incident triage | ✗ | No "last_event_before_close" pointer — operator must time-order events to find the trigger |
| Drift detection | ✗ | — |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `close_reason` (enum: `normal_exit` / `sigkill_detected` / `orphan_timeout` / `directive_shutdown` / `policy_block` / `unknown`), `policy_actions_summary` ({warn: N, block: N, degrade: N, mcp_warn: N, mcp_block: N}), `last_event_id` (UUID of the immediately-prior event for triage time-skip).
- **Capture-gated:** `outgoing_message.body` already gated.

**6. Capture-gated content plan.** No new content to route.

**7. Dashboard rendering gap.** Inline post-Q4: close_reason badge with chroma matching the reason class (red on policy_block / sigkill; muted on normal_exit). Detail drawer: policy_actions_summary chip-grid linking each count to the filtered timeline.

**8. Investigate facet gap.** New facet: `close_reason` — low-cardinality, high-value for "show me everything that died on SIGKILL last week".

**9. Cross-cutting.** Workers compute `close_reason` (the worker has the timeline; sensor doesn't always know — e.g., orphan-timeout is a worker decision). Sensor → ingestion shape adds the new fields; worker projector populates them at session-close-write time.

---

### `pre_call`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:_pre_call` (every framework's pre-call path).

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `agent_role` | string | yes | sensor |
| (top-level) `model`, `tokens_input` (estimate) | text/int | yes | sensor |

**3. Sample.**
```json
{
  "agent_role": "Explore"
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | Estimate is on the row, but no "estimated_via" attribution (tiktoken / heuristic / none) — when the post_call delta is large, operator can't attribute |
| Policy tuning | partial | Pre-call is the budget-decision moment; no `policy_decision_pre` field captures what the local PolicyCache decided (allow / warn / block) |
| Incident triage | ✗ | — |
| Drift detection | ✗ | — |
| Compliance/audit export | partial | Useful for "what did the sensor estimate" but missing the decision moment |

**5. Recommended enrichment.**

- **Always-included:** `policy_decision_pre` (enum: `allow` / `warn` / `degrade` / `block` / `no_policy`), `estimated_via` (enum: `tiktoken` / `heuristic` / `none`).
- **Capture-gated:** `messages` + `system_prompt` already route to `event_content` when capture is on.

**6. Capture-gated content plan.** Already covered by event_content table.

**7. Dashboard rendering gap.** Inline today: "PRE_CALL" badge + model + tokens_input estimate. Post-Q4: estimated_via chip when not tiktoken (so operator notices fallback estimation), policy_decision_pre chip when not `allow`. Detail drawer: estimation breakdown + decision context.

**8. Investigate facet gap.** New facet: `estimated_via` (3 values; operationally interesting for "did the heuristic fallback fire").

**9. Cross-cutting.** Sensor-only enrichment; ingestion + worker + dashboard pass-through.

---

### `post_call`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:_post_call` (every framework). Plugin via Claude-Code response hook.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `streaming.ttft_ms`, `chunk_count`, `inter_chunk_ms.{p50,p95,max}`, `final_outcome`, `abort_reason` | nested | yes (only when stream=true) | sensor |
| (top-level) `model`, `tokens_input/output/total/cache_*`, `latency_ms`, `framework`, `has_content` | various | yes | sensor envelope |
| `event_content` row (when capture on) — `messages`, `tools`, `response`, `system_prompt` | jsonb / text | yes | sensor + worker capture path |

**3. Sample (streaming branch).**
```json
{
  "streaming": {
    "ttft_ms": 320,
    "chunk_count": 42,
    "abort_reason": null,
    "final_outcome": "completed",
    "inter_chunk_ms": {"max": 150, "p50": 25, "p95": 80}
  }
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | strong — token + latency + content via event_content |
| Policy tuning | partial | Doesn't carry `policy_decision_post` (after the call, did the cumulative budget cross any threshold) — operator must reconstruct from sibling policy_warn/degrade/block events |
| Incident triage | ✓ | streaming sub-payload tells the story for stream aborts |
| Drift detection | partial | Per-call latency / TTFT in payload; no provider attribution beyond `provider` (e.g., region, OpenAI's `x-ratelimit-*` headers not captured) |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `policy_decision_post` (enum), `provider_metadata` (dict: rate-limit-remaining, region/datacentre when provider exposes it).
- **Capture-gated:** existing event_content route covers content; no new gated fields.

**6. Capture-gated content plan.** Unchanged. event_content already takes messages + response.

**7. Dashboard rendering gap.** Inline already covers model + tokens. Post-Q4: post-call decision chip when not `allow`, streaming-quality chip (red dot) when `final_outcome=aborted`. Detail drawer: streaming sub-payload as a sparkline (TTFT + chunk timing visualised), provider_metadata as a small key-value grid.

**8. Investigate facet gap.** New facet: `final_outcome` (3 values: completed / aborted / null-when-not-streaming).

**9. Cross-cutting.** Sensor-only fields; provider_metadata extraction is per-provider in `flightdeck_sensor/providers/*.py`. No schema changes (jsonb).

---

### `tool_call` (LLM-side, distinct from `mcp_tool_call`)

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:870` — Anthropic + OpenAI function-calling responses. One emission per tool invocation in the response. Plugin emits via Claude-Code's PostToolUse hook for non-MCP tools.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `agent_role` | string | yes | sensor |
| (top-level) `tool_name`, `tool_input` (capture-gated), `tool_result` (capture-gated, populated in next assistant turn), `latency_ms` | various | yes | sensor |

**3. Sample.**
```json
{
  "agent_role": "Explore"
}
```
(Top-level `tool_name` carries the tool identifier; payload is otherwise minimal.)

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | tool_name + capture-on tool_input/result tells the story; no `tool_caller` (which model + which message turn invoked) |
| Policy tuning | ✗ | No tool-invocation policy hook today (all-or-nothing capture) — operator can't query "show me every shell-exec the agent ran" without grepping content |
| Incident triage | partial | Single tool_call row tells operator what was invoked; doesn't link to the LLM call that originated the invocation |
| Drift detection | ✗ | — |
| Compliance/audit export | partial | Same gap as triage — no causal link to originating LLM call |

**5. Recommended enrichment.**

- **Always-included:** `originating_llm_call_event_id` (UUID — the post_call row whose response carried this tool invocation). High-value for triage; cheap (already tracked in sensor's interceptor state).
- **Capture-gated:** `tool_input` + `tool_result` already gated. Recommend extending event_content to carry these structured (today they sit on the events row; Q3's parity push for MCP tool args/results applies here too).

**6. Capture-gated content plan.** Migrate `tool_input` + `tool_result` from the events row to a new `event_content.tool_input` + `event_content.tool_result` jsonb pair. Same pattern as MCP tool capture (Step 3 in the supervisor's batch list).

**7. Dashboard rendering gap.** Inline today: "TOOL CALL" badge + tool_name. Post-Q4: tool_input preview chip (truncated, hoverable) when capture on; "→ post_call:abc12345" causal chip linking to originator. Detail drawer: full input + result + originating LLM-call jump-to.

**8. Investigate facet gap.** New facet: `tool_name` is already a column on events; surfacing as a top-level facet is in scope (currently it's only a chip on the row).

**9. Cross-cutting.** Sensor — populate `originating_llm_call_event_id` from the tracked-message-turn state. Worker — accept the new field. Dashboard — render the chip + jump.

---

### `embeddings`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/openai.py:358`, `interceptor/litellm.py:181/281`. Anthropic has no native embeddings; routed via litellm → Voyage.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| (top-level) `model`, `tokens_input` (output is always 0), `latency_ms`, `framework` | various | yes | sensor envelope |
| `payload.content.input` (capture-gated) | string \| string[] | yes | sensor — round-trips into `event_content.input` |

**3. Sample.** Dev DB returned NULL for the latest row's payload — see "Doc-drift findings" above. ARCHITECTURE.md § Embeddings (line 2398-2408) is the contract.

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | tokens + model + latency via top-level columns; embed input via event_content — gap: no `output_dimensions` (number of vectors returned), no `provider_response_id` |
| Policy tuning | partial | tokens_input feeds budget policy; same `policy_decision_*` gap as post_call |
| Incident triage | partial | Latency on the row; no error-correlation if the call raised (the `llm_error` event is the failure path) |
| Drift detection | ✗ | No `model_dimensions` + `model_version` to detect provider-side embedding-model rotation |
| Compliance/audit export | partial | input via event_content; output (the actual vectors) not captured |

**5. Recommended enrichment.**

- **Always-included:** `policy_decision_post`, `output_dimensions` (the response's vector count × dimensionality — small, observable).
- **Capture-gated:** `output_vectors` to event_content under capture (high data volume — only enable for explicit ops debugging; recommend a separate flag `capture_embeddings_output` rather than the global `capture_prompts` since output vectors are a different sensitivity class).

**6. Capture-gated content plan.** Add `event_content.embedding_output` jsonb. Gated by new `capture_embeddings_output` (default false) — Q3 parity says capture protects content, but embedding output is high-volume + low-operator-value 99% of the time, so a separate dial is justified.

**7. Dashboard rendering gap.** Inline today: "EMBEDDINGS" badge + model + tokens_total ("X tokens" framing per events.ts). Post-Q4: output_dimensions chip ("1536-d × 12 vectors"). Detail drawer: input preview (capture on), full vector dump option (gated by the new flag).

**8. Investigate facet gap.** Existing `model` facet covers it; no new facet needed.

**9. Cross-cutting.** New optional capture flag → sensor config + ingestion validator + event_content schema. Probably defer to a future commit; flag here as known-gap.

---

### `llm_error`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:926` — every framework's error-handling path catches via the structured 14-error taxonomy.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `error.error_type` | enum (14 values) | no | sensor classifier |
| `error.error_message` | string | yes | provider |
| `error.provider` | string | no | sensor |
| `error.http_status` | int | yes | provider |
| `error.provider_error_code` | string | yes | provider |
| `error.request_id` | string | yes | provider |
| `error.retry_after` | int (seconds) | yes | provider |
| `error.is_retryable` | bool | no | sensor classifier |
| (mid-stream extras) `partial_chunks`, `partial_tokens_*` | int | yes | sensor (only on `error_type=stream_error`) |

**3. Sample.**
```json
{
  "error": {
    "provider": "openai",
    "error_type": "timeout",
    "request_id": "req_e2e_timeout",
    "http_status": null,
    "retry_after": null,
    "is_retryable": true,
    "error_message": "E2E seeded timeout error",
    "provider_error_code": null
  }
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | strong — 14-class taxonomy is operator-actionable |
| Policy tuning | partial | "did the operator's retry policy work" missing — no `retry_attempt` (this is attempt N of M) and no `terminal` flag (was this the last retry that finally raised) |
| Incident triage | partial | No `originating_llm_call_event_id` — operator must time-correlate to find the pre_call this errored against |
| Drift detection | ✓ | error_type taxonomy + provider + http_status are the observable axes |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `originating_llm_call_event_id` (UUID — same shape as recommended for tool_call), `retry_attempt` (int, 1-based), `terminal` (bool — was this the final attempt that raised to caller).
- **Capture-gated:** if the request body was captured, the corresponding event_content row already exists; no new gated fields.

**6. Capture-gated content plan.** No change.

**7. Dashboard rendering gap.** Inline today: "LLM ERROR" badge + error_type + provider. Post-Q4: retry-attempt counter chip when N>1 ("attempt 3/4"); terminal flag adds a red dot. Detail drawer: full error sub-object + originating call jump.

**8. Investigate facet gap.** Existing `error_type` is operationally key; verify it surfaces today as a facet (per memory it does — T16 covers error event rendering + filter). New facet candidate: `is_retryable` (bool, useful for "show me every non-retryable error this week").

**9. Cross-cutting.** Sensor — track retry attempt counter per (provider, request_id). Worker — passthrough.

---

### `policy_warn`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:730` (local) + `core/session.py:1040` (server-arrival via directive). Two sources distinguished by payload `source`.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `source` | enum: `local` / `server` | no | sensor |
| `threshold_pct` | int (1-100) | no | sensor |
| `tokens_used` | int | no | sensor |
| `token_limit` | int | no | sensor |

**3. Sample.**
```json
{
  "source": "server",
  "token_limit": 10000,
  "tokens_used": 8000,
  "threshold_pct": 80
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | "what policy fired" missing — no `policy_id` (token-budget policy UUID), no `matched_policy_scope` (org / flavor / session); operator can't tell which policy row produced this without time-correlating the policies table |
| Policy tuning | ✗ | Cannot answer "this warn fired at 80% — was that the org policy or my flavor override?" |
| Incident triage | partial | Has the threshold but no causal link to the originating pre_call |
| Drift detection | partial | source=local vs server tells the story; no policy_version field |
| Compliance/audit export | partial | Operator needs the policy snapshot at fire time — joining is complex |

**5. Recommended enrichment.**

- **Always-included:** `policy_id` (UUID), `matched_policy_scope` (enum: `org` / `flavor:<name>` / `session:<id>`), `originating_event_id` (the pre_call/post_call that crossed the threshold).
- **Capture-gated:** none — these are state metadata, always include per Q2.

**6. Capture-gated content plan.** No content.

**7. Dashboard rendering gap.** Inline today: "POLICY WARN" badge + threshold + tokens framing. Post-Q4: policy-scope chip with link to the policy row, originating-event chip. Detail drawer: full policy snapshot (limit, warn_at, degrade_at, block_at, degrade_to) at fire time.

**8. Investigate facet gap.** New facets: `policy_id` (UUID, but bounded — tens of policies; valuable), `matched_policy_scope` (low-cardinality, key for tuning workflow).

**9. Cross-cutting.** Same sensor + worker + dashboard touch as session_start. Schema bumps fine pre-v0.6.

---

### `policy_degrade`

**1. Emission site.** `sensor/flightdeck_sensor/core/session.py:1068` — server-only (D035 — local never DEGRADEs).

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `source` | always `"server"` | no | sensor |
| `threshold_pct` | int | no | sensor (= `policy.degrade_at_pct`) |
| `tokens_used`, `token_limit` | int | no | sensor |
| `from_model` | string | no | sensor |
| `to_model` | string | no | directive payload |

**3. Sample.**
```json
{
  "source": "server",
  "to_model": "claude-haiku-4-5",
  "from_model": "claude-sonnet-4-6",
  "token_limit": 10000,
  "tokens_used": 9100,
  "threshold_pct": 90
}
```

**4. Workflows.** Same gaps + same recommendations as `policy_warn`.

**5. Recommended enrichment.**

- **Always-included:** `policy_id`, `matched_policy_scope`, `originating_event_id`, `degrade_directive_id` (UUID of the directive_result that delivered this — closes the loop with the parallel directive plumbing).
- **Capture-gated:** none.

**6. Capture-gated content plan.** No content.

**7. Dashboard rendering gap.** Inline today: "POLICY DEGRADE" badge + from→to. Post-Q4: policy chip + directive-correlation pill. Detail drawer: directive_result jump + policy snapshot.

**8. Investigate facet gap.** Inherits from policy_warn (same facets cover both).

**9. Cross-cutting.** Same as policy_warn.

---

### `policy_block`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/base.py:678` — local PolicyCache decision, sensor flushes synchronously then raises `BudgetExceededError`.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `source` | always `"server"` | no | sensor |
| `threshold_pct`, `tokens_used`, `token_limit` | int | no | sensor |
| `intended_model` | string | no | sensor — the model the blocked call would have used |

**3. Sample.**
```json
{
  "source": "server",
  "token_limit": 10000,
  "tokens_used": 10100,
  "threshold_pct": 100,
  "intended_model": "claude-opus-4-7"
}
```

**4. Workflows.** Same as policy_warn + the `intended_model` field already partially answers "which call hit the limit"; missing the originating event id.

**5. Recommended enrichment.**

- **Always-included:** `policy_id`, `matched_policy_scope`, `originating_event_id` (pre_call), `caller_stack_summary` (single-line summary of the call site that triggered the block — module + function for triage; not a full traceback).
- **Capture-gated:** none.

**6. Capture-gated content plan.** No content. (The blocked call never reached the provider; nothing to capture.)

**7. Dashboard rendering gap.** Inline today: "POLICY BLOCK" badge + intended_model. Post-Q4: policy chip + caller_stack_summary chip. Detail drawer: full block context including the BudgetExceededError stack the sensor raised (capture-gated since stack may carry sensitive arg names).

**8. Investigate facet gap.** Inherits from policy_warn.

**9. Cross-cutting.** Sensor — capture caller_stack_summary at block time (cheap). Worker — accept new field.

---

### `directive_result`

**1. Emission site.** `sensor/flightdeck_sensor/core/session.py:801,1082,1120,1150` — sensor's ack/result for every inbound directive. Single event type; status enum encodes the lifecycle (acknowledged → success/error/timeout).

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `directive_status` | enum: `acknowledged` / `success` / `error` / `timeout` | no | sensor |
| `directive_action` | enum: `shutdown` / `degrade` / `custom` / etc. | no | sensor |
| `result` | dict | yes | handler return / action-specific |
| `error` | string | yes (only when status=error) | sensor |
| `duration_ms` | int | yes | sensor |

**3. Sample.** None in current dev DB (no recent directive activity). ARCHITECTURE.md § directive_result (line 2489) is the contract.

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | Status + action + duration is good; missing `directive_id` (UUID of the inbound directive) so operator can correlate cross-directive |
| Policy tuning | partial | result dict contains action-specific data but no consistent shape |
| Incident triage | partial | Missing directive_id |
| Drift detection | partial | duration_ms helps; no `attempt_number` for retried directives |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `directive_id` (UUID, the inbound directive's id from the response envelope), `attempt_number` (int).
- **Capture-gated:** none.

**6. Capture-gated content plan.** None.

**7. Dashboard rendering gap.** Inline today: "DIRECTIVE RESULT" badge + status + action. Post-Q4: directive_id chip linking to the originator (when the dashboard surfaces inbound directives separately — out of scope for now). Detail drawer: full result dict + duration sparkline.

**8. Investigate facet gap.** New facet: `directive_status` + `directive_action` — both low-cardinality, valuable for triage.

**9. Cross-cutting.** Sensor — track directive_id from the response envelope.

---

### `mcp_tool_list`, `mcp_resource_list`, `mcp_prompt_list` (discovery family)

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/mcp.py:882-887` — single registry entry per type. Plugin does NOT emit these (D116 step 2 in PR #29 — only mcp_tool_call surfaces from the hook layer).

**2. Current payload schema.** Per ARCHITECTURE.md § MCP event types lean payload.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_name` | string | no | sensor (from InitializeResult) |
| `transport` | enum: `stdio` / `http` / `sse` / `websocket` | no | sensor |
| `count` | int | no | sensor (number of items returned) |
| `duration_ms` | int | no | sensor |
| `error` | structured (taxonomy: invalid_params / connection_closed / timeout / api_error / other) | yes | sensor (failure path) |

**3. Sample (mcp_tool_list).**
```json
{
  "count": 3,
  "content": null,
  "transport": "stdio",
  "duration_ms": 18,
  "server_name": "fixture-stdio-server"
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | partial | count + server tells the story; no `item_names` (operator can't tell what tools/resources/prompts the agent saw without separate query of `mcp_tool_call` traffic) |
| Policy tuning | ✗ | Discovery is the "what's available" snapshot; operator can't policy-tune against what the agent saw without the names |
| Incident triage | partial | Latency + error helps; missing item attribution |
| Drift detection | ✗ | "this server's tool list changed week-over-week" needs item_names persistence; today only count is queryable |
| Compliance/audit export | partial | count is tractable; full inventory is missing |

**5. Recommended enrichment.**

- **Always-included:** `item_names` (string[] — tool names / resource URIs / prompt names depending on type — operationally key for drift detection; cheap to ship since the sensor already has the InitializeResult). Cap at 100 items + a `truncated: true` flag if exceeded.
- **Capture-gated:** none — names are not content per Q2.

**6. Capture-gated content plan.** None. The full ListResult could be captured under capture, but cost-benefit unclear; defer to a future commit.

**7. Dashboard rendering gap.** Inline today: "MCP TOOLS DISCOVERED" / etc. badge + server name + count. Post-Q4: first-3 names + "+N more" chip. Detail drawer: full item_names list + diff-vs-previous-discovery (drift signal).

**8. Investigate facet gap.** None new. `mcp_server` facet (already exists per T25) covers it.

**9. Cross-cutting.** Sensor — populate item_names. Worker — accept the enriched payload. Dashboard — extend MCPEventDetails component.

---

### `mcp_tool_call`

**1. Emission site.** `interceptor/mcp.py:883` (sensor), `plugin/hooks/scripts/mcp_policy.mjs` PreToolUse + PostToolUse (plugin — emits with the same wire schema per ARCHITECTURE 2519-2521).

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_name`, `transport`, `duration_ms` | as above | no | sensor / plugin |
| `arguments` | dict | yes (capture-gated) | sensor / plugin |
| `result.content`, `result.isError` | nested | yes (capture-gated) | sensor / plugin |
| `content` | top-level (overflow path; null when arguments+result fit inline) | yes | sensor — has_content overflow routing |
| (top-level) `tool_name` | string | no | sensor envelope |

**3. Sample.**
```json
{
  "result": {
    "content": [{"text": "phase5-fixture", "type": "text"}],
    "isError": false
  },
  "content": null,
  "arguments": {"text": "phase5-fixture"},
  "transport": "stdio",
  "duration_ms": 22,
  "server_name": "fixture-stdio-server"
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ when capture on | strong — args + result captured |
| Policy tuning | partial | No `policy_decision` field — operator can't tell whether the call passed an explicit allow entry vs. fell through to mode default vs. is for-now-allowed pending tuning |
| Incident triage | partial | duration + error in the result; no LLM-call origin link (which post_call's tool-use response invoked this MCP call) |
| Drift detection | partial | result.isError + structured error taxonomy work; no historical comparison mechanic in the dashboard |
| Compliance/audit export | partial | args + result via capture; missing the policy-decision audit |

**5. Recommended enrichment.**

- **Always-included:** `policy_decision` ({ decision: allow/deny, decision_path: flavor_entry / global_entry / mode_default, policy_id, matched_entry_id }), `originating_llm_call_event_id`.
- **Capture-gated:** `arguments` + `result` are already gated and ride payload.* today. **Q3 migration:** move both to `event_content` (`event_content.tool_input` + `event_content.tool_output`) so the MCP-tool capture sits in the same per-event content table the LLM prompts use. Reduces events.payload bloat + unifies the capture story.

**6. Capture-gated content plan.** Migrate `arguments` → `event_content.tool_input`; `result` → `event_content.tool_output`. Set `events.has_content=true` whenever capture writes either. Same migration shape as the original LLM prompt → event_content move (Phase 1).

**7. Dashboard rendering gap.** Inline today: "MCP TOOL CALL" badge + tool_name + server_name. Post-Q4: policy-decision chip (allow/deny with chroma matching the Quick-start template chips), origin-link chip. Detail drawer: full args + result via the existing event_content fetch + policy snapshot at call time.

**8. Investigate facet gap.** New facets: `policy_decision_path` (3 values), `policy_decision` (allow/deny). Both low-cardinality + key for the "what's almost-allowed" tuning workflow.

**9. Cross-cutting.** Sensor + plugin — populate the policy_decision block (sensor already has it via the policy cache; plugin already runs classifyServer). Schema migration for event_content. Dashboard MCPEventDetails extends.

---

### `mcp_resource_read`

**1. Emission site.** `interceptor/mcp.py:885`.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_name`, `transport`, `duration_ms` | as above | no | sensor |
| `resource_uri` | string | no | sensor |
| `content_bytes` | int | no | sensor |
| `mime_type` | string | yes (capture-gated) | sensor |
| `content` | inline ≤8KiB OR `has_content=true` overflow → event_content | yes | sensor + worker |

**3. Sample.**
```json
{
  "mime_type": "text/plain",
  "transport": "stdio",
  "duration_ms": 42,
  "server_name": "fixture-stdio-server",
  "resource_uri": "mem://big-log",
  "content_bytes": 12288
}
```

**4. Workflows.** Same gaps as mcp_tool_call regarding policy_decision + originating_llm_call_event_id. Plus: resource reads pre-MCP-Protection were policy-uncovered; need to confirm whether the policy cache fires on read paths or only on tool calls.

**5. Recommended enrichment.**

- **Always-included:** `policy_decision` block (same shape as mcp_tool_call), `originating_llm_call_event_id`.
- **Capture-gated:** existing inline-vs-overflow `content` routing is the right shape. No change.

**6. Capture-gated content plan.** Already covered — content already routes to event_content on overflow.

**7. Dashboard rendering gap.** Inline today: "MCP RESOURCE READ" badge + resource_uri + size. Post-Q4: policy-decision chip. Detail drawer: full content via existing fetch (T25-14 covers this).

**8. Investigate facet gap.** Same new facets as mcp_tool_call.

**9. Cross-cutting.** Sensor + worker. Confirm: does the MCP Protection Policy cache fire on resource_read paths in v0.6? If not, this is a follow-up ask.

---

### `mcp_prompt_get`

**1. Emission site.** `interceptor/mcp.py:887`.

**2. Current payload schema.**

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_name`, `transport`, `duration_ms` | as above | no | sensor |
| `prompt_name` | string | no | sensor |
| `arguments` | dict | yes (capture-gated) | sensor |
| `rendered` | array of role-tagged messages | yes (capture-gated) | sensor |

**3. Sample.**
```json
{
  "content": null,
  "rendered": [
    {"role": "user", "content": {"text": "Please greet phase5.", "type": "text"}},
    {"role": "assistant", "content": {"text": "Hello, phase5!", "type": "text"}}
  ],
  "arguments": {"name": "phase5"},
  "transport": "stdio",
  "duration_ms": 38,
  "prompt_name": "greet",
  "server_name": "fixture-stdio-server"
}
```

**4. Workflows.** Same as mcp_tool_call.

**5. Recommended enrichment.**

- **Always-included:** `policy_decision` block, `originating_llm_call_event_id`.
- **Capture-gated:** Migrate `arguments` + `rendered` to `event_content` (same Q3 shape as mcp_tool_call).

**6. Capture-gated content plan.** Add `event_content.prompt_arguments` + `event_content.prompt_rendered`. Or reuse `event_content.tool_input` + `event_content.tool_output` columns since they're the same semantic shape (request/response payload). Recommendation: reuse existing columns.

**7. Dashboard rendering gap.** Inline today: "MCP PROMPT FETCHED" badge + prompt_name. Post-Q4: policy chip + rendered-preview chip ("2 messages"). Detail drawer: full rendered prompt via event_content.

**8. Investigate facet gap.** Same new facets as mcp_tool_call.

**9. Cross-cutting.** Same as mcp_tool_call.

---

### `policy_mcp_warn`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/mcp.py:443` + plugin SessionStart hook (`mcp_policy.mjs`). Both surfaces share the wire schema.

**2. Current payload schema.** No dev DB rows; reading from emission code + ARCHITECTURE § Sensor enforcement (line 2851).

| Field | Type | Nullable | Source |
|---|---|---|---|
| `policy_id` | UUID | no | sensor / plugin |
| `scope` | enum: `flavor:<name>` / `global` | no | sensor / plugin |
| `decision_path` | enum: `flavor_entry` / `global_entry` / `mode_default` | no | sensor |
| `fingerprint` | string (server fingerprint) | no | sensor |
| `server_name`, `server_url`, `transport` | various | no | sensor |
| `block_on_uncertainty` | bool | yes (only on mode_default path under allowlist) | sensor |

**3. Sample.** None in dev DB. Schema mirrors `policy_mcp_block` below.

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | strong — has policy_id + scope + decision_path |
| Policy tuning | partial | "what was almost-allowed" — has the right fields but no `matched_entry_id` (which specific entry in the policy matched, or null on mode_default). Operator can infer via fingerprint lookup against the policy's entries; surfacing the entry id directly closes the loop. |
| Incident triage | partial | No `originating_call_context` (which agent operation triggered this — list_tools? call_tool? read_resource?) |
| Drift detection | partial | fingerprint persistence enables it; no `prior_decision` flag (was this server allowed last week?) |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `matched_entry_id` (UUID, nullable on mode_default), `originating_call_context` (enum: `list_tools` / `call_tool` / `list_resources` / `read_resource` / `list_prompts` / `get_prompt` / `session_boot`), `originating_event_id` (the matching MCP-event row id when emitted alongside, or session_id for session-boot path).
- **Capture-gated:** none.

**6. Capture-gated content plan.** None.

**7. Dashboard rendering gap.** Inline today (per T17 + dashboard events.ts): "POLICY MCP WARN" badge + server_name. Post-Q4: matched-entry chip + decision-path chip + origin-context chip. Detail drawer: full policy snapshot at fire time + entry detail + the MCP call that triggered.

**8. Investigate facet gap.** New facets: `decision_path` (3 values), `originating_call_context` (7 values).

**9. Cross-cutting.** Sensor — `matched_entry_id` is already in the resolve result; just pipe through. Worker — accept new fields. Dashboard — extend MCPEventDetails + per-event policy summary.

---

### `policy_mcp_block`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/mcp.py:454` (sensor — flushes synchronously, raises `MCPPolicyBlocked`) + plugin (`mcp_policy.mjs` PreToolUse path).

**2. Current payload schema.** Per dev DB sample.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `policy_id`, `scope`, `decision_path`, `fingerprint`, `server_name`, `server_url`, `transport`, `block_on_uncertainty` | as policy_mcp_warn | no | sensor / plugin |

**3. Sample.**
```json
{
  "scope": "flavor:playground-template-strict-484842",
  "policy_id": "e1a0493d-5958-415b-9e0d-021eb2de2bb6",
  "transport": "stdio",
  "server_url": "/mnt/c/Users/.../python -m playground._mcp_reference_server",
  "fingerprint": "fe0c9bd4e900b288",
  "server_name": "flightdeck-mcp-reference",
  "decision_path": "mode_default",
  "block_on_uncertainty": true
}
```

**4. Workflows.** Same gaps + same recommendations as `policy_mcp_warn`. Block is the "did the agent get stopped" answer; warn is the "what would have been stopped if I tighten" answer.

**5. Recommended enrichment.** Same as policy_mcp_warn.

**6. Capture-gated content plan.** None. (Blocked call never reached the server; nothing to capture.)

**7. Dashboard rendering gap.** Same as policy_mcp_warn + chroma matches the danger class.

**8. Investigate facet gap.** Same as policy_mcp_warn.

**9. Cross-cutting.** Same as policy_mcp_warn.

---

### `mcp_server_attached`

**1. Emission site.** `sensor/flightdeck_sensor/interceptor/mcp.py:540` — when ClientSession.initialize() runs AFTER session_start (the common case for late-attaching frameworks per D140).

**2. Current payload schema.** Per dev DB sample.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_name`, `transport`, `fingerprint`, `server_url_canonical` | various | no | sensor |
| `attached_at` (per ARCHITECTURE; not visible in dev sample) | ISO 8601 | no | sensor |

**3. Sample.**
```json
{
  "transport": "stdio",
  "fingerprint": "fe0c9bd4e900b288",
  "server_name": "flightdeck-mcp-reference",
  "server_url_canonical": "stdio:///mnt/c/Users/.../python -m playground._mcp_reference_server"
}
```

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | — |
| Policy tuning | partial | No `policy_decision_at_attach` — when the server first attached, what would the current policy have decided about it? Operator can compute by hand; surfacing it directly is the operator-actionable shape. |
| Incident triage | ✓ | — |
| Drift detection | ✓ | fingerprint enables it |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `policy_decision_at_attach` ({decision, decision_path, policy_id, matched_entry_id} — same shape as policy_mcp_*).
- **Capture-gated:** none.

**6. Capture-gated content plan.** None.

**7. Dashboard rendering gap.** Inline today (per T25 SessionDrawer panel): adds the server to the MCP SERVERS panel via the WS-driven re-fetch. Post-Q4: policy chip on the attach event row in the timeline. Detail drawer: server fingerprint + capabilities + policy snapshot.

**8. Investigate facet gap.** None new (server_name covers it).

**9. Cross-cutting.** Sensor populates the policy_decision_at_attach by reusing the existing resolve cache. Cheap.

---

### `mcp_server_name_changed`

**1. Emission site.** `interceptor/mcp.py:599` — when an MCP server returns a different `serverInfo.name` on a subsequent initialize() than the previous one (drift detection per ARCHITECTURE 2785).

**2. Current payload schema.** No dev DB rows; reading from emission code.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `server_url_canonical` | string | no | sensor |
| `previous_name` | string | no | sensor |
| `new_name` | string | no | sensor |
| `previous_fingerprint`, `new_fingerprint` | string | no | sensor |
| `transport` | enum | no | sensor |

**3. Sample.** None in dev DB. Schema per code reading.

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | — |
| Policy tuning | partial | When name changes, the fingerprint changes too — any previous policy entries against the old fingerprint silently stop matching. Payload doesn't surface this consequence. |
| Incident triage | partial | No `policy_entries_orphaned` (count of entries whose fingerprint just stopped matching) |
| Drift detection | ✓ | this IS the drift-detection event |
| Compliance/audit export | ✓ | — |

**5. Recommended enrichment.**

- **Always-included:** `policy_entries_orphaned` ({policy_id, count, sample_entry_ids[]} — sensor doesn't have this, worker computes during projection).
- **Capture-gated:** none.

**6. Capture-gated content plan.** None.

**7. Dashboard rendering gap.** Inline today: not yet rendered (no test for it; events.ts doesn't have a switch case). Post-Q4: warning-class badge + previous→new chip. Detail drawer: orphaned-entries list with jump to each policy.

**8. Investigate facet gap.** None new.

**9. Cross-cutting.** Worker — compute orphan count by joining the new+old fingerprints against `mcp_policy_entries`. Sensor → worker → API → dashboard. Surfaces the dashboard-side gap (no renderer today; flag for Step 6 batch).

---

### `mcp_policy_user_remembered` (plugin-only)

**1. Emission site.** `plugin/hooks/scripts/remembered_decisions.mjs` — fires when the user clicks "yes and remember" on an MCP-policy ask prompt (D119 plugin-side reactive flow).

**2. Current payload schema.** Reading from emission code.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `tool_name` | string (e.g., `mcp__filesystem__read_file`) | no | plugin |
| `decision` | enum: `allow` / `deny` | no | plugin |
| `scope` | enum: `session` / `flavor` / `global` | no | plugin (user picks the scope) |
| `policy_id` | UUID, populated when scope is flavor or global | yes | plugin |

**3. Sample.** None in dev DB.

**4. Workflows.**

| Workflow | Supported | Gap |
|---|---|---|
| Forensic review | ✓ | — |
| Policy tuning | ✓ — this IS the user's tuning input | — |
| Incident triage | partial | No `originating_session_id` link — easy to derive from the row's session_id but no explicit pointer to the originating PreToolUse decision |
| Drift detection | ✗ | — |
| Compliance/audit export | ✓ | strong — captures who said yes-and-remember to what |

**5. Recommended enrichment.**

- **Always-included:** `originating_pretooluse_event_id` (UUID — the policy_mcp_warn or policy_mcp_block that triggered the ask).
- **Capture-gated:** none.

**6. Capture-gated content plan.** None.

**7. Dashboard rendering gap.** Inline today: "MCP POLICY REMEMBERED" badge per events.ts. Post-Q4: scope chip + decision chip + originating-event jump. Detail drawer: full chain (PreToolUse ask → user click → remember → applied).

**8. Investigate facet gap.** New facet: `decision` (allow/deny) + `scope` (3 values).

**9. Cross-cutting.** Plugin only.

---

## Cross-cutting findings

### Always-included field shape — recommend a shared `policy_decision` block

Across `mcp_tool_call`, `mcp_resource_read`, `mcp_prompt_get`, `mcp_server_attached`, `policy_mcp_warn`, `policy_mcp_block`, the same enrichment shape recurs:

```json
"policy_decision": {
  "decision": "allow|deny|warn|block",
  "decision_path": "flavor_entry|global_entry|mode_default",
  "policy_id": "uuid",
  "matched_entry_id": "uuid|null"
}
```

Recommend defining this once (sensor: `flightdeck_sensor.core.types.PolicyDecisionSummary`) and reusing across emissions. Reduces drift across event types and lets dashboard share a single renderer.

### `originating_event_id` chain

Half the recommendations add an `originating_event_id` field. Implement once at the sensor's interceptor base — track the "current LLM-call event id" in session state, expose via `get_current_call_id()`, every downstream emission (tool_call, llm_error, embeddings, mcp_*, policy_mcp_*) populates from it.

### Schema migrations needed

- `event_content`: add `tool_input`, `tool_output` jsonb columns (Q3 / Step 3 batch). Optionally add `embedding_output` (gated separately; defer).
- `events`: no new columns recommended — every enrichment fits in `payload` jsonb except those already promoted (model, tokens_*, latency_ms, tool_name, has_content). Rule 33 still binds; new payload fields don't trigger schema changes but do require ARCHITECTURE.md updates per Rule 41/42.
- `sessions`: no changes — all session-level enrichments live on the events `session_start`/`session_end` payloads.

### ARCHITECTURE.md drift surfaced (defer fix to enrichment commits)

| Drift | Location | Severity |
|---|---|---|
| "17 emitted event types" — actual is 21 sensor + 1 plugin = 22 | `ARCHITECTURE.md:2341` | medium — operator-facing taxonomy reference |
| `mcp_server_name_changed`, `mcp_server_attached`, `policy_mcp_warn`, `policy_mcp_block`, `mcp_policy_user_remembered` not enumerated in § Event Types | `ARCHITECTURE.md:2341-2347` | medium — enrichment commits land docs alongside |

### Dashboard rendering gaps (recurring across types)

- `mcp_server_name_changed` has **no events.ts switch case** — events render as untyped fallback. Step 6 batch must add the renderer.
- Detail drawer surface (Q4) does not yet exist as a component. The existing SessionDrawer renders timeline rows but the click-through to a detail panel is per-row inline only. A shared `<EventDetailDrawer>` keyed on event-id is the Q4 deliverable.
- Investigate facet system supports adding new facets via the existing pattern (T25-8 covers MCP_SERVER facet); each new facet enumerated above hooks the same way.

### Capture-flag boundaries (Q2/Q3 confirmation)

- Q2 boundary: every recommended `policy_*`, `originating_*`, `matched_entry_*`, `policy_decision`, `close_reason`, `directive_id`, `retry_attempt`, `policy_actions_summary`, `sensor_version`, `interceptor_versions`, `estimated_via`, `provider_metadata` field — **always included**, never gated by capture.
- Q3 boundary: MCP `arguments`, `result`, `rendered`, `embedding_output` — **gated by capture_prompts**, route through `event_content` (consistent with LLM messages/response).

---

## Roll-up — proposed enrichment batches

Confirms the supervisor's draft batch list is the right shape. Audit-derived adjustments:

| Batch | Supervisor's name | Audit-derived scope |
|---|---|---|
| Step 2 | Policy events | `policy_warn`, `policy_block`, `policy_degrade`, `policy_mcp_warn`, `policy_mcp_block` — `policy_decision` block + `matched_entry_id` + `originating_event_id` + `originating_call_context` (mcp variants only) |
| Step 3 | MCP outbound | `mcp_tool_call`, `mcp_resource_read`, `mcp_prompt_get` (+ `tool_call` LLM-side) — `policy_decision` block + `originating_llm_call_event_id` + Q3 event_content migration for tool_input/tool_output. Discovery family (`mcp_tool_list`, `mcp_resource_list`, `mcp_prompt_list`) gets `item_names` here too |
| Step 4 | State transitions | `session_start` (sensor_version, interceptor_versions, policy_snapshot), `session_end` (close_reason, policy_actions_summary, last_event_id), `mcp_server_attached` (policy_decision_at_attach), `mcp_server_name_changed` (policy_entries_orphaned + dashboard renderer) |
| Step 5 | LLM events | `llm_error` (originating_id + retry_attempt + terminal), `pre_call` / `post_call` (policy_decision_pre/post + estimated_via + provider_metadata). `embeddings` output_dimensions |
| Step 6 | Dashboard | All inline renderer chips called out per type; `<EventDetailDrawer>` shared component; new Investigate facets (`close_reason`, `decision_path`, `policy_decision`, `originating_call_context`, `decision`, `scope`, `directive_status`, `directive_action`, `is_retryable`, `final_outcome`, `estimated_via`, `sensor_version` — at least 12 new facets); ARCHITECTURE.md § Event Types refresh to lock the 22-type inventory |
| Step 7 | Phase-close audit | Combined MCP Protection Policy + Phase 7 audit per METHODOLOGY |

### Open questions for supervisor (audit findings; resolution needed before Step 2)

1. `context_switch` event type — supervisor's prompt list included it; does not exist in code or DB. Drop from inventory or design as a new type for some unknown trigger?
2. `directive_received` / `directive_applied` — supervisor's prompt list assumed two types; only `directive_result` exists with `directive_status` enum. Confirm: keep one type, or split for clarity?
3. `embeddings_output` capture flag — separate from `capture_prompts` per data-volume concern, or roll under the same flag? Audit recommends separate; defer to supervisor.
4. MCP Protection Policy coverage of `mcp_resource_read` and `mcp_prompt_get` paths — the audit assumes these go through the same policy cache as `mcp_tool_call`; verify the v0.6 cache fires on read/get paths or surface as a coverage gap.

---

## Verification

- **Inventory completeness.** Cross-reference: every value in `EventType` enum (`sensor/flightdeck_sensor/core/types.py:21-61`) appears in this audit; every event-type string emitted by `plugin/hooks/scripts/*.mjs` appears too. `tool_call` (LLM-side, missing from supervisor's prompt) is added to the audit. Supervisor's `context_switch` / `subagent_*` / `llm_streaming` / `directive_received-applied` are surfaced as inventory discrepancies above.
- **Markdown lint.** Doc rendered in `cat | head` and structurally clean (no broken tables, headings hierarchical).
- **ARCHITECTURE.md cross-reference.** Drift items listed under cross-cutting findings; no edits in this commit per scope.

