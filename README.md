# Flightdeck

**The control platform for AI agent fleets.**

See every agent. Know what it's doing. Stop it when you have to.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![PyPI](https://img.shields.io/pypi/v/flightdeck-sensor)](https://pypi.org/project/flightdeck-sensor/)
[![CI](https://github.com/flightdeckhq/flightdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/flightdeckhq/flightdeck/actions)

---

## The problem

You have AI agents running in production. You do not know how many. You cannot see what they are doing right now. When one goes wrong you find out from a bill, a bug report, or a teammate. There is no way to stop it without SSH access or a redeployment.

Flightdeck fixes all of that.

---

## Two lines. Full visibility.

```python
import flightdeck_sensor
flightdeck_sensor.init(server="https://flightdeck.company.internal", token="...")
```

That is it. No proxy. No gateway. No traffic rerouting. Works with Anthropic, OpenAI, LangChain, CrewAI, AutoGen, LlamaIndex, and the OpenAI Agents SDK.

---

## What you get

### Live fleet view
Every agent running across your org. Right now. Swim lanes by agent type, events flowing in real time. Click any event to drill into the full session.

### Full session history
Every LLM call. Every tool call. Every token count. Every policy event. In sequence, with full payloads. Reconstruct exactly what happened and why.

### Prompt visibility *(opt-in)*
When enabled, capture the full messages array and system prompt per call. See exactly what each agent sent and received. Off by default -- enable per deployment.

```yaml
# values.yaml
flightdeck:
  capturePrompts: false  # set to true to enable
```

### Token enforcement
Set budgets at any level -- org-wide, per agent type, per team, per session. Warn at 80%. Degrade to a cheaper model at 90%. Block at 100%. Defined centrally. Enforced everywhere automatically.

### Kill switch
Stop any agent from the dashboard. Or stop every agent of a given type across the entire fleet simultaneously. The directive arrives on the agent's next LLM call. No SSH. No kubectl exec. Sub-second.

### Analytics
Token consumption, session counts, policy violations, model distribution -- broken down by any dimension: agent type, model, framework, team, host. Flexible grouping on every chart. Default views answer the first question any engineering leader asks: *where is my AI budget going?*

### Shadow agent detection
Agents that start without a registered identity appear flagged in the fleet view automatically. Nothing runs invisible.

### Claude Code plugin
Developer Claude Code sessions appear in the fleet view alongside production agents. Shadow developer usage becomes visible.

```
claude plugin install flightdeck
```

---

## Quick start

### Docker Compose (try it in 5 minutes)

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Open [http://localhost:4000](http://localhost:4000). Enroll your first agent:

```bash
pip install flightdeck-sensor
```

```python
import flightdeck_sensor
flightdeck_sensor.init(server="http://localhost:4000", token="tok_dev")

# Your existing agent code. Nothing else changes.
```

### Kubernetes (production)

```bash
helm repo add flightdeck https://charts.flightdeck.dev
helm install flightdeck flightdeck/flightdeck \
  --set flightdeck.server.token=your-token \
  --namespace flightdeck \
  --create-namespace
```

Set the agent identity in your deployment:

```yaml
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

---

## Dashboard

**Fleet view** -- the primary surface. Real-time timeline with swim lanes by agent type. Every event visible as it happens. Pause and scrub for historical investigation. Click any event, the full session slides in from the right.

**Session drawer** -- the complete story of any session. Full event timeline, expandable payloads, token usage bar with threshold markers, prompt history when capture is enabled.

**Analytics page** -- aggregate views for engineering leaders. Default charts: token consumption over time, top agent types by spend, sessions by type, model distribution, policy events. Every chart has a group-by control. Slice by flavor, model, framework, host, team, or agent type. Global time range filter applies to all charts.

**Global search** -- Cmd+K to find any agent, session, event, tool call, or policy violation. Results in under a second.

---

## Architecture

```
Agent Fleet (flightdeck-sensor)
    ↓  HTTP fire-and-forget
Ingestion API (Go)
    ↓  NATS JetStream
Go Workers
    ↓
PostgreSQL
    ↑
Query API (Go)
    ↑  WebSocket + REST
React Dashboard
```

No proxy. No single point of failure. If the control plane goes down, agents continue running with their last known policy or halt -- your choice per deployment.

---

## What Flightdeck does not do

- It does not proxy LLM traffic
- It does not capture prompts unless you explicitly enable it
- It does not send data to any third party -- self-hosted only
- It does not tell agents what to do

---

## Methodology

Flightdeck is built using a deliberate Supervisor/Executor methodology for managing complex projects with AI assistants. See [METHODOLOGY.md](METHODOLOGY.md) for the full writeup.

The sensor is built on the foundation of [tokencap](https://github.com/pykul/tokencap).

---

## Contributing

```bash
make test            # unit tests, all components
make test-integration # full pipeline (requires Docker)
make lint            # all linters
make dev             # start local dev environment
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Apache 2.0. See [LICENSE](LICENSE).
