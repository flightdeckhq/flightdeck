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

## Quick start

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="http://localhost:4000/ingest",
    token="tok_dev",
)
flightdeck_sensor.patch()

# Your existing agent code. Nothing changes.
# Every Anthropic and OpenAI client is intercepted automatically.
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(model="claude-sonnet-4-6", ...)
```

`patch()` is the recommended way to use the sensor. After `init()` + `patch()`, every instance of `anthropic.Anthropic`, `openai.OpenAI` (and their async variants) -- including instances constructed internally by frameworks -- has its LLM call resources intercepted automatically. No `wrap()` call needed.

The dev `make dev` stack exposes the ingestion API at
`http://localhost:4000/ingest` via nginx. Production deployments
behind their own gateway typically route a single root URL like
`https://flightdeck.example.com` to the ingestion service; consult
your Helm `values.yaml` for the externally-visible ingestion path.

## Supported resources

| Provider  | Intercepted resources |
|-----------|----------------------|
| Anthropic | `client.messages.create/stream`, `client.beta.messages.create/stream` |
| OpenAI    | `client.chat.completions.create` (sync, async, streaming), `client.responses.create`, `client.embeddings.create` |

Resources NOT intercepted: `audio`, `images`, `moderations`, `files`, `fine_tuning`, legacy `completions`. These are utility resources with no relevance to agent fleet management.

## Frameworks

After `init()` + `patch()`, frameworks that use the official Anthropic or OpenAI SDKs internally are intercepted without any user-side wrapping:

- **LangChain** — `langchain-anthropic` (`ChatAnthropic.invoke()`) and `langchain-openai` (`ChatOpenAI.invoke()`)
- **LlamaIndex** — `llama-index-llms-anthropic` (`Anthropic.complete()`) and `llama-index-llms-openai` (`OpenAI.complete()`)
- **CrewAI 1.14+** — `LLM(model=...).call()` via the native OpenAI/Anthropic provider classes

Framework calls flow through the same sensor pipeline as direct SDK calls -- session events, token counts, and policy enforcement all apply automatically.

## Explicit wrapping with `wrap()`

If you have called `patch()`, you do **not** need `wrap()`. Every client is already intercepted at the class level. Calling `wrap()` after `patch()` is safe -- it detects that the class is already patched, returns the client unchanged, and produces no double interception and no error. It is simply redundant.

`wrap()` exists for one specific scenario: you deliberately choose **not** to call `patch()` and want to instrument a single client instance explicitly.

```python
import flightdeck_sensor
import anthropic

flightdeck_sensor.init(
    server="http://localhost:4000/ingest",
    token="tok_dev",
)

# No patch() -- only this specific client is intercepted.
client = flightdeck_sensor.wrap(anthropic.Anthropic())
```

Most users should use `patch()` instead. `wrap()` does not intercept clients that frameworks build internally, so framework calls will be invisible to the sensor unless `patch()` is also active.

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

**Runtime context, automatically**
On `init()` the sensor collects a snapshot of the agent's
environment — hostname, OS, Python version, git commit/branch/repo,
container orchestration (Kubernetes / Docker Compose / ECS /
Cloud Run), and any in-process AI frameworks (LangChain, CrewAI,
LlamaIndex, AutoGen, Haystack, DSPy, smolagents, pydantic_ai).
Each session in the dashboard surfaces this in a collapsible
**RUNTIME** panel inside the session drawer, plus a sidebar
**CONTEXT** facet panel that lets operators filter the fleet by
any context field (`os=Linux`, `k8s_namespace=research`,
`git_branch=main`, etc.). Git remote URLs are credential-stripped
before storage. The whole probe is best-effort: every collector
is wrapped in two layers of `try/except` so a broken probe never
crashes the agent.

**Visual fleet glance**
The fleet view is a swim-lane timeline with one row per agent
flavor and one sub-row per running session, plus pause / catch-up
controls, an event-type filter bar (LLM Calls / Tools / Policy /
Directives / Session), provider logos for Anthropic and OpenAI
calls, and OS / orchestration icons next to each session
hostname. The left panel is resizable and the timeline width is
fixed at 900 px so density scales with the time range, not the
viewport.

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

## Threading model

The sensor is safe to use from multithreaded agents. The
intended deployment patterns are:

| Pattern | Description | Status |
|---|---|---|
| **A — Single-threaded agent** | One `init()`, one thread, sequential LLM calls | ✓ Supported |
| **B — Multithreaded agent** | One `init()`, many threads sharing one patched client | ✓ Supported (web servers, async frameworks) |
| **C — Multi-agent in one process** | Multiple `init()` calls, one per "logical agent" | ⚠ See *Known limitations* below |

Internally the sensor runs two background daemon threads. The
first (`flightdeck-event-queue`) drains the event queue and
posts events to the control plane. The second
(`flightdeck-directive-queue`) processes directives received in
event response envelopes — kill switches, custom directive
handlers, model-degrade swaps, policy updates. The two queues
are decoupled so a slow custom directive handler can never block
LLM call event throughput. See `ARCHITECTURE.md` and DECISIONS
D081 for the full design.

---

## Known limitations

* **Call `patch()` before constructing clients.** Instances that
  accessed `.messages`, `.chat`, `.responses`, or `.embeddings`
  before `patch()` was called have the raw, unwrapped resource
  cached internally and will not be intercepted. In practice,
  `init()` + `patch()` runs at the top of your agent's
  entrypoint, well before any framework or user code constructs
  LLM clients.
* **One `init()` per process.** The second `init()` call from
  any thread is currently a no-op with a warning log. Pattern C
  (multiple "logically separate" agents in one process, each
  with its own Session) is not yet supported. The typical
  multi-agent framework deployment (CrewAI, LangGraph, etc.)
  works fine with one `init()` and a shared `AGENT_FLAVOR`,
  because every agent's calls flow under the same fleet
  identity. If you need per-thread Session isolation, follow
  `KNOWN_ISSUES.md` KI15.
* **Custom directive handler input validation is your job.** The
  `parameters` schema you declare in `@flightdeck_sensor.directive`
  is used to compute the directive fingerprint and to render the
  dashboard form. It is **not** enforced at execution time --
  the runtime only validates the directive payload's top-level
  shape (`directive_name: str`, `fingerprint: str`,
  `parameters: dict`). Your handler should defensively validate
  its own inputs. Type errors inside the handler are caught and
  logged but bad input data may produce surprising side effects
  before the crash.

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

## Smoke Tests

The smoke test suite runs real LLM API calls against a live Flightdeck stack. No mocks.

**Requirements:**
- Running stack: `make dev`
- Environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Sensor installed: `pip install -e sensor/`

**Run:**
```bash
make test-smoke
# or directly:
python tests/smoke/smoke_test.py
```

**Cost:** < $0.05 per full run (haiku + gpt-4o-mini, max_tokens=5).

**Coverage:** 12 groups, ~32 scenarios covering provider interception (patch/wrap, streaming, tools, embeddings, beta.messages), prompt capture, local and server policy enforcement, kill switch, custom directives, runtime context, session visibility, sensor status, unavailability, multi-session fleet, and framework support (LangChain, LlamaIndex, CrewAI). Scenarios that require missing API keys or packages are skipped gracefully.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
