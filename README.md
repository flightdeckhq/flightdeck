<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="dashboard/public/assets/flightdeck-lockup-dark.svg">
    <img alt="Flightdeck" src="dashboard/public/assets/flightdeck-lockup-light.svg" width="360">
  </picture>
  <p><strong>See and control every AI agent you run, from one self-hosted binary.</strong></p>
  <p><a href="#install">Quickstart</a> · <a href="#coverage">Coverage</a> · <a href="#self-hosting">Self-hosting</a> · <a href="https://github.com/flightdeckhq/flightdeck/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap">Roadmap</a></p>
  <p>
    <a href="https://github.com/flightdeckhq/flightdeck/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/flightdeckhq/flightdeck"></a>
    <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
    <a href="https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  </p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/fleet-dark.png">
    <img alt="The Flightdeck fleet view: every agent on one live timeline, with its LLM calls, tool calls and policy events as they happen." src="assets/readme/fleet-light.png" width="680">
  </picture>
</div>

## Install

Installing Flightdeck is one command, on Linux and macOS:

```bash
curl -fsSL https://flightdeck-hq.com/install.sh | sh
```

Then start it:

```bash
flightdeck
```

The dashboard is at http://localhost:4000. Nothing needs configuring: the data is a SQLite file under `~/.flightdeck`, and agents on the same machine find it without a server address or a token.

<details>
<summary>Homebrew, pip, Docker, Windows and the release page</summary>

```bash
brew install flightdeckhq/tap/flightdeck   # Homebrew
pip install flightdeck-cli                 # PyPI: the same binary, as the flightdeck command
uvx flightdeck-cli                         # or run it from PyPI without installing
docker run -p 127.0.0.1:4000:4000 -v flightdeck:/data flightdeckhq/flightdeck
```

```powershell
irm https://flightdeck-hq.com/install.ps1 | iex
```

Every channel installs the same binary, for Linux, macOS and Windows on amd64 and arm64; the archives are on the [release page](https://github.com/flightdeckhq/flightdeck/releases). The installers download from that release and verify the archive's checksum (and the release's signature when `cosign` is installed). The Docker image creates an access token on its first start and prints it; agents need it as `FLIGHTDECK_TOKEN`. `flightdeck --help` lists the flags.

</details>

## Connect your agents

### Claude Code

In Claude Code, install the plugin:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
/reload-plugins
```

The session appears in the fleet view within seconds. The plugin captures prompts and sanitised tool inputs by default, since you are watching your own session. [plugin/README.md](plugin/README.md) covers its options, `claude -p` and CI runs, enforcement and privacy.

### Python agents

```bash
pip install flightdeck-sensor
```

```python
import flightdeck_sensor

flightdeck_sensor.init()
flightdeck_sensor.patch()
```

Those two lines go at the top of your entrypoint; nothing else in your code changes. Every call your agent makes through the Anthropic or OpenAI SDK or litellm, directly or inside a framework, is reported, with prompt capture off until you turn it on. [sensor/README.md](sensor/README.md) has the agent identity model, the environment variables and the known limitations.

For a Flightdeck on another machine, set `FLIGHTDECK_TOKEN` and `FLIGHTDECK_SERVER`: the sensor takes the ingestion address (`https://flightdeck.example.com/ingest`), the plugin the bare one (`https://flightdeck.example.com`). Runs that neither reaches (`claude --bare`, CI without the plugin, agents in other languages) can report over [OpenTelemetry](docs/opentelemetry.md).

## What you get

Flightdeck is an observability and control plane for AI agents that you host yourself. Every LLM call, tool call and MCP call your coding agents and production agents make streams to one dashboard as it happens, and from that dashboard you set token budgets, allow or block MCP servers, and stop an agent.

<table>
  <tr>
    <td width="33%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/tile-timeline-dark.png"><img alt="A detail of the fleet timeline: agents and their sub-agents, one row each, with events arriving." src="assets/readme/tile-timeline-light.png"></picture><br><sub>A live fleet timeline</sub></td>
    <td width="33%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/tile-agents-dark.png"><img alt="The agents table: tokens, latency, errors, sessions and cost per agent over seven days." src="assets/readme/tile-agents-light.png"></picture><br><sub>Cost and tokens per agent</sub></td>
    <td width="33%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/tile-policies-dark.png"><img alt="The MCP protection policy of one agent: one server allowed, one denied and blocked." src="assets/readme/tile-policies-light.png"></picture><br><sub>Budgets, MCP rules and the kill switch</sub></td>
  </tr>
</table>

- **Live fleet view.** Every agent on a shared timeline, sub-agents under their parent, with LLM calls, tool and MCP calls, policy events and errors plotted as they arrive.
- **Agents and events.** A table of every agent with seven-day token, latency, error, session and cost trends, and a search over every event by agent, type, model, framework or MCP server.
- **Run inspection.** A run's events in order, its token usage, its runtime context and the sub-agents it spawned; with capture on, each call's prompt, tools and response in the provider's own shape.
- **Token budgets.** A budget per agent flavor, enforced inside the agent: warn at a threshold, degrade to a cheaper model, block.
- **MCP server policy.** Allow or block MCP servers for the whole fleet or per agent flavor; the sensor and the Claude Code plugin enforce it at every MCP call.
- **Kill switch and directives.** Stop one agent, or every agent of a flavor, from the dashboard; register your own functions as directives and invoke them the same way.
- **Analytics and estimated cost.** Tokens, runs, latency, policy events and cost from public list prices, grouped by agent flavor, model, framework, host, team and more.

[docs/features.md](docs/features.md) describes each in full, and [docs/mcp-protection-policy.md](docs/mcp-protection-policy.md) the MCP policy. Events arriving on the fleet view:

![The fleet view over nine seconds: events arrive on every agent's row and in the live feed below.](assets/readme/fleet-live.gif)

## Coverage

| | Covered |
|---|---|
| LLM SDKs | Anthropic (`messages.create`, `.stream`, `.parse`, on every client class: first-party, Bedrock, Vertex, Foundry), OpenAI (Chat Completions, Responses, embeddings) and litellm, sync, async and streaming. Not yet: Gemini through `google-genai` ([#276](https://github.com/flightdeckhq/flightdeck/issues/276)), boto3 Bedrock Converse ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)). |
| Coding agents | Claude Code, through the plugin or its own OpenTelemetry export. |
| Sub-agents | A child session per sub-agent, linked to its parent: Claude Code sub-agents, CrewAI agents, LangGraph nodes, LlamaIndex agent workflows, OpenAI Agents SDK agents. |
| MCP | Tool calls, resource reads and prompt fetches through the official `mcp` SDK (1.28 and later, and 2.x), whichever framework drives it; tool calls for Claude Code. |

The sensor meters every LLM call a framework makes through the Anthropic or OpenAI SDK or litellm, live, and can stop or budget the run. For some frameworks it also opens a session per sub-agent, and some export OpenTelemetry spans that Flightdeck maps after the run, observe-only. Report a run one way: both paths together count it twice.

| Framework | LLM calls | Sub-agents | OpenTelemetry |
|---|---|---|---|
| LangChain | yes | no | no |
| LangGraph | yes | yes | no |
| CrewAI 1.14+ | OpenAI, Anthropic, litellm | yes | no |
| LlamaIndex | yes | yes | no |
| OpenAI Agents SDK 0.6+ | yes | yes | yes |
| Claude Agent SDK (Python) | yes | a session per run | no |
| Google ADK | not on Gemini | planned | yes |
| Pydantic AI | Anthropic and OpenAI models | through OpenTelemetry | yes |
| Strands Agents | not on Bedrock | through OpenTelemetry | yes |
| Microsoft Agent Framework | not on `AzureAIAgentClient` | planned | no |
| Deep Agents | yes | planned | no |
| Agno, Haystack, smolagents | yes | on the roadmap | no |
| AutoGen, AG2, Semantic Kernel | yes | no | no |
| DSPy | on its litellm engine | n/a | no |

[docs/coverage.md](docs/coverage.md) has the full matrices: every intercepted method, which providers of each framework are metered, how streams and errors are reported, the client types, and what is not planned.

## Self-hosting

The same binary serves a team. Started with `--domain`, or listening on any address but your own machine's, it refuses the development token, creates an access token on its first start and prints it once; make more under **Settings → Access tokens** and give them to your agents ([Connect your agents](#connect-your-agents)).

```bash
flightdeck --domain flightdeck.example.com
```

HTTPS on port 443 with a Let's Encrypt certificate, port 80 redirecting to it. The host needs a DNS record and both ports reachable.

```bash
flightdeck --database-url 'postgres://flightdeck:PASSWORD@db.example.com:5432/flightdeck'
```

Postgres instead of the SQLite file, for a larger fleet; the schema is created on the first start.

```bash
docker run -d --name flightdeck -p 127.0.0.1:4000:4000 -v flightdeck:/data flightdeckhq/flightdeck
```

The image is the binary with its data on the `flightdeck` volume; `docker logs flightdeck` shows the token. The port is published on `127.0.0.1` because whoever can reach it can read that token: publish it wider only behind a firewall or a proxy that authenticates.

```bash
git clone https://github.com/flightdeckhq/flightdeck
docker compose -f flightdeck/docker/docker-compose.yml up -d
helm install flightdeck flightdeck/helm/ --namespace flightdeck --create-namespace
```

Compose runs that image as one container on SQLite, and with [`docker-compose.postgres.yml`](docker/docker-compose.postgres.yml) layered on it, beside a Postgres. The Helm chart runs one pod on SQLite by default, or several on Postgres with a NATS cluster they share. Both read their files from a clone of this repository. [docs/self-hosting.md](docs/self-hosting.md) has their settings, the chart's values and the upgrade notes.

**Data and backups.** Everything is in the data dir (`--data-dir`, default `~/.flightdeck`): the SQLite database, the message-bus store and the secrets file. [docs/self-hosting.md](docs/self-hosting.md#backing-up) has the command that backs up a running instance.

**Upgrading.** Install the new release and start it; the binary migrates its database at start. [ARCHITECTURE.md](ARCHITECTURE.md) ("Deployment") lists every flag and environment variable.

## What Flightdeck is not

- **Not a proxy.** The sensor wraps SDK client classes inside the agent's own process; calls go directly to the provider. Nothing routes through Flightdeck.
- **Not a content inspector by default for production agents.** The Python sensor defaults to `capture_prompts=False`; with capture off, event payloads carry token counts, model names, latency, framework, and tool names only. The Claude Code plugin is the one exception: it captures prompts and sanitised tool inputs by default because you are observing your own session on your own machine, and `FLIGHTDECK_CAPTURE_PROMPTS=false` turns that off.
- **Not an orchestrator.** Flightdeck observes; it does not decide what an agent should do next. Directives (kill switch, model swap, custom handlers) are explicit operator actions.
- **Not a billing system.** `estimated_cost` is an approximation from public list prices. Treat as a sanity check.
- **Not a notification platform.** No Slack, email, or PagerDuty integrations.
- **Not multi-tenant SaaS.** Self-hosted only. One deployment, one tenant.
- **Not an evaluation or prompt-management tool.** No LLM-as-judge scoring, eval datasets or prompt versioning.
- **Not an LLM gateway.** No model substitution, no caching layer, no retries injected by Flightdeck. The sensor enforces budgets your agents already know about.

## Roadmap

Planned work is tracked as [GitHub issues labelled `roadmap`](https://github.com/flightdeckhq/flightdeck/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap), grouped by release milestone. React with :+1: on the ones you need; that is how they get prioritised.

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev stack, lint, test instructions, the playground, and the process for adding a new LLM provider.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

Built and maintained by [Omri Arnon](https://github.com/pykul) ([LinkedIn](https://www.linkedin.com/in/omriarnon/)). The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), the author's own open source token budget enforcement library.
