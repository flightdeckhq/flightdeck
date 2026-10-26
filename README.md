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

Built and maintained by [Omri Arnon](https://github.com/pykul) ([LinkedIn](https://www.linkedin.com/in/omriarnon/)).

![Live fleet view: every agent on a shared timeline streaming events as agents run.](assets/fleet-demo.gif)

![Agents dashboard: every agent in your fleet with token, latency, error, and cost trends, plus a per-agent swimlane and feed.](assets/agents-table-demo.gif)

![Events search: filter every LLM call, tool use, and policy event by agent, type, framework, and MCP server.](assets/events-table-demo.gif)

---

## Quickstart

Prerequisites: Docker Engine 28+ with Compose v2. Python 3.11 to 3.14 for the sensor path; Claude Code for the plugin path.

Start the stack:

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Dashboard at http://localhost:4000. The dev stack seeds a test token `tok_dev` automatically.

### Coding agents (Claude Code)

Launch Claude Code, then install the plugin from this repo's marketplace inside the REPL:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
/reload-plugins
```

That's it for a local stack — the plugin defaults to `http://localhost:4000` with the dev token `tok_dev`, so the Claude Code session shows up in the fleet view within seconds. Tool inputs and LLM call content are captured by default — unlike the Python sensor, which keeps `capture_prompts=False` until you opt in — so the Prompts tab is populated without extra setup.

To point the plugin at a different stack (production, a remote dev server, etc.) export the env vars in the shell *before* launching `claude` — the plugin reads them at every `SessionStart`:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com"
export FLIGHTDECK_TOKEN="ftd_..."
claude
```

To use a local checkout instead of the marketplace: `claude --plugin-dir /path/to/flightdeck/plugin`.

Marketplace installs do not update themselves: after a Flightdeck release run `claude plugin update flightdeck@flightdeck-plugins` (or enable auto-update for the `flightdeck-plugins` marketplace under `/plugin`).

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
| Anthropic | `messages.create`, `messages.stream`, `messages.parse`, `beta.messages.*` (sync + async) | route via litellm to Voyage | `messages.stream`, `messages.create(stream=True)` (sync + async) | 14-entry `llm_error` taxonomy |
| OpenAI    | `chat.completions.create` / `.parse`, `responses.create` / `.parse`, and their `with_raw_response` counterparts (sync + async) | `embeddings.create` (sync + async) | `create(stream=True)` on chat and Responses (sync + async); the `.stream()` helpers and `with_streaming_response` are not intercepted | same |
| litellm   | `litellm.completion`, `litellm.acompletion` (chat path; a call litellm serves through the OpenAI SDK is counted once; `text_completion` and `responses` are not patched, see Known limitations) | `litellm.embedding`, `litellm.aembedding` | `completion(stream=True)`, `acompletion(stream=True)` (sync + async) | same |

The Anthropic row applies to every `anthropic` client class — first-party, Bedrock, Vertex, Google Cloud, Foundry, AWS, Mantle — and to the raw view (`with_raw_response`) and the streaming view (`with_streaming_response`): the streaming view is metered when you call `parse()`, and `create(stream=True)` through either view is metered as the parsed stream is iterated. Every Anthropic `post_call` records the platform the client talked to in `provider_metadata.platform` (`anthropic`, `bedrock`, `bedrock-mantle`, `aws`, `vertex`, `google-cloud`, `foundry`, or the host of a gateway the SDK was pointed at).

Streamed calls report the token counts the provider sends inside the stream, whether you iterate inside a `with` block or without one (a loop left with `break` and never closed is reported at the next LLM call the sensor intercepts after the stream object is collected, or when the session ends). Streaming events expose `payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms, final_outcome, abort_reason}`; `final_outcome` is `aborted` when you leave a stream before the event that ends the response, and `completed` otherwise. A mid-stream failure, inside a `with` block or while iterating without one, emits `llm_error{error_type="stream_error"}` with the chunks and tokens delivered before the failure.

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

Claude Code agents attach via a separate plugin distributed through this repo's marketplace:

```text
/plugin marketplace add flightdeckhq/flightdeck
/plugin install flightdeck@flightdeck-plugins
```

The plugin defaults to `http://localhost:4000` + `tok_dev` for the local-dev path; export `FLIGHTDECK_SERVER` + `FLIGHTDECK_TOKEN` before launching `claude` to point at a different stack. See [Quickstart > Coding agents](#coding-agents-claude-code) for the full flow. Tool inputs and LLM call content are captured by default, so the Prompts tab is populated without extra setup.

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

The sensor supports the official `mcp` SDK 1.x (from 1.20) and 2.x; on 2.x it also covers the high-level `mcp.Client`.

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

**Estimated cost.** Per-run cost computed from public list prices, accounting for cache reads and cache creation. Prices come from a vendored copy of litellm's price list, with your own overrides in [`pricing.yaml`](pricing.yaml). Treat as a sanity check, not an invoice.

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

Agents without `AGENT_FLAVOR` appear as `{user}@{hostname}`. That is how agents deployed outside your blessed config become visible.

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

`patch()` is the right answer in almost every case. For Anthropic it patches `create`, `stream` and `parse` on the SDK's `Messages` resource classes, which every `anthropic` client class hands out, so every client — first-party, Bedrock, Vertex, Google Cloud, Foundry, AWS, Mantle, and the ones frameworks build internally — is intercepted, including a client built before `patch()` (from its next call on; only a `with_raw_response` / `with_streaming_response` view first touched before `patch()` stays unmetered). For OpenAI it installs a class-level descriptor on `openai.OpenAI` and `openai.AsyncOpenAI` so every instance, including ones frameworks build internally, is intercepted.

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

- `patch()` must run before OpenAI clients are constructed. Instances that already accessed `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached and are not intercepted. Anthropic clients are intercepted from their next call on, whenever they were built, except that a `with_raw_response` / `with_streaming_response` view first touched before `patch()` binds the unpatched method and is not metered.
- The Anthropic patch needs `anthropic>=0.86` (the lowest release with the resource layout it imports); an older SDK is reported with a warning at import and its calls are not metered.
- An Anthropic `with_raw_response.create(stream=True)` response that is never parsed emits no `post_call`: the event stream is metered once `parse()` hands it to the sensor, and a raw response has no close hook to settle on. The streaming view (`with_streaming_response`) always settles: when its `with` block exits, or, for a response dropped without `parse()` or `close()`, at the next LLM call the sensor intercepts after the response is collected or when the session ends.
- Anthropic Message Batches (`messages.batches.*`) and `count_tokens` are not patched: batch spend runs outside the kill switch and the token budget.
- With `capture_prompts=True`, prompts sent through the Bedrock, Vertex, Foundry, AWS and Mantle clients — platforms often chosen for data residency — reach the Flightdeck control plane like any other captured prompt. Keep capture off for those sessions, or keep the control plane inside the same residency boundary.
- llama-index-llms-anthropic (through 0.12.3) always sends `temperature`, which anthropic 1.x's `Messages.create` rejects, so LlamaIndex's Anthropic LLM fails on anthropic 1.x with or without the sensor; the playgrounds skip it there.
- On mcp 2.x, `mcp.Client` answers `list_tools`, `list_resources`, `list_resource_templates`, `list_prompts` and `read_resource` from its response cache when it can; a cached answer makes no MCP request, so no `mcp_*` event is emitted for it (pass `cache=None` to the `Client` to observe every request). Tool calls are not cached and are always observed and policed.
- Per-thread Session isolation is not yet supported. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`.
- Custom directive handler input validation is yours. The `parameters` schema drives the dashboard form and the directive fingerprint; it is not enforced at execution time.
- litellm's `text_completion` and `responses` entry points are not patched: `text_completion` on an OpenAI chat model is reported by the OpenAI interceptor, `responses` on a provider without a native Responses API is reported once as a chat call, and litellm's own httpx routes of either are unobserved. Chat calls, streaming or not, and embeddings round-trip cleanly.
- While a litellm call is in flight, an SDK call made from inside it (by a litellm callback, guardrail or custom provider, or by a task created inside the call and run before it ends) is neither policed nor metered: the litellm wrapper has already metered the call it serves, and the mark that tells the SDK interceptors so covers the whole call.

---

## MCP Protection Policy

Flightdeck can gate which MCP servers your agents are allowed to talk to. The policy lives in the control plane, applies per flavor, and is enforced inside the sensor and the Claude Code plugin without changing the wire path.

### Why this exists

MCP servers are external code your agents call. A misconfigured `.mcp.json`, a typo'd hostname, a colleague's experimental server, or a substituted binary all reach the agent the same way: as a server entry the agent dials at session start. The MCP Protection Policy is the fence around that.

### Scope and resolution

The policy lives at two scopes: one **global** policy carrying the mode (allowlist or blocklist) plus a list of entries, and zero or more **per-flavor** policies carrying allow / deny entry deltas against the global.

On install, Flightdeck auto-creates an empty global policy in `blocklist` mode with zero entries (fully permissive by default). No operator action is required for MCP traffic to keep flowing on a fresh deployment; locking down a flavor is opt-in.

Per-server resolution: most-specific scope wins. If the per-flavor policy has an entry for the URL, use it; else if the global policy has an entry, use it; else apply the global mode default (allowlist blocks unknown, blocklist allows unknown).

Server identity is the canonical URL (or stdio command): entries match on it whatever name the server reports, and when a scope has several entries for one URL the most restrictive wins. The name is the display label and tamper-evidence axis; the displayed fingerprint is `sha256(canonical_url + 0x00 + name)`.

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
  --set postgres.externalUrl="postgres://user:pass@rds.example.com:5432/flightdeck?sslmode=require" \
  --set api.auth.jwtSecret="<strong-random-secret>" \
  --set api.corsOrigin="https://flightdeck.example.com" \
  --set nats.auth.token="<strong-random-token>"
```

A production render (`api.env=production`, the default) refuses to proceed without the JWT secret, a non-wildcard CORS origin and the NATS token, and without `postgres.password` when it bundles Postgres. Without `postgres.externalUrl` the chart ships its own single-instance Postgres StatefulSet (fine for small deployments, not HA, not backed up). NATS is always bundled; with more than one replica the servers form a cluster, so events published on any of them reach the workers. The `FLIGHTDECK` JetStream stream itself is created with one replica, so it lives on one server. The token may contain only letters, digits and `. _ ~ -` because it is placed in NATS URLs (`openssl rand -hex 32` works); with more than one replica the cluster routes authenticate with it too.

**Upgrading a v0.5.3 install with `nats.replicas` above 1** (the default is 3): the NATS StatefulSet's pod start policy changes, which Kubernetes does not allow in place. Scale ingestion to zero, give the workers a minute to drain, then run `kubectl delete statefulset <release>-flightdeck-nats` (the data volumes stay) before `helm upgrade`. On first start the clustered servers discard the old per-server streams and ingestion recreates the stream, so any event still on the bus at that point is dropped. A one-replica install upgrades in place and keeps its stream.

The chart is at `version` 0.7.0 with `appVersion` 0.7.0; the default `image.tag` is `v0.7.0`. See [`helm/values.yaml`](helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.7.0` | Image tag applied to ingestion/workers/api/dashboard. |
| `ingestion.replicas` | `2` | Initial replica count. HPA overrides at runtime when enabled. |
| `ingestion.hpa.enabled` | `true` | Enable the HorizontalPodAutoscaler for ingestion. |
| `workers.replicas` | `2` | NATS consumer pod count. |
| `api.replicas` | `2` | Query API replica count. |
| `api.corsOrigin` | `*` | `Access-Control-Allow-Origin` for the query API. Lock down in prod. |
| `dashboard.replicas` | `2` | Dashboard pod count. |
| `postgres.externalUrl` | *(empty)* | When set, bundled Postgres StatefulSet is not rendered. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.replicas` | `3` | NATS StatefulSet replica count; more than one forms a NATS cluster. |
| `nats.auth.token` | *(empty)* | Client token for the event bus. Required in production. |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `ingress.enabled` | `false` | Render an Ingress routing `/` to dashboard, `/api` to query API, `/ingest` to ingestion API. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza. |

---

## What Flightdeck is NOT

- **Not a proxy.** The sensor wraps SDK client classes inside the agent's own process; calls go directly to the provider. Nothing routes through Flightdeck.
- **Not a content inspector by default for production agents.** The Python sensor defaults to `capture_prompts=False`; with capture off, event payloads carry token counts, model names, latency, framework, and tool names only. The Claude Code plugin is the one exception: it captures prompts and sanitised tool inputs by default because you are observing your own session on your own machine, and `FLIGHTDECK_CAPTURE_PROMPTS=false` turns that off.
- **Not an orchestrator.** Flightdeck observes; it does not decide what an agent should do next. Directives (kill switch, model swap, custom handlers) are explicit operator actions.
- **Not a billing system.** `estimated_cost` is an approximation from public list prices. Treat as a sanity check.
- **Not a notification platform.** No Slack, email, or PagerDuty integrations.
- **Not multi-tenant SaaS.** Self-hosted only. One deployment, one tenant.
- **Not an LLM gateway.** No model substitution, no caching layer, no retries injected by Flightdeck. The sensor enforces budgets your agents already know about.

---

## Roadmap

Deferred and planned work lives here so it stays visible and user demand can prioritise it. Items are added when a release declines or defers them and removed when they ship. The sequence below is the October 2026 update plan; status reflects `main`.

### Next up (v0.8.0)

- Helm: replicate the `FLIGHTDECK` JetStream stream across the NATS cluster (it is created with one replica today, so losing that server stalls ingestion until it returns); needs an in-place stream update for existing installs.
- Sensor correctness on current SDKs: the `OpenAI.beta.chat.completions.parse` structured-output path (the non-beta `parse()` on chat and Responses is intercepted), litellm `text_completion` / `responses`.
- Streamed-call coverage: with `capture_prompts` on, `messages.create(stream=True)` and `chat.completions.create(stream=True)` store the request but not the streamed response text, because the raw event stream is never assembled into a message; `responses.create(stream=True)` stores neither, having no request `input` on any path; none of the raw streams emit `tool_call` events (the `messages.stream()` helper does both). The OpenAI `chat.completions.stream()` and `responses.stream()` helpers and `chat.completions.with_streaming_response` / `responses.with_streaming_response` are not intercepted (the non-streaming `.parse()` on both APIs is).
- Failed-stream accounting: the provider-billed tokens a stream delivered before a mid-stream failure (`llm_error.partial_tokens_*`) count only against the sensor's local session budget; server-side session totals (which add `post_call` and `embeddings` events) and the analytics `tokens` and `estimated_cost` metrics (`post_call`) do not include them yet.
- Raw-response streaming: `chat.completions.with_raw_response.create(stream=True)` and `responses.with_raw_response.create(stream=True)` record the pre-call estimate with no `streaming` block (langchain-openai takes the chat path with `include_response_headers=True`); the non-streaming raw-response `create` / `parse` calls on both resources are metered. The Anthropic raw and streaming views are metered.
- Responses MCP tool calls: the `tool_call` event for an `mcp_call` output item carries the tool's name but not its `server_label`; carry the server label so the event names the MCP server the call went to.
- Signal-handler shutdown: the SIGTERM / SIGINT handler runs `Session.end()` on the interrupted thread, which may already hold the session, policy or queue lock, so the shutdown can hang; move that shutdown work off the interrupted thread.
- Ingestion validation of streaming fields: `streaming.final_outcome`, `streaming.abort_reason`, `error.abort_reason` and the non-negativity of `partial_chunks` / `partial_tokens_*` are stored as sent; only `tokens_input` / `tokens_output` / `tokens_total` are range-checked today.
- Toolchain currency: npm and pip vulnerability scanning in CI (Go modules are checked by govulncheck and release images by Trivy today).
- Operations: add request-latency histograms to the Go services, bound the NATS stream (`MaxAge` / `MaxBytes`; the `FLIGHTDECK` stream keeps every message today) and rotate the workers' logs in the compose files, so a flood of events cannot fill the NATS store or the host disk.
- Claude Code plugin tool failures in the dashboard: a failed tool call is stored as a `tool_call` with an `error` block and already shows in the unscoped `/v1/events` `error_type` facet and the Investigate status chip, but the session drawer's error indicator, the `tool_call` rows, the per-session `error_types[]` aggregate and the agent `errors` count do not include it yet. The per-session MCP-server facet keys plugin-bundled servers as `plugin:<plugin>:<server>` for rows stored from v0.6.0 on while older rows keep `plugin_<plugin>_<server>`.
- Workers: validate the `session_id` shape and cap log field sizes at the NATS consumer boundary. Ingestion validates today and the NATS stream is treated as untrusted, so a direct publisher can still make the worker log oversized ids.
- Identity model v2: an extensible `client_type` registry and entrypoint detection for headless, SDK and CI runs.
- Claude Code plugin v2: the remaining hook events (API errors, permission prompts, compaction, model switches, teams and worktrees), native cost from the transcript, async hooks, plugin `userConfig`, and enforcement (kill switch, token budgets and MCP deny) for Claude Code sessions.
- Claude Agent SDK interceptor for Python agents built on the SDK.
- Sensor import cost: `import flightdeck_sensor` imports litellm, the MCP SDK and the Anthropic and OpenAI SDKs whenever they are installed, whether or not the application uses them, and importing litellm fetches its price list from GitHub. Patch these when they are first imported instead, so an application pays only for the libraries it uses.

### Planned (v0.9.0 and later)

- OTLP / OpenTelemetry ingest (observer class) for Claude Code native telemetry, Codex CLI, Gemini CLI, GitHub Copilot and OTel-instrumented frameworks.
- Google provider (`google-genai`) and Google ADK; OpenAI Agents SDK, Pydantic AI, LlamaIndex, Strands (Bedrock Converse), Microsoft Agent Framework, Agno, Haystack and smolagents sub-agent coverage; a DSPy callback adapter.
- Coding-agent adapters, in this order: Codex CLI, GitHub Copilot, OpenCode, Gemini CLI, Cursor.
- MCP: server-side MCP (the OpenAI Responses `mcp` tool and the Anthropic MCP connector) observation and policy, per-tool allow / deny with annotation awareness, tool-definition drift detection, and the MCP 2.x surfaces (discover, elicitation, tasks).
- Run-drawer span and turn tree, a per-user cost dimension, PII and secret redaction before storage, OIDC login with roles and an audit log, vendor usage import (Claude Code Analytics API, Codex, Cursor, Copilot), and agent version-drift signals.

### Carried over

- Continuous live-API smoke runs (a scheduled playground job).
- nginx rate limiting at the edge (a per-token limiter exists in ingestion).
- Dashboard authentication beyond the single bearer token (lands with OIDC above).
- MCP policy version history, dry-run preview and YAML import / export (dropped from the first MCP policy release; reinstated on demand).
- Removal of the CrewAI MCP schema compat helper once `mcpadapt` no longer needs it.
- Surfacing API 400 validation errors in the dashboard.

### Declined

- Antigravity CLI adapter (its hooks expose no telemetry or token data yet), Roo Code (shut down), Continue (repository read-only), AutoGen (archived; superseded by the Microsoft Agent Framework item above).
- Evaluations and LLM-as-judge, prompt management, notifications, a proxy or gateway mode, and multi-tenant SaaS (see "What Flightdeck is NOT").

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, lint, test instructions, and the process for adding a new LLM provider.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), the author's own open source token budget enforcement library.
