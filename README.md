# Flightdeck

Observability and control for AI agent fleets.

Flightdeck ingests events from sensor-instrumented agents and the Claude Code plugin, stores them in Postgres, and serves a dashboard, a query API, and a WebSocket push channel.

---

<!-- Fleet view demo. Recording coming shortly. -->
![Fleet view: every session on a shared timeline, events stream in as agents run.](docs/assets/fleet-demo.gif)

<!-- Session drawer demo. Recording coming shortly. -->
![Session drawer: every LLM call, tool use, policy event, and directive in order.](docs/assets/session-demo.gif)

> Recordings above are placeholders. The UI they describe is shipping today.

---

## Quickstart

Start the stack:

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
make dev
```

Dashboard: http://localhost:4000. The dev stack seeds a test token `tok_dev` automatically.

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

Working examples for every supported framework -- LangChain, LangGraph, LlamaIndex, CrewAI, direct SDKs -- live in [`playground/`](playground/). Copy the one that matches your stack.

To run the sensor from source instead of PyPI: `pip install -e sensor/` from the repo root.

---

## What it covers

| Provider  | Intercepted resources                                                                      |
|-----------|--------------------------------------------------------------------------------------------|
| Anthropic | `messages.create`, `messages.stream`, `beta.messages.create`, `beta.messages.stream` (sync and async) |
| OpenAI    | `chat.completions.create`, `responses.create`, `embeddings.create` (sync, async, streaming)|

Non-agent resources (`audio`, `images`, `moderations`, `files`, `fine_tuning`, legacy `completions`) are deliberately not intercepted.

### Frameworks

After `init()` + `patch()`, frameworks that build Anthropic or OpenAI clients internally are intercepted without any user-side wrapping.

| Framework    | Path covered                                                                             |
|--------------|------------------------------------------------------------------------------------------|
| LangChain    | `langchain-anthropic` (`ChatAnthropic.invoke`), `langchain-openai` (`ChatOpenAI.invoke`) |
| LangGraph    | Covered transitively via LangChain. Any graph routing through `ChatAnthropic` or `ChatOpenAI` is intercepted, including `langgraph.prebuilt.create_react_agent` tool loops. |
| LlamaIndex   | `llama-index-llms-anthropic` and `llama-index-llms-openai` (`.complete`)                 |
| CrewAI 1.14+ | `LLM(model=...).call()` via the native Anthropic and OpenAI provider classes            |

---

## Capabilities

### Live fleet timeline

Every session on one shared time axis, one swim lane per agent flavor and one sub-row per running session. LLM calls, tool uses, policy events, and directives are plotted on the timeline as events arrive. Pause and catch-up controls freeze the scroll without dropping events; the event-type filter bar isolates LLM Calls, Tools, Policy, Directives, or Session events. Provider logos render on LLM call nodes, OS and orchestration icons on session hostnames. Click any event to inspect it inline.

### Full session inspection

Enable prompt capture to store every call's full payload: system prompt, messages, tool definitions, and model response. Off by default.

```python
flightdeck_sensor.init(server="...", token="...", capture_prompts=True)
```

Provider shape is preserved. Anthropic sessions display `system`, `messages`, `tools`, and `response` as separate fields. OpenAI sessions display `messages` (system role included), `tools`, and `response`. No cross-provider normalization.

### Runtime context

On `init()` the sensor captures hostname, OS, Python version, git commit / branch / repo, container orchestration (Kubernetes, Docker Compose, ECS, Cloud Run), and any in-process AI frameworks (LangChain, CrewAI, LlamaIndex, AutoGen, Haystack, DSPy, smolagents, pydantic_ai). Git remote URLs are credential-stripped before storage.

The session drawer surfaces a collapsible **RUNTIME** panel. The sidebar **CONTEXT** facet panel filters the fleet by any context field (`os=Linux`, `k8s_namespace=research`, `git_branch=main`). Every probe is wrapped in defensive try/except: a broken collector never crashes the agent.

### Token enforcement

Define policies centrally. Each agent pulls its policy on session start and enforces it locally with no code changes.

- At 82% of budget: a warning event fires, the call proceeds.
- At 91% of budget: the model is substituted for a cheaper model configured on the policy.
- At 100% of budget: the call raises `BudgetExceededError`.

Thresholds, actions, and model substitutions are configurable per policy. Policies attach to agent flavors and propagate to every session of that flavor.

### Kill switch

Stop an individual agent or every agent of a flavor from the dashboard. The directive is delivered on the agent's next LLM call; agents in a tool loop stop when the loop returns to its next call.

### Custom directives

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

The function registers with the control plane on `init()` and is callable from the dashboard. Results are recorded as `directive_result` events on the session timeline.

### Analytics

Token consumption, session counts, policy event volume, latency, and model distribution on a shared time range. Every chart has a group-by control spanning `flavor`, `model`, `framework`, `host`, `agent_type`, `team`, and `provider`. Every chart reads from the same endpoint (`GET /v1/analytics`), so the global time range applies to all of them at once.

### Estimated cost

Flightdeck computes an estimated cost per session from public list prices. The per-event formula is:

```
(tokens_input - tokens_cache_read - tokens_cache_creation) * input_price
  + tokens_cache_read     * input_price * 0.10
  + tokens_cache_creation * input_price * 1.25
  + tokens_output         * output_price
```

Cache ratios follow Anthropic's published structure (90% discount on reads, 25% premium on writes) and apply uniformly to every model that reports cache tokens. OpenAI and other providers that don't report cache tokens contribute 0 to the cache terms, so the formula collapses to `tokens_input * input_price + tokens_output * output_price`.

Pricing data lives in [`pricing.yaml`](pricing.yaml) at the repo root and is loaded at API startup. To change a price: edit the YAML, open a PR with a link to the provider's pricing page. See [CONTRIBUTING.md](CONTRIBUTING.md#updating-pricing-data).

These are estimates. Actual billing will differ. Not included: volume discounts, enterprise commitments, negotiated rates, cached-token rebates beyond the published ratio. Treat the cost chart as a sanity check, never as an invoice.

### Search

Cmd+K searches sessions, agents, and events.

### Access tokens

Mint opaque `ftd_` bearer tokens from the Settings page. Each token carries a name that persists on every session it opens, so you can trace which deployment's token produced which session. Plaintext is shown once at creation time and is not recoverable afterwards.

Revoking a token does not strip its historical attribution: previous sessions keep their `token_name` snapshot.

`tok_dev` is accepted only when the service sees `ENVIRONMENT=dev` (the dev compose opts in). Production deployments leave that env var unset and the seed token becomes inert.

### Claude Code plugin

Claude Code sessions appear in the fleet view alongside sensor-instrumented agents. The plugin is an observer; it has no code footprint in the Claude Code process beyond the hook scripts.

```bash
export FLIGHTDECK_SERVER="http://localhost:4000"
export FLIGHTDECK_TOKEN="tok_dev"
claude --plugin-dir /path/to/flightdeck/plugin
```

`--plugin-dir` loads the plugin for the session without a marketplace install. A marketplace-installable build is not published yet.

Sessions carry `flavor=claude-code`, `agent_type=developer`, and render with a `DEV` badge. Tool inputs and LLM call content are captured by default so the Prompts tab is populated without extra setup -- the developer is observing their own session, not production traffic. Set `FLIGHTDECK_CAPTURE_PROMPTS=false` or `FLIGHTDECK_CAPTURE_TOOL_INPUTS=false` to opt out. Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist. See [plugin/README.md](plugin/README.md) for the full event list and privacy controls.

The plugin is hook-based, so claude-code sessions cannot act on directives mid-call. The Stop Agent button is hidden for these sessions and the Fleet Stop All control skips them when counting directive-capable sessions. See DECISIONS.md D109.

---

## Identity

Every session carries a persistent **flavor** and an ephemeral **session ID**. Set the flavor via environment variable at deploy time, typically from your orchestrator manifest:

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

### Orchestrator session attachment

When a Temporal workflow or Airflow DAG re-runs, you usually want one continuous session rather than a new session per run. Pass a stable `session_id` at `init()` and the backend attaches each execution to the prior session.

```python
import uuid
import flightdeck_sensor as fd

# Pick any fixed namespace UUID per deployment. Same input -> same UUID.
NS = uuid.UUID("00000000-0000-0000-0000-000000000001")

fd.init(
    server="http://flightdeck.internal/ingest",
    token="ftd_...",
    session_id=str(uuid.uuid5(NS, workflow_id)),
)
```

`session_id` must be a valid UUID (any version). Hash string identifiers (workflow_id, dag_run_id) with `uuid.uuid5`. The `FLIGHTDECK_SESSION_ID` environment variable takes precedence over the kwarg.

---

## Sensor reference

### `patch()` vs `wrap()`

`patch()` is the right answer in almost every case. It installs a class-level descriptor on `anthropic.Anthropic`, `anthropic.AsyncAnthropic`, `openai.OpenAI`, and `openai.AsyncOpenAI` so every instance, including ones frameworks build internally, is intercepted.

`wrap()` instruments a single client instance:

```python
client = flightdeck_sensor.wrap(anthropic.Anthropic())
```

Use `wrap()` only when you deliberately do not call `patch()`. Clients built by frameworks will be invisible unless `patch()` is active. Calling `wrap()` after `patch()` is safe: it detects that the class is already patched and returns the client unchanged.

Call `patch()` before any framework or user code constructs a client. Instances that already accessed `.messages`, `.chat`, `.responses`, or `.embeddings` before the patch keep the raw resource cached on the instance and are not intercepted. In practice this means calling `init()` + `patch()` at the top of your entrypoint.

### Environment variables

| Variable                        | Purpose                                                         |
|---------------------------------|-----------------------------------------------------------------|
| `FLIGHTDECK_SERVER`             | Ingestion base URL. Overrides the `server=` kwarg.              |
| `FLIGHTDECK_TOKEN`              | Access token. Overrides the `token=` kwarg.                     |
| `FLIGHTDECK_API_URL`            | Control-plane base URL. Derived from `FLIGHTDECK_SERVER` if unset. |
| `FLIGHTDECK_SESSION_ID`         | Stable session UUID for orchestrator re-runs.                   |
| `FLIGHTDECK_CAPTURE_PROMPTS`    | `true` to enable full payload capture.                          |
| `FLIGHTDECK_UNAVAILABLE_POLICY` | `continue` (default) or `halt` when the control plane is down.  |
| `AGENT_FLAVOR`                  | Persistent agent identity. Default: `unknown`.                  |
| `AGENT_TYPE`                    | `autonomous`, `supervised`, or `batch`.                         |

### Unavailability policy

```bash
FLIGHTDECK_UNAVAILABLE_POLICY=continue  # run with cached policy (default)
FLIGHTDECK_UNAVAILABLE_POLICY=halt      # block new sessions until CP responds
```

The sensor reports over HTTP on a background thread. Control plane downtime is handled by the configured policy; it does not block agent code.

### Threading model

| Pattern                         | Description                                                | Status                |
|---------------------------------|------------------------------------------------------------|-----------------------|
| A. Single-threaded agent        | One `init()`, one thread, sequential LLM calls             | Supported             |
| B. Multithreaded agent          | One `init()`, many threads sharing patched clients         | Supported             |
| C. Multi-agent in one process   | Multiple `init()` calls, one per logical agent             | See Known limitations |

Two background daemon threads run inside the sensor. `flightdeck-event-queue` drains events to the control plane; `flightdeck-directive-queue` processes directives received in event responses (kill, custom handlers, model swap, policy updates). The queues are decoupled so a slow directive handler cannot block event throughput.

---

## Known limitations

- **`patch()` must run before clients are constructed.** Instances that already accessed `.messages`, `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached in `__dict__`. In practice this is a non-issue when `init()` + `patch()` runs at the top of the entrypoint.
- **One `init()` per process.** A second `init()` is a no-op with a warning. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`. Per-thread Session isolation is not yet supported.
- **Custom directive handler input validation is yours.** The `parameters` schema used to register a directive drives the dashboard form and the directive fingerprint. It is not enforced at execution time. Validate types inside your handler.

---

## Self-hosting

Flightdeck is self-hosted. Two deployment targets are supported: Docker Compose (single host) and a Helm chart for Kubernetes with a bundled Postgres + NATS shape. The sections below cover the Docker Compose production overlay step by step, then point at the Helm chart with a values reference table.

### Prerequisites

- Docker Engine 28+ with Compose v2 (`docker compose version` reports `v2.x`).
- A DNS A/AAAA record for the host, e.g. `flightdeck.example.com`.
- A TLS cert for that hostname. The walkthrough below uses `certbot`. Bring-your-own-cert works too -- any `fullchain.pem` + `privkey.pem` pair does.
- Ports 80 and 443 reachable from the public internet (certbot's HTTP-01 challenge needs port 80 during issuance; nginx serves HTTPS on 443).

### 1. Get a TLS certificate

Certbot's standalone mode is the shortest path. It binds port 80 for the ACME HTTP-01 challenge, so nothing else can be listening on 80 at the time -- run it before starting the stack, or stop nginx briefly first (`docker compose ... down nginx` on a running stack):

```bash
sudo certbot certonly --standalone \
  -d flightdeck.example.com \
  --non-interactive --agree-tos \
  -m ops@example.com --no-eff-email
```

Certbot writes the cert to `/etc/letsencrypt/live/flightdeck.example.com/`. If you need to issue or renew without stopping nginx, use `--webroot -w /var/www/certbot` instead. The prod nginx config serves `/.well-known/acme-challenge/` from that path for in-place renewals.

For renewal, certbot ships its own systemd timer (`systemctl list-timers | grep certbot`) and a cron recipe. Renewals happen in place; reload nginx to pick up the new cert:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  exec nginx nginx -s reload
```

### 2. Place the certificate where nginx expects it

The prod compose file mounts `/etc/nginx/certs` on the host read-only into the nginx container and expects `fullchain.pem` + `privkey.pem` inside it. Symlink certbot's output so renewals are picked up automatically:

```bash
sudo mkdir -p /etc/nginx/certs
sudo ln -sf /etc/letsencrypt/live/flightdeck.example.com/fullchain.pem \
  /etc/nginx/certs/fullchain.pem
sudo ln -sf /etc/letsencrypt/live/flightdeck.example.com/privkey.pem \
  /etc/nginx/certs/privkey.pem
```

Bring-your-own-cert: drop the two PEM files directly into `/etc/nginx/certs/` with the same filenames.

### 3. Start the stack

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml up -d
```

What the overlay does (full rationale in `docker/docker-compose.prod.yml`):

- TLS at nginx on 443, 80 → 443 redirect. No direct service ports exposed.
- `ENVIRONMENT` unset on ingestion and api, so the seed `tok_dev` row is rejected (D095).
- `restart: unless-stopped` on every service, memory and CPU ceilings sized for light-to-moderate load, named volumes for Postgres data and NATS JetStream.

Check the stack is healthy:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml ps
```

Every service except nginx listens on the internal compose network only. `workers` has no HTTP surface and shows no open ports; that is correct.

### 4. Reach the dashboard and mint your first access token

Open `https://flightdeck.example.com/` in a browser. The dashboard is reachable without authentication in v0.3.0 -- restrict network access at the ingress or firewall layer until dashboard auth ships (planned post-v0.3.0). Any user with network access to the dashboard can mint and revoke access tokens.

Go to **Settings → Access tokens → Create**. Give the token a name that identifies its caller (e.g. `research-fleet-us-east`). Plaintext is shown once at creation time and is not recoverable afterwards -- copy it into your secret store before closing the modal.

Point an agent at the stack:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com/ingest"
export FLIGHTDECK_TOKEN="ftd_..."
```

The agent appears in the fleet view within seconds of its first LLM call.

### Kubernetes (Helm)

A chart lives at `helm/`. One-command install against an existing cluster with an external managed Postgres:

```bash
helm install flightdeck helm/ \
  --namespace flightdeck --create-namespace \
  --values helm/values.prod.yaml \
  --set postgres.externalUrl="postgres://user:pass@rds.example.com:5432/flightdeck?sslmode=require"
```

Without `postgres.externalUrl` the chart ships its own single-instance Postgres StatefulSet -- fine for small deployments, not HA and not backed up. NATS is always bundled in v0.3.0.

The chart is `v0.3.0` (Chart.yaml) with `appVersion: 0.2.0` because `v0.3.0` container images are not yet published on Docker Hub. Bump `image.tag` in `values.yaml` once they are.

### Helm values reference

The ~20 values an operator is most likely to override. See `helm/values.yaml` for the full schema including resources, node selectors, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.registry` | `docker.io` | Container registry host for all Flightdeck images. |
| `image.repository` | `flightdeckhq` | Namespace under the registry. |
| `image.tag` | `v0.2.0` | Image tag applied to ingestion/workers/api/dashboard unless the per-component `image.tag` overrides it. |
| `image.pullSecrets` | `[]` | `imagePullSecrets` for private registries. |
| `ingestion.replicas` | `2` | Initial replica count. HPA overrides this at runtime when enabled. |
| `ingestion.hpa.enabled` | `true` | Enable the HorizontalPodAutoscaler for ingestion. |
| `ingestion.hpa.minReplicas` | `2` | HPA lower bound. |
| `ingestion.hpa.maxReplicas` | `10` | HPA upper bound. |
| `workers.replicas` | `2` | NATS consumer pod count. |
| `workers.poolSize` | `10` | Per-pod goroutine pool size for NATS consumption. |
| `api.replicas` | `2` | Query API replica count. |
| `api.corsOrigin` | `*` | `Access-Control-Allow-Origin` for the query API. Lock this down to your dashboard origin in prod. |
| `dashboard.replicas` | `2` | Dashboard pod count. |
| `postgres.externalUrl` | *(empty)* | Single escape hatch. When set to a DSN, the bundled Postgres StatefulSet is not rendered and every service reads this DSN from the generated Secret. |
| `postgres.password` | *(empty)* | Superuser password for the bundled StatefulSet. Ignored when `externalUrl` is set. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.replicas` | `3` | NATS StatefulSet replica count. |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `ingress.enabled` | `false` | Render an Ingress that routes `/` to the dashboard, `/api` to the query API, and `/ingest` to the ingestion API. |
| `ingress.className` | *(empty)* | `ingressClassName` on the Ingress resource. |
| `ingress.host` | `flightdeck.local` | Host header routed by the Ingress. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza; typically one entry with a `secretName` populated by cert-manager. |

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, lint, test instructions, and the process for adding a new LLM provider. A `make test-smoke` target runs real LLM calls against a live stack for sensor regression checks (requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; under $0.05 per full run).

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), an open source token budget enforcement library.
