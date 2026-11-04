# GenAI semantic-convention spans: four frameworks compared

What four agent frameworks export over OTLP when their OpenTelemetry
instrumentation is on, read from the recordings in this directory
(README.md lists the scenarios). The question it answers: can one
generic normalizer turn OpenTelemetry GenAI spans (`gen_ai.operation.name`
`chat`, `execute_tool`, `invoke_agent`) into `post_call` and `tool_call`
events and child sessions, for at least two frameworks? The verdict is at
the end.

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Package | `pydantic-ai-slim` 2.64.0 | `strands-agents` 1.63.0 | `openai-agents` 0.24.0 | `google-adk` 2.13.0 |
| Instrumentation | built in: `Agent.instrument_all()`, data format version 5 (default) | built in: `StrandsTelemetry()` | `opentelemetry-instrumentation-openai-agents-v2` 0.1.0 (OpenTelemetry contrib; the SDK's own tracing goes only to OpenAI's backend) | built in: `maybe_set_otel_providers()`, telemetry schema 2 (default) |
| OTel SDK | 1.45.2 | 1.45.2 | 1.45.2 | 1.44.0 (ADK allows no newer) |
| Model | `claude-haiku-4-5` (Anthropic SDK 2.3.0) | `gpt-4o-mini` (OpenAI SDK 3.42.1) | `gpt-4o-mini` (Responses API) | `gpt-4o-mini` through LiteLLM 1.106.6 |
| Encodings recorded | protobuf, JSON | protobuf, JSON | protobuf, JSON | protobuf |

## Resource and scope

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| `service.name` | none of its own: the SDK default `unknown_service:python` | `strands-agents`, with `service.version` 1.63.0 (`OTEL_SERVICE_NAME` overrides) | none of its own: `unknown_service:python` | none: the resource is empty (not even `telemetry.sdk.*`) unless `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` set it |
| Scope (name, version) | `pydantic-ai` 2.64.0 | `strands.telemetry.tracer`, no version | `opentelemetry.instrumentation.openai_agents`, no version on spans | `gcp.vertex.agent` 2.13.0 |
| Schema URL | none | none | `https://opentelemetry.io/schemas/1.28.0` | `https://opentelemetry.io/schemas/1.36.0` |
| Other scopes in the trace | `com.anthropic.sdk.python` 2.3.0: the Anthropic SDK's own `anthropic.messages.create` span under every Pydantic AI `chat` span | none | none | none |
| Log records | none | none | none, even with content mode `span_and_event` | `gen_ai.client.inference.operation.details` (event name), one per model call, always sent, repeating the model span's `gen_ai.usage.*`; content only when capture is on |
| Metrics | `gen_ai.client.token.usage`, `operation.cost` | `strands.*` only (cycle, token, tool counters) | `gen_ai.client.operation.duration`, `gen_ai.client.token.usage` | `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_agent.*`, `gen_ai.invoke_workflow.duration` |

The schema URLs say nothing reliable: OpenAI Agents declares 1.28.0 and
ADK 1.36.0, while both write attributes from later conventions
(`gen_ai.provider.name`, `gen_ai.input.messages`).

## Model call spans

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Span name | `chat claude-haiku-4-5` | `chat` (no model) | `chat gpt-4o-mini-2024-07-18` | `generate_content openai/gpt-4o-mini` |
| Span kind | CLIENT | INTERNAL | CLIENT | INTERNAL |
| `gen_ai.operation.name` | `chat` | `chat` | `chat` | `generate_content` |
| Provider | `gen_ai.provider.name=anthropic` and `gen_ai.system=anthropic` | the framework, not the provider: `gen_ai.system=strands-agents` (default conventions) or `gen_ai.provider.name=strands-agents` (latest) | `gen_ai.provider.name=openai`, `gen_ai.system=openai`: the instrumentation's default, not read from the model (`OTEL_INSTRUMENTATION_OPENAI_AGENTS_SYSTEM` overrides it) | `gen_ai.provider.name=openai` |
| Request model | `gen_ai.request.model=claude-haiku-4-5` | `gen_ai.request.model=gpt-4o-mini` | `gen_ai.request.model` holds the response model (`gpt-4o-mini-2024-07-18`) | `gen_ai.request.model=openai/gpt-4o-mini` (LiteLLM's provider prefix kept) |
| Response model, id | `gen_ai.response.model`, `gen_ai.response.id` (`msg_...`), `gen_ai.response.finish_reasons` | none | `gen_ai.response.model`, `gen_ai.response.id` (`resp_...`) | `gen_ai.response.finish_reasons` only |
| Tokens | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, also `prompt_tokens`, `completion_tokens`, `total_tokens` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| Cache read tokens | `gen_ai.usage.details.cache_read_input_tokens` always; `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.details.cache_read_tokens` too when non-zero | `gen_ai.usage.cache_read.input_tokens`, and `gen_ai.usage.cache_read_input_tokens` under the default conventions only | none, even when the provider reports them | `gen_ai.usage.cache_read.input_tokens` |
| Cache creation tokens | `gen_ai.usage.details.cache_creation_input_tokens` always; `gen_ai.usage.cache_creation.input_tokens` and `gen_ai.usage.details.cache_write_tokens` too when non-zero | none (only an agent's totals carry them) | none | none (OpenAI reports none) |
| Do the input tokens include cached ones? | yes (Cached input tokens, below) | yes | yes | yes |
| Other | `operation.cost` (USD), `gen_ai.tool.definitions`, `server.address`, `gen_ai.request.max_tokens` | `gen_ai.server.time_to_first_token` (ms) | `server.address`, `server.port` | `gen_ai.tool.definitions` |
| Agent on the span | `gen_ai.agent.name`, `gen_ai.agent.call.id` | none | `gen_ai.agent.name=OpenAI Agent`, `gen_ai.agent.id=agent`: the instrumentation's placeholders, the same for every agent | `gen_ai.agent.name` |
| Conversation | `gen_ai.conversation.id` | none | none | `gen_ai.conversation.id` |

The Anthropic SDK span under each Pydantic AI `chat` span is the same
model call: `gen_ai.operation.name=chat`, its own `gen_ai.usage.*`
(`gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_write.input_tokens`) and the account it ran on
(`anthropic.organization.id`, `anthropic.workspace.id`, replaced by
placeholders in these files), but no agent and no conversation: only its
parent `chat` span says whose call it was. The OpenAI SDK used here
emits no spans.

## Cached input tokens

The `cache-*` scenarios make two calls with the same long instructions,
and their manifests hold what the provider answered each call
(`provider_calls`). In all four frameworks `gen_ai.usage.input_tokens`
**includes** the cached tokens: it is the whole prompt, cached or not,
and the cached share is reported beside it.

| Framework, scenario | Provider's usage (call 1; call 2) | Span `gen_ai.usage.input_tokens` | Arithmetic |
|---|---|---|---|
| Pydantic AI, `cache-no-content-protobuf` (Anthropic) | `input_tokens` 12, `cache_creation_input_tokens` 6670, `cache_read_input_tokens` 0; then 12, 0, 6670 | 6682; 6682 | 12 + 6670 + 0 = 6682 and 12 + 0 + 6670 = 6682: Anthropic's `input_tokens` counts only the uncached tokens, and Pydantic AI adds both cache counts to it. The Anthropic SDK's own span reports the same 6682. |
| Strands, `cache-protobuf` (OpenAI chat completions) | `prompt_tokens` 1933, `cached_tokens` 0; then 1933, 1792 | 1933; 1933 | OpenAI's `prompt_tokens` already includes `cached_tokens`; Strands copies it, and `gen_ai.usage.cache_read.input_tokens` is 0 then 1792. |
| Google ADK, `cache-no-content-protobuf` (OpenAI through LiteLLM) | `prompt_tokens` 1934, `cached_tokens` 1024; then 1934, 1792 | 1934; 1934 | The same: `prompt_tokens` copied, `gen_ai.usage.cache_read.input_tokens` 1024 then 1792. The first call was already partly cached, from the Strands run's identical instructions moments before. |
| OpenAI Agents, `cache-no-content-protobuf` (OpenAI Responses API) | `input_tokens` 1921, `cached_tokens` 1792; then 1921, 1792 | 1921; 1921 | The Responses API's `input_tokens` includes `cached_tokens`, and the instrumentation copies it, but it records no cache attribute, so the cached share is lost. Both calls were hits: diagnostic runs moments before had warmed the cache. The Responses API served neither of two back-to-back calls from its cache in four tries until the request carried a `prompt_cache_key`. |

Flightdeck's `tokens_input` already counts cached tokens in (for Claude
Code it is `input_tokens` + `cache_read_tokens` +
`cache_creation_tokens`), so `gen_ai.usage.input_tokens` maps to it
unchanged, and the cache attributes map to `tokens_cache_read` and
`tokens_cache_creation`. A normalizer must not add the cache counts to
`gen_ai.usage.input_tokens` again, which a reading of Anthropic's own
`input_tokens` would suggest.

Anthropic splits cache writes by retention, and only the nested
Anthropic SDK span carries the split
(`anthropic.usage.cache_creation.ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`). Pydantic AI's own span has the total
alone, so `tokens_cache_creation_1h` cannot come from the outermost
model span, which is the one tokens are taken from. Every write in these
recordings was a 5-minute one.

## Tool spans

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Span name | `execute_tool get_weather` | `execute_tool get_weather` | `execute_tool get_weather` | `execute_tool get_weather` |
| Span kind | INTERNAL | INTERNAL | INTERNAL | INTERNAL |
| `gen_ai.operation.name` | `execute_tool` | `execute_tool` | `execute_tool` | `execute_tool` |
| Tool name | `gen_ai.tool.name` | `gen_ai.tool.name` | `gen_ai.tool.name` | `gen_ai.tool.name` |
| Call id | `gen_ai.tool.call.id` (`toolu_...`) | `gen_ai.tool.call.id` (`call_...`) | none | `gen_ai.tool.call.id` (`call_...`); `<not specified>` on the tool that raised |
| Other | | `gen_ai.tool.description`, `gen_ai.tool.json_schema`, `gen_ai.tool.status` (`success`, `error`) | `gen_ai.tool.type=function` | `gen_ai.tool.type` (`FunctionTool`, `AgentTool`, `TransferToAgentTool`), `gen_ai.tool.description` |
| Agent on the span | `gen_ai.agent.name` | none | `OpenAI Agent` placeholder | `gen_ai.agent.name` |
| Conversation | `gen_ai.conversation.id` | none | none | none (on none of ADK's 7 tool spans) |
| Arguments and result (capture on) | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` attributes | default conventions: span events `gen_ai.tool.message`, `gen_ai.choice`; latest: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` attributes | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` attributes | not recorded with `=true` (event-only mode); the call and its result appear only inside the next model call's messages in the log record |

## Agent spans

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Span name | `invoke_agent weather_agent` | `invoke_agent weather_agent` | `invoke_agent weather_agent`, under an `Agent workflow` root (SERVER, `gen_ai.operation.name=invoke_agent`, no agent name) | `invoke_agent weather_agent`, under an `invoke_workflow weather_agent` root (`gen_ai.workflow.name`) |
| Span kind | INTERNAL | INTERNAL | CLIENT | INTERNAL |
| `gen_ai.operation.name` | `invoke_agent` | `invoke_agent` | `invoke_agent` | `invoke_agent` |
| Agent name | `gen_ai.agent.name` | `gen_ai.agent.name` | `gen_ai.agent.name` | `gen_ai.agent.name` |
| Agent id | `gen_ai.agent.call.id` (one per run) | none | `gen_ai.agent.id=agent` (constant) | none |
| Conversation | `gen_ai.conversation.id` (a new id per agent run, the delegated agent's run included) | none | none | `gen_ai.conversation.id`: the ADK session id, shared by a hand-off's agents; an agent called as a tool gets a session of its own |
| Tokens | the agent's own model calls, not its sub-agents', as `gen_ai.aggregated_usage.*` (`assistant`: 1430 input tokens, 2798 with the delegated agent's calls) | the agent's own model calls, not its sub-agents', as `gen_ai.usage.*`, the same keys as a model call (`assistant`: 219 input tokens, 384 with the sub-agent's); its cache creation tokens appear only here | none | none |
| Spans in between | none | `execute_event_loop_cycle` per model turn | `unknown` (`gen_ai.operation.name=unknown`) around each turn and around the agent | `invoke_workflow` at the root of a run, and a nested one (`gen_ai.workflow.nested=true`) above an agent called as a tool; a hand-off's target sits directly under the triage agent's workflow |

OpenAI Agents' `Agent workflow` root is an `invoke_agent` span with no
agent name, in all six of its recordings, and every agent of the run
sits below it. An agent span is therefore an `invoke_agent` span that
carries `gen_ai.agent.name`, not any `invoke_agent` span.

## Parent and child

No framework uses span links. A whole run, sub-agents and hand-offs
included, is one trace, and every relation is the parent span id.

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Agent as a tool | the child's `invoke_agent` is a child of the parent's `execute_tool ask_weather_agent` | the same | the same, with an `unknown` span between | the same, with a nested `invoke_workflow weather_agent` (`gen_ai.workflow.nested=true`) between; the tool is named after the agent (`execute_tool weather_agent`) |
| Hand-off | not recorded (no hand-off primitive) | not recorded (`Swarm` not run) | the target's `invoke_agent` is a sibling of the triage agent's, both under the workflow root; an `agent_handoff` span carries `gen_ai.handoff.from_agent` and `gen_ai.handoff.to_agent` | the target's `invoke_agent` is a sibling of the triage agent's under `invoke_workflow`; the hand-off is the triage agent's `execute_tool transfer_to_agent` |

Spans are exported when they end, so a parent arrives after its
children, and in a later export when the exporter sends a batch in
between. In `openai-agents-0.24.0/subagent-protobuf`, `001-traces.pb`
holds 4 spans (the parent's first model call and the sub-agent's first
turn: its model call, its `get_weather` call and the span around them)
and `002-traces.pb` the other 11, both `invoke_agent` spans, the
`execute_tool ask_weather_agent` span that makes the sub-agent a child
and the root among them. Every other OpenAI Agents recording, the tool
runs included, came in a single trace export.

## Message content

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Switch | `InstrumentationSettings(include_content=...)`; the OTel variable is not read | none to turn it off; `OTEL_SEMCONV_STABILITY_OPT_IN=...,gen_ai_unredacted_attributes=` replaces every content value with `[REDACTED]` | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (`true` = span and event, `false` = none) | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (`true` = event only; `SPAN_ONLY`, `SPAN_AND_EVENT` also accepted); the recording with capture off also sets ADK's own `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`, so it does not isolate the OTel switch |
| Default with nothing set | on | on | on | off (telemetry schema 2) |
| Where it lives (on) | span attributes: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` on `chat`; `pydantic_ai.all_messages`, `final_result` on `invoke_agent` | span events: `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice` (default); under latest, one `gen_ai.client.inference.operation.details` span event per attribute: three on `chat` (`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`), two on `execute_tool` and on `invoke_agent` (input, output), and up to two `gen_ai.input.messages` events on an `execute_event_loop_cycle` span | span attributes `gen_ai.input.messages`, `gen_ai.output.messages` on `chat` and `invoke_agent` | log records `gen_ai.client.inference.operation.details` with `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, tied to the `generate_content` span by trace and span id; 6 of the 12 records arrived in an earlier export than their span |
| Message shape | `[{"role", "parts": [{"type": "text", "content"}]}]` | Bedrock-style blocks (`[{"text"}]`, `toolUse`, `toolResult`) by default; the `parts` shape under latest | the `parts` shape (the first turn's tool call written as a Python repr of the SDK object) | the `parts` shape |
| What is left with capture off | message structure without text (`parts` with a `type` only); tool definitions | `[REDACTED]` in place of each value; tool descriptions and schemas | nothing of the messages or tool calls | the log records without messages; tool definitions on spans and records |

With capture off no recording holds a prompt, response, tool argument or
tool result; tool definitions and descriptions (schema, not messages)
stay in Pydantic AI, Strands and ADK. A normalizer reading Strands'
latest-convention content must merge a span's same-named events, and
one reading ADK's must take the content from the log record and the
tokens from the span, since the record repeats them.

## A failed model call

The `model-error-*` scenarios ask for a model the provider does not
have, and the provider answers 404 (Anthropic `not_found_error`, OpenAI
`invalid_request_error` / `model_not_found`). No framework retries it,
and every run ends with the framework raising.

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Model-call span | `chat claude-fd-does-not-exist`, ERROR | `chat`, ERROR | `chat` (no model in the name), ERROR | `generate_content openai/gpt-fd-does-not-exist`, ERROR |
| Status message | `ModelNotFoundError: status_code: 404, ...` with the provider's error body (and its request id) | the provider's message (`Error code: 404 - The model ... does not exist ...`) | `Error getting response: {...}` with the provider's message | `NotFoundError: litellm.NotFoundError: OpenAIException - ...` |
| `error.type` | none (the Anthropic SDK span under it has `error.type=not_found_error` and `http.response.status_code=404`) | none | none | none on the span; the three duration metrics (`gen_ai.client.operation.duration`, `gen_ai.invoke_agent.duration`, `gen_ai.invoke_workflow.duration`) carry `error.type=NotFoundError` |
| Exception event | `pydantic_ai.exceptions.ModelNotFoundError` | `openai.NotFoundError` | none | `litellm.exceptions.NotFoundError` |
| Request model | `gen_ai.request.model` | `gen_ai.request.model` | none | `gen_ai.request.model` |
| Usage | none: no `gen_ai.usage.*` on any span | none | none | none on the span or on its log record, which still comes (with the input messages, content being on) |
| Agent and root | `invoke_agent` ERROR with the exception | `invoke_agent` and the cycle span ERROR with the exception | `invoke_agent` ERROR, but the `Agent workflow` root OK | `invoke_agent` and `invoke_workflow` ERROR with the exception |

A failed model call is therefore a model-call span with ERROR status,
no usage and, in three frameworks, an exception event naming the error.
It maps to `llm_error`. A normalizer can classify the error from the
exception type or from the status message only: no framework puts the
HTTP status or the provider's error type on its own span. Pydantic AI's
Anthropic SDK span is the exception, carrying both. Whatever the error
text and status message hold is content, so it belongs behind the
capture gate.

## Errors (a tool that raises `ValueError`)

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Run | ends; the `invoke_agent` span is ERROR with an `exception` event | continues; the model is told; `invoke_agent` OK | continues; the model gets "An error occurred while running the tool"; `invoke_agent` OK | ends; `invoke_agent` and `invoke_workflow` ERROR with `exception` events |
| Tool span status | ERROR (no message) | ERROR, message `order 42 not found` | ERROR, message `Error running tool (non-fatal): {...}` | ERROR, message `ValueError: order 42 not found` |
| `error.type` | none | none | none | `ValueError` |
| Exception event | `exception` (`exception.type=ValueError`) | `exception` | none | `exception` (twice) |
| Other | | `gen_ai.tool.status=error` | `gen_ai.tool.call.result` is the error text sent to the model | `gen_ai.tool.call.id=<not specified>` |

## Verdict

**The bar is met: all four frameworks agree on the core that a generic
normalizer needs, and Pydantic AI and Google ADK agree closely beyond
it.** One normalizer can map every recording here if it keys on
`gen_ai.operation.name`, takes an agent span to be an `invoke_agent`
span that names its agent, holds each trace until it is complete, and
does not trust the fields listed under "differ".

What agrees (frameworks out of four):

- `execute_tool` spans named `execute_tool <tool>` with `gen_ai.tool.name` (4). A tool error sets the span's status to ERROR (4).
- `invoke_agent` spans named `invoke_agent <agent>` with `gen_ai.agent.name` (4). OpenAI Agents also gives its nameless `Agent workflow` root `gen_ai.operation.name=invoke_agent`, so it is the name, not the operation alone, that makes an agent span.
- A model call is a span with `gen_ai.operation.name` `chat` (3) or `generate_content` (ADK), with `gen_ai.request.model` (4) and `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (4). The span's duration is the call's latency.
- One run is one trace; an agent called as a tool is an `invoke_agent` span below the parent's `execute_tool` span; no span links (4). A hand-off makes the next agent's `invoke_agent` a sibling, not a child (both frameworks that have one).
- Spans are exported when they end, so a parent never arrives before its children (4).
- `gen_ai.tool.call.id` (3; not OpenAI Agents).
- `gen_ai.provider.name` naming the model's provider (3; Strands names itself, and OpenAI Agents' value is a configured default).
- When content is captured as messages, the `gen_ai.input.messages` / `gen_ai.output.messages` `parts` shape (Pydantic AI, OpenAI Agents, ADK, Strands under its latest conventions).
- Pydantic AI and ADK also stamp `gen_ai.agent.name` on every model and tool span of their own, and `gen_ai.conversation.id` on their model and agent spans; Pydantic AI's tool spans carry it too, ADK's carry none.

What differs:

- `service.name`: only Strands sets one; ADK sends an empty resource. The source must be told from the scope name (`pydantic-ai`, `strands.telemetry.tracer`, `opentelemetry.instrumentation.openai_agents`, `gcp.vertex.agent`), not `service.name` or the schema URL.
- The root: OpenAI Agents' `Agent workflow` span is `invoke_agent` with no agent name, above every agent of the run; ADK's root is `invoke_workflow`; Pydantic AI's and Strands' is the root agent's own span.
- Duplicate model spans: the Anthropic SDK 2.x adds its own `chat` span, which names no agent, under Pydantic AI's. Counting every `chat` span counts that call twice.
- Totals on agent spans: Pydantic AI (`gen_ai.aggregated_usage.*`) and Strands (`gen_ai.usage.*`, the same keys as a model call) total the agent's own model calls, not its sub-agents'. Summing usage over all spans double-counts.
- ADK's log records repeat their model span's `gen_ai.usage.*`: a normalizer that maps log records as well as spans, as the Claude Code dialect maps log records, counts each of ADK's calls twice.
- Cache tokens: `gen_ai.usage.input_tokens` includes cached tokens in all four (Cached input tokens). Cache reads come in `gen_ai.usage.cache_read.input_tokens` (Strands, ADK, and Pydantic AI when non-zero), `gen_ai.usage.details.cache_read_input_tokens` (Pydantic AI, always) and `gen_ai.usage.cache_read_input_tokens` (Strands under its default conventions only). Cache creation is on the model span in Pydantic AI only (`gen_ai.usage.cache_creation.input_tokens` when non-zero, `gen_ai.usage.details.cache_creation_input_tokens` always). Strands has it only in an agent's totals, ADK and OpenAI Agents send none, and OpenAI Agents drops even the cache reads OpenAI reports. In these recordings `estimated_cost` could price cache writes per call only for Pydantic AI.
- A failed model call: a model-call span with ERROR status and no usage (4), an exception event (3, not OpenAI Agents), and no `error.type` or HTTP status on the framework's own span (4). OpenAI Agents leaves its root span OK.
- Response model and id: Pydantic AI and OpenAI Agents only; the request model is raw in Strands, provider-prefixed in ADK, and the response model in OpenAI Agents.
- Agent on model and tool spans: absent in Strands, a constant placeholder in OpenAI Agents.
- Session ids: `gen_ai.conversation.id` in Pydantic AI (per run) and ADK (per ADK session, not on tool spans); nothing in Strands or OpenAI Agents.
- Content: span attributes (Pydantic AI, OpenAI Agents); span events (Strands, one event per attribute under its latest conventions, to be merged); log records (ADK, which can arrive before their span). Four different switches, and ADK alone is off by default.
- Error detail: `error.type` from ADK only; exception events from three.
- Framework-only spans (`execute_event_loop_cycle`, `invoke_workflow`, `unknown`, `agent_handoff`, and OpenAI Agents' nameless `Agent workflow` root) carry no model call or tool.

How a normalizer would identify a session and an agent from these spans:

- **Agent span**: an `invoke_agent` span that carries `gen_ai.agent.name`. OpenAI Agents' `Agent workflow` root, `invoke_agent` with no name, is not one.
- **Session**: the trace. Every framework puts a run in one trace and only two send a conversation id, so a root session is `uuid5` of the trace id; a `gen_ai.conversation.id` on the root agent span, where present, can name the conversation in the session's context.
- **Agent**: an agent span with no agent span among its ancestors is a root agent. A run has one, except that a hand-off's agents (OpenAI Agents, ADK) are all roots: siblings under the run's root span (in ADK, sharing one conversation id). Whether a hand-off is one session that changes agent, or a session per agent, is a choice the recordings leave open. An agent span with an agent span among its ancestors is a child session (`uuid5` of the trace id and its span id), whose parent is the nearest ancestor agent's session and whose role is its `gen_ai.agent.name`.
- **Events**: a model-call span (`chat`, `generate_content`) with no model-call ancestor is a `post_call` on the session of its nearest agent ancestor. Its tokens come from that span only, never from an agent span or a log record. An `execute_tool` span is a `tool_call`: name, call id when present, duration, and the error from the status and exception event. ADK's content comes from the log record that carries the model span's span id.
- **State**: all four need state per trace, held until the trace's root span arrives or the trace goes quiet:
  - Whether an agent is a root or a child depends on its ancestors, which end, and so arrive, after it. In `openai-agents-0.24.0/subagent-protobuf` the sub-agent's first model and tool spans came in one export, and both agent spans and the `execute_tool` span between them in the next.
  - Stamping the agent on every span (Pydantic AI, ADK) names the agent but not its place. ADK's tool spans carry no conversation id, ADK's log records arrived before their span in 6 of 12 cases, and the Anthropic SDK's spans in Pydantic AI traces name no agent.
  - Unlike the Claude Code dialect, which maps each log record on its own, the GenAI normalizer needs this state.

Not covered by these recordings: runs of more than one turn in one
conversation, streaming responses, cache writes on a provider other
than Anthropic, provider errors other than an unknown model (rate limits,
overload, a request the model rejects), Pydantic AI on another provider, Strands `Swarm` hand-offs, agents in other languages,
and the OpenTelemetry Python SDK's own GenAI instrumentations for the
provider SDKs (`opentelemetry-instrumentation-openai-v2` and others),
which would add their own model-call spans as the Anthropic SDK does.
