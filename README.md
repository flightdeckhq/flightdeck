# Flightdeck

The control plane for AI agent fleets.

Complete visibility, runtime control, and live time series tracing for every agent in your organization. See every prompt, every tool call, every completion as it happens. Execute custom actions on any agent or the entire fleet without redeploying -- clear a cache, rotate a credential, switch a prompt template, checkpoint state. Stop any agent or an entire fleet instantly. Enforce token budgets before they become incidents.

From a single developer session to hundreds of agents in production. Two lines of code. No proxies. No infrastructure changes. No single point of failure in your agent's execution path.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![PyPI](https://img.shields.io/pypi/v/flightdeck-sensor)](https://pypi.org/project/flightdeck-sensor/)
[![CI](https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/flightdeckhq/flightdeck/actions)

---

## The problem

Whether you are a solo developer debugging why your agent behaved unexpectedly, or a platform engineer managing hundreds of agents in production -- you have the same problem: you cannot see what your agents are actually doing.

You know a call was made. You see a token count. You have no idea what was in the system prompt, what the messages array looked like, what tools were available, what the model actually returned, or why the agent made the decision it did.

At scale the problem compounds. One agent enters a retry loop. Another starts calling endpoints you did not expect. A third consumes your entire monthly token budget in an afternoon. You have no way to intervene short of killing the entire deployment, and no idea what went wrong.

That is not a token problem. That is a visibility and control problem.

Provider-level spending caps are coarse and reactive. They cap your entire account, not individual agents, and they do not stop a session already in flight. SSH and kubectl exec are manual, slow, and do not scale to a fleet. Redeployment takes minutes you do not have.

Flightdeck gives you a control plane. See everything. Act on anything. Stop any agent in seconds.

---

## What it does

### Live time series tracing

Real-time dashboard. Every agent, every LLM call, every token, every tool invocation, plotted as it happens. Timeline view by agent flavor -- the same mental model as distributed tracing for microservices, applied to AI agents.

Click any event and the full session slides in. Every call in chronological order: model, tokens, latency, tool names, policy events. Expandable. Searchable. Live.

Whether you are running one agent locally or a thousand in production, the view is the same. Every session that calls `init()` appears in the fleet within seconds of starting.

### Full payload inspection

When you need to know exactly what your agent sent to the provider and what it got back, Flightdeck shows you everything. Enable prompt capture and every LLM call stores the complete payload -- exactly as it left the sensor, exactly as the provider received it.

```python
flightdeck_sensor.init(
    server="https://flightdeck.company.internal",
    token="...",
    capture_prompts=True,
)
```

Or via environment variable, with no code changes required:

```
FLIGHTDECK_CAPTURE_PROMPTS=true
```

For every LLM call you get:

- **System prompt** -- Anthropic's `system` parameter shown separately. OpenAI's system role shown in context.
- **Full messages array** -- every message, every role, in order, exactly as sent to the provider.
- **Tool definitions** -- every tool the agent had available for that call.
- **Tool call inputs and outputs** -- what the agent asked the tool to do and what it got back.
- **Full completion response** -- exactly what the model returned, before any processing by your code.

Provider terminology is preserved exactly. No normalization layer. No abstraction. What you see is what the model saw.

Off by default. The default path never touches message content. When capture is off, events contain token counts, model names, latency, and tool names only.

### Act on anything

Register Python functions as callable actions directly from the dashboard. No redeployment. No external API calls. The action executes inside the agent process on its next LLM call and the result appears in the session timeline within seconds.

```python
@flightdeck_sensor.directive(
    name="clear_cache",
    description="Clear the agent's prompt cache",
    parameters=[
        flightdeck_sensor.Parameter(
            name="cache_type",
            type="string",
            options=["all", "prompt", "tool"],
            default="all",
        )
    ]
)
def clear_cache(context, cache_type="all"):
    cleared = my_cache.clear(cache_type)
    return {"cleared": cleared}

flightdeck_sensor.init(server="...", token="...")
# clear_cache is now live in the dashboard.
```

The function appears in the dashboard the moment an agent calls `init()`. Select a session or an entire fleet, set the parameters, and send. The result appears in the session timeline within seconds.

Use it to clear caches, rotate credentials, switch prompt templates, checkpoint state, change verbosity, or anything else your agents need at runtime. No redeploy. No SSH. No waiting.

### Stop anything

Kill any individual agent or every agent of a given type simultaneously. One click in the dashboard. The directive arrives on the agent's next LLM call. Active agents in a loop stop within seconds. The session transitions to closed.

No kubectl. No SSH. No deployment.

Fleet-wide stop by agent type:

```
POST /v1/directives
{
  "action": "shutdown_flavor",
  "flavor": "research-agent",
  "reason": "runaway cost event"
}
```

Every agent with `AGENT_FLAVOR=research-agent` that makes an LLM call receives the directive and terminates gracefully.

### Enforce budgets

Define token policies centrally. Every agent enforces them automatically without code changes. Warn at 80%. Degrade to a cheaper model at 90%. Block at 100%. Policies attach to agent flavors and propagate on session start.

```
session: 82,000 / 100,000 tokens (82%)   -- warning fires, call proceeds
session: 91,200 / 100,000 tokens (91%)   -- model transparently degraded to haiku
session: 100,400 / 100,000 tokens (100%) -- BudgetExceededError raised, call blocked
```

The model swap is transparent to your agent code. The request is modified before it leaves the sensor. Your code never changes.

### Analytics

Aggregate views across every dimension. Token consumption, session counts, policy violations, model distribution, latency -- grouped by agent flavor, model, framework, host, team, or agent type. Flexible time range. The default charts answer the question any engineering leader asks first: where is the AI budget going, and which agents are responsible.

### Search

Find anything across your entire fleet with Cmd+K. Search by agent flavor, session ID, host, tool name, or model. Results grouped by agents, sessions, and events. Keyboard navigable. Results in under 500ms.

---

## What it deliberately does not do

**No proxy.** The sensor runs inside the agent process and reports out-of-band over HTTP. It never sits between your agent and the LLM provider. There is no single point of failure in your execution path.

**No content capture by default.** The default path never touches message content. Token counts, model names, latency, and tool names only.

**No infrastructure management.** Flightdeck manages what your agents do at runtime, not where they run or how they are deployed.

**No dollar costs.** Token counts are exact -- they come directly from the provider response. Dollar figures derived from stale pricing tables are not. Cost tracking is on the roadmap.

**No notifications yet.** Slack, email, and PagerDuty integration is planned for a future release.

---

## Quickstart

### Install the sensor

```
pip install flightdeck-sensor
```

### Add two lines to your agent

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="https://flightdeck.company.internal",
    token="...",
)

# Your existing agent code below. Nothing else changes.

import anthropic
client = anthropic.Anthropic()
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Research this topic."}],
)
```

The sensor intercepts every LLM call, reports to your control plane, and enforces any policy you have defined. Your agent code does not change.

### For agent frameworks

One line. The sensor patches SDK constructors so every client the framework builds internally is intercepted automatically.

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="https://flightdeck.company.internal",
    token="...",
)
flightdeck_sensor.patch()

from crewai import Agent, Task, Crew
# All LLM calls made by this crew are now tracked and controlled.
```

Works with LangChain, CrewAI, LlamaIndex, AutoGen, and any framework that uses the Anthropic or OpenAI SDKs internally.

### Start the control plane

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Open [http://localhost:4000](http://localhost:4000). Your agents appear in the timeline within seconds of starting.

The dev environment seeds a test token `tok_dev` automatically.

```python
import flightdeck_sensor
flightdeck_sensor.init(server="http://localhost:4000", token="tok_dev")
```

---

## Architecture

Flightdeck has no single point of failure in your agent's execution path. The sensor is a library, not a proxy. It runs inside your agent process, reports out-of-band over HTTP, and receives directives back in HTTP response envelopes. If the control plane goes down, your agents keep running -- with their cached policy or halted, depending on your `FLIGHTDECK_UNAVAILABLE_POLICY` setting.

```
Agent Fleet (flightdeck-sensor)
    |  HTTP fire-and-forget POST
    |  response envelope carries directives back
    v
Ingestion API (Go)  →  validates token, publishes to NATS, returns directive
    |
    v
NATS JetStream  →  durable event buffer
    |
    v
Go Workers  →  write fleet state + events to Postgres, evaluate policy
    |
    v
PostgreSQL  →  agents, sessions, events, token_policies, directives
    ^
    |  LISTEN/NOTIFY for real-time push
    |
Query API (Go)  →  REST + WebSocket for dashboard
    ^
    |
React Dashboard  →  fleet view, session drawer, analytics, search (Cmd+K)
```

---

## Identity model

Every agent session has two identities: a persistent flavor and an ephemeral session ID.

The **flavor** (`AGENT_FLAVOR`) represents what kind of agent this is -- its role, its policy attachment point, its place in the fleet view. Set it via environment variable, ideally injected by your Kubernetes Helm chart or deployment configuration. Policies attach to flavors. Custom actions target flavors.

The **session ID** is a UUID generated at `init()`. It represents one running instance. The fleet timeline shows sessions. The fleet health panel shows flavors.

```yaml
# values.yaml (Helm)
env:
  - name: AGENT_FLAVOR
    value: "research-agent"
  - name: AGENT_TYPE
    value: "autonomous"
  - name: FLIGHTDECK_SERVER
    value: "https://flightdeck.svc.cluster.local"
  - name: FLIGHTDECK_TOKEN
    valueFrom:
      secretKeyRef:
        name: flightdeck-token
        key: token
```

If `AGENT_FLAVOR` is not set, the sensor defaults to `unknown`. The agent appears in the fleet view flagged as unregistered. This is how shadow AI agents -- agents deployed outside the blessed configuration -- are detected automatically.

---

## Unavailability policy

If the control plane is unreachable, the sensor falls back to one of two behaviors:

```
FLIGHTDECK_UNAVAILABLE_POLICY=continue  # default: run with cached policy
FLIGHTDECK_UNAVAILABLE_POLICY=halt      # block new sessions until CP responds
```

`continue` is for teams where agent availability is critical. Agents run with their last known cached policy until the control plane comes back.

`halt` is for regulated environments where ungoverned agents cannot run even briefly. New `init()` calls block until the control plane responds. In-flight sessions complete normally.

---

## Production deployment (Kubernetes)

```bash
helm repo add flightdeck https://charts.flightdeck.dev
helm install flightdeck flightdeck/flightdeck \
  --set flightdeck.server.token=your-token \
  --namespace flightdeck \
  --create-namespace
```

See the [production deployment guide](docs/production.md) for TLS configuration, HA setup, and security hardening.

---

## Claude Code plugin

Developer Claude Code sessions appear in the fleet view alongside production agents. Shadow developer usage becomes visible to platform engineers without requiring developers to change anything.

```
claude plugin install flightdeck
```

Sessions from Claude Code appear with `AGENT_TYPE=developer`. The dashboard has a filter toggle to show production sessions, developer sessions, or both.

---

## Supported providers and frameworks

| Provider | Install | Notes |
|---|---|---|
| Anthropic | `pip install flightdeck-sensor[anthropic]` | Sync, async, streaming |
| OpenAI | `pip install flightdeck-sensor[openai]` | Sync, async, streaming, tiktoken for estimation |

---

## Development

### Prerequisites

| Tool | Minimum | Purpose |
|---|---|---|
| Docker + Compose | v24+ | Running the full platform stack |
| Go | 1.22+ | Building the backend services |
| Python | 3.9+ | Building and testing the sensor |
| Node.js | 20+ | Building the dashboard |

### Running locally

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
cp docker/.env.example docker/.env
make dev
```

`make dev` builds all images, starts all 7 services, and waits for every health check to pass before returning. Open [http://localhost:4000](http://localhost:4000).

### Running tests

```bash
make test              # unit tests across all components
make test-integration  # full pipeline integration tests (requires Docker)
make lint              # ruff + mypy --strict, golangci-lint, tsc + eslint
```

---

## How this was built

Flightdeck is built using a deliberate Supervisor/Executor methodology for managing complex projects with AI assistants. See [METHODOLOGY.md](METHODOLOGY.md) for the full writeup.

The sensor is built on the foundation of [tokencap](https://github.com/pykul/tokencap), an open source token budget enforcement library.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
