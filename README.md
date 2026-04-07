# Flightdeck

Flightdeck is an open source control platform for AI agent fleets. Add two lines
to any Python AI agent and get a live dashboard showing every agent running across
your organization -- what it is doing, what tools it has called, how many tokens it
has consumed, and the full history of every LLM interaction it has made. Define token
budgets centrally and enforce them at call time. Stop any agent or an entire fleet of
agents from a single dashboard action.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![PyPI](https://img.shields.io/pypi/v/flightdeck-sensor)](https://pypi.org/project/flightdeck-sensor/)
[![CI](https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/flightdeckhq/flightdeck/actions)

---

## The problem

These are not edge cases. They happen constantly.

A research agent entered a retry loop and ran undetected for three days. Bill: $47,000.
A code generation pipeline spawned subagents that called the same API 200 times in ten
minutes. Bill: $187 before anyone noticed. A multi-tenant SaaS had one runaway session
exhaust the entire monthly API budget allocated across all customers.

The common thread: nobody knew the agents were running. There was no way to see them,
no way to stop them mid-flight, and no way to enforce a limit before the damage was done.

Provider-level spending caps help but they are coarse and reactive -- they cap your
entire account, not individual agents, and they do not stop a session that is already
in progress. Flightdeck gives you enforcement in your code, visibility in a dashboard,
and a kill switch you can pull from anywhere.

---

## What it does and deliberately does not do

**Does:**

* Run as a sensor inside any Python AI agent with two lines of code
* Give you a live dashboard showing every agent running across your org right now
* Track token usage per session, per agent type, per team, and org-wide
* Enforce token budgets at call time: warn the developer, degrade to a cheaper model,
  or block the call entirely -- before tokens are spent
* Capture the full messages array, system prompt, and tool definitions per call
  when you opt in -- so you can see exactly what each agent sent and received
* Let you stop any individual agent or every agent of a given type across the fleet
  from the dashboard, with the directive arriving on the agent's next LLM call
* Detect agents running without a registered identity and flag them in the fleet view
* Connect Claude Code developer sessions to the same fleet view via a plugin

**Does not:**

* Proxy or intercept LLM traffic at the network layer. There is no single point of
  failure introduced into your agent's execution path.
* Capture prompt content unless you explicitly enable it per deployment. The default
  path never touches message content.
* Calculate dollar costs. Token counts are always accurate because they come directly
  from the provider response. Dollar figures derived from a stale pricing table are
  not. Cost conversion is on the roadmap.
* Send notifications to Slack, email, or PagerDuty. That is planned for a future
  release.

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

# Everything below this line is your existing agent code.
# No other changes needed.

import anthropic

client = anthropic.Anthropic()
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Research this topic."}],
)
```

The sensor intercepts every LLM call, reports events to your Flightdeck control plane,
and enforces any token policy you have configured -- all without touching your agent
logic or adding latency to the call path.

### For agent frameworks (LangChain, CrewAI, AutoGen, LlamaIndex)

One line at the top of your script. The sensor patches the SDK constructors so every
client the framework builds internally is intercepted automatically.

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="https://flightdeck.company.internal",
    token="...",
)
flightdeck_sensor.patch()  # intercepts all Anthropic + OpenAI clients

from crewai import Agent, Task, Crew

researcher = Agent(role="Researcher", goal="Research the topic", llm="anthropic/claude-sonnet-4-6")
# All LLM calls made by this crew are now tracked and policy-enforced.
```

### Start the control plane

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Open [http://localhost:4000](http://localhost:4000). Your agents will appear in the
timeline within seconds of starting.

---

## Token enforcement

Set a budget at any level: org-wide, per agent type, per team, or per individual
session. The policy is defined centrally and pulled by the sensor on session start.
Enforcement runs locally in the sensor -- no control plane call required on every
LLM call.

```python
# No code changes in your agent. Policy is configured in the dashboard
# or via the API. The sensor enforces it automatically.
flightdeck_sensor.init(server="...", token="...")
```

When the session reaches 80% of its token budget, the sensor fires a warning
callback. At 90%, subsequent calls are transparently rerouted to a cheaper model.
At 100%, the next call raises `BudgetExceededError` before it reaches the provider.

```
session: 82,000 / 100,000 tokens (82.0%)  -- warning fires, call proceeds
session: 91,200 / 100,000 tokens (91.2%)  -- model degraded to claude-haiku-4-5
session: 100,400 / 100,000 tokens (100.4%) -- BudgetExceededError raised
```

The DEGRADE action is transparent to your agent code. The model parameter is swapped
in a copy of the request before it leaves -- your code never changes.

---

## Kill switch

Stop any running agent from the dashboard. Or stop every agent of a given type across
the entire fleet simultaneously. The directive is delivered inside the HTTP response
envelope of the sensor's next event POST -- no persistent connection required, no SSH,
no kubectl exec.

From the dashboard, click the stop button on any session. The agent receives the
directive on its next LLM call and terminates gracefully within the configured grace
period (default: 5 seconds).

For a fleet-wide stop -- every agent of a given type:

```
POST /v1/directives
{
  "action": "shutdown_flavor",
  "flavor": "research-agent",
  "reason": "runaway cost event",
  "grace_period_ms": 5000
}
```

Every agent with `AGENT_FLAVOR=research-agent` that makes an LLM call within the
next heartbeat interval receives the directive and terminates.

---

## Prompt capture (opt-in)

By default, Flightdeck tracks token counts, model names, tool call names, and
latency. It never reads or stores the content of your prompts or responses.

When you enable prompt capture, the sensor also captures the full messages array,
system prompt, tool definitions, and completion response for every LLM call. This
content is stored separately from event metadata and fetched on demand when you
open the session drawer in the dashboard.

```python
flightdeck_sensor.init(
    server="https://flightdeck.company.internal",
    token="...",
    capture_prompts=True,  # off by default
)
```

Or via environment variable, which is the recommended approach so engineers do not
need to change their agent code:

```
FLIGHTDECK_CAPTURE_PROMPTS=true
```

Provider terminology is preserved exactly. Anthropic's `system` parameter is shown
separately. OpenAI's `messages` array with all role types is shown as sent. No
normalization layer to reason about when debugging.

---

## Identity model

Every agent session has two identities: a persistent flavor and an ephemeral session
ID.

The **flavor** (`AGENT_FLAVOR`) represents what kind of agent this is -- its role,
its policy attachment point, its place in the fleet view. Set it via environment
variable, ideally injected by your Kubernetes Helm chart or deployment configuration.
Policies attach to flavors.

The **session ID** is a UUID generated at `init()`. It represents one running
instance. The fleet timeline shows sessions. The fleet health panel shows flavors.

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

If `AGENT_FLAVOR` is not set, the sensor defaults to `unknown`. The agent appears
in the fleet view flagged as unregistered. This is how shadow AI agents -- agents
deployed outside the blessed configuration -- are detected automatically.

---

## Unavailability policy

If the control plane is unreachable, the sensor falls back to one of two behaviors
depending on your deployment configuration:

```
FLIGHTDECK_UNAVAILABLE_POLICY=continue  # default: run with cached policy
FLIGHTDECK_UNAVAILABLE_POLICY=halt      # block new sessions until CP responds
```

`continue` is for teams where agent availability is critical. Agents run with their
last known cached policy until the control plane comes back. No enforcement gap is
logged silently -- the dashboard shows the outage window.

`halt` is for regulated environments where ungoverned agents cannot run even briefly.
New `init()` calls block until the control plane responds. In-flight sessions
complete normally.

---

## Dashboard

The fleet view is the primary surface. A real-time timeline with swim lanes by agent
flavor, events flowing in as they happen. Click any event and the full session slides
in from the right.

The session drawer shows the complete history of that session: every LLM call, every
tool call, every token count, every policy event, in chronological order. Each event
is expandable to show the full payload, latency, and model used. When prompt capture
is enabled, a Prompts tab shows the full messages array as sent to the provider.

The analytics page provides aggregate views with flexible breakdown. Token consumption,
session counts, policy violations, model distribution -- grouped by any dimension:
agent flavor, model, framework, host, team, or agent type. The default charts answer
the question any engineering leader asks first: where is the AI budget going?

---

## Architecture

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
PostgreSQL  →  agents, sessions, events, policies, directives
    ^
    |  LISTEN/NOTIFY for real-time push
    |
Query API (Go)  →  REST + WebSocket for dashboard
    ^
    |
React Dashboard  →  fleet view, session drawer, analytics, search (Cmd+K)
```

The sensor runs in-process inside your agent. It never sits between your agent and
the LLM provider. If the control plane goes down, agents continue running -- either
with their cached policy or halted, depending on your `FLIGHTDECK_UNAVAILABLE_POLICY`
setting. There is no single point of failure in your agent's execution path.

---

## Production deployment (Kubernetes)

```bash
helm repo add flightdeck https://charts.flightdeck.dev
helm install flightdeck flightdeck/flightdeck \
  --set flightdeck.server.token=your-token \
  --namespace flightdeck \
  --create-namespace
```

See the [production deployment guide](docs/production.md) for TLS configuration,
HA setup, and security hardening.

---

## Claude Code plugin

Developer Claude Code sessions appear in the fleet view alongside production agents.
Shadow developer usage becomes visible to platform engineers without requiring
developers to change anything.

```
claude plugin install flightdeck
```

Sessions from Claude Code appear with `AGENT_TYPE=developer`. The dashboard has a
filter toggle to show production sessions, developer sessions, or both.

---

## Supported providers and frameworks

| Provider | Install | Notes |
|---|---|---|
| Anthropic | `pip install flightdeck-sensor[anthropic]` | Sync, async, streaming |
| OpenAI | `pip install flightdeck-sensor[openai]` | Sync, async, streaming, tiktoken for estimation |

Patch mode works transparently with any framework that uses the Anthropic or OpenAI
SDKs internally: LangChain, CrewAI, LlamaIndex, AutoGen, OpenAI Agents SDK.

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

`make dev` builds all images, starts all 7 services, and waits for every health
check to pass before returning. Open [http://localhost:4000](http://localhost:4000).

The dev environment seeds a test enrollment token `tok_dev` automatically.

```python
import flightdeck_sensor
flightdeck_sensor.init(server="http://localhost:4000", token="tok_dev")
```

### Running tests

```bash
make test              # unit tests across all components
make test-integration  # full pipeline integration tests (requires Docker)
make test-smoke        # smoke test against real provider APIs (see below)
make lint              # ruff + mypy --strict, golangci-lint, tsc + eslint
```

### Smoke test

The smoke test runs every Phase 1 feature against real provider APIs with a
live Flightdeck stack. It is a plain Python script, not pytest.

Requirements:
- `make dev` (stack must be running)
- `pip install anthropic openai`
- Anthropic and/or OpenAI API keys in environment

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
python tests/smoke/smoke_test.py
```

Each scenario is independent. Comment out any section to skip it. The full run
costs roughly $0.05-0.10. API keys are read from environment only and are never
printed or logged.

---

## How this was built

Flightdeck is built using a deliberate Supervisor/Executor methodology for managing
complex projects with AI assistants. See [METHODOLOGY.md](METHODOLOGY.md) for the
full writeup.

The sensor is built on the foundation of
[tokencap](https://github.com/pykul/tokencap), an open source token budget
enforcement library.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
