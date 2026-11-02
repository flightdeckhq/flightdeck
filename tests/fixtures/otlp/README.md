# OTLP fixtures

OTLP/HTTP requests a real agent exported, filtered and scrubbed, one
directory per agent version and scenario. Each scenario directory holds
the requests in the order they arrived (`NNN-<signal>.json` or `.pb`)
and a `manifest.json` that names each file's route, content type and the
encoding it was sent in (protobuf requests are stored uncompressed).

Both recorders run the agent with its exporters pointed at a local
recorder on the loopback interface (`tests/otlp/recorder.py`), never at a
Flightdeck stack, and write a scenario only when it passes
`tests/otlp/fixture_checks.py`. They make real model calls, so they are
run by hand, never in CI.

## Claude Code

`claude-code-<version>/` is recorded by `tests/otlp/record_claude_code.py`
from `claude -p` runs with Claude Code's telemetry pointed at the
recorder:

| Scenario | What it exercises |
|---|---|
| `bash-json-prompts` | Bash calls, one failing, over `http/json`, prompts and responses logged |
| `bash-protobuf-gzip` | the same over `http/protobuf` with gzip, prompts not logged |
| `subagent-json` | a general-purpose sub-agent that runs a Bash call |
| `subagent-resume-json` | a sub-agent that completes, is resumed with `SendMessage` under the same `agent_id`, and completes again: one `subagent_completed` per run |
| `subagent-wake-json` | a sub-agent that stops with its own background Bash task running and is woken when it finishes: no `subagent_completed` at the stop, one at the end |
| `mcp-json` | an MCP tool call to the in-tree reference server |
| `api-error-json` | a request for a model that does not exist |

Re-record when a new Claude Code version changes its telemetry.

## Agent frameworks (GenAI semantic conventions)

`pydantic-ai-<version>/`, `strands-agents-<version>/`,
`openai-agents-<version>/` and `google-adk-<version>/` are recorded by
`tests/otlp/record_genai.py`, which runs one small program per framework
(`tests/otlp/genai/run_*.py`) with OpenTelemetry's traces, logs and
metrics exported to the recorder. Each framework's own instrumentation
is used, set up the way it documents; the OpenAI Agents SDK has none of
its own, so OpenTelemetry's `opentelemetry-instrumentation-openai-agents-v2`
traces it. Pydantic AI calls Anthropic's `claude-haiku-4-5`, the others
OpenAI's `gpt-4o-mini` (Google ADK through LiteLLM). The harness has its
own pinned dependency lists, `tests/otlp/requirements-genai.txt` and,
for Google ADK, which needs an older OpenTelemetry SDK,
`tests/otlp/requirements-genai-adk.txt`; each goes in a venv of its own.
Each `manifest.json` adds the framework, instrumentation, model, the
environment switches the run set, how the run ended, and the package
versions it ran with.

| Scenario | What it exercises |
|---|---|
| `tool-protobuf` | one agent run: a model call that asks for `get_weather`, the tool call, a final model call; content capture on |
| `tool-json` | the same over `http/json` (Pydantic AI, OpenAI Agents) |
| `tool-latest-json` | Strands under `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, over `http/json` |
| `tool-no-content-protobuf` | the tool run with content capture off by the framework's switch (Pydantic AI `include_content=False`; `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` for OpenAI Agents and Google ADK) |
| `tool-redacted-protobuf` | Strands, which has no off switch, with every content attribute redacted (`gen_ai_unredacted_attributes=`) |
| `tool-error-protobuf` | a tool that raises `ValueError` (it ends the run in Pydantic AI and Google ADK; Strands and the OpenAI Agents SDK hand the error to the model) |
| `subagent-protobuf` | an agent whose tool runs a second agent (agent as a tool), which calls `get_weather` |
| `handoff-protobuf` | a triage agent that hands the conversation to a second agent (OpenAI Agents `handoffs`, Google ADK `transfer_to_agent`) |

Google ADK is recorded over `http/protobuf` only: OpenTelemetry's Python
OTLP/HTTP JSON exporter needs an SDK newer than the one ADK allows.
`GENAI_COMPARISON.md` compares what the four frameworks send, span kind
by span kind, and whether one normalizer can map them.

## Scrubbing

Identity and account attributes hold placeholders: Claude Code's
`user.email`, `user.account_uuid`, `user.account_id`, `user.id` and
`organization.id`, `host.name`, and the `anthropic.organization.id` and
`anthropic.workspace.id` the Anthropic Python SDK records on its own
spans. Records that describe the recording machine (managed settings,
bundled plugins, the user's claude.ai connectors) are dropped, and
machine paths are replaced by `/home/user` stand-ins. A recorder refuses
to write a scenario that holds the value of any credential in its
environment. `tests/integration/test_otlp_fixtures.py` runs the same
checks over the committed files (no other email address, home directory
or machine path, no string shaped like a provider API key or Flightdeck
token) and checks that each file decodes as the OTLP export its manifest
names.
