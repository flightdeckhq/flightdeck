# flightdeck-sensor

In-process agent observability sensor for [Flightdeck](https://github.com/flightdeckhq/flightdeck).

## Quickstart

```bash
pip install flightdeck-sensor
```

```python
import flightdeck_sensor

flightdeck_sensor.init()
flightdeck_sensor.patch()
```

`init()` resolves `server` and `token` each as: the kwarg, else the
`FLIGHTDECK_SERVER` / `FLIGHTDECK_TOKEN` environment variable, else the
default. The server default is `http://localhost:4000/ingest`, where the
`flightdeck` binary and the dev compose stack listen. The token default
is the dev seed `tok_dev`, used only when the server was defaulted as
well and its host is loopback; `init()` logs one WARNING when it is in
use. A server supplied without a token raises `ConfigurationError` (a
`ValueError`) naming both variables, whatever its host: the sensor never
sends `tok_dev` to a server you chose. The environment wins over a passed
kwarg, as for every other `init()` knob.

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

Every session also carries a **client type**, the kind of client that produced it (the sensor sends `flightdeck_sensor`, the Claude Code plugin `claude_code`). The dashboard shows it as a pill on each agent and offers it as a filter. A stable `agent_id`, derived from the agent type, user, host, client type and agent name, ties a client's sessions to one agent.

For one continuous session across the re-runs of a Temporal workflow or an Airflow DAG, pass a stable `session_id` at `init()`: see [Optional `session_id` hint](#optional-session_id-hint).

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
| `FLIGHTDECK_SERVER`             | The server's address: its base URL (`https://flightdeck.example.com`) or its ingestion URL (`https://flightdeck.example.com/ingest`, what the start-up block prints). Overrides the `server=` kwarg. Default `http://localhost:4000/ingest`. The Claude Code plugin reads the same variable and takes the same two forms. |
| `FLIGHTDECK_TOKEN`              | Access token. Overrides the `token=` kwarg. Defaults to `tok_dev` only when the server is defaulted too. |
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

- `patch()` must run before OpenAI clients are constructed. On openai 1.78 and later, instances that already accessed `.chat`, `.responses`, or `.embeddings` before `patch()` keep the raw resource cached and are not intercepted. Anthropic clients are intercepted from their next call on, whenever they were built, except that a `with_raw_response` / `with_streaming_response` view first touched before `patch()` binds the unpatched method and is not metered.
- The OpenAI patch needs `openai>=1.26` (the first release whose chat `create` takes `stream_options`, which the sensor adds to streamed calls); an older SDK is reported with a warning at import and its calls are not metered. On openai before 1.78 a client built before `patch()` is metered from its next call. Its client-level `with_raw_response` / `with_streaming_response` view is the exception: the SDK builds it with the client, so on a client built before `patch()` or with no session active it is not metered, and on a client built while a session was active it reports to that session.
- The Anthropic patch needs `anthropic>=0.86` (the lowest release with the resource layout it imports); an older SDK is reported with a warning at import and its calls are not metered.
- A `with_raw_response.create(stream=True)` response (Anthropic or OpenAI) that is never parsed has no close hook to settle on: it is reported on the pre-call estimate (as an aborted stream with no chunks when its body was never read), at the next LLM call the sensor intercepts after the response is collected, or when the session ends. The streaming view (`with_streaming_response`) settles when its `with` block exits, whether or not its stream was parsed or read.
- Anthropic Message Batches (`messages.batches.*`) and `count_tokens` are not patched: batch spend runs outside the kill switch and the token budget.
- With `capture_prompts=True`, prompts sent through the Bedrock, Vertex, Foundry, AWS and Mantle clients — platforms often chosen for data residency — reach the Flightdeck control plane like any other captured prompt. Keep capture off for those sessions, or keep the control plane inside the same residency boundary.
- llama-index-llms-anthropic (through 0.12.3) always sends `temperature`, which anthropic 1.x's `Messages.create` rejects, so LlamaIndex's Anthropic LLM fails on anthropic 1.x with or without the sensor; the playgrounds skip it there.
- On mcp 2.x, `mcp.Client` answers `list_tools`, `list_resources`, `list_resource_templates`, `list_prompts` and `read_resource` from its response cache when it can; a cached answer makes no MCP request, so no `mcp_*` event is emitted for it (pass `cache=None` to the `Client` to observe every request). Tool calls are not cached and are always observed and policed.
- Per-thread Session isolation is not yet supported. Multi-agent frameworks (CrewAI, LangGraph, etc.) work fine under a single `init()` and shared `AGENT_FLAVOR`.
- Custom directive handler input validation is yours. The `parameters` schema drives the dashboard form and the directive fingerprint; it is not enforced at execution time.
- While a litellm call is in flight, an SDK call made from inside it (by a litellm callback, guardrail or custom provider, or by a task created inside the call and run before it ends) is neither policed nor metered: the litellm wrapper has already metered the call it serves, and the mark that tells the SDK interceptors so covers the whole call. A litellm call made from inside it is reported as a call of its own, except litellm's own re-issues of the same call (its responses/completion bridge and its `fallbacks` loop, which report once, with the model that answered). A chat call through litellm's MCP gateway is reported twice, and a sync call with `fallbacks` made while an event loop is running in its thread (a notebook) has each attempt reported as a call of its own beside it (a failed primary and one fallback: three `pre_call`s, two `post_call`s, one `llm_error`). Under a DEGRADE policy a litellm call's `fallbacks` are dropped, so it runs only the degrade target.

## Local development venv

Flightdeck pins **Python 3.12** for local development. The sensor
supports `3.11 ≤ x < 3.15` (pyproject `requires-python`); `sensor/.venv`
is the canonical interpreter for every Make target that runs Python.

Recreate from a fresh clone or after a `rm -rf sensor/.venv`:

```bash
python3.12 -m venv sensor/.venv
./sensor/.venv/bin/python -m pip install -e ".[dev,anthropic,openai]"
```

`make -C sensor install` does the same once the venv exists. To get
the exact versions CI tests with, install from the lockfile instead:

```bash
cd sensor && uv sync --locked --python 3.12 --extra dev --extra anthropic --extra openai
```

CI installs from `sensor/uv.lock` into the `actions/setup-python`
interpreter and overrides via env (`PYTHON=python make -C sensor
test`). The lock covers Python 3.11 to 3.14 and every CI lane: the
framework lane (`dev` extra), the newest-SDK lane (`sdk-majors`
dependency group), the oldest-openai lane (`openai-floor` dependency
group, openai 1.26.0, which runs `tests/unit/test_openai_constructed_resources.py`)
and the SDK-floors lane (`sdk-floors` dependency group: anthropic
0.86.0, openai 2.8.0, litellm 1.83.0 and mcp 1.28.0 on Python 3.11,
which runs the unit suite). pydantic 2.10 is the declared core floor;
the mcp extra lifts it to 2.11 (mcp 1.28 requires it), and the
SDK-floors lane resolves a newer pydantic, so 2.10 itself is not tested
in CI.
`uv lock` resolves only releases at least 14 days
old, anthropic a day old (`[tool.uv]` in `pyproject.toml`).

## Optional `session_id` hint

By default `init()` auto-generates a fresh UUID every time the process
starts. Orchestrators that re-run the same logical workflow (Temporal,
Airflow, cron) can instead pass a stable identifier; if the backend
already has a row for that session, the new execution is attached to it
and appears as a continuation of the prior run in the fleet view.

Supply the hint via either the `session_id=` kwarg or the
`FLIGHTDECK_SESSION_ID` environment variable. The env var takes
precedence.

The value MUST parse as a canonical UUID (any version) -- the
sessions table column is UUID-typed. If you pass a non-UUID the
sensor logs a warning and falls back to auto-generating one.
Orchestrators that use string identifiers (Temporal workflow_id,
Airflow dag_run_id) should hash the identifier into a deterministic
UUID with `uuid.uuid5`.

### Temporal workflow example

```python
import uuid
import flightdeck_sensor as fd
from temporalio import workflow

# Pick any fixed namespace UUID for your deployment. The same
# workflow_id + namespace always produces the same session UUID,
# so re-runs of the same workflow all map to the same sessions row.
FLIGHTDECK_NS = uuid.UUID("00000000-0000-0000-0000-000000000001")


@workflow.defn
class MyWorkflow:
    @workflow.run
    async def run(self, input):
        ctx = workflow.info()
        fd.init(
            server="http://flightdeck.internal/ingest",
            token="ftd_...",
            session_id=str(uuid.uuid5(FLIGHTDECK_NS, ctx.workflow_id)),
        )
        # If this workflow_id has run before, the backend attaches
        # this execution to the existing session automatically; the
        # sensor logs INFO on the first response that confirms it.
        ...
```

The sensor logs a single WARNING at `init()` time whenever a custom
`session_id` is in play so the behaviour is visible in operational
logs, and an INFO line on the first response where the backend
confirms attachment. See ARCHITECTURE.md ("Session attachment flow")
for the full protocol.

## Shutdown and signals

The session ends, sending `session_end`, when the process exits normally
(an `atexit` handler), when you call `flightdeck_sensor.teardown()`, or
on SIGTERM or SIGINT. For a signal, the sensor's handler does not end the
session on the thread the signal interrupted, which may be holding one of
the sensor's locks: the event queue's background thread sends the queued
events and `session_end`, and the handler waits up to 2 seconds for it.
It then passes the signal on to the handler it replaced, so the process
ends as it would have without the sensor: SIGTERM with no handler of your
own ends the process, SIGINT raises `KeyboardInterrupt`, and your own
handler is called. If `session_end` is not out yet and the signal's
action is to end the process, the sensor lets the interrupted code go on
and delivers the signal again once `session_end` is sent. That shutdown
takes 8 seconds at most, or about 10.5 when an event's POST was under way
as the signal arrived (it runs to its 10-second timeout first, without a
retry); both are well inside Kubernetes' 30-second grace period. Each
event gets one attempt, so a control plane that is down or slow delays
the exit by that much at most; a slow DNS lookup for the control plane
is not covered. Python acts on the signal delivered again when the main
thread next runs Python code, so a long call into native code there
delays the exit until it returns. A second signal is passed on at once
and forces the exit. A signal your application ignores stays ignored, and
the session carries on.

## Framework support

`flightdeck_sensor.patch()` installs seven interceptors process-wide:
three LLM-call interceptors (class-level or module-level), one MCP
interceptor, two sub-agent interceptors and one Claude Agent SDK
interceptor. Every LLM call that flows through a patched entry point
emits a `pre_call` / `post_call` event pair without any
framework-specific wiring; the other interceptors emit their own event
types, described in the table.

`patch()` never imports an SDK. An SDK your application has already
imported is patched at once; one it imports later is patched as it is
imported, before the `import` statement returns, so the order of
`import openai` and `flightdeck_sensor.patch()` does not matter, and an
SDK the application never imports is never loaded. `import
flightdeck_sensor`, `init()` and `patch()` therefore load none of
anthropic, openai, litellm, mcp, crewai, langgraph, claude-agent-sdk or openai-agents,
and litellm downloads its price list from GitHub (which it does when it
is imported) only if your application imports it. `unpatch()` (and
`teardown()`) stops patching SDKs as they are imported.

| Framework | Interceptor | Entry points |
| --- | --- | --- |
| Anthropic SDK — every client class (`Anthropic`, `AnthropicBedrock`, `AnthropicVertex`, `AnthropicFoundry`, `AnthropicAWS`, `AnthropicBedrockMantle`, `AnthropicGoogleCloud` and their async forms), direct or via a framework that constructs one internally (LangChain, LlamaIndex, CrewAI native) | `patch_anthropic_classes` | `messages.create` (including `stream=True`), `.stream`, `.parse`, async + sync, beta resources, the raw view (`with_raw_response`) and the streaming view (`with_streaming_response`, metered at `parse()`); streamed calls are metered from the in-stream usage events, and a raw stream (`create(stream=True)`) is assembled with the SDK's own accumulator, so it stores its response under `capture_prompts` and emits its `tool_call` events like a non-streamed call; every `post_call` carries `provider_metadata.platform` (`anthropic`, `bedrock`, `bedrock-mantle`, `aws`, `vertex`, `google-cloud`, `foundry`, or a gateway's host) |
| OpenAI SDK (direct or via a framework that constructs `OpenAI()` internally — LangChain, LlamaIndex, CrewAI native) | `patch_openai_classes` | `OpenAI.chat.completions.create` / `.parse` / `.stream` (and `OpenAI.beta.chat.completions.parse` / `.stream`), `.responses.create` / `.parse` / `.stream`, `.embeddings.create`, async + sync, and the raw and streaming views of each (`with_raw_response` / `with_streaming_response`, on the resource or the client; a streamed view call is metered when its response is parsed, and one whose stream is never read is reported as an aborted stream with no chunks); streamed calls are metered from the chat usage chunk and `response.completed` and assembled with the SDK's own stream state, so they store their response under `capture_prompts` and emit their `tool_call` events; a Responses call stores its `instructions` and `input`, and an `mcp_call` names its server as `server_name` |
| litellm (router that aggregates many providers behind one function surface) | `patch_litellm_functions` | `litellm.completion`, `litellm.acompletion`, `litellm.text_completion`, `litellm.atext_completion`, `litellm.responses`, `litellm.aresponses` (each with `stream=True`), `litellm.embedding`, `litellm.aembedding` |
| MCP (official Python `mcp` SDK, reached transitively by `langchain-mcp-adapters`, `llama-index-tools-mcp` and `mcpadapt`) | `patch_mcp_classes` | `mcp.client.session.ClientSession.initialize` on mcp 1.x / `.adopt` on mcp 2.x (server fingerprint capture, every 2.x handshake path), `.list_tools`, `.call_tool`, `.list_resources`, `.read_resource`, `.list_prompts`, `.get_prompt` (one `mcp_*` event type each), plus the stdio / SSE / streamable-HTTP / websocket transport client factories and mcp 2.x's `Client._build_session` for transport attribution. `call_tool` also enforces the MCP Protection Policy. Supported SDK range: `mcp>=1.28,<3`. |
| CrewAI (sub-agent sessions) | `patch_crewai_classes` | `crewai.Agent.execute_task` / `.aexecute_task` — each Crew member's turn lands as a child session (`session_start` / `session_end`) with `parent_session_id`, `agent_role` taken from `Agent.role`, and incoming / outgoing message capture gated on `capture_prompts` |
| LangGraph (sub-agent sessions) | `patch_langgraph_classes` | `langgraph.graph.StateGraph.add_node` — the registered node callable is wrapped so each node run lands as a child session with `agent_role` taken from the node name; every node is treated as agent-bearing unless narrowed with `init(langgraph_agent_node_pattern=...)`. Only a node whose action is a plain callable is wrapped: Runnable, `ToolNode` and compiled-subgraph nodes are not |
| LlamaIndex agent workflows (sub-agent sessions, `llama-index-core>=0.14`) | `patch_llama_index` | A span handler on LlamaIndex's root instrumentation dispatcher (no LlamaIndex method is replaced): each agent of a `FunctionAgent`, `ReActAgent`, `CodeActAgent` or `AgentWorkflow` run lands as a child session with `agent_role` the agent's name (the agent's model, tool and MCP calls stay on the sensor's session, as for CrewAI and LangGraph); an `AgentWorkflow` hand-off ends one child, records an `agent_handoff` signal on it and opens the next; a tool call the model wrote as text (ReAct, CodeAct) is reported once as a `tool_call`, its arguments and output under `capture_prompts` |
| Claude Agent SDK (`claude-agent-sdk>=0.2.168,<0.3`) | `patch_claude_agent_sdk` | `query()` (however it was imported) and `ClaudeSDKClient` — each run lands as its own `claude_agent_sdk` session keyed by the Claude Code session id, with a `post_call` per assistant message (tokens, cache split, billing mode) and a `tool_call` per tool use, read from the SDK's message stream; a Claude Code plugin loaded into the run stays silent. `PreToolUse` and `UserPromptSubmit` callbacks added after the caller's hooks apply the run's directives (a stop denies the next tool call and blocks prompts; budget warnings reach the run) and the MCP Protection Policy. Install with `pip install flightdeck-sensor[claude-agent-sdk]`. |
| OpenAI Agents SDK (`openai-agents>=0.6`, sub-agent sessions) | `patch_openai_agents` | `AgentRunner.run` / `.run_streamed` (so `Runner.run`, `run_sync` and `run_streamed`) and the `run` of the four guardrail classes — each agent that runs lands as a child session with `agent_role` taken from `Agent.name`, an agent used as a tool nests under the agent that called it, a hand-off posts `agent_handoff` on the agent handing off, a guardrail that fires posts `guardrail_tripwire` (names only), and the run's conversation id lands in the child's context as `gen_ai_conversation_id`. Model, tool and MCP calls stay on the sensor's session (the OpenAI and MCP interceptors meter them); a shutdown also stops the run when the next agent starts or hands off. Patched only when `agents` comes from the `openai-agents` distribution. Install with `pip install flightdeck-sensor[openai-agents]`. |

### Coverage beyond these interceptors

Any framework that calls a model through the Anthropic or OpenAI SDK or
litellm is metered and enforced through the interceptors above, with no
wrap of its own: Deep Agents, Microsoft Agent Framework,
Google ADK (on `LiteLlm`, Anthropic or OpenAI models), Pydantic AI and
Strands Agents (on their Anthropic, OpenAI and LiteLLM models), Agno,
Haystack, smolagents, Semantic Kernel, AutoGen, AG2 and DSPy on its
litellm engine. Each event names the framework in
`framework` (see "Framework attribution" in ARCHITECTURE.md).

- **Sub-agent sessions planned**
  ([#185](https://github.com/flightdeckhq/flightdeck/issues/185)): Google
  ADK, Microsoft Agent Framework and Deep Agents (each agent and each
  `task` sub-agent).
- **LLM calls planned**
  ([#185](https://github.com/flightdeckhq/flightdeck/issues/185)): a DSPy
  callback adapter for its default engine, which has its own HTTP
  transport and bypasses the SDKs and litellm.
- **No sub-agent sessions from `create_agent`**: the LangGraph
  interceptor wraps only nodes whose action is a plain callable.
  LangChain's `create_agent`, and Deep Agents built on it, register
  Runnable and `ToolNode` nodes, so their runs are one session (their LLM
  calls are still metered).
- **Structure through OpenTelemetry instead**: Pydantic AI and Strands
  Agents export GenAI spans that Flightdeck's OTLP receiver maps into
  observe-only child sessions. The sensor does not wrap them. Report a
  run one way: a run the sensor and an exporter both report counts twice
  ([#279](https://github.com/flightdeckhq/flightdeck/issues/279)).
- **Labelled, structure on the roadmap**: Agno, Haystack and smolagents
  ([#278](https://github.com/flightdeckhq/flightdeck/issues/278)).
- **Not supported**: Gemini through `google-genai`, Google ADK's default
  model included ([#276](https://github.com/flightdeckhq/flightdeck/issues/276));
  boto3 `bedrock-runtime` Converse, Strands' default model included
  ([#277](https://github.com/flightdeckhq/flightdeck/issues/277)); BAML,
  Letta, MetaGPT and CAMEL.

ARCHITECTURE.md ("Framework support") has the full matrix.

### litellm example

litellm's Anthropic route uses raw httpx instead of the Anthropic
SDK, so it bypasses the SDK-class patches. The litellm interceptor
patches `litellm.completion` / `litellm.acompletion` directly to
close this gap. An Anthropic model string via litellm exercises the
bypass case:

```python
import flightdeck_sensor
import litellm

flightdeck_sensor.init(
    server="http://flightdeck.internal/ingest",
    token="ftd_...",
)
flightdeck_sensor.patch()

# After patch(), this call routes through the sensor's pre/post-call
# plumbing regardless of which underlying provider litellm picks for
# the model string.
response = litellm.completion(
    model="claude-haiku-4-5-20251001",
    messages=[{"role": "user", "content": "hi"}],
    max_tokens=5,
)
```

Install the optional dependency: `pip install flightdeck-sensor[litellm]`
(the extra requires `litellm>=1.83.0`; 1.82.7 and 1.82.8 were compromised
builds).

### What the litellm interceptor catches, and what it doesn't

**Catches.** Direct callers of `litellm.completion` and
`litellm.acompletion` — the vast majority of litellm
integrations, including the default chat-completion surface exposed
by user code, Router, and frameworks that route through the public
API (CrewAI non-native flavors, langchain-community's litellm
adapter, etc.) — streaming included: `stream=True` on either returns
the sensor's stream guard around litellm's `CustomStreamWrapper`,
iterated the same way (`for` / `async for`), metered from the token
counts litellm reports in its trailing usage chunk; that chunk is
kept from a caller who did not ask for `stream_options.include_usage`.
`litellm.text_completion` / `atext_completion` and
`litellm.responses` / `aresponses` are wrapped the same way, streaming
included (a Responses stream is metered from its terminal event), on
every route: one served through the OpenAI SDK, litellm's own httpx
routes (Anthropic, the native Responses API), and a Responses call
litellm bridges through `completion` for a provider without a native
Responses API. Each litellm call is counted once, by the wrapper of
the entry point the caller used, also where litellm calls the OpenAI
SDK or its own `completion` underneath. Embedding calls through
`litellm.embedding` and `litellm.aembedding` are wrapped the same way,
so embedding-model token usage lands too. Arguments may be passed
positionally or by name, as litellm takes them (`12_litellm.py` in the
playground exercises sync and async streaming, the single-count
assertion and the capture round-trip; `30_parse_and_litellm_routes.py`
covers `text_completion` and `responses` on each route kind).

**Does NOT catch.**
- **Lower-level litellm entry points.** Some integrations reach
  past `completion` into `litellm.llms.custom_httpx.http_handler`
  or other internal helpers directly. Those calls bypass the
  module-level wrapper. A broader httpx-level interceptor was
  considered when the litellm interceptor was scoped and deferred —
  if framework reports surface calls that slip past the current
  coverage, file a new issue.
- **SDK calls made from inside a litellm call.** The litellm wrapper
  marks the call it serves so the SDK interceptors pass it through; the
  mark covers the whole call, so an SDK call made while it is in flight
  by a litellm callback, guardrail or custom provider, or by a task
  created inside the call, is neither policed nor metered. A litellm
  call made from inside it is a call of its own and is reported; only
  litellm's own re-issues of the same call pass through: its
  responses/completion bridge and its `fallbacks` loop (a call a fallback
  answered is reported once, with the model that answered; a failed
  attempt before it is not reported on its own, and neither are the
  tokens of a non-streamed attempt the provider billed before it failed).
  Under a DEGRADE policy a call's `fallbacks` and
  `context_window_fallback_dict` are dropped, so it runs only the degrade
  target.
- **Reported more than once.** A chat call routed through litellm's MCP gateway
  (tools that name it), whose re-issue cannot be told from its billed
  follow-ups; a sync call with `fallbacks` made while an event loop is
  running in its thread (a notebook), whose attempts run in a worker
  thread without the call's context, so each attempt is reported as a
  call of its own beside the call (a failed primary and one fallback:
  three `pre_call`s, two `post_call`s, one `llm_error`); and re-issued
  calls when another
  instrumentation library replaces a litellm entry point after
  `flightdeck_sensor.patch()`.
