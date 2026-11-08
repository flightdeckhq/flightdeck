<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="dashboard/public/assets/flightdeck-lockup-dark.svg">
    <img alt="Flightdeck" src="dashboard/public/assets/flightdeck-lockup-light.svg" width="480">
  </picture>
</div>

---

Flightdeck is a self-hosted observability and control plane for production and coding agents.

Every LLM call, MCP event, and tool call your agents make streams to the dashboard as it happens, surfaced as a per-agent timeline and as a live fleet-wide feed.

Set token budgets, MCP allow/block rules, and live directives on your production agents.

Coding agents attach via the Claude Code plugin in this repo.

Production agents add the `flightdeck-sensor` Python package to their entrypoint - `init()` + `patch()`, no other code changes.

Built and maintained by [Omri Arnon](https://github.com/pykul) ([LinkedIn](https://www.linkedin.com/in/omriarnon/)).

![Live fleet view: every agent on a shared timeline streaming events as agents run.](assets/fleet-demo.gif)

![Agents dashboard: every agent in your fleet with token, latency, error, and cost trends, plus a per-agent swimlane and feed.](assets/agents-table-demo.gif)

![Events search: filter every LLM call, tool use, and policy event by agent, type, framework, and MCP server.](assets/events-table-demo.gif)

---

## Quickstart

Prerequisites: Docker Engine 28+ with Compose v2. Python 3.11 to 3.14 for the sensor path; Claude Code for the plugin path.

Start the stack:

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Dashboard at http://localhost:4000. The dev stack seeds a test token `tok_dev` automatically.

### Coding agents (Claude Code)

Launch Claude Code, then install the plugin from this repo's marketplace inside the REPL:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
/reload-plugins
```

That's it for a local stack — the plugin defaults to `http://localhost:4000` with the dev token `tok_dev`, so the Claude Code session shows up in the fleet view within seconds. Tool inputs and LLM call content are captured by default — unlike the Python sensor, which keeps `capture_prompts=False` until you opt in — so the Prompts tab is populated without extra setup.

To point the plugin at a different stack (production, a remote dev server, etc.) export the env vars in the shell *before* launching `claude` — the plugin reads them at every `SessionStart`:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com"
export FLIGHTDECK_TOKEN="ftd_..."
claude
```

To use a local checkout instead of the marketplace: `claude --plugin-dir /path/to/flightdeck/plugin`.

Marketplace installs do not update themselves: after a Flightdeck release run `claude plugin update flightdeck@flightdeck-plugins` (or enable auto-update for the `flightdeck-plugins` marketplace under `/plugin`).

For runs the plugin does not report, such as `claude --bare`, CI jobs and cloud sessions without the plugin, and the TypeScript Agent SDK, point Claude Code's own OpenTelemetry export at Flightdeck instead: see [Claude Code over OpenTelemetry](#claude-code-over-opentelemetry).

### Production agents

Install the sensor and point your agent at it:

```bash
pip install flightdeck-sensor
```

```python
import flightdeck_sensor

flightdeck_sensor.init()
flightdeck_sensor.patch()

# Your existing agent code. Nothing changes.
import anthropic
client = anthropic.Anthropic()
client.messages.create(model="claude-sonnet-4-6", ...)
```

The agent shows up in the fleet view within seconds. With no arguments `init()` talks to the local stack at `http://localhost:4000/ingest` with the dev token `tok_dev` and logs one warning saying so. For any other stack set `FLIGHTDECK_SERVER` and `FLIGHTDECK_TOKEN` (or pass `server=` and `token=`); a server given without a token is an error, the dev token is never sent to a server you chose.

To run the sensor from source instead of PyPI: `pip install -e sensor/` from the repo root.

---

## Playground

Working examples for every supported framework live in [`playground/`](playground/). Each script costs cents per run and exercises the sensor against real LLM APIs. On WSL with the repo under `/mnt/c`, keep the virtualenv on the Linux filesystem; [CONTRIBUTING.md](CONTRIBUTING.md#releasing) shows how.

```bash
make playground-anthropic    # Anthropic direct
make playground-openai       # OpenAI direct
make playground-langchain    # LangChain + ChatAnthropic / ChatOpenAI
make playground-langgraph    # LangGraph agent loops
make playground-llamaindex   # LlamaIndex
make playground-llamaindex-agents  # LlamaIndex agent workflows as child sessions
make playground-crewai       # CrewAI multi-agent
make playground-mcp          # MCP tool calls
make playground-policies     # token policy enforcement

make playground-all          # everything (~$0.50/run)
```

Each script self-skips when its API keys aren't set, so `make playground-all` runs cleanly on any box and only exercises what you have credentials for. The `flavor` field on each session names the playground script that produced it, so you can find them on the dashboard. See [`playground/README.md`](playground/README.md) for the full matrix.

---

## Coverage

### LLM SDKs

| Provider  | Chat | Embeddings | Streaming | Errors |
|-----------|------|------------|-----------|--------|
| Anthropic | `messages.create`, `messages.stream`, `messages.parse`, `beta.messages.*` (sync + async) | route via litellm to Voyage | `messages.stream`, `messages.create(stream=True)` (sync + async) | 14-entry `llm_error` taxonomy |
| OpenAI    | `chat.completions.create` / `.parse` (also on `beta.chat`), `responses.create` / `.parse`, and their `with_raw_response` and `with_streaming_response` counterparts (sync + async) | `embeddings.create` (sync + async) | `create(stream=True)` on chat and Responses, the `.stream()` helpers and the streaming views (sync + async) | same |
| litellm   | `litellm.completion`, `text_completion`, `responses` and their async forms (each call counted once, also where litellm serves it through the OpenAI SDK or its own `completion`) | `litellm.embedding`, `litellm.aembedding` | `stream=True` on `completion`, `text_completion` and `responses` (sync + async) | same |

The Anthropic row applies to every `anthropic` client class — first-party, Bedrock, Vertex, Google Cloud, Foundry, AWS, Mantle — and to the raw view (`with_raw_response`) and the streaming view (`with_streaming_response`): the streaming view is metered when you call `parse()`, and `create(stream=True)` through either view is metered as the parsed stream is iterated. Every Anthropic `post_call` records the platform the client talked to in `provider_metadata.platform` (`anthropic`, `bedrock`, `bedrock-mantle`, `aws`, `vertex`, `google-cloud`, `foundry`, or the host of a gateway the SDK was pointed at).

Streamed calls report the token counts the provider sends inside the stream, whether you iterate inside a `with` block or without one (a loop left with `break` and never closed is reported at the next LLM call the sensor intercepts after the stream object is collected, or when the session ends). Streaming events expose `payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms, final_outcome, abort_reason}`; `final_outcome` is `aborted` when you leave a stream before the event that ends the response, and `completed` otherwise. A mid-stream failure, inside a `with` block or while iterating without one, emits `llm_error{error_type="stream_error"}` with the chunks and tokens delivered before the failure.

Not supported yet: Gemini through `google-genai` ([#276](https://github.com/flightdeckhq/flightdeck/issues/276)) and boto3 Bedrock Converse ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)). Claude on Bedrock or Vertex AI through the `anthropic` SDK is covered (above).

### Frameworks

Flightdeck reaches a framework two ways. The sensor meters and enforces every LLM call the framework makes through the Anthropic or OpenAI SDK or litellm, live, and for the frameworks it wraps opens a child session per sub-agent. The [OpenTelemetry receiver](#agent-frameworks-over-opentelemetry) maps the GenAI spans some frameworks export: their agents, model calls and tool calls, from any language, but observe only and once the run has ended. A framework gets a native wrap where that adds enforcement inside the run, live events or structure OpenTelemetry does not report; its model calls stay on the sensor's session, so a Stop or a budget covers the whole run.

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

"Planned" is tracked in [#185](https://github.com/flightdeckhq/flightdeck/issues/185). Report a run one way: the sensor and an OpenTelemetry exporter on the same run count it twice. Not supported: BAML (its Rust runtime makes the calls), Letta (its server runs the agents), MetaGPT and CAMEL (they pin SDK majors long superseded or conflicting). [ARCHITECTURE.md](ARCHITECTURE.md) ("Framework support") has what each path gives per framework.

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

### Coding agents

Claude Code agents attach via a separate plugin distributed through this repo's marketplace:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
```

The plugin defaults to `http://localhost:4000` + `tok_dev` for the local-dev path; export `FLIGHTDECK_SERVER` + `FLIGHTDECK_TOKEN` before launching `claude` to point at a different stack. For `claude -p` scripts, CI and the GitHub Action, see [plugin/README.md](plugin/README.md#headless-runs-ci-and-the-github-action). See [Quickstart > Coding agents](#coding-agents-claude-code) for the full flow. Tool inputs and LLM call content are captured by default, so the Prompts tab is populated without extra setup.

Sessions carry `flavor=claude-code`, `agent_type=coding`, and `client_type=claude_code`. By default the plugin only observes and the Stop Agent button is hidden for these sessions; with its `enforcement` option on, a stop or a token budget denies the session's next tool call and blocks its prompts (see [plugin/README.md](plugin/README.md#enforcement-opt-in)). Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist.

`client_type` names the client that produced a session. Flightdeck accepts nine values (`claude_code`, `flightdeck_sensor`, `claude_agent_sdk`, `codex`, `copilot`, `opencode`, `gemini_cli`, `cursor`, `otlp`), each with a display label, an expected agent type, a billing-mode default and whether the client can act on directives; see "Client type registry" in [ARCHITECTURE.md](ARCHITECTURE.md). The plugin sends `claude_code`, the sensor sends `flightdeck_sensor`, and the sensor's Claude Agent SDK interceptor sends `claude_agent_sdk`. A session reported over OpenTelemetry takes the type of the tool that produced it, so Claude Code's own telemetry also lands as `claude_code` (see [Claude Code over OpenTelemetry](#claude-code-over-opentelemetry)), and the agent frameworks the receiver maps, which no other value names, land as `otlp` (see [Agent frameworks over OpenTelemetry](#agent-frameworks-over-opentelemetry)). The other values are reserved for the integrations on the [Roadmap](#roadmap).

### Claude Code over OpenTelemetry

Claude Code exports OpenTelemetry of its own, and Flightdeck's ingestion API receives it. This reaches runs the plugin does not see: `claude --bare` (it runs no hooks, a plugin's included), CI jobs and cloud sessions without the plugin, the TypeScript Agent SDK (the sensor covers the Python one), and any Claude Code whose telemetry is pointed at Flightdeck. Set these in the environment Claude Code starts in:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://flightdeck.example.com/ingest
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ftd_..."
export OTEL_LOGS_EXPORT_INTERVAL=1000
export OTEL_RESOURCE_ATTRIBUTES="host.name=$(hostname)"
```

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` turns Claude Code's export on.
- `OTEL_LOGS_EXPORTER=otlp`: every event Flightdeck stores comes from Claude Code's log events (prompts, model calls with tokens, TTFT and Claude Code's own cost, tool calls, denied tools, API errors, sub-agents). Leave `OTEL_METRICS_EXPORTER` and `OTEL_TRACES_EXPORTER` unset: the receiver accepts metrics and traces and counts them in its response, but stores neither.
- `OTEL_EXPORTER_OTLP_PROTOCOL`: Claude Code has no default. `http/protobuf` and `http/json` both work, gzip-compressed or not; `grpc` does not, since the receiver speaks OTLP over HTTP only.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: the exporter appends `/v1/logs`, which the edge proxy routes to ingestion. On the dev stack: `http://localhost:4000/ingest`.
- `OTEL_EXPORTER_OTLP_HEADERS`: a Flightdeck token, the kind the sensor and the plugin use (`tok_dev` on the dev stack).
- `OTEL_LOGS_EXPORT_INTERVAL=1000`: Claude Code sends logs in batches every 5 seconds and flushes at exit under a short timeout, so a `claude -p` or Agent SDK run that is killed, or slow to flush, can lose its last batch. A 1-second interval narrows that window; an interactive session can keep the default.
- `OTEL_RESOURCE_ATTRIBUTES`: Claude Code sends no host name, so without `host.name` all of a user's machines are one agent, `<user>@unknown`. The same comma-separated list takes Flightdeck's own keys: `flightdeck.flavor` (default `claude-code`), `flightdeck.billing_mode` and `flightdeck.capture_prompts` (below). The billing mode defaults to `subscription`; set `metered` for a run that pays per token, so its cost counts toward estimated cost. A `claude --bare` run always does: it signs in only with `ANTHROPIC_API_KEY`, an `apiKeyHelper` or a cloud provider's credentials, never a claude.ai login.
- Leave `OTEL_SERVICE_NAME` unset. Flightdeck recognises Claude Code by `service.name=claude-code` and counts the records of any other service name as rejected (`source "<name>" is not mapped`); tell agents apart with `flightdeck.flavor`.

**Tool details (opt-in).** `OTEL_LOG_TOOL_DETAILS=1` makes Claude Code name an MCP tool call's server and tool, which Flightdeck puts on the `mcp_tool_call` and on a denied call's signal (without them the call is a `tool_call` named `mcp_tool`), and a custom sub-agent by its name rather than `custom`. It also sends each tool's parameters and input, such as a Bash command line, and a failed tool's error text. Flightdeck stores a tool's input and a failed tool's error text only on a session whose `flightdeck.capture_prompts` is `true`, and a repository can set that flag (below) unless managed settings, or `--settings`, set `OTEL_RESOURCE_ATTRIBUTES`.

**What a repository can change.** Claude Code applies the `env` of a repository's `.claude/settings.json` and `.claude/settings.local.json` over your shell, but ignores there the variables that turn telemetry on or choose where it goes and what content it carries: `CLAUDE_CODE_ENABLE_TELEMETRY`, the exporter selectors, the `OTEL_LOG_*` content switches and the `OTEL_EXPORTER_OTLP_*` endpoint, header and protocol variables (Claude Code 2.1.282 and later). Of those, a repository can only switch an exporter or a content switch off, and only over your user settings. Two variables Flightdeck reads stay open to it: `OTEL_RESOURCE_ATTRIBUTES`, whose value replaces yours, so it can set `flightdeck.capture_prompts=true`, a flavor or a host; and `OTEL_SERVICE_NAME`, which can keep its runs out of Flightdeck. Prompt text, tool inputs and a failed tool's error text still reach Flightdeck only when your own `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS` send them, gates a repository cannot open; an API error's message, up to 200 characters, needs only the capture flag. Only managed settings, or JSON passed with `--settings`, outrank a repository's settings. `--setting-sources user` leaves them out, and with them the repository's CLAUDE.md, rules, skills, commands, agents and hooks (checked on Claude Code 2.1.316).

What the dashboard shows for such a session:

- A `claude_code` session (`agent_type=coding`) with an `OTEL` pill beside its Claude Code pill, and "via OpenTelemetry" in its run drawer. Its agent is `<user>@<host>`, the user being the signed-in `user.email` (personal data, stored on the agent), else the account id, else `unknown`.
- It observes only: no Stop, no Stop All and no custom directive reaches it.
- Content stays off unless the exporter asks for it twice: `flightdeck.capture_prompts=true` (not `1`) in `OTEL_RESOURCE_ATTRIBUTES` turns capture on for the session, and Claude Code then sends the prompt text only with `OTEL_LOG_USER_PROMPTS=1`, and tool inputs and a failed tool's error text only with `OTEL_LOG_TOOL_DETAILS=1`. An API error's message, up to 200 characters, needs only the capture flag, which a repository can set (above). With capture off, Flightdeck stores names, ids, counts, durations and whether each call succeeded. No server setting overrides this; the settings Claude Code runs with decide (see What a repository can change, above). `OTEL_LOG_USER_PROMPTS=1` also makes Claude Code send response text, which Flightdeck does not store; `OTEL_LOG_ASSISTANT_RESPONSES=0` keeps it off the wire.
- Running the plugin as well is safe. When the plugin, or the sensor's Agent SDK interceptor, already reports the Claude Code session, its OpenTelemetry records are dropped (counted as rejected in the export response), so nothing is counted twice. The check runs on the session's first export, so a session whose telemetry arrives before the plugin's first event is reported by both.
- Claude Code sends no event when a session ends. The session goes `stale` after 2 minutes without a record and `lost` after 30, and the workers close it 24 hours after its last record by default (`FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`, `close_reason=orphan_timeout`). A record that arrives later reopens it.
- Each sub-agent is a child session, labeled with its type as `agent_role`, that closes when Claude Code reports the sub-agent completed; one resumed with `SendMessage` reopens its child session. Claude Code 2.1.310 and later tags a sub-agent's log events, so `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` is not needed: it adds traces, which Flightdeck does not store.

If no session appears, start Claude Code with `--debug-file <path>`: the log names the exporter's failures in `[3P telemetry]` lines. Under the Agent SDK, set `CLAUDE_CODE_OTEL_DIAG_STDERR=1` and read them through the SDK's `stderr` option (TypeScript) or callback (Python).

Rolling it out:

- **Across an organization**, put the variables in the `env` block of Claude Code's managed settings (a managed settings file or server-managed settings). Managed settings outrank every other source, and Claude Code 2.1.217 and later also removes a developer's own endpoint variables, so the export cannot be pointed elsewhere. Set `OTEL_SERVICE_NAME=claude-code` and `OTEL_RESOURCE_ATTRIBUTES` there too, so a repository cannot change them (above). The managed `OTEL_RESOURCE_ATTRIBUTES` replaces each machine's own, and no shell expands a settings file, so write `host.name` into each machine's managed settings file. Server-managed settings are the same on every machine, so pinning `OTEL_RESOURCE_ATTRIBUTES` there makes every session `<user>@unknown`. From Claude Code 2.1.223, managed sources merge `env` variable by variable, and `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` sit outside the telemetry variables that must come from one source, so server-managed settings can carry the export while each machine's own managed settings file carries `OTEL_RESOURCE_ATTRIBUTES` with its `host.name`. A token made for the rollout can be revoked on its own. Ingestion allows each token 1000 events a minute (`FLIGHTDECK_RATE_LIMIT_PER_MINUTE`, counted per replica), shared with the sensor and the plugin, so a large rollout may need a higher budget or a token per team.
- **In GitHub Actions**, `anthropics/claude-code-action` passes nine telemetry variables from the step's `env` to Claude Code: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL` and `OTEL_RESOURCE_ATTRIBUTES`. This example sends the export through them and pins the two variables a repository could set with `--settings` in `claude_args`:

  ```yaml
  - uses: anthropics/claude-code-action@v1
    env:
      CLAUDE_CODE_ENABLE_TELEMETRY: "1"
      OTEL_LOGS_EXPORTER: otlp
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_EXPORTER_OTLP_ENDPOINT: https://flightdeck.example.com/ingest
      OTEL_EXPORTER_OTLP_HEADERS: Authorization=Bearer ${{ secrets.FLIGHTDECK_TOKEN }}
      OTEL_LOGS_EXPORT_INTERVAL: "1000"
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      claude_args: |
        --settings '{"env": {"OTEL_SERVICE_NAME": "claude-code", "OTEL_RESOURCE_ATTRIBUTES": "host.name=github-actions,flightdeck.billing_mode=metered"}}'
  ```

  The run pays with an API key, hence `metered`; leave it out for `claude_code_oauth_token`. The Action also loads the repository's settings (on a pull request, the base branch's: it restores `.claude/` and `CLAUDE.md` from the base branch before Claude Code starts), which outrank the step's `env` and the `settings` input, so the repository's committed settings can set `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` for the run. The `--settings` pin outranks them without dropping any of the repository's settings; `--setting-sources user` in `claude_args` also shuts them out, but drops the repository's CLAUDE.md, rules, skills, commands, agents and hooks too. Send any other variable, such as `OTEL_EXPORTER_OTLP_COMPRESSION`, through the `env` of the `settings` input, which the Action writes to the runner's user settings. The runner must reach your Flightdeck deployment.
- **Cloud sessions** (Claude Code on the web) read the variables from your organization's server-managed settings, which reach every cloud session except Claude Tag channel sessions. Claude Code's documentation advises against putting a credential such as the token in a cloud environment's own variables, since anyone who uses the environment can read them, and those variables are the only route to Claude Tag sessions. The session's network must reach your Flightdeck host: add its domain to the environment's allowed domains if its network access level does not cover it.
- **The TypeScript Agent SDK** runs the Claude Code CLI, which does the exporting: set the variables in the process environment, or in `options.env`, which replaces the inherited environment, so spread `process.env` into it. Anthropic's Agent SDK observability guide suggests renaming the service with `OTEL_SERVICE_NAME`; leave it unset for Flightdeck and set `flightdeck.flavor` instead. An app that pays with an API key also sets `flightdeck.billing_mode=metered`.

A proxy in front of ingestion must accept 4 MiB request bodies on `/ingest/`; the bundled nginx does, and so does the Helm chart's `values.prod.yaml` for ingress-nginx. The limit applies to the body as sent, and a gzip body may inflate to 16 MiB. With content logging on, a batch carries prompts, responses (each cut at 60 KB by default) and tool parameters, so a backlog can pass 4 MiB; the receiver then answers 413 and the exporter drops the whole batch. Add `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` when capture is on.

### Agent frameworks over OpenTelemetry

Pydantic AI, Strands Agents, the OpenAI Agents SDK (through `opentelemetry-instrumentation-openai-agents-v2`) and Google ADK export OpenTelemetry GenAI spans, and the ingestion API maps them: each agent becomes a session (a sub-agent a child session), with its model calls, tokens, tool calls and hand-offs. These sessions observe only (no Stop, no token budget), land as `client_type=otlp`, and appear 3 to 30 seconds after the run ends. Set the exporter environment before the framework is imported:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://flightdeck.example.com/ingest
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20ftd_..."
export OTEL_RESOURCE_ATTRIBUTES="flightdeck.flavor=my-app,host.name=$(hostname),flightdeck.capture_prompts=true"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

Then turn on the framework's tracing:

- **Pydantic AI:** a global `TracerProvider` with an OTLP span exporter, and `Agent.instrument_all()`.
- **Strands Agents:** `StrandsTelemetry().setup_otlp_exporter()`.
- **OpenAI Agents SDK:** a global `TracerProvider` with an OTLP span exporter, and `OpenAIAgentsInstrumentor().instrument()` from `opentelemetry-instrumentation-openai-agents-v2`. The SDK also exports its traces to OpenAI by default; call `set_trace_processors([])` before `instrument()` to turn that off, as playground script 34 does (the instrumentor adds its processor to the existing ones, so calling it afterwards drops the Flightdeck export too).
- **Google ADK:** `adk web` and `adk api_server` set it up, or call `maybe_set_otel_providers()` from `google.adk.telemetry.setup`. ADK sends each model call's content as a log record on `/v1/logs`, so a setup of your own needs a logs exporter as well as a span exporter.

`flightdeck.capture_prompts=true` keeps message content, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` makes the OpenAI Agents instrumentation and ADK send it (Pydantic AI and Strands send it by default). `flightdeck.agent_type` (`coding` or `production`, default `production`) and `flightdeck.billing_mode` are read as for Claude Code, but the billing default here is `metered`, not Claude Code's `subscription`. Playground scripts 32 to 35 show the setup per framework. When the sensor already reports the same run, leave the exporter off: both paths count it ([#279](https://github.com/flightdeckhq/flightdeck/issues/279)).

### Sub-agent observability

Multi-agent frameworks render as a tree: a parent session for the orchestrator and a separate child session per sub-agent execution, linked by `parent_session_id` and labeled with `agent_role`.

| Mechanism | parent source | role source |
|---|---|---|
| Claude Code Task subagent | hook payload `session_id` | hook payload `agent_type` (e.g. `"Explore"`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute |
| LangGraph agent-bearing node whose action is a plain callable | parent runner's session | node name |

Direct SDK calls outside a multi-agent framework emit root sessions; identity is unchanged. When `capture_prompts=True`, each child session carries the parent's input as `incoming_message` and the child's response back as `outgoing_message`, visible in the run drawer's Sub-agents tab.

### MCP

Flightdeck observes MCP traffic as a first-class event surface alongside chat and embeddings. Six event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`) emit per operation. The sensor patches `mcp.client.session.ClientSession` directly, so every framework that mediates MCP through the official SDK is observed: LangChain via `langchain-mcp-adapters`, LangGraph via the same, LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`, plus the raw `mcp` SDK.

The sensor supports the official `mcp` SDK 1.x (from 1.28) and 2.x; on 2.x it also covers the high-level `mcp.Client`.

The Claude Code plugin's MCP coverage is limited to tool calls; resource reads and prompt fetches are below the plugin hook layer.

---

## Features

**Live fleet view (`/`).** Every agent on a shared timeline, one row per agent, sub-agents indented under their parent. LLM calls, embeddings, tool uses, policy events, and structured errors plot on each agent's row as they arrive. Run boundary glyphs mark when each run started and ended. Click any event to inspect it inline.

**Agents dashboard (`/agents`).** Every agent in the fleet as a sortable row with token, latency, error rate, session count, and cost trends over the last 7 days. Filter chips narrow the table by state, agent type, client type, or framework. Click an agent for a focused drawer with that agent's runs, events, sub-agent relationships, and MCP servers. Click the status badge for a single-agent swimlane modal with its own time-range picker and sub-agent toggle.

**Events search (`/events`).** Every individual event across the fleet with facet filtering by agent, event type, error type, MCP server, framework, model, close reason, policy event type, and more. Click any event for full detail. Click the run badge to inspect the run that emitted it.

**Run inspection.** Open any run to see its events in chronological order, the token usage bar, the runtime context (git commit, k8s namespace, frameworks installed, hostname, OS), and the sub-agents it spawned. With `capture_prompts=True`, every LLM call's full payload is available: system prompt, messages, tool definitions, model response, embedding inputs. Provider shape is preserved (Anthropic sessions display `system`, `messages`, `tools`, and `response` as separate fields; OpenAI sessions display `messages` with system role included).

**Token policy enforcement.** Define token budgets centrally per flavor. Each agent pulls its policy on session start and enforces it locally with no code changes. At a configurable warn threshold (default 80% of budget) a `policy_warn` event fires and the call proceeds; at the degrade threshold (default 90%) `policy_degrade` swaps to a cheaper model; at the block threshold (default 100%) `policy_block` raises `BudgetExceededError`. Every enforcement decision is a structured event on the run timeline.

**Agent control.** Stop an individual agent or every agent of a flavor from the dashboard; the kill signal delivers on the agent's next LLM call. Register custom directives (Python functions decorated with `@flightdeck_sensor.directive`) and invoke them from the dashboard. Results land as `directive_result` events on the run timeline.

```python
@flightdeck_sensor.directive(
    name="clear_cache",
    description="Clear the prompt cache",
    parameters=[
        flightdeck_sensor.Parameter(
            name="cache_type",
            type="string",
            options=["all", "prompt"],
            default="all",
        )
    ],
)
def clear_cache(context, cache_type="all"):
    return {"cleared": my_cache.clear(cache_type)}
```

**MCP server policy.** Per-flavor allowlist or blocklist of MCP servers your agents can talk to. The sensor enforces at every MCP call; misconfigured or unrecognized servers either warn or block per the policy. See [MCP Protection Policy](#mcp-protection-policy).

**Analytics (`/analytics`).** Token consumption, run counts, latency, model distribution, policy event volume, and estimated cost on a shared time range, grouped by any of: flavor, model, framework, host, agent_type, team, provider, agent_role, parent_session_id.

**Estimated cost.** Per-run cost computed from public list prices, accounting for cache reads and cache creation. Prices come from a vendored copy of litellm's price list, with your own overrides in [`pricing.yaml`](pricing.yaml). Treat as a sanity check, not an invoice.

---

## Identity

Every session carries a persistent **flavor** and an ephemeral **session ID**. Set the flavor via environment variable, typically from your orchestrator manifest:

```yaml
env:
  - name: AGENT_FLAVOR
    value: "research-agent"
  - name: FLIGHTDECK_SERVER
    value: "https://flightdeck.svc.cluster.local"
  - name: FLIGHTDECK_TOKEN
    valueFrom:
      secretKeyRef:
        name: flightdeck-token
        key: token
```

Agents without `AGENT_FLAVOR` appear as `{user}@{hostname}`. That is how agents deployed outside your blessed config become visible.

Every session also carries a **client type**, the kind of client that produced it (the sensor sends `flightdeck_sensor`, the Claude Code plugin `claude_code`). The dashboard shows it as a pill on each agent and offers it as a filter. A stable `agent_id`, derived from the agent type, user, host, client type and agent name, ties a client's sessions to one agent.

### Orchestrator re-attachment

When a Temporal workflow or Airflow DAG re-runs, you usually want one continuous session rather than a new session per run. Pass a stable `session_id` at `init()`:

```python
import uuid
import flightdeck_sensor as fd

# Fixed namespace UUID per deployment. Same input, same UUID.
NS = uuid.UUID("00000000-0000-0000-0000-000000000001")

fd.init(
    server="http://flightdeck.internal/ingest",
    token="ftd_...",
    session_id=str(uuid.uuid5(NS, workflow_id)),
)
```

`session_id` must be a valid UUID. Hash string identifiers (workflow_id, dag_run_id) with `uuid.uuid5`. The `FLIGHTDECK_SESSION_ID` env var overrides the kwarg.

---

## Sensor reference

### `patch()` vs `wrap()`

`patch()` is the right answer in almost every case. For Anthropic it patches `create`, `stream` and `parse` on the SDK's `Messages` resource classes, which every `anthropic` client class hands out, so every client — first-party, Bedrock, Vertex, Google Cloud, Foundry, AWS, Mantle, and the ones frameworks build internally — is intercepted, including a client built before `patch()` (from its next call on; only a `with_raw_response` / `with_streaming_response` view first touched before `patch()` stays unmetered). For OpenAI it installs a class-level descriptor on `openai.OpenAI` and `openai.AsyncOpenAI` so every instance, including ones frameworks build internally, is intercepted.

`wrap()` instruments a single client instance:

```python
client = flightdeck_sensor.wrap(anthropic.Anthropic())
```

Use `wrap()` only when you deliberately do not call `patch()`. Clients built by frameworks will be invisible unless `patch()` is active.

Call `patch()` before any framework or user code constructs a client. In practice this means calling `init()` + `patch()` at the top of your entrypoint.

### Environment variables

| Variable                        | Purpose                                                         |
|---------------------------------|-----------------------------------------------------------------|
| `FLIGHTDECK_SERVER`             | Ingestion base URL. Overrides the `server=` kwarg. Default `http://localhost:4000/ingest`. |
| `FLIGHTDECK_TOKEN`              | Access token. Overrides the `token=` kwarg. Defaults to `tok_dev` only when the server is defaulted too. |
| `FLIGHTDECK_API_URL`            | Control-plane base URL. Derived from `FLIGHTDECK_SERVER` if unset. |
| `FLIGHTDECK_SESSION_ID`         | Stable session UUID for orchestrator re-runs.                   |
| `FLIGHTDECK_CAPTURE_PROMPTS`    | `true` to enable full payload capture.                          |
| `FLIGHTDECK_UNAVAILABLE_POLICY` | `continue` (default) or `halt` when the control plane is down.  |
| `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` | Persistent agent label. Default: `{user}@{hostname}`.    |
| `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE`   | `coding` or `production`. Default: `production`. Any other value raises `ConfigurationError`. |
| `FLIGHTDECK_HOSTNAME`           | Override `socket.gethostname()` (useful for k8s pod grouping).  |

### Threading model

| Pattern                         | Description                                                | Status                |
|---------------------------------|------------------------------------------------------------|-----------------------|
| Single-threaded agent           | One `init()`, one thread, sequential LLM calls             | Supported             |
| Multithreaded agent             | One `init()`, many threads sharing patched clients         | Supported             |
| Multi-agent in one process      | Multiple `init()` calls, one per logical agent             | One `init()` per process; a second `init()` is a no-op with a warning |

The sensor reports over HTTP on background daemon threads. Control plane downtime is handled by the configured policy; it does not block agent code.

### Known limitations

- `patch()` must run before OpenAI clients are constructed. On openai 1.78 and later, instances that already accessed `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached and are not intercepted. Anthropic clients are intercepted from their next call on, whenever they were built, except that a `with_raw_response` / `with_streaming_response` view first touched before `patch()` binds the unpatched method and is not metered.
- The OpenAI patch needs `openai>=1.26` (the first release whose chat `create` takes `stream_options`, which the sensor adds to streamed calls); an older SDK is reported with a warning at import and its calls are not metered. On openai before 1.78 a client built before `patch()` is metered from its next call. Its client-level `with_raw_response` / `with_streaming_response` view is the exception: the SDK builds it with the client, so on a client built before `patch()` or with no session active it is not metered, and on a client built while a session was active it reports to that session.
- The Anthropic patch needs `anthropic>=0.86` (the lowest release with the resource layout it imports); an older SDK is reported with a warning at import and its calls are not metered.
- A `with_raw_response.create(stream=True)` response (Anthropic or OpenAI) that is never parsed has no close hook to settle on: it is reported on the pre-call estimate (as an aborted stream with no chunks when its body was never read), at the next LLM call the sensor intercepts after the response is collected, or when the session ends. The streaming view (`with_streaming_response`) settles when its `with` block exits, whether or not its stream was parsed or read.
- Anthropic Message Batches (`messages.batches.*`) and `count_tokens` are not patched: batch spend runs outside the kill switch and the token budget.
- With `capture_prompts=True`, prompts sent through the Bedrock, Vertex, Foundry, AWS and Mantle clients — platforms often chosen for data residency — reach the Flightdeck control plane like any other captured prompt. Keep capture off for those sessions, or keep the control plane inside the same residency boundary.
- llama-index-llms-anthropic (through 0.12.3) always sends `temperature`, which anthropic 1.x's `Messages.create` rejects, so LlamaIndex's Anthropic LLM fails on anthropic 1.x with or without the sensor; the playgrounds skip it there.
- On mcp 2.x, `mcp.Client` answers `list_tools`, `list_resources`, `list_resource_templates`, `list_prompts` and `read_resource` from its response cache when it can; a cached answer makes no MCP request, so no `mcp_*` event is emitted for it (pass `cache=None` to the `Client` to observe every request). Tool calls are not cached and are always observed and policed.
- Per-thread Session isolation is not yet supported. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`.
- Custom directive handler input validation is yours. The `parameters` schema drives the dashboard form and the directive fingerprint; it is not enforced at execution time.
- While a litellm call is in flight, an SDK call made from inside it (by a litellm callback, guardrail or custom provider, or by a task created inside the call and run before it ends) is neither policed nor metered: the litellm wrapper has already metered the call it serves, and the mark that tells the SDK interceptors so covers the whole call. A litellm call made from inside it is reported as a call of its own, except litellm's own re-issues of the same call (its responses/completion bridge and its `fallbacks` loop, which report once, with the model that answered). A chat call through litellm's MCP gateway is reported twice, and a sync call with `fallbacks` made while an event loop is running in its thread (a notebook) has each attempt reported as a call of its own beside it (a failed primary and one fallback: three `pre_call`s, two `post_call`s, one `llm_error`). Under a DEGRADE policy a litellm call's `fallbacks` are dropped, so it runs only the degrade target.

---

## MCP Protection Policy

Flightdeck can gate which MCP servers your agents are allowed to talk to. The policy lives in the control plane, applies per flavor, and is enforced inside the sensor and the Claude Code plugin without changing the wire path.

### Why this exists

MCP servers are external code your agents call. A misconfigured `.mcp.json`, a typo'd hostname, a colleague's experimental server, or a substituted binary all reach the agent the same way: as a server entry the agent dials at session start. The MCP Protection Policy is the fence around that.

### Scope and resolution

The policy lives at two scopes: one **global** policy carrying the mode (allowlist or blocklist) plus a list of entries, and zero or more **per-flavor** policies carrying allow / deny entry deltas against the global.

On install, Flightdeck auto-creates an empty global policy in `blocklist` mode with zero entries (fully permissive by default). No operator action is required for MCP traffic to keep flowing on a fresh deployment; locking down a flavor is opt-in.

Per-server resolution: most-specific scope wins. If the per-flavor policy has an entry for the URL, use it; else if the global policy has an entry, use it; else apply the global mode default (allowlist blocks unknown, blocklist allows unknown).

Server identity is the canonical URL (or stdio command): entries match on it whatever name the server reports, and when a scope has several entries for one URL the most restrictive wins. The name is the display label and tamper-evidence axis; the displayed fingerprint is `sha256(canonical_url + 0x00 + name)`.

### Configuration

Operators create a flavor policy in the dashboard under **Policies → MCP Protection**. The Python sensor fetches the active policy at `init()` (synchronous, alongside the existing token-policy preflight). The Claude Code plugin fetches at every `SessionStart` with a one-hour disk cache.

Per-call enforcement:

- **warn** decisions emit `policy_mcp_warn` and proceed.
- **block** decisions emit `policy_mcp_block`, flush the event queue, and raise `flightdeck.MCPPolicyBlocked`. Frameworks surface this as a tool-call failure to the agent's reasoning loop.

A `policy_update` directive received in a response envelope refreshes the sensor cache; the new policy applies at the next `session_start`. In-flight sessions keep the policy that was active at their start.

---

## Self-hosting

Flightdeck is self-hosted. Two deployment targets are supported: Docker Compose (single host) and a Helm chart for Kubernetes with a bundled Postgres and NATS.

### Prerequisites

- Docker Engine 28+ with Compose v2 (`docker compose version` reports `v2.x`).
- A DNS A/AAAA record for the host (e.g. `flightdeck.example.com`).
- A TLS cert for that hostname. The walkthrough below uses `certbot`; bring-your-own works too.
- Ports 80 and 443 reachable from the public internet.

### Docker Compose

Issue the cert (certbot standalone is the shortest path):

```bash
sudo certbot certonly --standalone \
  -d flightdeck.example.com \
  --non-interactive --agree-tos \
  -m ops@example.com --no-eff-email
```

Symlink certbot's output into where nginx expects it:

```bash
sudo mkdir -p /etc/nginx/certs
sudo ln -sf /etc/letsencrypt/live/flightdeck.example.com/fullchain.pem \
  /etc/nginx/certs/fullchain.pem
sudo ln -sf /etc/letsencrypt/live/flightdeck.example.com/privkey.pem \
  /etc/nginx/certs/privkey.pem
```

Start the stack:

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml up -d
```

The prod overlay terminates TLS at nginx on 443 with 80 to 443 redirect, rejects the seed `tok_dev` token, sets `restart: unless-stopped` on every service, and uses named volumes for Postgres and NATS JetStream.

The `FLIGHTDECK` NATS stream that carries events from ingestion to the workers keeps them for 72 hours, up to 5 GiB, then removes the oldest (`FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS`, `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB` in `docker/.env`). The limits remove events whether or not the workers have processed them, so if the workers are down for longer than 72 hours, or fall more than 5 GiB behind, the oldest unprocessed events are lost; the workers log how many at their next start. To roll back to a release before the stream was bounded, first run `nats stream edit FLIGHTDECK --max-age=0 --max-bytes=-1 --discard=old --replicas=1 --force` (with `-s <your NATS URL>`), which restores unbounded retention; the earlier ingestion and workers do not start on the bounded stream.

Reach the dashboard at `https://flightdeck.example.com/`. Go to **Settings → Access tokens → Create** and mint your first token. The token's plaintext is shown once at creation; copy it into your secret store before closing the modal.

Point an agent:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com/ingest"
export FLIGHTDECK_TOKEN="ftd_..."
```

The dashboard fetches its bearer token at runtime from `/runtime-config.json` rather than baking it into the bundle. Rotation is a single-file replace plus `nginx -s reload`; no rebuild required.

### Kubernetes (Helm)

```bash
helm install flightdeck helm/ \
  --namespace flightdeck --create-namespace \
  --values helm/values.prod.yaml \
  --set postgres.externalUrl="postgres://user:pass@rds.example.com:5432/flightdeck?sslmode=require" \
  --set api.auth.jwtSecret="<strong-random-secret>" \
  --set api.corsOrigin="https://flightdeck.example.com" \
  --set nats.auth.token="<strong-random-token>"
```

A production render (`api.env=production`, the default) refuses to proceed without the JWT secret, a non-wildcard CORS origin and the NATS token, and without `postgres.password` when it bundles Postgres. Without `postgres.externalUrl` the chart ships its own single-instance Postgres StatefulSet (fine for small deployments, not HA, not backed up). NATS is always bundled; with more than one replica the servers form a cluster, so events published on any of them reach the workers. On a cluster of 3 or more servers the `FLIGHTDECK` JetStream stream keeps a copy on 3 of them, so it survives the loss of one; ingestion raises an existing one-replica stream to 3 in place on its first start after the upgrade. The token may contain only letters, digits and `. _ ~ -` because it is placed in NATS URLs (`openssl rand -hex 32` works); with more than one replica the cluster routes authenticate with it too.

**Upgrading a v0.5.3 install with `nats.replicas` above 1** (the default is 3): the NATS StatefulSet's pod start policy changes, which Kubernetes does not allow in place. Scale ingestion to zero, give the workers a minute to drain, then run `kubectl delete statefulset <release>-flightdeck-nats` (the data volumes stay) before `helm upgrade`. On first start the clustered servers discard the old per-server streams and ingestion recreates the stream, so any event still on the bus at that point is dropped. A one-replica install upgrades in place and keeps its stream.

The chart is at `version` 0.8.0 with `appVersion` 0.8.0; the default `image.tag` is `v0.8.0`. See [`helm/values.yaml`](helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.8.0` | Image tag applied to ingestion/workers/api/dashboard. |
| `ingestion.replicas` | `2` | Initial replica count. HPA overrides at runtime when enabled. |
| `ingestion.hpa.enabled` | `true` | Enable the HorizontalPodAutoscaler for ingestion. |
| `workers.replicas` | `2` | NATS consumer pod count. |
| `api.replicas` | `2` | Query API replica count. |
| `api.corsOrigin` | `*` | `Access-Control-Allow-Origin` for the query API. Lock down in prod. |
| `dashboard.replicas` | `2` | Dashboard pod count. |
| `postgres.externalUrl` | *(empty)* | When set, bundled Postgres StatefulSet is not rendered. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.replicas` | `3` | NATS StatefulSet replica count; more than one forms a NATS cluster. |
| `nats.auth.token` | *(empty)* | Client token for the event bus. Required in production. |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `nats.jetstream.stream.maxAgeHours` | `72` | How long the `FLIGHTDECK` stream keeps an event, processed or not. Unprocessed events older than this are lost. |
| `nats.jetstream.stream.maxSizeMiB` | `5120` | Most the stream stores on each NATS server; at the limit the oldest events go. The render fails above 75% of `fileStore.size`; keep it well under (`values.prod.yaml`: 30720 for 50Gi). |
| `nats.jetstream.stream.replicas` | *(empty)* | Servers holding a copy of the stream. Empty: 3 when `nats.replicas` is 3 or more, else 1. At most `nats.replicas` and 5, and not 2. |
| `ingress.enabled` | `false` | Render an Ingress routing `/` to dashboard, `/api` to query API, `/ingest` to ingestion API. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza. |

---

## What Flightdeck is NOT

- **Not a proxy.** The sensor wraps SDK client classes inside the agent's own process; calls go directly to the provider. Nothing routes through Flightdeck.
- **Not a content inspector by default for production agents.** The Python sensor defaults to `capture_prompts=False`; with capture off, event payloads carry token counts, model names, latency, framework, and tool names only. The Claude Code plugin is the one exception: it captures prompts and sanitised tool inputs by default because you are observing your own session on your own machine, and `FLIGHTDECK_CAPTURE_PROMPTS=false` turns that off.
- **Not an orchestrator.** Flightdeck observes; it does not decide what an agent should do next. Directives (kill switch, model swap, custom handlers) are explicit operator actions.
- **Not a billing system.** `estimated_cost` is an approximation from public list prices. Treat as a sanity check.
- **Not a notification platform.** No Slack, email, or PagerDuty integrations.
- **Not multi-tenant SaaS.** Self-hosted only. One deployment, one tenant.
- **Not an evaluation or prompt-management tool.** No LLM-as-judge scoring, eval datasets or prompt versioning.
- **Not an LLM gateway.** No model substitution, no caching layer, no retries injected by Flightdeck. The sensor enforces budgets your agents already know about.

---

## Roadmap

Planned work is tracked as [GitHub issues labelled `roadmap`](https://github.com/flightdeckhq/flightdeck/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap), grouped by release milestone. React with :+1: on the ones you need; that is how they get prioritised.

Not planned: Antigravity CLI (its hooks expose no telemetry or token data yet), Roo Code (shut down), Continue (repository read-only) and sub-agent structure for AutoGen and AG2 (their runs are labelled `autogen` and `ag2` and their LLM calls are metered; AutoGen's successor, Microsoft Agent Framework, is on the roadmap), sub-agent structure in the sensor for Pydantic AI and Strands Agents (their OpenTelemetry export reports it, and the sensor meters their calls), and BAML, Letta, MetaGPT and CAMEL (no in-process seam, or SDK pins too old for current providers).

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, lint, test instructions, and the process for adding a new LLM provider.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), the author's own open source token budget enforcement library.
