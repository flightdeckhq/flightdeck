# Flightdeck Playground

Working examples for every framework Flightdeck supports. Each file is a minimal, copy-pasteable developer script showing how to wire `flightdeck-sensor` into a specific stack. Pick the file that matches your framework, copy it, adapt to your code.

The suite also doubles as Flightdeck's canonical Rule 40d manual-exercise surface (D124): `make playground-all` runs every script against a live Flightdeck stack with real provider API keys and asserts on the event shapes that land on the wire. Total cost under $0.05 per full run.

## Files

| File | Stack | What it shows |
|---|---|---|
| `01_direct_anthropic.py` | anthropic SDK | sync / async / sync-stream / async-stream / beta.messages, plus invalid-model `llm_error` classification |
| `02_direct_openai.py` | openai SDK | sync / async / sync-stream / async-stream / responses, embeddings (single + list) capture round-trip, auth-error classification |
| `03_langchain.py` | `langchain-anthropic`, `langchain-openai` (+ optional `langchain-mcp-adapters`) | `ChatAnthropic.invoke` + `ChatOpenAI.invoke` + `OpenAIEmbeddings.embed_documents` capture + `session.framework='langchain'` attribution + MCP tool call via the adapter |
| `04_langgraph.py` | `langgraph` (+ optional `langchain-mcp-adapters`) | StateGraph routing through ChatAnthropic + `ToolNode` driving an MCP-adapter tool |
| `05_llamaindex.py` | `llama-index-llms-anthropic`, `llama-index-llms-openai` (+ optional `llama-index-tools-mcp`) | `.complete(...)` for both providers + MCP tool call via `McpToolSpec` |
| `06_crewai.py` | `crewai` (+ optional `mcpadapt`) | `LLM("anthropic/...").call(...)` + `LLM("openai/...").call(...)` + MCP tool call via `mcpadapt` direct (version-drift canary for `crewai-tools[mcp]`) |
| `07_directives.py` | anthropic | register → POST custom directive → handler runs |
| `08_enforcement.py` | anthropic | server policy `block_at_pct=1` → `BudgetExceededError` |
| `09_capture.py` | anthropic | `capture_prompts` OFF (404) vs ON (200) |
| `10_killswitch.py` | anthropic | POST `shutdown` directive → `DirectiveError` |
| `11_unavailability.py` | anthropic | `continue` vs `halt` against a dead URL |
| `12_litellm.py` | `litellm` | Anthropic + OpenAI routes, embeddings capture round-trip, invalid-model `llm_error` |
| `13_mcp.py` | bare `mcp` SDK | All six MCP event types against the in-tree reference server, plus a multi-server attribution scenario using a sibling secondary server (`_secondary_mcp_server.py`). Verifies `transport=stdio` on every event. |
| `14_claude_code_plugin.py` | Claude Code plugin (`observe_cli.mjs` over Node 20+) | Synthetic `PostToolUse` + `PostToolUseFailure` hooks → `mcp_tool_call` event with parsed server attribution, plus `PluginToolError` structured-error path |
| `15_bifrost.py` | bifrost gateway (optional, opt-in via `BIFROST_URL`) | openai SDK and anthropic SDK pointed at bifrost; both protocols intercepted independently |
| `policy_demo_warn.py` | anthropic + flavor-scoped policy | server WARN directive emits `policy_warn` with `source=server` |
| `policy_demo_block.py` | anthropic + flavor-scoped policy | server BLOCK pre-flight emits `policy_block` + `BudgetExceededError`; `intended_model` + `token_limit` round-trip |
| `policy_demo_degrade.py` | anthropic + flavor-scoped policy | server DEGRADE swaps the model on threshold cross; `to_model` lands and post_calls show the swap |
| `policy_demo_forced_degrade.py` | anthropic + flavor-scoped policy | Decision-1 lock: exactly one `policy_degrade` event regardless of how many subsequent calls fire on the armed session |

## Prerequisites

- **Python 3.10 ≤ x < 3.14.** Run via the project venv (`./sensor/.venv/bin/python` — see root `README.md` setup), or via `make playground-*` targets which resolve through `$(PYTHON)` to the venv. `run_all.py` refuses to run on the wrong interpreter so a misconfigured local box can't silently SKIP framework-touching demos. (D124.)
- A running Flightdeck stack. Default: `make dev` on `localhost:4000`. Override via `FLIGHTDECK_SERVER` / `FLIGHTDECK_TOKEN` / `FLIGHTDECK_API_URL`.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment for the chat / embeddings demos.
- Optional: `BIFROST_URL` (for `15_bifrost.py`), `node` 20+ (for `14_claude_code_plugin.py`).
- Framework packages for the examples you want to run. Each file prints a `SKIP: pip install <package>` line and exits cleanly when its dependency is missing, so you can run the suite with only the frameworks you care about installed. The full project-pinned set is installed by `pip install -e ./sensor[dev,anthropic,openai]` (see root README setup).

## Running

Single file:

```bash
make playground-langchain
# equivalent: ./sensor/.venv/bin/python playground/03_langchain.py
```

Full suite:

```bash
make playground-all
# equivalent: ./sensor/.venv/bin/python playground/run_all.py
```

`run_all.py` executes each file as an isolated subprocess with a 60-second timeout, streams stdout/stderr through in real time, and prints a PASS/SKIP/FAIL summary at the end. Exits 0 iff every file returned 0 (PASS) or 2 (SKIP). FAIL exits non-zero so CI / pre-release gates trip loudly.

## How playground demos assert

Each script demonstrates a working flow AND verifies the event shapes that landed on the wire:

```python
from _helpers import fetch_events_for_session, init_sensor, print_result

events = fetch_events_for_session(session_id, expect_event_types=["post_call"], timeout_s=8.0)
streamed = [e for e in events if (e.get("payload") or {}).get("streaming")]
ttft_ok = any(e["payload"]["streaming"].get("ttft_ms") is not None for e in streamed)
print_result("streaming.ttft_ms populated", ttft_ok, 0)
if not ttft_ok:
    raise AssertionError(f"no post_call carried streaming.ttft_ms; events={events!r}")
```

The pattern is print + assert, so each script reads as a working demonstration AND a regression guard. A failing assertion exits non-zero so `run_all.py` flips the file to FAIL in the summary table.

## Coverage notes

- **litellm** has its own module-level interceptor (`12_litellm.py`). `litellm.completion` and `litellm.acompletion` are wrapped regardless of underlying provider, closing the previous gap where litellm's raw-httpx Anthropic route bypassed the SDK-class patches. Streaming (`stream=True`) is not yet supported -- see the Roadmap in the root `README.md`. For the full "what's caught, what's not" breakdown of the litellm interceptor, see `sensor/README.md`.
- **CrewAI 1.14+** uses the official `anthropic` / `openai` SDKs directly, so its LLM calls are intercepted through the SDK-class patches (see `06_crewai.py`). The MCP section uses `mcpadapt` directly (rather than `crewai_tools.MCPServerAdapter` which sits on top of it) so a future `crewai-tools` upgrade that silently bumps to an incompatible `mcpadapt` release breaks the demo loudly.
- **Claude Code plugin** is observation-only and doesn't itself call providers; the plugin demo (`14_claude_code_plugin.py`) pipes synthetic hook events to `observe_cli.mjs` to exercise the success and failure code paths without needing a real Claude Code session.
- **bifrost** (`15_bifrost.py`) is opt-in via `BIFROST_URL`. Skips silently when unset. Both the OpenAI-protocol and Anthropic-protocol forwarding paths are exercised so a regression in either interceptor trips the demo.

## Rule 40d in one line

> Any framework-touching change requires a real-provider playground demo alongside the mocked integration tests. Skipping the playground run is a release-gate failure.
