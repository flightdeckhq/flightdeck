# Coverage

What Flightdeck sees and can act on, in full: the LLM SDK calls the sensor intercepts, what each agent framework gets from the sensor and from OpenTelemetry, the coding agents, sub-agents and MCP. The [README](../README.md#coverage) has the short version; [opentelemetry.md](opentelemetry.md) has the OpenTelemetry setup.

## LLM SDKs

| Provider  | Chat | Embeddings | Streaming | Errors |
|-----------|------|------------|-----------|--------|
| Anthropic | `messages.create`, `messages.stream`, `messages.parse`, `beta.messages.*` (sync + async) | route via litellm to Voyage | `messages.stream`, `messages.create(stream=True)` (sync + async) | 14-entry `llm_error` taxonomy |
| OpenAI    | `chat.completions.create` / `.parse` (also on `beta.chat`), `responses.create` / `.parse`, and their `with_raw_response` and `with_streaming_response` counterparts (sync + async) | `embeddings.create` (sync + async) | `create(stream=True)` on chat and Responses, the `.stream()` helpers and the streaming views (sync + async) | same |
| litellm   | `litellm.completion`, `text_completion`, `responses` and their async forms (each call counted once, also where litellm serves it through the OpenAI SDK or its own `completion`) | `litellm.embedding`, `litellm.aembedding` | `stream=True` on `completion`, `text_completion` and `responses` (sync + async) | same |

The Anthropic row applies to every `anthropic` client class — first-party, Bedrock, Vertex, Google Cloud, Foundry, AWS, Mantle — and to the raw view (`with_raw_response`) and the streaming view (`with_streaming_response`): the streaming view is metered when you call `parse()`, and `create(stream=True)` through either view is metered as the parsed stream is iterated. Every Anthropic `post_call` records the platform the client talked to in `provider_metadata.platform` (`anthropic`, `bedrock`, `bedrock-mantle`, `aws`, `vertex`, `google-cloud`, `foundry`, or the host of a gateway the SDK was pointed at).

Streamed calls report the token counts the provider sends inside the stream, whether you iterate inside a `with` block or without one (a loop left with `break` and never closed is reported at the next LLM call the sensor intercepts after the stream object is collected, or when the session ends). Streaming events expose `payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms, final_outcome, abort_reason}`; `final_outcome` is `aborted` when you leave a stream before the event that ends the response, and `completed` otherwise. A mid-stream failure, inside a `with` block or while iterating without one, emits `llm_error{error_type="stream_error"}` with the chunks and tokens delivered before the failure.

Not supported yet: Gemini through `google-genai` ([#276](https://github.com/flightdeckhq/flightdeck/issues/276)) and boto3 Bedrock Converse ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)). Claude on Bedrock or Vertex AI through the `anthropic` SDK is covered (above).

## Frameworks

Flightdeck reaches a framework two ways. The sensor meters and enforces every LLM call the framework makes through the Anthropic or OpenAI SDK or litellm, live, and for the frameworks it wraps opens a child session per sub-agent. The [OpenTelemetry receiver](opentelemetry.md#agent-frameworks-over-opentelemetry) maps the GenAI spans some frameworks export: their agents, model calls and tool calls, from any language, but observe only and once the run has ended. A framework gets a native wrap where that adds enforcement inside the run, live events or structure OpenTelemetry does not report; its model calls stay on the sensor's session, so a Stop or a budget covers the whole run.

| Framework | Sensor: LLM calls | Sensor: sub-agents | OpenTelemetry |
|---|---|---|---|
| LangChain | yes | no (`create_agent` builds Runnable and `ToolNode` nodes, which are not wrapped) | no |
| LangGraph | yes | yes, for nodes whose action is a plain callable (not Runnable, `ToolNode` or compiled-subgraph nodes) | no |
| CrewAI 1.14+ | yes on its OpenAI and Anthropic providers and the litellm fallback; not on its Gemini, Azure or Bedrock providers | yes | no |
| Claude Agent SDK (Python) | yes | its own session per run | no |
| Google ADK | yes on `LiteLlm` and its Claude / `AnthropicLlm` models; not on Gemini | planned | yes |
| OpenAI Agents SDK 0.6+ | yes (not over its Responses WebSocket transport) | yes: a child session per agent and per agent used as a tool, hand-offs and guardrail tripwires (`pip install flightdeck-sensor[openai-agents]`) | yes |
| Microsoft Agent Framework | yes on its OpenAI, Azure OpenAI, Foundry and Anthropic clients; not on `AzureAIAgentClient` | planned | no |
| LlamaIndex | yes | yes on llama-index-core 0.14+: a child session per agent of an agent workflow run, with hand-offs (its calls stay on the sensor's session) | no |
| Deep Agents | yes (LangChain) | planned: a child session per agent and per `task` sub-agent | no |
| Pydantic AI | yes on Anthropic and OpenAI models; not on `GoogleModel` or `BedrockConverseModel` | no: use OpenTelemetry | yes |
| Strands Agents | yes on its OpenAI, Anthropic and LiteLLM providers; not on Bedrock | no: use OpenTelemetry | yes |
| Agno, Haystack, smolagents | yes on the Anthropic / OpenAI SDKs or litellm | on the [roadmap](https://github.com/flightdeckhq/flightdeck/issues/278) | no |
| AutoGen, AG2 | yes on the Anthropic / OpenAI SDKs | not planned | no |
| Semantic Kernel | yes on the Anthropic / OpenAI SDKs | no | no |
| DSPy | on its litellm engine; its default engine is planned | n/a | no |

"Planned" is tracked in [#185](https://github.com/flightdeckhq/flightdeck/issues/185). Report a run one way: the sensor and an OpenTelemetry exporter on the same run count it twice. Not supported: BAML (its Rust runtime makes the calls), Letta (its server runs the agents), MetaGPT and CAMEL (they pin SDK majors long superseded or conflicting). [ARCHITECTURE.md](../ARCHITECTURE.md) ("Framework support") has what each path gives per framework.

The sensor reaches a framework's LLM calls through the clients it builds:

| Framework        | Chat | Embeddings |
|------------------|------|------------|
| LangChain        | `langchain-anthropic`, `langchain-openai` | `OpenAIEmbeddings.embed_*` |
| LangGraph        | transitive via LangChain (any graph routing through `ChatAnthropic` or `ChatOpenAI`) | inherits |
| LlamaIndex       | `llama-index-llms-anthropic`, `llama-index-llms-openai` | inherits |
| CrewAI 1.14+     | `LLM(model=...).call()` via native Anthropic / OpenAI provider classes | inherits |
| bifrost          | multi-protocol LLM gateway (point the matching SDK at bifrost's `base_url`) | multi-protocol |
| Claude Agent SDK | `query()` and `ClaudeSDKClient`: each run is its own `claude_agent_sdk` session, reported from the SDK's message stream, that the dashboard can stop and the MCP policy holds (`pip install flightdeck-sensor[claude-agent-sdk]`) | n/a |

The per-event `framework` field carries the bare name (`langchain`, `crewai`, etc.). Higher-level framework wins over SDK transport: a LangChain pipeline routing through litellm reports `framework=langchain`.

## Coding agents

Claude Code agents attach via a separate plugin distributed through this repo's marketplace:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
```

The plugin defaults to `http://localhost:4000` + `tok_dev` for the local-dev path; export `FLIGHTDECK_SERVER` (the server's address, the same value the sensor reads) + `FLIGHTDECK_TOKEN` before launching `claude` to point at a different stack. For `claude -p` scripts, CI and the GitHub Action, see [plugin/README.md](../plugin/README.md#headless-runs-ci-and-the-github-action). See [Connect your agents](../README.md#connect-your-agents) in the README for the full flow. Tool inputs and LLM call content are captured by default, so the Prompts tab is populated without extra setup.

Sessions carry `flavor=claude-code`, `agent_type=coding`, and `client_type=claude_code`. By default the plugin only observes and the Stop Agent button is hidden for these sessions; with its `enforcement` option on, a stop or a token budget denies the session's next tool call and blocks its prompts (see [plugin/README.md](../plugin/README.md#enforcement-opt-in)). Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist.

`client_type` names the client that produced a session. Flightdeck accepts nine values (`claude_code`, `flightdeck_sensor`, `claude_agent_sdk`, `codex`, `copilot`, `opencode`, `gemini_cli`, `cursor`, `otlp`), each with a display label, an expected agent type, a billing-mode default and whether the client can act on directives; see "Client type registry" in [ARCHITECTURE.md](../ARCHITECTURE.md). The plugin sends `claude_code`, the sensor sends `flightdeck_sensor`, and the sensor's Claude Agent SDK interceptor sends `claude_agent_sdk`. A session reported over OpenTelemetry takes the type of the tool that produced it, so Claude Code's own telemetry also lands as `claude_code` (see [Claude Code over OpenTelemetry](opentelemetry.md#claude-code-over-opentelemetry)), and the agent frameworks the receiver maps, which no other value names, land as `otlp` (see [Agent frameworks over OpenTelemetry](opentelemetry.md#agent-frameworks-over-opentelemetry)). The other values are reserved for the integrations on the [Roadmap](../README.md#roadmap).

## Sub-agent observability

Multi-agent frameworks render as a tree: a parent session for the orchestrator and a separate child session per sub-agent execution, linked by `parent_session_id` and labeled with `agent_role`.

| Mechanism | parent source | role source |
|---|---|---|
| Claude Code Task subagent | hook payload `session_id` | hook payload `agent_type` (e.g. `"Explore"`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute |
| LangGraph agent-bearing node whose action is a plain callable | parent runner's session | node name |

Direct SDK calls outside a multi-agent framework emit root sessions; identity is unchanged. When `capture_prompts=True`, each child session carries the parent's input as `incoming_message` and the child's response back as `outgoing_message`, visible in the run drawer's Sub-agents tab.

## MCP

Flightdeck observes MCP traffic as a first-class event surface alongside chat and embeddings. Six event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`) emit per operation. The sensor patches `mcp.client.session.ClientSession` directly, so every framework that mediates MCP through the official SDK is observed: LangChain via `langchain-mcp-adapters`, LangGraph via the same, LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`, plus the raw `mcp` SDK.

The sensor supports the official `mcp` SDK 1.x (from 1.28) and 2.x; on 2.x it also covers the high-level `mcp.Client`.

The Claude Code plugin's MCP coverage is limited to tool calls; resource reads and prompt fetches are below the plugin hook layer.

## Not planned

Not planned: Antigravity CLI (its hooks expose no telemetry or token data yet), Roo Code (shut down), Continue (repository read-only) and sub-agent structure for AutoGen and AG2 (their runs are labelled `autogen` and `ag2` and their LLM calls are metered; AutoGen's successor, Microsoft Agent Framework, is on the roadmap), sub-agent structure in the sensor for Pydantic AI and Strands Agents (their OpenTelemetry export reports it, and the sensor meters their calls), and BAML, Letta, MetaGPT and CAMEL (no in-process seam, or SDK pins too old for current providers).
