# Flightdeck

Flightdeck is a self-hosted observability and control plane for production and coding agents.

Flightdeck shows you in real time every LLM call, MCP event, and tool call your agents make.

We support coding agents like Claude Code and production agents instrumented with the Flightdeck sensor. Drop it in your code (2 lines) and get visibility and control.

<!-- Live fleet view. Recording coming shortly. -->
![Live fleet view: every agent on a shared timeline streaming events as agents run.](docs/assets/fleet-demo.gif)

<!-- Agents dashboard. Recording coming shortly. -->
![Agents dashboard: every agent in your fleet with token, latency, error, and cost trends.](docs/assets/agents-demo.gif)

<!-- Per-agent swimlane. Recording coming shortly. -->
![Per-agent swimlane: focused view of a single agent's runs and events.](docs/assets/per-agent-swimlane-demo.gif)

<!-- Events search. Recording coming shortly. -->
![Events search: filter every LLM call, tool use, and policy event by agent, type, framework, and MCP server.](docs/assets/events-demo.gif)

> Recordings above are placeholders; the demo GIFs are being recorded.

---

## Quickstart

Prerequisites: Docker Engine 28+ with Compose v2. Python 3.10+ for the sensor path; Claude Code for the plugin path.

Start the stack:

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Dashboard at http://localhost:4000. The dev stack seeds a test token `tok_dev` automatically.

### Production agents

Install the sensor and point your agent at it:

```bash
pip install flightdeck-sensor
```

```python
import flightdeck_sensor

flightdeck_sensor.init(
    server="http://localhost:4000/ingest",
    token="tok_dev",
)
flightdeck_sensor.patch()

# Your existing agent code. Nothing changes.
import anthropic
client = anthropic.Anthropic()
client.messages.create(model="claude-sonnet-4-6", ...)
```

The agent shows up in the fleet view within seconds.

To run the sensor from source instead of PyPI: `pip install -e sensor/` from the repo root.

### Coding agents (Claude Code)

Point Claude Code at the plugin shipped in this repo:

```bash
export FLIGHTDECK_SERVER="http://localhost:4000"
export FLIGHTDECK_TOKEN="tok_dev"
claude --plugin-dir /path/to/flightdeck/plugin
```

The Claude Code session shows up in the fleet view within seconds. Tool inputs and LLM call content are captured by default — unlike the Python sensor, which keeps `capture_prompts=False` until you opt in — so the Prompts tab is populated without extra setup.

`--plugin-dir` is the path. Set `FLIGHTDECK_SERVER` and `FLIGHTDECK_TOKEN` in your shell so the plugin picks them up at every Claude Code session.

---

## Playground

Working examples for every supported framework live in [`playground/`](playground/). Each script costs cents per run and exercises the sensor against real LLM APIs.

```bash
make playground-anthropic    # Anthropic direct
make playground-openai       # OpenAI direct
make playground-langchain    # LangChain + ChatAnthropic / ChatOpenAI
make playground-langgraph    # LangGraph agent loops
make playground-llamaindex   # LlamaIndex
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
| Anthropic | `messages.create`, `messages.stream`, `beta.messages.*` (sync + async) | route via litellm to Voyage | sync + async | 14-entry `llm_error` taxonomy |
| OpenAI    | `chat.completions.create`, `responses.create` (sync + async) | `embeddings.create` (sync + async) | sync + async | same |
| litellm   | `litellm.completion`, `litellm.acompletion` (chat path only) | `litellm.embedding`, `litellm.aembedding` | sync only | same |

Streaming events expose `payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms, final_outcome, abort_reason}`. Mid-stream aborts emit `llm_error{error_type="stream_error"}` with partial-chunk and partial-token data.

### Frameworks

After `init()` + `patch()`, frameworks that build Anthropic or OpenAI clients internally are intercepted with no user-side wrapping.

| Framework        | Chat | Embeddings |
|------------------|------|------------|
| LangChain        | `langchain-anthropic`, `langchain-openai` | `OpenAIEmbeddings.embed_*` |
| LangGraph        | transitive via LangChain (any graph routing through `ChatAnthropic` or `ChatOpenAI`) | inherits |
| LlamaIndex       | `llama-index-llms-anthropic`, `llama-index-llms-openai` | inherits |
| CrewAI 1.14+     | `LLM(model=...).call()` via native Anthropic / OpenAI provider classes | inherits |
| bifrost          | multi-protocol LLM gateway (point the matching SDK at bifrost's `base_url`) | multi-protocol |

The per-event `framework` field carries the bare name (`langchain`, `crewai`, etc.). Higher-level framework wins over SDK transport: a LangChain pipeline routing through litellm reports `framework=langchain`.

### Coding agents

Claude Code agents surface via a separate plugin that ships with this repo. Tool inputs and LLM call content are captured by default, so the Prompts tab is populated without extra setup.

```bash
export FLIGHTDECK_SERVER="http://localhost:4000"
export FLIGHTDECK_TOKEN="tok_dev"
claude --plugin-dir /path/to/flightdeck/plugin
```

Sessions carry `flavor=claude-code`, `agent_type=coding`, and `client_type=claude_code`. The plugin is hook-based and cannot act on directives mid-call; the Stop Agent button is hidden for these sessions. Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist.

### Sub-agent observability

Multi-agent frameworks render as a tree: a parent session for the orchestrator and a separate child session per sub-agent execution, linked by `parent_session_id` and labeled with `agent_role`.

| Mechanism | parent source | role source |
|---|---|---|
| Claude Code Task subagent | hook payload `session_id` | hook payload `agent_type` (e.g. `"Explore"`) |
| CrewAI agent execution | parent crew's session | `Agent.role` attribute |
| LangGraph agent-bearing node | parent runner's session | node name |

Direct SDK calls outside a multi-agent framework emit root sessions; identity is unchanged. When `capture_prompts=True`, each child session carries the parent's input as `incoming_message` and the child's response back as `outgoing_message`, visible in the run drawer's Sub-agents tab.

### MCP

Flightdeck observes MCP traffic as a first-class event surface alongside chat and embeddings. Six event types (`mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get`) emit per operation. The sensor patches `mcp.client.session.ClientSession` directly, so every framework that mediates MCP through the official SDK is observed: LangChain via `langchain-mcp-adapters`, LangGraph via the same, LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`, plus the raw `mcp` SDK.

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

**Estimated cost.** Per-run cost computed from public list prices, accounting for cache reads and cache creation. Pricing data lives in [`pricing.yaml`](pricing.yaml). Treat as a sanity check, not an invoice.

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

Agents without `AGENT_FLAVOR` appear as `unknown`. That is how agents deployed outside your blessed config become visible.

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

`patch()` is the right answer in almost every case. It installs a class-level descriptor on `anthropic.Anthropic`, `anthropic.AsyncAnthropic`, `openai.OpenAI`, and `openai.AsyncOpenAI` so every instance, including ones frameworks build internally, is intercepted.

`wrap()` instruments a single client instance:

```python
client = flightdeck_sensor.wrap(anthropic.Anthropic())
```

Use `wrap()` only when you deliberately do not call `patch()`. Clients built by frameworks will be invisible unless `patch()` is active.

Call `patch()` before any framework or user code constructs a client. In practice this means calling `init()` + `patch()` at the top of your entrypoint.

### Environment variables

| Variable                        | Purpose                                                         |
|---------------------------------|-----------------------------------------------------------------|
| `FLIGHTDECK_SERVER`             | Ingestion base URL. Overrides the `server=` kwarg.              |
| `FLIGHTDECK_TOKEN`              | Access token. Overrides the `token=` kwarg.                     |
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

- `patch()` must run before clients are constructed. Instances that already accessed `.messages`, `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached and are not intercepted.
- Per-thread Session isolation is not yet supported. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`.
- Custom directive handler input validation is yours. The `parameters` schema drives the dashboard form and the directive fingerprint; it is not enforced at execution time.
- litellm streaming is not intercepted. Non-streaming chat calls and embeddings round-trip cleanly.

---

## MCP Protection Policy

Flightdeck can gate which MCP servers your agents are allowed to talk to. The policy lives in the control plane, applies per flavor, and is enforced inside the sensor and the Claude Code plugin without changing the wire path.

### Why this exists

MCP servers are external code your agents call. A misconfigured `.mcp.json`, a typo'd hostname, a colleague's experimental server, or a substituted binary all reach the agent the same way: as a server entry the agent dials at session start. The MCP Protection Policy is the fence around that.

### Scope and resolution

The policy lives at two scopes: one **global** policy carrying the mode (allowlist or blocklist) plus a list of entries, and zero or more **per-flavor** policies carrying allow / deny entry deltas against the global.

On install, Flightdeck auto-creates an empty global policy in `blocklist` mode with zero entries (fully permissive by default). No operator action is required for MCP traffic to keep flowing on a fresh deployment; locking down a flavor is opt-in.

Per-server resolution: most-specific scope wins. If the per-flavor policy has an entry for the URL, use it; else if the global policy has an entry, use it; else apply the global mode default (allowlist blocks unknown, blocklist allows unknown).

Server identity is the pair `(URL, name)`. The URL is the security key; the name is the display label and tamper-evidence axis. The fingerprint is `sha256(canonical_url + 0x00 + name)`.

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
  --set postgres.externalUrl="postgres://user:pass@rds.example.com:5432/flightdeck?sslmode=require"
```

Without `postgres.externalUrl` the chart ships its own single-instance Postgres StatefulSet (fine for small deployments, not HA, not backed up). NATS is always bundled.

The chart is at `version` 0.3.0 with `appVersion` 0.3.1; the default `image.tag` is `v0.3.1`. See [`helm/values.yaml`](helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.3.1` | Image tag applied to ingestion/workers/api/dashboard. |
| `ingestion.replicas` | `2` | Initial replica count. HPA overrides at runtime when enabled. |
| `ingestion.hpa.enabled` | `true` | Enable the HorizontalPodAutoscaler for ingestion. |
| `workers.replicas` | `2` | NATS consumer pod count. |
| `api.replicas` | `2` | Query API replica count. |
| `api.corsOrigin` | `*` | `Access-Control-Allow-Origin` for the query API. Lock down in prod. |
| `dashboard.replicas` | `2` | Dashboard pod count. |
| `postgres.externalUrl` | *(empty)* | When set, bundled Postgres StatefulSet is not rendered. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.replicas` | `3` | NATS StatefulSet replica count. |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `ingress.enabled` | `false` | Render an Ingress routing `/` to dashboard, `/api` to query API, `/ingest` to ingestion API. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza. |

---

## What Flightdeck is NOT

- **Not a proxy.** The sensor wraps SDK client classes inside the agent's own process; calls go directly to the provider. Nothing routes through Flightdeck.
- **Not a content inspector by default.** Prompt and embedding-input capture is opt-in (`capture_prompts=True`). With capture off, event payloads carry token counts, model names, latency, framework, and tool names only.
- **Not an orchestrator.** Flightdeck observes; it does not decide what an agent should do next. Directives (kill switch, model swap, custom handlers) are explicit operator actions.
- **Not a billing system.** `estimated_cost` is an approximation from public list prices. Treat as a sanity check.
- **Not a notification platform.** No Slack, email, or PagerDuty integrations.
- **Not multi-tenant SaaS.** Self-hosted only. One deployment, one tenant.
- **Not an LLM gateway.** No model substitution, no caching layer, no retries injected by Flightdeck. The sensor enforces budgets your agents already know about.

---

## Coming soon

Broader coding-agent support is the next batch of work: Codex, Cursor, and other agents with a hook surface comparable to Claude Code's. Continuous live-API smoke runs across every supported framework so SDK class renames don't break the sensor silently.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, lint, test instructions, and the process for adding a new LLM provider.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), an open source token budget enforcement library.
</content>
</invoke>