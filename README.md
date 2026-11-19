<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="dashboard/public/assets/flightdeck-lockup-dark.svg">
    <img alt="Flightdeck" src="dashboard/public/assets/flightdeck-lockup-light.svg" width="280">
  </picture>
  <p><strong>See and control every AI agent you run, from one self-hosted binary.</strong></p>
  <p>An observability and control plane for AI agents: every LLM, tool and MCP call as it happens, with token budgets, MCP policy and a kill switch.</p>
  <p>
    <a href="#what-you-get">What it is</a> · <a href="#install">Quickstart</a> · <a href="#coverage">Coverage</a> · <a href="#self-hosting">Self-hosting</a> · <a href="https://github.com/flightdeckhq/flightdeck/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap">Roadmap</a>
    &nbsp;
    <a href="https://github.com/flightdeckhq/flightdeck/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/flightdeckhq/flightdeck"></a>
    <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
    <a href="https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  </p>
  <a href="assets/readme/fleet-dark.png"><img alt="The Flightdeck fleet view: every agent on one live timeline, with its LLM calls, tool calls and policy events as they happen." src="assets/readme/fleet-dark.png" width="440"></a>
</div>

## Install

Installing Flightdeck is one command.

**Linux and macOS**

```bash
curl -fsSL https://flightdeck-hq.com/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://flightdeck-hq.com/install.ps1 | iex
```

Then start it:

```bash
flightdeck
```

The dashboard is at http://localhost:4000, and nothing needs configuring: agents on the same machine find it without a server address or a token; `flightdeck --port 4100` runs it on another port, and `flightdeck --help` lists the flags. The binary goes to `/usr/local/bin` or `~/.local/bin` and the data, a SQLite file, to `~/.flightdeck`; on Windows, to `%LOCALAPPDATA%\Programs\flightdeck` and `%LOCALAPPDATA%\flightdeck`. If `flightdeck` is not found, run the `PATH` line the installer printed, or on Windows open a new PowerShell window. [guides/windows.md](guides/windows.md) has the rest for Windows.

To keep it running on Linux or macOS, starting at every login and again if it stops, run `flightdeck service install` once, with the flags you start it with (`flightdeck service install --port 4100`); it needs no sudo. `flightdeck service status` shows it, `flightdeck service restart` runs a newly installed release, and `flightdeck service remove` removes it and keeps the data. [guides/self-hosting.md](guides/self-hosting.md#running-in-the-background) has the details.

### Other ways to install

Every channel installs the same binary, built for Linux, macOS and Windows on amd64 and arm64.

**Homebrew**

```bash
brew install flightdeckhq/tap/flightdeck
```

**PyPI**, as the `flightdeck` command:

```bash
pip install flightdeck-cli
```

Or run it from PyPI without installing:

```bash
uvx flightdeck-cli
```

**Docker**: the image creates an access token on its first start and prints it; agents need it as `FLIGHTDECK_TOKEN`. After a stop, `docker start -a flightdeck` runs the same container again.

```bash
docker run --name flightdeck -p 127.0.0.1:4000:4000 -v flightdeck:/data flightdeckhq/flightdeck
```

**Release page**: the archives for every platform are on the [release page](https://github.com/flightdeckhq/flightdeck/releases). The installers above download from that release and verify the archive's checksum (and the release's signature when `cosign` is installed).

### Upgrade and uninstall

| Installed with | Upgrade | Uninstall |
|---|---|---|
| The install command | Stop Flightdeck, run the install command again, start it | Delete the `flightdeck` file the installer put in `/usr/local/bin` or `~/.local/bin`, and the `PATH` line you added for it, if any; on Windows, [these steps](guides/windows.md#uninstall) |
| Homebrew | `brew upgrade flightdeckhq/tap/flightdeck`, then restart Flightdeck (`brew services restart flightdeck` for the service) | `brew services stop flightdeck` if it runs as a service, then `brew uninstall flightdeckhq/tap/flightdeck` |
| PyPI | Stop Flightdeck, `pip install --upgrade flightdeck-cli`, start it; with uvx, `uvx flightdeck-cli@latest` | `pip uninstall flightdeck-cli`; uvx installs nothing, and `uv cache clean flightdeck-cli`, then `uv cache prune`, remove its cached copy |
| Docker | `docker pull flightdeckhq/flightdeck`, `docker stop flightdeck`, `docker rm flightdeck`, then the same `docker run` again | `docker stop flightdeck`, `docker rm flightdeck`, then `docker rmi flightdeckhq/flightdeck` |

The first start of a new release migrates the database when the release changes its schema, and an older release does not start on it after that. On SQLite that start first keeps a copy in `~/.flightdeck/backups/`, and `flightdeck backup` takes one whenever you like, while Flightdeck runs; `flightdeck restore <file>`, with Flightdeck stopped, puts one back and keeps the database it replaces ([guides/self-hosting.md](guides/self-hosting.md#backing-up-and-restoring), which also has Postgres). With `flightdeck service`, the stop and the start of an upgrade are one `flightdeck service restart` after the new release is installed: the service runs the old binary until it restarts. To uninstall, first run `flightdeck service remove` if you installed the service, and `flightdeck connect claude-code --remove` (without the binary, `claude plugin uninstall flightdeck@flightdeck-plugins`): a plugin left installed warns at the start of every Claude Code session that it cannot reach Flightdeck. Then remove the binary as above. The data dir stays (`~/.flightdeck`, `%LOCALAPPDATA%\flightdeck`, or the `flightdeck` volume): Flightdeck does not delete sessions or events, so delete the directory (`docker volume rm flightdeck`) only to remove all of them.

## Connect your agents

### Claude Code

The installer offers this when it finds Claude Code; otherwise:

```bash
flightdeck connect claude-code
```

It installs the Flightdeck plugin for your user, and the sessions you start from then on appear in the fleet view within seconds. It points the plugin at the Flightdeck running on this machine, on whichever port it was started (`flightdeck --port 4100`), and if none runs yet it says to start it. `flightdeck connect` shows whether Claude Code is connected and to which server. It needs a recent Claude Code: with an older one it changes nothing and says to run `claude update`. Or install the plugin from inside Claude Code:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
/reload-plugins
```

The plugin captures prompts and sanitised tool inputs by default, since you are watching your own session. [plugin/README.md](plugin/README.md) covers its options, `claude -p` and CI runs, enforcement and privacy.

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

For a Flightdeck on another machine, set `FLIGHTDECK_SERVER` to its address (`https://flightdeck.example.com`; the ingestion URL its start-up block prints works too) and `FLIGHTDECK_TOKEN` to a token minted under **Settings → Access tokens**: the plugin and the sensor take the same two values. For Claude Code, `flightdeck connect claude-code --server <address> --token-file <file>` saves both in the plugin's options instead. Runs that neither reaches (`claude --bare`, CI without the plugin, agents in other languages) can report over [OpenTelemetry](guides/opentelemetry.md).

## What you get

Flightdeck is an observability and control plane for AI agents that you host yourself. Every LLM call, tool call and MCP call your coding agents and production agents make streams to one dashboard as it happens, and from that dashboard you set token budgets, allow or block MCP servers, and stop an agent.

<table>
  <tr>
    <td width="33%" valign="top"><a href="assets/readme/tile-timeline-dark.png"><img alt="A detail of the fleet timeline: agents and their sub-agents, one row each, with events arriving." src="assets/readme/tile-timeline-dark.png"></a><br><sub>A live fleet timeline</sub></td>
    <td width="33%" valign="top"><a href="assets/readme/tile-agents-dark.png"><img alt="The agents table: tokens, latency, errors, sessions and cost per agent over seven days." src="assets/readme/tile-agents-dark.png"></a><br><sub>Cost and tokens per agent</sub></td>
    <td width="33%" valign="top"><a href="assets/readme/tile-control-dark.png"><img alt="A run's drawer: a blocked MCP call at the top of its timeline and the Stop Agent button in its header." src="assets/readme/tile-control-dark.png"></a><br><sub>A blocked MCP call and the kill switch</sub></td>
  </tr>
</table>

- **Live fleet view.** Every agent on a shared timeline, sub-agents under their parent, with LLM calls, tool and MCP calls, policy events and errors plotted as they arrive.
- **Agents and events.** A table of every agent with seven-day token, latency, error, session and cost trends, and a search over every event by agent, type, model, framework or MCP server.
- **Run inspection.** A run's events in order, its token usage, its runtime context and the sub-agents it spawned; with capture on, each call's prompt, tools and response in the provider's own shape.
- **Token budgets.** A budget per agent flavor, enforced inside the agent: warn at a threshold, degrade to a cheaper model, block.
- **MCP server policy.** Allow or block MCP servers for the whole fleet or per agent flavor; the sensor and the Claude Code plugin enforce it at every MCP call.
- **Kill switch and directives.** Stop one agent, or every agent of a flavor, from the dashboard; register your own functions as directives and invoke them the same way.
- **Analytics and estimated cost.** Tokens, runs, latency, policy events and cost from public list prices, grouped by agent flavor, model, framework, host, team and more.

[guides/features.md](guides/features.md) describes each in full, and [guides/mcp-protection-policy.md](guides/mcp-protection-policy.md) the MCP policy. Events arriving on the fleet view:

![The fleet view over nine seconds: events arrive on every agent's row and in the live feed below.](assets/readme/fleet-live.gif)

## Coverage

| | Covered |
|---|---|
| LLM SDKs | Anthropic (`messages.create`, `.stream`, `.parse`, on every client class: first-party, Bedrock, Vertex, Foundry), OpenAI (Chat Completions, Responses, embeddings), Gemini through `google-genai` (`generate_content`, `generate_content_stream`, `embed_content`, chats; the Gemini API and Vertex AI) and litellm, sync, async and streaming. Not yet: boto3 Bedrock Converse ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)). |
| Coding agents | Claude Code, through the plugin or its own OpenTelemetry export. |
| Sub-agents | A child session per sub-agent, linked to its parent: Claude Code sub-agents, CrewAI agents, LangGraph nodes and nested graph runs, Deep Agents sub-agents, LlamaIndex agent workflows, OpenAI Agents SDK agents, Google ADK sub-agents. |
| MCP | Tool calls, resource reads and prompt fetches through the official `mcp` SDK (1.28 and later, and 2.x), whichever framework drives it; tool calls for Claude Code. |

The sensor meters every LLM call a framework makes through the Anthropic, OpenAI or google-genai SDK or litellm, live, and can stop or budget the run. For some frameworks it also opens a session per sub-agent, and some export OpenTelemetry spans that Flightdeck maps after the run, observe-only. Report a run one way: both paths together count it twice.

| Framework | LLM calls | Sub-agents | OpenTelemetry |
|---|---|---|---|
| LangChain | yes | an agent run inside another | no |
| LangGraph | yes | yes | no |
| CrewAI 1.14+ | OpenAI, Anthropic, Gemini, litellm | yes | no |
| LlamaIndex | yes | yes | no |
| OpenAI Agents SDK 0.6+ | yes | yes | yes |
| Claude Agent SDK (Python) | yes | a session per run | no |
| Google ADK 2.13+ | yes | yes | yes |
| Pydantic AI | Anthropic and OpenAI models (`GoogleModel` not verified) | through OpenTelemetry | yes |
| Strands Agents | not on Bedrock (`GeminiModel` not verified) | through OpenTelemetry | yes |
| Microsoft Agent Framework | not on `AzureAIAgentClient` | planned | no |
| Deep Agents | yes | yes | no |
| Agno, Haystack, smolagents | yes | on the roadmap | no |
| AutoGen, AG2, Semantic Kernel | yes | no | no |
| DSPy | on its litellm engine | n/a | no |

[guides/coverage.md](guides/coverage.md) has the full matrices: every intercepted method, which providers of each framework are metered, how streams and errors are reported, the client types, and what is not planned.

## Self-hosting

The same binary serves a team. Started with `--public` (every network interface, so other machines reach it), with `--domain`, or with `--listen <address>:<port>` on an address beyond your own machine, it refuses the development token, creates an access token on its first start and prints it once; make more under **Settings → Access tokens** and give them to your agents ([Connect your agents](#connect-your-agents)). Whoever can reach the server can read that token, so open it only on a network you trust, or put it behind a proxy that authenticates.

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

Compose runs that image as one container on SQLite, and with [`docker-compose.postgres.yml`](docker/docker-compose.postgres.yml) layered on it, beside a Postgres. The Helm chart runs it as a StatefulSet: by default one pod on SQLite with the embedded bus, with nothing to set. More than one pod needs a Postgres (`postgres.enabled=true` with `postgres.password`, or `postgres.externalUrl`) and a NATS they share (the chart's, with `nats.auth.token`, or `nats.externalUrl`). The notes `helm install` prints say how to open the dashboard and read the token; `flightdeck.dashboardTokenSecret` names a Secret holding a token you supply, and a host name beyond the chart's Service and Ingress names goes in `flightdeck.extraAllowedHosts`. Both read their files from a clone of this repository. [guides/self-hosting.md](guides/self-hosting.md#kubernetes-helm) has their settings, the chart's values and the upgrade notes.

**Data and backups.** Everything is in the data dir (`--data-dir`, default `~/.flightdeck`): the SQLite database, the message-bus store and the secrets file. [guides/self-hosting.md](guides/self-hosting.md#backing-up-and-restoring) has how to back up a running instance and restore it, on SQLite and on Postgres.

**Upgrading.** [Upgrade and uninstall](#upgrade-and-uninstall) has the commands for each install channel; the binary migrates its database at start. [guides/self-hosting.md](guides/self-hosting.md) has the Compose and Helm upgrades, and [guides/windows.md](guides/windows.md) upgrading on Windows, the firewall and removing it. [ARCHITECTURE.md](ARCHITECTURE.md) ("Deployment") lists every flag and environment variable.

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
