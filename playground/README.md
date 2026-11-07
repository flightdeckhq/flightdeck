# Flightdeck Playground

Working examples for every framework Flightdeck supports. Each file is a minimal, copy-pasteable developer script showing how to wire `flightdeck-sensor` into a specific stack. Pick the file that matches your framework, copy it, adapt to your code.

The suite also doubles as Flightdeck's canonical Rule 40d manual-exercise surface: `make playground-all` runs every script against a live Flightdeck stack with real provider API keys and asserts on the event shapes that land on the wire. Total cost ~$0.50 per full run (each script costs cents).

## Files

| File | Stack | What it shows |
|---|---|---|
| `01_direct_anthropic.py` | anthropic SDK | sync / async / sync-stream / async-stream / async-stream via `text_stream` / async-stream via `get_final_message` / raw `create(stream=True)` plain iteration / beta.messages; asserts every streamed `post_call` carries real token usage; invalid-model `llm_error` classification |
| `02_direct_openai.py` | openai SDK | sync / async / sync-stream / async-stream / chat stream plain iteration / responses / `responses.create(stream=True)`, embeddings (single + list) capture round-trip; asserts every streamed `post_call` carries real token usage; auth-error classification |
| `03_langchain.py` | `langchain-anthropic`, `langchain-openai` (+ optional `langchain-mcp-adapters`) | `ChatAnthropic.invoke` + `ChatOpenAI.invoke` + `OpenAIEmbeddings.embed_documents` capture + `session.framework='langchain'` attribution + MCP tool call via the adapter |
| `04_langgraph.py` | `langgraph` (+ optional `langchain-mcp-adapters`) | StateGraph routing through ChatAnthropic + `ToolNode` driving an MCP-adapter tool |
| `05_llamaindex.py` | `llama-index-llms-anthropic`, `llama-index-llms-openai` (+ optional `llama-index-tools-mcp`) | `.complete(...)` for both providers + MCP tool call via `McpToolSpec` |
| `06_crewai.py` | `crewai` (+ optional `mcpadapt`) | `LLM("anthropic/...").call(...)` + `LLM("openai/...").call(...)` + MCP tool call via `mcpadapt` direct (version-drift canary for `crewai-tools[mcp]`) |
| `07_directives.py` | anthropic | register → POST custom directive → handler runs |
| `08_enforcement.py` | anthropic | server policy `block_at_pct=1` → `BudgetExceededError` |
| `09_capture.py` | anthropic | `capture_prompts` OFF (404) vs ON (200) |
| `10_killswitch.py` | anthropic | POST `shutdown` directive → `DirectiveError` |
| `11_unavailability.py` | anthropic | `continue` vs `halt` against a dead URL |
| `12_litellm.py` | `litellm` | Anthropic + OpenAI routes / sync-stream (Anthropic route) / async-stream (OpenAI route); asserts every streamed `post_call` carries real token usage and that the four chat calls land as exactly four `post_call`s (the two served through the OpenAI SDK are counted once); embeddings capture round-trip; invalid-model `llm_error` |
| `13_mcp.py` | bare `mcp` SDK | All six MCP event types against the in-tree reference server, plus a multi-server attribution scenario using a sibling secondary server (`_secondary_mcp_server.py`). Verifies `transport=stdio` on every event. |
| `14_claude_code_plugin.py` | Claude Code plugin (`observe_cli.mjs` over Node 22+) | Synthetic `PostToolUse` + `PostToolUseFailure` hooks → `mcp_tool_call` event with parsed server attribution, plus `PluginToolError` structured-error path |
| `15_bifrost.py` | bifrost gateway (optional, opt-in via `BIFROST_URL`) | openai SDK and anthropic SDK pointed at bifrost; both protocols intercepted independently |
| `16_subagents_crewai.py` | `crewai` | Real two-agent Crew (Researcher + Writer) through the CrewAI sub-agent interceptor: each `Agent.execute_task` lands as its own child session with `parent_session_id`, `agent_role` from `Agent.role`, and incoming / outgoing message capture |
| `17_subagents_langgraph.py` | `langgraph`, `langchain-anthropic` | Real two-node graph through the LangGraph sub-agent interceptor: each `StateGraph.add_node` body lands as its own child session; exercises both the inline (≤ 8 KiB) and the `event_content` overflow message paths |
| `18_mcp_policy_warn.py` | bare `mcp` SDK + flavor policy | MCP Protection Policy warn enforcement: a flavor deny entry with `enforcement=warn` makes a tool call land `policy_mcp_warn`; no LLM key needed |
| `19_mcp_policy_block.py` | bare `mcp` SDK + flavor policy | MCP Protection Policy block enforcement: `policy_mcp_block` lands and `MCPPolicyBlocked` is raised at `call_tool` time; no LLM key needed |
| `20_mcp_policy_block_on_uncertainty.py` | bare `mcp` SDK (runs without the dev stack) | Block-on-uncertainty failsafe: unreachable control plane + `init(mcp_block_on_uncertainty=True)` resolves unmatched servers to block (`decision_path="mode_default"`, `scope="local_failsafe"`) |
| `21_mcp_policy_blocklist.py` | bare `mcp` SDK + global policy | Blocklist mode + global deny entry: `PUT /v1/mcp-policies/global` deny blocks via `decision_path="global_entry"`, then the empty global policy is restored |
| `22_mcp_policy_crewai.py` | `crewai` + `mcpadapt` | CrewAI transitive MCP policy coverage: a real CrewAI agent with an MCP tool trips a flavor warn policy through the shared `ClientSession` patch |
| `23_mcp_policy_langgraph.py` | `langgraph` + `langchain-mcp-adapters` | LangGraph transitive MCP policy coverage: a model node + `ToolNode` loop with an MCP tool trips a flavor warn policy |
| `24_mcp_policy_langchain.py` | `langchain` + `langchain-mcp-adapters` | LangChain explicit MCP policy coverage: `create_agent` across WARN / BLOCK / ALLOW sub-scenarios |
| `25_mcp_policy_llamaindex.py` | `llama-index-tools-mcp`, `llama-index-llms-anthropic` | LlamaIndex transitive MCP policy coverage: `FunctionAgent` + `McpToolSpec` across WARN / BLOCK / ALLOW sub-scenarios |
| `26_mcp_policy_template_apply.py` | control-plane API + bare `mcp` SDK | MCP policy template apply: `POST /v1/mcp-policies/{flavor}/apply_template` across the three shipped templates (`strict-baseline`, `permissive-dev`, `strict-with-common-allows`) plus resolve-API verification; no LLM key needed |
| `27_anthropic_platforms.py` | anthropic SDK | The raw view and the streaming view (`with_raw_response.create`, `with_streaming_response.create` settled by `parse()` / `await parse()` / `stream=True` iteration), `messages.parse` structured output, `beta.messages` through the raw view, and `AnthropicBedrock` / `AnthropicVertex` / `AnthropicFoundry` sections that run only with their credentials (SKIP lines otherwise); asserts every `post_call` carries real usage and `provider_metadata.platform` |
| `28_claude_agent_sdk.py` | claude-agent-sdk | A `query()` run and a two-turn `ClaudeSDKClient` connection, each with this repository's Claude Code plugin loaded; asserts each lands as one `claude_agent_sdk` session (`session_start`, `post_call` with tokens and content, a Bash `tool_call`, `session_end`) and that the plugin reported nothing for it. Then a shutdown issued from the API for a running `query()` denies its next tool call (`close_reason=directive_shutdown`), and a flavor MCP policy blocks the run's call to the reference MCP server (`policy_mcp_block`); the script removes that policy when it ends. Needs a Claude login or an API key the CLI accepts; exits 2 without the SDK |
| `29_stream_capture.py` | anthropic + openai SDKs | One small stream per streaming path: Anthropic `messages.create(stream=True)`, OpenAI `chat.completions.create(stream=True)` and `responses.create(stream=True)` (each with a forced tool), the `chat.completions.stream()` / `responses.stream()` helpers, `with_raw_response.create(stream=True)` and `with_streaming_response.create(stream=True)` on both OpenAI resources, and a Responses call to OpenAI's public DeepWiki MCP server (SKIP line when it is unavailable); asserts each lands a completed `streaming` block with real tokens and stored content holding the streamed text or tool call, every forced tool lands its `tool_call`, and the `mcp_call` names its server as `server_name` |
| `30_parse_and_litellm_routes.py` | openai SDK + `litellm` | OpenAI `beta.chat.completions.parse()`, an async `with_streaming_response.create(stream=True)` left with its stream parsed but unread, and litellm `text_completion` / `atext_completion` (OpenAI through the SDK, Anthropic on litellm's httpx route, streamed and not) and `responses` / `aresponses` (OpenAI native, streamed async, streamed and left early, and Anthropic bridged through `completion`); asserts exactly one `post_call` per call with real tokens (the unread view as an aborted stream with no chunks on the estimate), the stored `input` of a Responses call, and that the call left early stores a Responses object (`object: "response"`, `status: "in_progress"`) |
| `31_lazy_patch_signals.py` | openai, anthropic, `litellm` | `import flightdeck_sensor`, `init()` and `patch()` load none of the SDKs `patch()` covers (`sys.modules` is checked), then openai, anthropic and litellm are imported and each makes one tiny call that must land a metered `post_call` (the litellm call once); then a child process makes a call, holds the session's lock and is sent a real SIGTERM, and must end by SIGTERM with its `session_end` on the stack |
| `32_genai_pydantic_ai.py` | Pydantic AI over OpenTelemetry, no sensor | Pydantic AI's own instrumentation exports to `/ingest/v1/traces` with `flightdeck.agent_type=coding`, `flightdeck.flavor=playground-genai-pydantic-ai` and `flightdeck.capture_prompts=true`; an `assistant` agent runs `weather_agent` through its `ask_weather_agent` tool (Anthropic Claude Haiku 4.5). Asserts two `otlp` sessions, the child's `parent_session_id` and `agent_role`, exactly two `post_call`s per session with tokens on each summing to `tokens_used`, `ask_weather_agent` and `get_weather` tool calls, a 200 from `GET /v1/events/:id/content` for every call and the child's tool call, and the child's `incoming_message` |
| `33_genai_strands.py` | Strands Agents over OpenTelemetry, no sensor | The same run and checks through `StrandsTelemetry().setup_otlp_exporter()`, on Strands' OpenAI provider (`gpt-4o-mini`) in place of its Bedrock default |
| `34_genai_openai_agents.py` | OpenAI Agents SDK + `opentelemetry-instrumentation-openai-agents-v2`, no sensor | The same run and checks with `Agent.as_tool` (`gpt-4o-mini`); the SDK's own trace exporter is removed so the run reaches Flightdeck only |
| `35_genai_google_adk.py` | Google ADK over OpenTelemetry, no sensor | The same run through `AgentTool` with `maybe_set_otel_providers()`, which also exports each call's content as a log record to `/ingest/v1/logs`; OpenAI `gpt-4o-mini` through ADK's LiteLLM wrapper in place of its Gemini default. ADK records tool arguments only inside model messages, so its tool calls and child carry no content of their own and only the calls' content is checked |
| `36_openai_floor.py` | openai 1.26 to 1.77, from the OpenAI floor venv | On the client layout of openai before 1.78, which builds `chat` and `embeddings` in its constructor: sync and async chat, a sync and an async chat stream, embeddings (single + list input), and a chat call on a client built and touched before `patch()`; asserts five `post_call`s with input and output tokens (two of them streamed), two `embeddings` events with tokens, and stored content on all. SKIPs on a newer openai |
| `policy_demo_warn.py` | anthropic + flavor-scoped policy | server WARN directive emits `policy_warn` with `source=server` |
| `policy_demo_block.py` | anthropic + flavor-scoped policy | server BLOCK pre-flight emits `policy_block` + `BudgetExceededError`; `intended_model` + `token_limit` round-trip |
| `policy_demo_degrade.py` | anthropic + flavor-scoped policy | server DEGRADE swaps the model on threshold cross; `to_model` lands and post_calls show the swap |
| `policy_demo_forced_degrade.py` | anthropic + flavor-scoped policy | Decision-1 lock: exactly one `policy_degrade` event regardless of how many subsequent calls fire on the armed session |

## Prerequisites

- **Python 3.11 ≤ x < 3.14.** (The sensor supports 3.14, but crewai does not install there yet, so its demos would skip.) Run via the project venv (`./sensor/.venv/bin/python` — see root `README.md` setup), or via `make playground-*` targets which resolve through `$(PYTHON)` to the venv. `run_all.py` refuses to run on the wrong interpreter so a misconfigured local box can't silently SKIP framework-touching demos.
- A running Flightdeck stack. Default: `make dev` on `localhost:4000`. Override via `FLIGHTDECK_SERVER` / `FLIGHTDECK_TOKEN` / `FLIGHTDECK_API_URL`.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment for the chat / embeddings demos.
- Optional: `BIFROST_URL` (for `15_bifrost.py`), `node` 20+ (for `14_claude_code_plugin.py`).
- Framework packages for the examples you want to run. Each file prints a `SKIP: pip install <package>` line and exits cleanly when its dependency is missing, so you can run the suite with only the frameworks you care about installed. The full project-pinned set is installed by `pip install -e ./sensor[dev,anthropic,openai]` (see root README setup).

## OpenTelemetry GenAI frameworks

`32`–`35` run a framework with its own OpenTelemetry instrumentation and no
sensor: the framework's OTLP exporter sends the run to the receiver
(ARCHITECTURE.md, OTLP ingest > GenAI dialect), which assembles each trace
into `otlp` sessions 3 to 30 seconds after the run ends. `_genai.py` sets
the exporter's environment before the framework is imported
(`OTEL_EXPORTER_OTLP_ENDPOINT` at the stack's `/ingest`, the bearer token
in `OTEL_EXPORTER_OTLP_HEADERS`, and the `flightdeck.*` resource
attributes in `OTEL_RESOURCE_ATTRIBUTES`), drops any other `OTEL_*`
variable the shell holds, then polls the API for at most 90 seconds until
the sessions pass every check.

The frameworks are pinned at the versions the receiver's recordings were
made with, and run from two venvs of their own rather than the sensor's
(Google ADK needs an older OpenTelemetry SDK than the other three). They
are the venvs the recordings use (`tests/fixtures/otlp/README.md`); keep
them on a Linux filesystem:

```bash
uv venv --python 3.12 ~/.cache/fd-genai-capture-venv
uv pip install --python ~/.cache/fd-genai-capture-venv/bin/python \
  -r tests/otlp/requirements-genai.txt -c tests/otlp/constraints-genai.txt
uv venv --python 3.12 ~/.cache/fd-genai-capture-adk-venv
uv pip install --python ~/.cache/fd-genai-capture-adk-venv/bin/python \
  -r tests/otlp/requirements-genai-adk.txt -c tests/otlp/constraints-genai-adk.txt
```

`make playground-genai-<framework>` runs one script with its venv
(`GENAI_PYTHON` and `GENAI_ADK_PYTHON` override the paths), and
`run_all.py` runs them under `FD_GENAI_PYTHON` and `FD_GENAI_ADK_PYTHON`
(the same defaults); when a venv is missing, `run_all.py` prints
"GenAI scripts skipped: no venv at <path>" and tags the script SKIP
without running it. Run directly under an interpreter without the
framework, a script SKIPs; one whose framework is installed but does
not import (a broken venv) fails.

## OpenAI floor venv

`36_openai_floor.py` runs the sensor against openai 1.26.0, the oldest
release it supports (ARCHITECTURE.md, SDK class patching). Its
client builds its resources in the constructor, a layout the project
venv's openai never shows, so it runs from a venv of its own; openai
before 1.55.3 needs httpx below 0.28. Keep it on a Linux filesystem:

```bash
uv venv --python 3.12 ~/.cache/fd-openai-floor-venv
uv pip install --python ~/.cache/fd-openai-floor-venv/bin/python \
  -e ./sensor "openai==1.26.0" "httpx<0.28" tiktoken
```

`make playground-openai-floor` runs it (`OPENAI_FLOOR_PYTHON` overrides
the path), and `run_all.py` runs it under `FD_OPENAI_FLOOR_PYTHON` (the
same default), tagging it SKIP when the venv is missing. Any release
from 1.26 to 1.77 exercises the same layout.

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

- **litellm** has its own module-level interceptor (`12_litellm.py`). `litellm.completion`, `text_completion`, `responses` and their async forms are wrapped regardless of underlying provider, closing the previous gap where litellm's raw-httpx Anthropic route bypassed the SDK-class patches. `12_litellm.py` exercises sync and async streaming (`stream=True` returns the sensor's stream guard, iterated like litellm's own wrapper) and asserts the single count for the calls litellm serves through the OpenAI SDK. `30_parse_and_litellm_routes.py` covers `text_completion` and `responses` on each route kind with the same single-count assertion. For the full "what's caught, what's not" breakdown of the litellm interceptor, see `sensor/README.md`.
- **CrewAI 1.14+** uses the official `anthropic` / `openai` SDKs directly, so its LLM calls are intercepted through the SDK-class patches (see `06_crewai.py`). The MCP section uses `mcpadapt` directly (rather than `crewai_tools.MCPServerAdapter` which sits on top of it) so a future `crewai-tools` upgrade that silently bumps to an incompatible `mcpadapt` release breaks the demo loudly.
- **Claude Code plugin** is observation-only and doesn't itself call providers; the plugin demo (`14_claude_code_plugin.py`) pipes synthetic hook events to `observe_cli.mjs` to exercise the success and failure code paths without needing a real Claude Code session.
- **bifrost** (`15_bifrost.py`) is opt-in via `BIFROST_URL`. Skips silently when unset. Both the OpenAI-protocol and Anthropic-protocol forwarding paths are exercised so a regression in either interceptor trips the demo.

## Rule 40d in one line

> Any framework-touching change requires a real-provider playground demo alongside the mocked integration tests. Skipping the playground run is a release-gate failure.
