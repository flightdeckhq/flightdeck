# demo_helpers — fleet-view recording helpers

Snapshot of the local helpers used to record the live-fleet demo
GIF on May 26, 2026. **Not part of the product.** Lives on the
`demo/fleet-recording-helpers` branch so it can be checked out
again next time the demo needs re-shooting; intentionally not on
`main` (these are operator scripts, not shipping code).

## What's here

| File | Role |
|---|---|
| `seed_history.py` | Seeds 7 days × 11 agents (7 sensor flavors + 4 claude_code agents: parent + 3 sub-agent roles) of synthetic historical events. POSTs through the ingestion API, then backdates `events.occurred_at` + `sessions.{started_at,last_seen_at,ended_at}` + `agents.first_seen_at` via `docker exec psql` so the Agents-page sparklines (Tokens / Latency p95 / Errors / Sessions / Cost) render with real shape before the live burst starts. Claude Code agent_ids match the plugin's D115 UUID5 derivation so the historical seed lands on the same fleet row the live plugin emits during the burst. |
| `emit_demo_fleet.py` | Live burst — 7 synthetic sensor sessions (`checkout-orchestrator`, `research-assistant`, `mcp-explorer`, `pii-redactor`, `support-triage`, `multi-step-research`, `researcher-subagent`) with the full sensor event catalog (`session_start`, `pre_call`, `post_call`, `tool_call`, `mcp_*`, `policy_*`, `embeddings`, `llm_error`, `directive_result`, `subagent_*`, `session_end`). Events are paced in real time over `max_offset × SPACE_MULTIPLIER` seconds (~40 s @ 2.2×) so sessions transition `active → closed` at the dashboard's natural pace instead of all collapsing to `closed` on a single tick. |
| `launch_with_flavor.py` | Flavor-override shim — monkey-patches `playground/_helpers.py::init_sensor` so an existing playground script (e.g. `01_direct_anthropic.py`) runs under a `DEMO_FLAVOR_OVERRIDE` env var. Used during the earlier playground-launch demo attempt; kept here for future cherry-picks. |
| `provision_policies.py` | One-shot pre-provisioner — per-flavor TOKEN policies (`POST /v1/policies`) + an MCP Protection Policy on `mcp-explorer` denying `flightdeck-mcp-reference`. Used during the playground-launch demo; not part of the current synthetic-event flow. |
| `fire_killswitch.py` | Discovers active demo sessions via `GET /v1/sessions` and POSTs `action=shutdown` directives. Used during the playground-launch demo; not part of the current synthetic-event flow. |

## How to re-run the demo

```bash
# 1. Copy the helpers back into /tmp so the path constants line up.
cp -r demo_helpers /tmp/
mv /tmp/demo_helpers/README.md /tmp/demo_helpers/README.snap.md

# 2. Clean stack.
make dev-reset

# 3. Wait for stack + seed history.
until curl -s http://localhost:4000/api/health | grep -q '"ok"'; do sleep 2; done
/usr/bin/python3 /tmp/demo_helpers/seed_history.py

# 4. Open the dashboard, confirm Agents page sparklines render.

# 5. Fire the burst. The expected pattern is:
#      a. Spawn 3 Task sub-agents in parallel via the Claude Code
#         Agent tool (or any equivalent harness).
#      b. After ~8 s head-start, run the sensor emitter:
#         /usr/bin/python3 /tmp/demo_helpers/emit_demo_fleet.py
#      c. Burst paces over ~40 s wall-clock; sessions transition
#         active → closed naturally during the recording.
```

## Operator-facing knobs

- `seed_history.py::DAYS_BACK` — which days T-N to seed (default
  `(7,6,5,4,3,2,1)`).
- `seed_history.py::FLAVOR_PROFILES` — per-flavor traffic shape
  (event counts, token ranges, latency ranges, errors-per-day).
  Each flavor's `agent_role` for the claude-code agents is the
  D115 grammar's 6th path segment.
- `emit_demo_fleet.py::SPACE_MULTIPLIER` (default `2.2`) — stretches
  the burst over `max_offset × multiplier` seconds of wall-clock.
  Bumping it spreads events further; pulling it down compresses.
- `emit_demo_fleet.py::FLAVOR_PROFILES` (per session) — event
  counts, token ranges, latency ranges, model selection.

## Why not in `playground/`?

`playground/` is the production-facing demo surface that runs against
real LLM provider keys; every script there asserts inline correctness
and exits non-zero on assertion failure (the `run_all.py` smoke
matrix gates on this). These helpers emit synthetic events through
the ingestion API to populate the dashboard for screen-recording
purposes; they have no provider dependency, no assertion contract,
and no role in the CI smoke matrix. Keeping them isolated under
`demo_helpers/` on a side branch preserves the snapshot without
intermixing.
