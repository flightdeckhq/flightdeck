# Flightdeck

Observability and control for AI agent fleets.

See every LLM call, tool use, and token spend across your entire fleet in real time. Stop any agent, enforce budgets, and execute custom actions without redeploying.

---

<!-- Fleet view demo — replace with actual recording -->
![Fleet view](docs/assets/fleet-demo.gif)
*Live fleet view — events stream in as agents run. Click any session to inspect every call.*

<!-- Session drawer demo — replace with actual recording -->
![Session drawer](docs/assets/session-demo.gif)
*Full session detail — every LLM call, tool use, and policy event in order. Prompt and response captured separately when enabled.*

---

## Install

```bash
pip install flightdeck-sensor
```

## Add two lines

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="http://localhost:4000",
    token="tok_dev",
)

# Your existing agent code. Nothing changes.
import anthropic
client = anthropic.Anthropic()
```

Works with OpenAI too. For frameworks (LangChain, CrewAI, LlamaIndex, AutoGen), add one more line:

```python
flightdeck_sensor.patch()
# Every client the framework builds is intercepted automatically.
```

## Start the control plane

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Open [http://localhost:4000](http://localhost:4000). Your agents appear in the fleet view within seconds of calling `init()`.

The dev environment seeds a test token `tok_dev` automatically — no configuration needed to get started.

---

## What you get

**Live fleet timeline**
Every agent session on a shared time axis. LLM calls, tool uses, policy events, and directives plotted as colored nodes as they happen. Click any event to inspect the full call inline.

**Full payload inspection**
Enable prompt capture to store the complete payload for every LLM call. System prompt, messages, tool definitions, and the full model response are stored and displayed in separate fields. Off by default.

```python
flightdeck_sensor.init(
    server="...",
    token="...",
    capture_prompts=True,
)
```

Anthropic sessions show `system`, `messages`, `tools`, and `response` as separate collapsible sections. OpenAI sessions show `messages` (including system role), `tools`, and `response`. Provider terminology is preserved exactly — no normalization between providers.

**Custom actions**
Register Python functions as callable directives from the dashboard. No redeployment. The function executes inside the agent process on its next LLM call and the result appears in the session timeline within seconds.

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
    ]
)
def clear_cache(context, cache_type="all"):
    return {"cleared": my_cache.clear(cache_type)}
```

The function appears in the dashboard the moment an agent calls `init()`. No redeploy. No SSH. No waiting.

**Kill switch**
Stop any individual agent or an entire fleet by flavor. One click. The directive arrives on the agent's next LLM call. Active agents in a loop stop within seconds.

**Token enforcement**
Define policies centrally. Every agent enforces them automatically without code changes.

```
82% of budget  →  warning fires, call proceeds
91% of budget  →  model transparently degraded to a cheaper model
100% of budget →  call blocked, BudgetExceededError raised
```

Policies attach to agent flavors and propagate on session start.

**Analytics**
Token consumption, session counts, policy events, latency, and model distribution — grouped by flavor, model, team, or agent type. Flexible time range.

**Search**
Find any session, agent, or event across your entire fleet with Cmd+K.

---

## Claude Code plugin

Developer Claude Code sessions appear in the fleet view alongside production agents. Shadow developer AI usage becomes visible to platform engineers automatically — no developer action required.

```bash
claude plugin install flightdeck
```

Developer sessions appear with a `DEV` badge. Use the filter toggle to view production sessions, developer sessions, or both.

---

## Identity

Every agent session has two identities: a persistent **flavor** and an ephemeral **session ID**.

Set the flavor via environment variable — ideally injected by your Helm chart:

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

Agents without `AGENT_FLAVOR` appear flagged as `unknown` — this is how agents deployed outside the blessed configuration are detected automatically.

---

## Unavailability policy

If the control plane is unreachable:

```bash
FLIGHTDECK_UNAVAILABLE_POLICY=continue  # run with cached policy (default)
FLIGHTDECK_UNAVAILABLE_POLICY=halt      # block new sessions until CP responds
```

The sensor never sits in your agent's execution path. It reports out-of-band over HTTP. If the control plane goes down, your agents keep running.

---

## Production

```bash
helm repo add flightdeck https://charts.flightdeck.dev
helm install flightdeck flightdeck/flightdeck \
  --set flightdeck.server.token=your-token \
  --namespace flightdeck \
  --create-namespace
```

See [docs/production.md](docs/production.md) for TLS, HA setup, and security hardening.

---

## Supported providers

| Provider  | Install                                    | Notes                  |
|-----------|--------------------------------------------|------------------------|
| Anthropic | `pip install flightdeck-sensor[anthropic]` | Sync, async, streaming |
| OpenAI    | `pip install flightdeck-sensor[openai]`    | Sync, async, streaming |

---

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10) — an excellent tool for observing individual Claude Code sessions. Flightdeck builds on that visual language for production fleet management at scale. If you are running Claude Code personally, agent-observe is worth checking out.

The sensor is built on the foundation of [tokencap](https://github.com/pykul/tokencap), an open source token budget enforcement library.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
