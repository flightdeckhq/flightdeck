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

### Local development environment

Flightdeck pins **Python 3.12** for local development. The project bound is `3.10 ≤ x < 3.14` (sensor `pyproject.toml`); the venv at `sensor/.venv` is the canonical interpreter for every Make target that runs Python (playground demos, integration tests, seed scripts).

Fresh-clone setup:

```bash
python3.12 -m venv sensor/.venv
./sensor/.venv/bin/python -m pip install -e "./sensor[dev,anthropic,openai]"
```

Every `make` target that runs Python resolves through `$(PYTHON)`, defaulting to `./sensor/.venv/bin/python`. CI overrides via env (`PYTHON=python make ...`) where `actions/setup-python` already pinned the right interpreter. See [`sensor/README.md`](sensor/README.md) for the recreation step if the venv is nuked.

`make playground-all` runs the canonical manual-exercise matrix against a live dev stack — every framework + every event shape Flightdeck observes. Each script self-skips on missing API keys / optional gateway URLs / optional CLI binaries; a clean run on a fresh box has only those acceptable skips. See [`playground/README.md`](playground/README.md).

---

## What it covers

| Provider  | Chat | Embeddings | Streaming (TTFT/chunks/abort) | Errors |
|-----------|------|------------|-------------------------------|--------|
| Anthropic | `messages.create`, `messages.stream`, `beta.messages.create`, `beta.messages.stream` (sync + async) | N/A native — route via litellm → Voyage | sync + async | structured `llm_error` event with 14-entry taxonomy |
| OpenAI    | `chat.completions.create`, `responses.create` (sync + async) | `embeddings.create` (sync + async) | sync + async | same |
| litellm   | `litellm.completion`, `litellm.acompletion` (chat path only — KI26 streaming deferred) | `litellm.embedding`, `litellm.aembedding` | sync only (KI26) | same |

Streaming events expose `payload.streaming = {ttft_ms, chunk_count, inter_chunk_ms: {p50, p95, max}, final_outcome, abort_reason}`. Mid-stream aborts emit `llm_error{error_type="stream_error"}` with `partial_chunks` / `partial_tokens_*` so token accounting reflects work done before the failure.

Non-agent resources (`audio`, `images`, `moderations`, `files`, `fine_tuning`, legacy `completions`) are deliberately not intercepted.

### Frameworks

After `init()` + `patch()`, frameworks that build Anthropic or OpenAI clients internally are intercepted without any user-side wrapping.

| Framework        | Chat | Embeddings | Streaming | Errors |
|------------------|------|------------|-----------|--------|
| LangChain        | `langchain-anthropic` (`ChatAnthropic.invoke`), `langchain-openai` (`ChatOpenAI.invoke`) | `OpenAIEmbeddings.embed_*` (transitive); Voyage-direct deferred | inherits OpenAI / Anthropic | inherits OpenAI / Anthropic |
| LangGraph        | Transitive via LangChain — any graph routing through `ChatAnthropic` or `ChatOpenAI`, including `langgraph.prebuilt.create_react_agent` tool loops | inherits LangChain | inherits LangChain | inherits LangChain |
| LlamaIndex       | `llama-index-llms-anthropic`, `llama-index-llms-openai` (`.complete`) | inherits OpenAI | inherits OpenAI / Anthropic | inherits OpenAI / Anthropic |
| CrewAI 1.14+     | `LLM(model=...).call()` via the native Anthropic and OpenAI provider classes. Model strings that don't match a native-provider prefix (e.g. `openrouter/`, `deepseek/`) fall through to litellm and inherit the litellm-Anthropic gap above. | inherits OpenAI / litellm | inherits | inherits |
| Claude Code plugin | observational — every tool use, prompt, and response surfaces in the fleet view | N/A (observational) | N/A (observational) | partial — `stream_error` only when transcript shows unexpected termination |
| bifrost          | multi-protocol gateway — see below | multi-protocol | multi-protocol | multi-protocol |

Per-event ``framework`` field carries the bare name (``langchain``, ``crewai``, ...) populated at sensor ``init()`` from in-process introspection. Higher-level framework wins over SDK transport: a LangChain pipeline routing through litellm routing through OpenAI reports ``framework=langchain``.

**Bifrost** is a multi-provider LLM gateway. Flightdeck observes agents routing through bifrost via the protocol used — point the openai SDK at bifrost's `base_url` and the OpenAI interceptor fires; point the anthropic SDK at bifrost and the Anthropic interceptor fires. Both protocols are supported as deployment topologies.

### Sub-agent observability

Multi-agent frameworks render as a tree in the fleet view: a parent session for the orchestrator and a separate child session per sub-agent execution, linked by ``parent_session_id`` and labeled with ``agent_role`` (D126).

| Mechanism | parent_session_id source | agent_role source |
|---|---|---|
| Claude Code Task subagent | hook payload ``session_id`` | hook payload ``agent_type`` (e.g. ``"Explore"``) |
| CrewAI agent execution | parent crew's session | ``Agent.role`` attribute |
| LangGraph agent-bearing node | parent runner's session | node name |

Direct Anthropic / OpenAI SDK and litellm calls outside a multi-agent framework emit root sessions with both fields null — the existing 5-tuple identity is unchanged. Sub-agent observability ships only for frameworks Flightdeck already supports for LLM-call interception (Frameworks table above); AutoGen support is on the Roadmap.

When ``capture_prompts=True``, each child session carries the parent's input as ``incoming_message`` and the child's response back as ``outgoing_message`` — visible in the SessionDrawer's Sub-agents tab MESSAGES sub-section. The Fleet swimlane renders a ``→ N`` pill on parents and a ``← {parent_name}`` pill on children, plus Bezier connectors from each parent spawn event to its child's first event circle. Sub-agent emission failures surface as red row-level dots on Investigate, the Fleet AgentTable, and the swimlane left panel — same pattern as ``llm_error`` and ``mcp_error``.

### MCP (Model Context Protocol)

Flightdeck observes MCP traffic as a first-class event surface alongside chat and embeddings. Six event types — `mcp_tool_list`, `mcp_tool_call`, `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get` — emit per operation. The sensor patches `mcp.client.session.ClientSession` directly, so every framework that mediates MCP through the official SDK lights up automatically: LangChain via `langchain-mcp-adapters`, LangGraph via the same, LlamaIndex via `llama-index-tools-mcp`, CrewAI via `mcpadapt`, plus the raw `mcp` SDK. Each event carries `server_name` + `transport` for attribution; the session-level `MCPServerFingerprint` (name, transport, protocol_version, version, capabilities, instructions) lands in `context.mcp_servers` when MCP init runs before sensor init.

The Claude Code plugin's MCP coverage is limited to tool calls. Resource reads, prompt fetches, and list operations are below the plugin hook layer and don't surface as events.

---

## Capabilities

### Live fleet timeline

Every session on one shared time axis, one swim lane per agent and one sub-row per running session. LLM calls, embeddings, tool uses, policy events, structured errors, and directives are plotted on the timeline as events arrive. Pause and catch-up controls freeze the scroll without dropping events; the event-type filter bar isolates LLM Calls, Embeddings, Tools, Policy, Errors, Directives, or Session events. Provider logos render on LLM call nodes, OS and orchestration icons on session hostnames. Click any event to inspect it inline.

Expanding an agent row lists every session for that agent — including sessions older than the live time window — with a "View in Investigate →" link for the full history.

### Full session inspection

Enable prompt capture to store every call's full payload: system prompt, messages, tool definitions, model response, and embedding inputs. Off by default.

```python
flightdeck_sensor.init(server="...", token="...", capture_prompts=True)
```

Provider shape is preserved. Anthropic sessions display `system`, `messages`, `tools`, and `response` as separate fields. OpenAI sessions display `messages` (system role included), `tools`, and `response`. Embeddings show the request `input` (string or list of strings) in a dedicated viewer. No cross-provider normalization.

### Runtime context

On `init()` the sensor captures hostname, OS, Python version, git commit / branch / repo, container orchestration (Kubernetes, Docker Compose, ECS, Cloud Run), and any in-process AI frameworks (LangChain, CrewAI, LlamaIndex, AutoGen, Haystack, DSPy, smolagents, pydantic_ai). Git remote URLs are credential-stripped before storage.

The session drawer surfaces a collapsible **RUNTIME** panel. The sidebar **CONTEXT** facet panel filters the fleet by any context field (`os=Linux`, `k8s_namespace=research`, `git_branch=main`). Every probe is wrapped in defensive try/except: a broken collector never crashes the agent.

### Token enforcement

Define policies centrally. Each agent pulls its policy on session start and enforces it locally with no code changes.

- At 82% of budget: a warning event fires, the call proceeds.
- At 91% of budget: the model is substituted for a cheaper model configured on the policy.
- At 100% of budget: the call raises `BudgetExceededError`.

Thresholds, actions, and model substitutions are configurable per policy. Policies attach to agent flavors and propagate to every session of that flavor.

Each enforcement decision lands as a structured event on the session timeline — `policy_warn`, `policy_degrade`, or `policy_block` — alongside the regular `post_call` events. The drawer renders type-specific badges and details (threshold, tokens used vs limit, model swap on degrade, intended-model on block); the Investigate POLICY facet groups sessions by the enforcement outcomes they hit; the session-row dot ranks block > degrade > warn at a glance. Operators see exactly when enforcement fired and why, not just the silence of a blocked call.

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

Sessions carry `flavor=claude-code`, `agent_type=coding`, and `client_type=claude_code` (D115 identity). Tool inputs and LLM call content are captured by default so the Prompts tab is populated without extra setup -- the developer is observing their own session, not production traffic. Set `FLIGHTDECK_CAPTURE_PROMPTS=false` or `FLIGHTDECK_CAPTURE_TOOL_INPUTS=false` to opt out. Raw file bodies written by `Write` / `Edit` are never forwarded; tool inputs go through a sanitised whitelist. See [plugin/README.md](plugin/README.md) for the full event list and privacy controls.

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
| `AGENT_FLAVOR` / `FLIGHTDECK_AGENT_NAME` | Persistent agent label. Default: `{user}@{hostname}`.    |
| `AGENT_TYPE` / `FLIGHTDECK_AGENT_TYPE`   | `coding` or `production` (D114/D115). Default: `production`. Any other value raises `ConfigurationError`. |
| `FLIGHTDECK_HOSTNAME`           | Override `socket.gethostname()` (useful for k8s pod grouping).  |

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

## MCP Protection Policy

Flightdeck can gate which MCP servers your agents are allowed to talk to. The policy lives in the control plane, applies per flavor, and is enforced inside the sensor and the Claude Code plugin without changing the wire path. See `ARCHITECTURE.md` "MCP Protection Policy" for the full design and `DECISIONS.md` D127-D135 for the rationale.

### Why this exists

MCP servers are external code your agents call. A misconfigured `.mcp.json`, a typo'd hostname, a colleague's experimental server, or a substituted binary all reach the agent the same way: as a server entry the agent dials at session start. The MCP Protection Policy is the fence around that. Operators define which servers a production flavor can reach; the sensor and the Claude Code plugin enforce that decision at every MCP call.

### Two scopes: global + per-flavor

The policy lives at two scopes:

- **Global.** One per deployment. Carries the **mode** (allowlist or blocklist) and a list of entries.
- **Per-flavor.** Zero or more. Each carries allow / deny entry deltas against whatever the global resolves to. Per-flavor policies do not carry their own mode (D134).

On install Flightdeck auto-creates an empty global policy in `blocklist` mode with zero entries — fully permissive by default. No operator action is required for MCP traffic to keep flowing on a fresh deployment; locking down a flavor is opt-in.

Per-server resolution proceeds in three steps (D135):

1. If the per-flavor policy has an entry for the URL, use it.
2. Else if the global policy has an entry for the URL, use it.
3. Else apply the global mode default: allowlist → block; blocklist → allow.

Most-specific scope wins; per-flavor entries are real overrides, not suggestions.

### Mode comparison

| Behaviour | `allowlist` | `blocklist` |
|---|---|---|
| Default for unlisted servers | Block | Allow |
| Fits when… | You can enumerate every server agents may use | You can enumerate the servers agents must avoid |
| Typical scope | Production flavor | Dev flavor |
| `block_on_uncertainty` toggle | Meaningful — emits an audit-grade `policy_mcp_block` event with `block_on_uncertainty=true` so unknown servers surface for promotion | Ignored (mode default is already permissive) |

The `block_on_uncertainty` per-flavor boolean (default off) only affects allowlist mode. With it on, unlisted-server traffic still blocks, but the block events carry an explicit "fell through to mode default" signal so operators can find them in the dashboard and promote them to deliberate allow / deny entries.

### Worked fingerprint examples

Server identity is the pair `(URL, name)`. The URL is the security key; the name is the display label and the tamper-evidence axis (D127). The fingerprint is `sha256(canonical_url + 0x00 + name)`; the first 16 hex characters are the display fingerprint.

**HTTP example.** Declared as `https://Maps.Example.com:443/SSE/?token=abc#frag` with name `maps`.

```
canonical_url   = "https://maps.example.com/SSE/"
                  (lowercase scheme + host, default :443 stripped,
                   path case preserved, fragment + query dropped)
fingerprint     = sha256("https://maps.example.com/SSE/" + 0x00 + "maps")
display         = first 16 hex chars
```

**Stdio example.** Declared as `npx -y @modelcontextprotocol/server-filesystem $HOME/data` with name `fs`.

```
canonical_url   = "stdio://npx -y @modelcontextprotocol/server-filesystem /home/alice/data"
                  (stdio:// prefix, single-space separators,
                   $HOME resolved at fingerprint time, args case-sensitive)
fingerprint     = sha256(canonical_url + 0x00 + "fs")
display         = first 16 hex chars
```

A declaration whose URL matches a previously-seen URL under a different name produces a `mcp_server_name_changed` event so operators can investigate drift; the policy decision still resolves on URL.

### Configuration walkthrough

1. **Operator creates a flavor policy on the dashboard** under Settings → MCP Policies. The form lets you select a flavor (e.g., `production`), pick allow / deny entries against the global, and toggle `block_on_uncertainty`.
2. **Sensor and plugin pick it up at the next session.** The Python sensor fetches the active policy at `init()` (synchronous, alongside the existing token-policy preflight). The Claude Code plugin fetches at every `SessionStart` with a one-hour disk cache.
3. **Per-call enforcement.** The sensor evaluates each MCP `call_tool` against the cached policy. On `warn` it emits `policy_mcp_warn` and proceeds. On `block` it emits `policy_mcp_block`, flushes the event queue, and raises `flightdeck.MCPPolicyBlocked` — frameworks surface this as a tool-call failure to the agent's reasoning loop (D130).
4. **Mid-session updates.** A `policy_update` directive received in a response envelope refreshes the sensor cache; the new policy applies at the **next** `session_start`. In-flight sessions deliberately keep the policy that was active at their start so a mid-session flip doesn't change behaviour for a call already in progress (D129).

### Quickstart YAML — "allow exactly these three servers in production"

```yaml
# Global policy (auto-created by Flightdeck on install; shown for clarity)
scope: global
mode: allowlist                  # block any server not explicitly allowed
block_on_uncertainty: false      # (toggle is per-flavor; shown here as a reminder)
entries: []                      # global allow-list is empty; flavor below carries the entries

---
# Per-flavor policy: production
scope: flavor
scope_value: production
block_on_uncertainty: true       # surface fall-through cases as audit-grade blocks
entries:
  - server_url: "https://maps.example.com/sse"
    server_name: "maps"
    entry_kind: allow
    enforcement: block           # ignored on allow entries; matters on deny entries
  - server_url: "https://search.example.com/sse"
    server_name: "search"
    entry_kind: allow
    enforcement: block
  - server_url: "https://wiki.internal/mcp"
    server_name: "internal-wiki"
    entry_kind: allow
    enforcement: block
```

Bulk YAML import is the operator workflow for the "I have N servers, here's the list" case. The dashboard renders the same data as a sortable table.

### Soft-launch in v0.6

The policy machinery ships in two phases (D133). v0.6 hard-codes warn-only behaviour: configured `block` enforcement still emits an event, but the event is `policy_mcp_warn` with `would_have_blocked=true` rather than `policy_mcp_block`, and the agent's call proceeds. v0.7 removes the override and `block` raises `MCPPolicyBlocked` as designed. The full storage, API, dashboard, fingerprinting, and event surfaces ship complete in v0.6.

`FLIGHTDECK_MCP_POLICY_DEFAULT` is the per-agent escape hatch. Set to `enforce` to opt in to real enforcement before v0.7, or to `warn` after v0.7 to opt out.

### Troubleshooting

- **"MCP call works in dev but blocked in production."** The flavor policies differ. Check `Settings → MCP Policies → production` against `dev` — production typically runs allowlist mode, dev typically runs blocklist mode (the default). The `policy_mcp_block` event payload's `decision_path` field tells you which step in the resolution algorithm produced the block (`flavor_entry`, `global_entry`, or `mode_default`).
- **"A server name changed silently."** Look for `mcp_server_name_changed` events in the dashboard. The URL hash is stable across renames; only the display label drifted. Investigate whether the rename is legitimate (a typo fix) or suspicious (an attacker substituting a server with a familiar URL but a different declared name). The policy decision still resolves on URL, so enforcement isn't bypassed by rename.
- **"Decisions remembered locally don't match the dashboard."** Claude Code's `yes-and-remember` decisions live at `~/.claude/flightdeck/remembered_mcp_decisions.json` (D132). The plugin lazy-syncs to the control plane and re-fetches on the standard TTL, so a real `deny` on the server-side policy will eventually override a stale local `yes`. Force a resync immediately by deleting the file and starting a new Claude Code session.
- **"Sensor isn't enforcing in v0.6."** Soft-launch is warn-only by default. Set `FLIGHTDECK_MCP_POLICY_DEFAULT=enforce` to opt in to real enforcement before v0.7, or wait for the v0.7 release to flip enforcement on by default.

### Known framework constraints

CrewAI agents using MCP via `mcpadapt` currently emit JSON Schemas that violate JSON Schema draft 2020-12 — empty `anyOf` arrays, null `enum` / `items` fields, and properties that lose their `type` annotation when the empty `anyOf` is the only type carrier. OpenAI and Anthropic both reject these schemas with cryptic errors:

- OpenAI surfaces it as `"tools[0].function.parameters: None is not of type 'object', 'boolean'"` (strict-mode validation coalesces the malformed schema into `None`).
- Anthropic returns `"tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"`.

**Workaround.** Flightdeck ships an opt-in compat helper that strips the invalid keys and infers a missing `type` from the property's default value before the schema reaches the LLM API. After constructing your CrewAI agent, call:

```python
import crewai
from mcpadapt.core import MCPAdapt
from mcpadapt.crewai_adapter import CrewAIAdapter
from flightdeck_sensor.compat.crewai_mcp import crewai_mcp_schema_fixup

with MCPAdapt(server_params, CrewAIAdapter()) as tools:
    agent = crewai.Agent(role=..., goal=..., tools=tools)
    crewai_mcp_schema_fixup(agent)
    # agent now ready to invoke; LLM tool-call payload uses cleaned JSON Schema.
```

The fixup is idempotent and safe to call multiple times. It mutates each tool's `args_schema` Pydantic class so every downstream consumer (CrewAI's `generate_model_description`, the LLM provider's tool-conversion path, raw `model_json_schema()` calls) sees the cleaned schema.

The helper will be removed in a future Flightdeck release once the underlying mcpadapt schema generation is fixed; tracked in the Roadmap below.

---

## Known limitations

- **`patch()` must run before clients are constructed.** Instances that already accessed `.messages`, `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached in `__dict__`. In practice this is a non-issue when `init()` + `patch()` runs at the top of the entrypoint.
- **One `init()` per process.** A second `init()` is a no-op with a warning. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`. Per-thread Session isolation is not yet supported.
- **Custom directive handler input validation is yours.** The `parameters` schema used to register a directive drives the dashboard form and the directive fingerprint. It is not enforced at execution time. Validate types inside your handler.
- **litellm streaming events are not intercepted.** The sensor patches `litellm.completion` / `litellm.acompletion` for non-streaming calls and `litellm.embedding` / `litellm.aembedding` for embeddings. Streaming via `litellm.completion(stream=True)` falls through to the underlying provider's stream handling and bypasses the sensor's TTFT / chunk / abort accounting. Non-streaming chat calls and embeddings round-trip cleanly. Tracked on the Roadmap below.

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

## What Flightdeck is NOT

Set expectations early so the boundaries are clear:

- **Not a proxy.** Flightdeck never intercepts LLM traffic on the network. The sensor wraps the SDK client classes inside the agent's own process; calls go directly to the provider as before. Nothing routes through Flightdeck.
- **Not a content inspector by default.** Prompt and embedding-input capture is opt-in (``capture_prompts=True``). With capture off, event payloads carry token counts, model names, latency, framework, and tool names only — no message content, no system prompts, no tool inputs or outputs, no response text.
- **Not an orchestrator.** Flightdeck observes; it does not decide what an agent should do next. Directives (kill switch, model swap, custom handlers) are explicit operator actions, not autonomous control.
- **Not a billing system.** ``estimated_cost`` is an approximation from public list prices. Volume discounts, enterprise commitments, negotiated rates, and cache-token rebates beyond the published ratio are not reflected. Treat the cost chart as a sanity check, never as an invoice.
- **Not a notification platform.** No Slack, email, or PagerDuty integrations. That class of feature is post-launch.
- **Not multi-tenant SaaS.** Self-hosted only. One deployment, one tenant.
- **Not an LLM gateway.** No model substitution, no caching layer, no retries injected by Flightdeck. The sensor enforces budgets your agents already know about.

---

## Roadmap

Open work tracked here. Prioritized when users tell us which matters most.

- **Per-agent landing page.** A dedicated agent detail view (today's Investigate filter is the closest equivalent). Token / latency / error trends per agent over rolling windows.
- **Continuous framework verification.** Scheduled live-API smoke runs across every supported framework, not just on PR. Catches SDK class-rename breakage (anthropic ``RateLimitError`` → ``QuotaError`` etc.) before users hit it.
- **Production hardening.** NATS authentication, Helm chart polish, nginx rate limiting, dashboard auth, litellm streaming interception, native LangChain Voyage embeddings, dedicated LlamaIndex / CrewAI interceptors where transitive coverage falls short.
- **AutoGen framework support.** LLM-call interception via `autogen-core` / `autogen-agentchat` (the 0.4 rewrite) or `pyautogen` (0.2 legacy), plus sub-agent observability for it (`agent_role` from `participant.name`, child session per RoutedAgent dispatch / `generate_reply`). AutoGen ships two libraries that share a name with different APIs; both versions need their own interceptor.
- **MCP policy dry-run draft mode.** Current dry-run replays the saved policy against historical events. Pre-save 'draft' state for what-if exploration before committing changes is a post-v0.6 enhancement; user demand will drive prioritization.
- **Remove `flightdeck_sensor.compat.crewai_mcp_schema_fixup` helper.** The helper exists as a workaround for an upstream mcpadapt schema-generation bug emitting JSON-Schema-2020-12-invalid keys (empty `anyOf`, null `enum` / `items`, missing `type` after the empty `anyOf` is removed). Remove the helper + the README "Known framework constraints" subsection once mcpadapt emits valid schemas. Verify by running playground demo 22 without the fixup call; if it PASSES, the upstream is fixed and the helper can land for removal.

The roadmap is intentionally loose. User demand reorders priorities.

---

## Contributing

Bug reports, provider requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, lint, test instructions, and the process for adding a new LLM provider. A `make test-smoke` target runs real LLM calls against a live stack for sensor regression checks (requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; under $0.05 per full run).

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

The fleet timeline UI was inspired by [agent-observe](https://github.com/simple10/agents-observe) by [@simple10](https://github.com/simple10), a great tool for observing individual Claude Code sessions. The sensor builds on the foundation of [tokencap](https://github.com/pykul/tokencap), an open source token budget enforcement library.
