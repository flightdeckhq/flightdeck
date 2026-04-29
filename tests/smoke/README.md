# Smoke tests (Rule 40d)

Manual smoke tests that exercise the sensor against **real LLM providers**
through **real network**, via the local dev stack. They are the "does
this actually observe what we claim it observes?" verification that
backs Rule 40d in `CLAUDE.md`.

## What they do NOT do

- **Not run in CI.** Every test here costs money and requires valid API
  keys, so the CI pipeline only runs the cheap mocked integration
  tests under `tests/integration/`. Smoke tests are an operator-gated
  pre-PR step, not a gate machine can flip.
- **Not a substitute for unit tests.** The sensor's unit tests pin every
  classification / wrapping / emission contract against mocked
  clients. Smoke tests verify the classifiers and wrappers still hold
  when a real provider SDK's exception / streaming / chunking shape
  drifts.

## Running

All targets live in the root `Makefile` with the `smoke-*` prefix.
Per-framework smokes cover both chat (where applicable) AND any MCP
integration the framework exposes, so a single command per framework
is enough to verify the full surface:

| Target | Env vars required | Scope |
|---|---|---|
| `make smoke-anthropic` | `ANTHROPIC_API_KEY` | Chat (non-stream, sync stream, async stream), error classification |
| `make smoke-openai` | `OPENAI_API_KEY` | Chat (all three stream modes), embeddings, auth error |
| `make smoke-litellm` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Chat (multi-provider), embeddings, provider-specific error pass-through |
| `make smoke-langchain` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (+ optional `langchain-mcp-adapters`) | `ChatAnthropic.invoke`, `ChatOpenAI.invoke`, `OpenAIEmbeddings`, **MCP tool call** via the adapter |
| `make smoke-langgraph` | `ANTHROPIC_API_KEY` (+ optional `langchain-mcp-adapters`) | `StateGraph` chat invocation, **MCP `ToolNode`** driving an adapter tool |
| `make smoke-llamaindex` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (+ optional `llama-index-tools-mcp`) | `.complete(...)` for both providers, **MCP tool call** via `McpToolSpec` |
| `make smoke-crewai` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (+ optional `mcpadapt`) | Native-provider chat via `LLM(...).call(...)`, **MCP tool call** via mcpadapt + CrewAIAdapter |
| `make smoke-claude-code` | (none — Node 20+ for MCP path; `CLAUDE_CLI_AVAILABLE=1` for the lifecycle test) | Plugin lifecycle + **MCP** `mcp__server__tool` hook payload routed to `mcp_tool_call` (success + failure path) |
| `make smoke-bifrost` | `BIFROST_URL` + upstream provider key | OpenAI-compatible indirect path |
| `make smoke-mcp` | (none — uses in-tree reference server) | Direct `mcp` SDK: every patched op (`initialize`, `list_tools`, `call_tool`, `list_resources`, `read_resource`, `list_prompts`, `get_prompt`), per-event server attribution, multi-server attribution |

The MCP coverage uses a shared in-tree reference server
(`tests/smoke/fixtures/mcp_reference_server.py`) over stdio so the
schema and fingerprint contract stays aligned across frameworks —
what the bare-SDK smoke sees on the wire is what every per-framework
smoke sees, modulo each framework's adapter glue.

Each target calls its corresponding `pytest` file under this
directory. Tests that need a missing env var or optional package skip
cleanly with a clear message — running `smoke-all` without all keys
or all adapters still works; it just covers fewer frameworks.

Smoke tests expect the dev stack to be running (`make dev`) so the
sensor has a control plane to POST events to. They assert that the
event actually lands in `/v1/events` and carries the contract fields
they were supposed to produce (`event_type="embeddings"`,
`streaming.ttft_ms`, `error.error_type`, `mcp_tool_call.payload.server_name`,
etc.).

## Rule 40d in one line

> Any framework-touching change requires real-provider smoke tests
> alongside the mocked integration tests. Skipping the smoke run is
> a release-gate failure.
