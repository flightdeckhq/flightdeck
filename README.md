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

Flightdeck is one binary: the ingestion API, the workers, the query API, the message bus and the dashboard in one process, on SQLite by default, with Postgres for larger fleets.

Built and maintained by [Omri Arnon](https://github.com/pykul) ([LinkedIn](https://www.linkedin.com/in/omriarnon/)).

![Live fleet view: every agent on a shared timeline streaming events as agents run.](assets/fleet-demo.gif)

![Agents dashboard: every agent in your fleet with token, latency, error, and cost trends, plus a per-agent swimlane and feed.](assets/agents-table-demo.gif)

![Events search: filter every LLM call, tool use, and policy event by agent, type, framework, and MCP server.](assets/events-table-demo.gif)

---

## Quickstart

Linux, macOS or Windows, amd64 or arm64; nothing else to install or configure.

```bash
curl -fsSL https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh | sh
flightdeck
```

Open the URL it prints: the dashboard is at http://localhost:4000, the data lives in `~/.flightdeck` (SQLite, nothing to set up) and the token the agents use is printed with it, `tok_dev` while the binary listens on your own machine only. Ctrl+C stops it.

Other ways to install the same binary: `brew install flightdeckhq/tap/flightdeck` (then `brew services start flightdeck` to keep it running), `pip install flightdeck-cli` or `uvx flightdeck-cli` (Python users; the package is `flightdeck-cli`, the sensor below is `flightdeck-sensor`), `irm https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.ps1 | iex` on Windows, the archives on the [release page](https://github.com/flightdeckhq/flightdeck/releases), or the Docker image under [Self-hosting](#self-hosting). `flightdeck --help` lists the flags.

## Point your agents at it

### Coding agents (Claude Code)

Launch Claude Code, then install the plugin from this repo's marketplace inside the REPL:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
```

That's it for a local stack: the plugin defaults to `http://localhost:4000` with the dev token `tok_dev`, so the Claude Code session shows up in the fleet view within seconds. Tool inputs and LLM call content are captured by default — unlike the Python sensor, which keeps `capture_prompts=False` until you opt in — so the Prompts tab is populated without extra setup.

To point the plugin at another stack (a server with a minted token, a remote dev server), export `FLIGHTDECK_SERVER` and `FLIGHTDECK_TOKEN` in the shell before launching `claude`; the plugin reads them at every `SessionStart`. Marketplace installs do not update themselves: after a Flightdeck release run `claude plugin update flightdeck@flightdeck-plugins`, or enable auto-update for the `flightdeck-plugins` marketplace under `/plugin`. [plugin/README.md](plugin/README.md) covers `claude -p` scripts, CI, the GitHub Action, enforcement and privacy.

For runs the plugin does not report — `claude --bare`, CI jobs and cloud sessions without the plugin, the TypeScript Agent SDK — point Claude Code's own OpenTelemetry export at Flightdeck: [docs/opentelemetry.md](docs/opentelemetry.md).

### Production agents (Python)

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

The agent shows up in the fleet view within seconds. With no arguments `init()` talks to the local stack at `http://localhost:4000/ingest` with the dev token `tok_dev` and logs one warning saying so. For any other stack set `FLIGHTDECK_SERVER` and `FLIGHTDECK_TOKEN` (or pass `server=` and `token=`); a server given without a token is an error, the dev token is never sent to a server you chose. Every session carries a persistent **flavor** (`AGENT_FLAVOR`, typically from your orchestrator manifest; agents without one appear as `{user}@{hostname}`) and a **client type**; [sensor/README.md](sensor/README.md) has the identity model, `patch()` vs `wrap()`, the environment variables, the threading model and the known limitations. Working examples for every supported framework live in [`playground/`](playground/).

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

Flightdeck reaches a framework two ways. The sensor meters and enforces every LLM call the framework makes through the Anthropic or OpenAI SDK or litellm, live, and for the frameworks it wraps opens a child session per sub-agent. The [OpenTelemetry receiver](docs/opentelemetry.md#agent-frameworks-over-opentelemetry) maps the GenAI spans some frameworks export: their agents, model calls and tool calls, from any language, but observe only and once the run has ended. A framework gets a native wrap where that adds enforcement inside the run, live events or structure OpenTelemetry does not report; its model calls stay on the sensor's session, so a Stop or a budget covers the whole run.

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

Claude Code sessions carry `flavor=claude-code`, `agent_type=coding`, and `client_type=claude_code`. By default the plugin only observes and the Stop Agent button is hidden for these sessions; with its `enforcement` option on, a stop or a token budget denies the session's next tool call and blocks its prompts (see [plugin/README.md](plugin/README.md#enforcement-opt-in)). Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist.

`client_type` names the client that produced a session. Flightdeck accepts nine values (`claude_code`, `flightdeck_sensor`, `claude_agent_sdk`, `codex`, `copilot`, `opencode`, `gemini_cli`, `cursor`, `otlp`), each with a display label, an expected agent type, a billing-mode default and whether the client can act on directives; see "Client type registry" in [ARCHITECTURE.md](ARCHITECTURE.md). The plugin sends `claude_code`, the sensor sends `flightdeck_sensor`, and the sensor's Claude Agent SDK interceptor sends `claude_agent_sdk`. A session reported over OpenTelemetry takes the type of the tool that produced it, so Claude Code's own telemetry also lands as `claude_code`, and the agent frameworks the receiver maps, which no other value names, land as `otlp` ([docs/opentelemetry.md](docs/opentelemetry.md)). The other values are reserved for the integrations on the [Roadmap](#roadmap).

### Sub-agent observability

Multi-agent frameworks render as a tree: a parent session for the orchestrator and a separate child session per sub-agent execution, linked by `parent_session_id` and labeled with `agent_role`.

| Mechanism | parent source | role source |
|---|---|---|
| Claude Code Task subagent | hook payload `session_id` | hook payload `agent_type` (e.g. `"Explore"`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute |
| LangGraph agent-bearing node whose action is a plain callable | parent runner's session | node name |

Direct SDK calls outside a multi-agent framework emit root sessions; identity is unchanged. When `capture_prompts=True`, each child session carries the parent's input as `incoming_message` and the child's response back as `outgoing_message`, visible in the run drawer's Sub-agents tab.

### MCP

Flightdeck observes MCP traffic as a first-class event surface alongside chat and embeddings. Six event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`) emit per operation. The sensor patches `mcp.client.session.ClientSession` directly, so every framework that mediates MCP through the official SDK is observed: LangChain via `langchain-mcp-adapters`, LangGraph via the same, LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`, plus the raw `mcp` SDK. The sensor supports the official `mcp` SDK 1.x (from 1.28) and 2.x; on 2.x it also covers the high-level `mcp.Client`. The Claude Code plugin's MCP coverage is limited to tool calls; resource reads and prompt fetches are below the plugin hook layer.

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

**MCP server policy.** Per-flavor allowlist or blocklist of MCP servers your agents can talk to. The sensor and the Claude Code plugin enforce it at every MCP call; misconfigured or unrecognized servers either warn or block per the policy. A fresh deployment starts fully permissive (an empty global blocklist); locking a flavor down is opt-in under **Policies → MCP Protection**. [docs/mcp-protection-policy.md](docs/mcp-protection-policy.md) has the scopes, the resolution rules and the enforcement semantics.

**Analytics (`/analytics`).** Token consumption, run counts, latency, model distribution, policy event volume, and estimated cost on a shared time range, grouped by any of: flavor, model, framework, host, agent_type, team, provider, agent_role, parent_session_id.

**Estimated cost.** Per-run cost computed from public list prices, accounting for cache reads and cache creation. Prices come from a vendored copy of litellm's price list, with your own overrides in [`pricing.yaml`](pricing.yaml). Treat as a sanity check, not an invoice.

---

## Self-hosting

The same binary serves a team. Bound to anything but your own machine it refuses the dev token, mints a real `ftd_` access token on its first start, prints it once and keeps it in its data dir for the dashboard; further tokens are minted under **Settings → Access tokens** (the plaintext is shown once). The data dir (`--data-dir`, default `~/.flightdeck`) holds the SQLite database, the message-bus store and the secrets; back it up and the install moves with it. Upgrading is installing the new release: the binary migrates its database at start.

```bash
flightdeck --domain flightdeck.example.com      # HTTPS on :443 with a Let's Encrypt certificate, :80 redirects (a DNS record pointing at the host is all it needs)
flightdeck --database-url postgres://flightdeck:PASSWORD@db.example.com:5432/flightdeck?sslmode=require   # Postgres instead of SQLite, for a larger fleet or several instances
```

SQLite serializes writes through one connection and is right for a laptop and a small team; Postgres is the scale path, and several binaries can share one database when they also share one message bus (`--nats-url`, or the Helm chart below, which runs one for them). The `FLIGHTDECK` stream between ingestion and the workers keeps events for 72 hours or 5 GiB (`FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS`, `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB`), processed or not, so an event the workers have not stored by then is lost. ARCHITECTURE.md ("Deployment") lists every flag and variable.

Point an agent at it with `FLIGHTDECK_SERVER=https://flightdeck.example.com/ingest` and `FLIGHTDECK_TOKEN=ftd_...` (the sensor, the plugin and the OpenTelemetry exporters all read them). The dashboard is served from the same origin.

**Docker, Compose and Kubernetes.** The image `flightdeckhq/flightdeck` (amd64 and arm64) is the binary with its data under `/data`; its first start prints the token in `docker logs`. [`docker/docker-compose.yml`](docker/docker-compose.yml) runs it on SQLite, and [`docker-compose.postgres.yml`](docker/docker-compose.postgres.yml) layered on it adds a Postgres (`POSTGRES_PASSWORD` required). The Helm chart at [`helm/`](helm/) runs one or more replicas on a bundled or managed Postgres and, with more than one replica, the NATS cluster they share; [`helm/values.yaml`](helm/values.yaml) documents every value and [`helm/values.prod.yaml`](helm/values.prod.yaml) is a production shape with an Ingress.

```bash
docker run -d --name flightdeck -p 4000:4000 -v flightdeck-data:/data flightdeckhq/flightdeck
docker compose -f docker/docker-compose.yml up -d
helm install flightdeck helm/ -f helm/values.prod.yaml --set postgres.externalUrl=postgres://... --set nats.auth.token=$(openssl rand -hex 32)
```

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

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev stack, lint, test instructions, and the process for adding a new LLM provider.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), the author's own open source token budget enforcement library.
