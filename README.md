# Flightdeck

**Observability and control for AI agent fleets.**

Flightdeck is a self-hosted control plane for teams running AI agents in production. Drop a one-line sensor into your agent, and every LLM call, tool use, and token spend streams to a live dashboard. Stop any agent, enforce token budgets, and push custom actions to a running fleet — without redeploying.

- **See it** — live timeline of every agent, every call, across your whole fleet.
- **Control it** — kill switch, budget enforcement, and custom directives pushed to running agents.
- **Understand it** — full prompt and response capture (opt-in), with provider-native rendering.

---

<!-- Fleet view demo — replace with actual recording -->
![Fleet view](docs/assets/fleet-demo.gif)
*Live fleet view — events stream in as agents run. Click any session to inspect every call.*

<!-- Session drawer demo — replace with actual recording -->
![Session drawer](docs/assets/session-demo.gif)
*Full session detail — every LLM call, tool use, and policy event in order.*

---

## Install

```bash
pip install "flightdeck-sensor[anthropic,openai]"
```

Use the extras that match the providers you call. Leave both off to install the bare sensor.

## Quick start

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="http://localhost:4000/ingest",
    token="tok_dev",
)
flightdeck_sensor.patch()

# Your existing agent code. Nothing changes.
# Every Anthropic and OpenAI client is intercepted automatically,
# including clients constructed inside frameworks like LangChain or CrewAI.
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(model="claude-sonnet-4-6", ...)
```

That's it. After `init()` + `patch()`, every `anthropic.Anthropic`, `openai.OpenAI`, and their async variants are intercepted at the class level — no per-client wrapping needed.

> **Tip:** To make orchestrator re-runs attach to the same session instead of creating a new one each time, pass `session_id="..."` to `init()` or export `FLIGHTDECK_SESSION_ID`. See `DECISIONS.md` D094.

## Start the control plane

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Open [http://localhost:4000](http://localhost:4000). A test token `tok_dev` is seeded automatically — your agents appear in the fleet view within seconds of calling `init()`.

The dev stack exposes the ingestion API at `http://localhost:4000/ingest` via nginx. Production deployments usually route a single root URL (e.g. `https://flightdeck.example.com`) to the ingestion service — see your Helm `values.yaml`.

---

## What works out of the box

| Provider  | SDK resources intercepted | Install extra |
|-----------|---------------------------|---------------|
| Anthropic | `messages.create/stream`, `beta.messages.create/stream` (sync + async) | `flightdeck-sensor[anthropic]` |
| OpenAI    | `chat.completions.create`, `responses.create`, `embeddings.create` (sync + async + streaming) | `flightdeck-sensor[openai]` |

| Framework   | Minimum version | Entrypoints covered |
|-------------|-----------------|---------------------|
| LangChain   | any             | `ChatAnthropic.invoke()`, `ChatOpenAI.invoke()` via `langchain-anthropic` / `langchain-openai` |
| LangGraph   | any             | Any graph that drives its LLM nodes through `ChatAnthropic` / `ChatOpenAI`, including `langgraph.prebuilt.create_react_agent` tool loops. Intercepted transitively via LangChain. |
| LlamaIndex  | any             | `Anthropic.complete()`, `OpenAI.complete()` via `llama-index-llms-*` |
| CrewAI      | 1.14+           | `LLM(model=...).call()` via the native OpenAI/Anthropic provider classes |

Framework calls flow through the same pipeline as direct SDK calls — session events, token counts, and policy enforcement all apply automatically.

**Not intercepted:** `audio`, `images`, `moderations`, `files`, `fine_tuning`, and legacy `completions`. These are utility resources unrelated to agent fleet management.

---

## What you get

**Live fleet timeline.** Every agent on a shared time axis. LLM calls, tool uses, policy events, and directives stream as colored nodes. Click any event for the full call inline.

**Full payload capture (opt-in).** Set `capture_prompts=True` on `init()` to store the complete system prompt, messages, tool definitions, and model response for every call. Off by default. Anthropic and OpenAI payloads are stored and displayed using each provider's native terminology — no normalization.

```python
flightdeck_sensor.init(server="...", token="...", capture_prompts=True)
```

**Kill switch.** Stop any agent or an entire fleet by flavor. One click. The directive arrives on the agent's next LLM call.

**Token budget enforcement.** Central policy, automatic enforcement — no agent code changes.

```
 82% of budget  →  warning fires, call proceeds
 91% of budget  →  model transparently degraded to a cheaper one
100% of budget  →  call blocked, BudgetExceededError raised
```

**Custom directives.** Register a Python function with `@flightdeck_sensor.directive(...)` and it becomes callable from the dashboard — no redeploy, no SSH. The function executes inside the agent process on its next LLM call; the result appears on the timeline within seconds.

```python
@flightdeck_sensor.directive(
    name="clear_cache",
    description="Clear the prompt cache",
    parameters=[
        flightdeck_sensor.Parameter(
            name="cache_type", type="string",
            options=["all", "prompt"], default="all",
        )
    ],
)
def clear_cache(context, cache_type="all"):
    return {"cleared": my_cache.clear(cache_type)}
```

**Analytics.** Tokens, sessions, policy events, latency, and model distribution — grouped by `flavor`, `model`, `framework`, `host`, `agent_type`, or `team`. Flexible time range, one endpoint.

**Search.** `Cmd+K` jumps to any session, agent, or event across the fleet.

**Runtime context, automatic.** On `init()` the sensor snapshots the agent's environment — hostname, OS, Python version, git commit/branch/repo, container orchestration (Kubernetes, Docker Compose, ECS, Cloud Run), and in-process AI frameworks (LangChain, LangGraph, CrewAI, LlamaIndex, AutoGen, Haystack, DSPy, smolagents, pydantic_ai). Every collector is best-effort; git remote URLs are credential-stripped before storage. Filter the fleet by any context field (`os=Linux`, `k8s_namespace=research`, `git_branch=main`).

---

## Claude Code plugin

Developer Claude Code sessions appear in the fleet view alongside production agents — shadow developer AI usage becomes visible to platform engineers with no developer action required.

```bash
claude plugin install flightdeck
```

Developer sessions carry a `DEV` badge; toggle production / developer / both in the filter bar.

---

## Identity

Every session has two identities: a persistent **flavor** and an ephemeral **session ID**. Set the flavor via environment variable — ideally injected by your Helm chart:

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

Agents without `AGENT_FLAVOR` are flagged `unknown` — that's how deployments outside the blessed configuration surface automatically.

---

## Unavailability policy

If the control plane is unreachable:

```bash
FLIGHTDECK_UNAVAILABLE_POLICY=continue  # run with cached policy (default)
FLIGHTDECK_UNAVAILABLE_POLICY=halt      # block new sessions until CP responds
```

The sensor never sits in the agent's execution path — events are reported out-of-band over HTTP. If the control plane goes down, your agents keep running.

---

## Threading model

Safe to use from multithreaded agents.

| Pattern | Description | Status |
|---|---|---|
| **A** — Single-threaded agent | One `init()`, one thread, sequential LLM calls | ✓ Supported |
| **B** — Multithreaded agent | One `init()`, many threads sharing patched clients (web servers, async frameworks) | ✓ Supported |
| **C** — Multi-agent in one process | Multiple `init()` calls, one per logical agent | ⚠ Not yet — see [Known limitations](#known-limitations) |

Internally, two background daemon threads drain the event queue and process inbound directives independently, so a slow custom directive handler can never block event throughput. Details in `ARCHITECTURE.md` and DECISIONS D081.

---

## Known limitations

- **Call `patch()` before constructing clients.** Instances that accessed `.messages`, `.chat`, `.responses`, or `.embeddings` before `patch()` cache the unwrapped resource and will not be intercepted. In practice, `init()` + `patch()` belong at the top of your entrypoint.
- **One `init()` per process.** A second `init()` is a no-op with a warning. Multi-agent framework deployments (CrewAI, LangGraph, etc.) work fine with one `init()` and a shared `AGENT_FLAVOR`. Per-thread Session isolation is tracked in `KNOWN_ISSUES.md` KI15.
- **Validate directive inputs yourself.** The `parameters` schema in `@flightdeck_sensor.directive` is used for the dashboard form and fingerprinting — it is **not** enforced at execution time. Your handler should defensively validate its inputs.

---

## `wrap()` — explicit, single-client instrumentation

If you've called `patch()`, you do **not** need `wrap()`. It exists for one case: you deliberately skip `patch()` and want to instrument a single client instance.

```python
client = flightdeck_sensor.wrap(anthropic.Anthropic())
```

`wrap()` does not intercept clients that frameworks build internally. Most users should stick with `patch()`.

---

## Production

```bash
helm repo add flightdeck https://charts.flightdeck.dev
helm install flightdeck flightdeck/flightdeck \
  --set flightdeck.server.token=your-token \
  --namespace flightdeck \
  --create-namespace
```

TLS, HA setup, and security hardening: [docs/production.md](docs/production.md).

---

## Smoke tests

The smoke suite runs real LLM API calls against a live stack — no mocks.

**Requires:** `make dev` running, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set, and `pip install -e sensor/`.

```bash
make test-smoke
```

**Cost:** under $0.05 per full run (haiku + gpt-4o-mini, `max_tokens=5`).
**Coverage:** ~32 scenarios across 12 groups — provider interception (patch/wrap, streaming, tools, embeddings, beta.messages), prompt capture, local and server policy enforcement, kill switch, custom directives, runtime context, session visibility, sensor status, unavailability, multi-session fleet, and framework support. Scenarios missing API keys or packages are skipped gracefully.

---

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, data flow, component boundaries.
- [`DECISIONS.md`](DECISIONS.md) — every non-obvious trade-off, with rationale.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to run the stack locally and propose changes.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

---

## Acknowledgements

The fleet timeline UI draws on [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10) — an excellent tool for observing individual Claude Code sessions. Flightdeck extends that visual language to production fleet management at scale.

The sensor is built on the foundation of [tokencap](https://github.com/pykul/tokencap), an open-source token budget enforcement library.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
