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
| Log records | none | none | none, even with content mode `span_and_event` | `gen_ai.client.inference.operation.details` (event name), one per model call, always sent; content only when capture is on |
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
| Cache tokens | `gen_ai.usage.details.cache_read_input_tokens`, `gen_ai.usage.details.cache_creation_input_tokens` | `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_read_input_tokens` | none | `gen_ai.usage.cache_read.input_tokens` |
| Other | `operation.cost` (USD), `gen_ai.tool.definitions`, `server.address`, `gen_ai.request.max_tokens` | `gen_ai.server.time_to_first_token` (ms) | `server.address`, `server.port` | `gen_ai.tool.definitions` |
| Agent on the span | `gen_ai.agent.name`, `gen_ai.agent.call.id` | none | `gen_ai.agent.name=OpenAI Agent`, `gen_ai.agent.id=agent`: the instrumentation's placeholders, the same for every agent | `gen_ai.agent.name` |
| Conversation | `gen_ai.conversation.id` | none | none | `gen_ai.conversation.id` |

The Anthropic SDK span under each Pydantic AI `chat` span is the same
model call: `gen_ai.operation.name=chat`, its own `gen_ai.usage.*`
(`gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_write.input_tokens`) and the account it ran on
(`anthropic.organization.id`, `anthropic.workspace.id`, replaced by
placeholders in these files). The OpenAI SDK used here emits no spans.
Cache tokens were zero in every run, so whether `input_tokens` includes
them could not be told from these recordings.

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
| Tokens | the run's totals as `gen_ai.aggregated_usage.*` | the run's totals as `gen_ai.usage.*` (the same keys as its model calls) | none | none |
| Spans in between | none | `execute_event_loop_cycle` per model turn | `unknown` (`gen_ai.operation.name=unknown`) around each turn and around the agent | `invoke_workflow` above each agent |

## Parent and child

No framework uses span links. A whole run, sub-agents and hand-offs
included, is one trace, and every relation is the parent span id.

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Agent as a tool | the child's `invoke_agent` is a child of the parent's `execute_tool ask_weather_agent` | the same | the same, with an `unknown` span between | the same, with a nested `invoke_workflow weather_agent` (`gen_ai.workflow.nested=true`) between; the tool is named after the agent (`execute_tool weather_agent`) |
| Hand-off | not recorded (no hand-off primitive) | not recorded (`Swarm` not run) | the target's `invoke_agent` is a sibling of the triage agent's, both under the workflow root; an `agent_handoff` span carries `gen_ai.handoff.from_agent` and `gen_ai.handoff.to_agent` | the target's `invoke_agent` is a sibling of the triage agent's under `invoke_workflow`; the hand-off is the triage agent's `execute_tool transfer_to_agent` |

Spans are exported when they end, so a parent arrives after its
children: in the OpenAI Agents tool run, the model and tool spans came in
the first trace export and the `invoke_agent` span in the second.

## Message content

| | Pydantic AI | Strands Agents | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|
| Switch | `InstrumentationSettings(include_content=...)`; the OTel variable is not read | none to turn it off; `OTEL_SEMCONV_STABILITY_OPT_IN=...,gen_ai_unredacted_attributes=` replaces every content value with `[REDACTED]` | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (`true` = span and event, `false` = none) | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (`true` = event only; `SPAN_ONLY`, `SPAN_AND_EVENT` also accepted) |
| Default with nothing set | on | on | on | off (telemetry schema 2) |
| Where it lives (on) | span attributes: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` on `chat`; `pydantic_ai.all_messages`, `final_result` on `invoke_agent` | span events: `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice` (default); one `gen_ai.client.inference.operation.details` span event holding `gen_ai.input.messages` / `gen_ai.output.messages` (latest) | span attributes `gen_ai.input.messages`, `gen_ai.output.messages` on `chat` and `invoke_agent` | log records `gen_ai.client.inference.operation.details` with `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, tied to the `generate_content` span by trace and span id |
| Message shape | `[{"role", "parts": [{"type": "text", "content"}]}]` | Bedrock-style blocks (`[{"text"}]`, `toolUse`, `toolResult`) by default; the `parts` shape under latest | the `parts` shape (the first turn's tool call written as a Python repr of the SDK object) | the `parts` shape |
| What is left with capture off | message structure without text (`parts` with a `type` only); tool definitions | `[REDACTED]` in place of each value; tool descriptions and schemas | nothing of the messages or tool calls | the log records without messages; tool definitions on spans and records |

With capture off no recording holds a prompt, response, tool argument or
tool result; tool definitions and descriptions (schema, not messages)
stay in Pydantic AI, Strands and ADK.

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
it.** One normalizer keyed on `gen_ai.operation.name` can map every
recording here, provided it assembles each trace's span tree and does
not trust the fields listed under "differ".

What agrees (frameworks out of four):

- `execute_tool` spans named `execute_tool <tool>` with `gen_ai.tool.name` (4). A tool error sets the span's status to ERROR (4).
- `invoke_agent` spans named `invoke_agent <agent>` with `gen_ai.agent.name` (4).
- A model call is a span with `gen_ai.operation.name` `chat` (3) or `generate_content` (ADK), with `gen_ai.request.model` (4) and `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (4). The span's duration is the call's latency.
- One run is one trace; a sub-agent run as a tool is an `invoke_agent` span below the parent's `execute_tool` span; no span links (4). A hand-off makes the next agent's `invoke_agent` a sibling, not a child (both frameworks that have one).
- `gen_ai.tool.call.id` (3; not OpenAI Agents).
- `gen_ai.provider.name` naming the model's provider (3; Strands names itself, and OpenAI Agents' value is a configured default).
- When content is captured as messages, the `gen_ai.input.messages` / `gen_ai.output.messages` `parts` shape (Pydantic AI, OpenAI Agents, ADK, Strands under its latest conventions).
- Pydantic AI and ADK also agree on `gen_ai.agent.name` stamped on every model and tool span and on `gen_ai.conversation.id`.

What differs:

- `service.name`: only Strands sets one; ADK sends an empty resource. The source must be told from the scope name (`pydantic-ai`, `strands.telemetry.tracer`, `opentelemetry.instrumentation.openai_agents`, `gcp.vertex.agent`), not `service.name` or the schema URL.
- Duplicate model spans: the Anthropic SDK 2.x adds its own `chat` span under Pydantic AI's. Counting every `chat` span counts that call twice.
- Run totals on agent spans: Pydantic AI (`gen_ai.aggregated_usage.*`) and Strands (`gen_ai.usage.*`, the same keys as a model call). Summing usage over all spans double-counts.
- Cache tokens: three spellings (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.details.cache_read_input_tokens`, `gen_ai.usage.cache_read_input_tokens`), and OpenAI Agents sends none.
- Response model and id: Pydantic AI and OpenAI Agents only; the request model is raw in Strands, provider-prefixed in ADK, and the response model in OpenAI Agents.
- Agent on model and tool spans: absent in Strands, a constant placeholder in OpenAI Agents.
- Session ids: `gen_ai.conversation.id` in Pydantic AI (per run) and ADK (per ADK session); nothing in Strands or OpenAI Agents.
- Content: span attributes (Pydantic AI, OpenAI Agents), span events (Strands), log records (ADK); four different switches, and ADK alone is off by default.
- Error detail: `error.type` from ADK only; exception events from three.
- Framework-only spans (`execute_event_loop_cycle`, `invoke_workflow`, `unknown`, `agent_handoff`) carry no model call or tool.

How a normalizer would identify a session and an agent from these spans:

- **Session**: the trace. Every framework puts a run in one trace and only two send a conversation id, so a root session is `uuid5` of the trace id; a `gen_ai.conversation.id` on the root agent span, where present, can name the conversation in the session's context.
- **Agent**: the outermost `invoke_agent` span's `gen_ai.agent.name` is the root agent. An `invoke_agent` span with another `invoke_agent` span among its ancestors is a child session (`uuid5` of the trace id and its span id), whose parent is the nearest ancestor agent's session and whose role is its `gen_ai.agent.name`. A hand-off's sibling agents have no agent ancestor; whether they are one session that changes agent or separate sessions is a choice the recordings leave open.
- **Events**: a model-call span (`chat`, `generate_content`) with no model-call ancestor is a `post_call` on the session of its nearest agent ancestor (tokens from that span only); an `execute_tool` span is a `tool_call` (name, call id when present, duration, error from the status and exception event).
- **State**: Pydantic AI and ADK stamp the agent on every span, so their spans map one by one. Strands and OpenAI Agents do not, and a parent arrives after its children, so the normalizer must hold a trace's spans until their agent span arrives (or the trace goes quiet). Unlike the Claude Code dialect, which maps each log record on its own, this needs state per trace.

Not covered by these recordings: runs of more than one turn in one
conversation, streaming responses, non-zero cache tokens, Pydantic AI on
another provider, Strands `Swarm` hand-offs, agents in other languages,
and the OpenTelemetry Python SDK's own GenAI instrumentations for the
provider SDKs (`opentelemetry-instrumentation-openai-v2` and others),
which would add their own model-call spans as the Anthropic SDK does.
