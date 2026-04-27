# Phase 5 Dashboard Fixtures

This directory holds frozen fixture data the dashboard's MCP unit tests
and Playwright E2E spec consume. The fixtures are the **dashboard contract**
between the sensor / worker / Query API and the dashboard.

## Files

| File | Source | What it represents |
|---|---|---|
| `mcp-events.json` | Captured live by `_capture_mcp_fixtures.py` running flightdeck-sensor against `tests/smoke/fixtures/mcp_reference_server.py` | Top-level keys: `events` (one canonical payload per MCP event type + `session_start` with `context.mcp_servers`), `session_listing_item` (synthetic — what `GET /v1/sessions` returns per row, including `mcp_server_names[]`), `session_detail` (synthetic — what `GET /v1/sessions/:id` returns, including `context.mcp_servers[]`) |
| `_capture_mcp_fixtures.py` | Generator script | Re-run when the sensor's MCP payload shape legitimately changes |

## Why fixtures, not live captures, in dashboard tests

Dashboard tests must run without the full Docker dev stack (mcp client +
mcp server subprocess + worker + Postgres + Query API). Replaying a frozen
canonical payload makes tests fast, deterministic, and decoupled from
sensor-side flakes. The trade-off is that the fixture must be kept in
sync with reality — see governance below.

## Governance

This file is the **Phase 5 dashboard contract**.

**Rules:**

- Sensor / worker / API changes that affect any MCP event payload shape
  require regenerating this file.

- After Step 8 (dashboard implementation) begins, any contract change
  requires explicit Supervisor approval AND a full dashboard test rerun.
  Drift here silently breaks rendering.

- The fixture file is authoritative. If the fixture and a test disagree,
  fix the test (or fix the fixture with approval) — never tolerate drift.

## How to regenerate

```bash
# From repo root
sensor/.venv/bin/python -m dashboard.tests.e2e.fixtures._capture_mcp_fixtures
```

The generator boots the reference MCP server as a subprocess, runs the
sensor's MCP interceptor against it, captures one event of each type,
normalises volatile fields (session_id / agent_id / timestamp / host /
user / agent_name / duration_ms) to fixed placeholder strings so the
output is deterministic, and writes the JSON to disk.

Synthetic listing / detail shapes are appended after the live capture —
they are not produced by the sensor (the sensor only emits events) and
must be hand-edited in the generator script to track the API as Step 7
implements it.

## Field-shape rules locked in `mcp-events.json`

* MCP event payloads are **lean** — they do NOT carry the LLM-baseline
  fields (`model`, `tokens_input/output/total`, `tokens_cache_read/creation`,
  `latency_ms`, `tool_input`, `tool_result`, `has_content`, `content`).
  See `Session._build_payload` and the `test_mcp_event_payload_omits_llm_baseline_fields`
  regression guard in `sensor/tests/unit/test_mcp_interceptor.py`.

* `tool_name` (top-level) appears on `mcp_tool_call` only — it populates
  the existing `events.tool_name` column so existing tooling that filters
  by tool name keeps working.

* `protocol_version` on each fingerprint preserves the SDK's `str | int`
  type. The dashboard's renderer must handle both. Do NOT coerce to string
  in the worker / API.

* Listing rows surface `mcp_server_names: string[]` (names only) parallel
  to `error_types[]` and `policy_event_types[]`. Detail responses surface
  `context.mcp_servers: object[]` (full fingerprint).

* Per-event `framework` is `null` on the bare Python sensor. When a
  framework is detected (LangChain / LlamaIndex / CrewAI / etc.), it
  populates the bare-name field (e.g. `"langchain"`).

## Phase 5 cross-source coverage asymmetry

The Python sensor emits all 6 MCP event types. The Claude Code plugin
emits **MCP_TOOL_CALL only** plus session-level `mcp_servers` metadata.
Resource reads, prompt fetches, and list operations are invisible to
Claude Code's hook surface — they are not routed through PreToolUse /
PostToolUse and there is no resource/prompt hook in the runtime today.

This asymmetry is intentional and documented in `README.md` under
"MCP Observability by Source". The dashboard's MCP filter shows fewer
event types for plugin-source sessions; it does NOT synthesise events
that don't exist.

`test_smoke_mcp_claude_code.py` asserts byte-for-byte schema parity on
the one event type both sources emit (`MCP_TOOL_CALL`) — see Phase 5
addition C.
