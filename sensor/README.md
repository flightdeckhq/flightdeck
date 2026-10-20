# flightdeck-sensor

In-process agent observability sensor for [Flightdeck](https://github.com/flightdeckhq/flightdeck).

## Local development venv

Flightdeck pins **Python 3.12** for local development. The project
bound is `3.10 ≤ x < 3.14` (pyproject `requires-python`); `sensor/.venv`
is the canonical interpreter for every Make target that runs Python.

Recreate from a fresh clone or after a `rm -rf sensor/.venv`:

```bash
python3.12 -m venv sensor/.venv
./sensor/.venv/bin/python -m pip install -e ".[dev,anthropic,openai]"
```

`make -C sensor install` does the same once the venv exists. CI
overrides via env (`PYTHON=python make -C sensor test`) where
`actions/setup-python` already pinned the interpreter.

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

## Framework support

`flightdeck_sensor.patch()` installs six interceptors process-wide:
three LLM-call interceptors (class-level or module-level), one MCP
interceptor, and two sub-agent interceptors. Every LLM call that
flows through a patched entry point emits a `pre_call` / `post_call`
event pair without any framework-specific wiring; the MCP and
sub-agent interceptors emit their own event types, described in the
table.

| Framework | Interceptor | Entry points |
| --- | --- | --- |
| Anthropic SDK (direct or via a framework that constructs `Anthropic()` internally — LangChain, LlamaIndex, CrewAI native) | `patch_anthropic_classes` | `Anthropic.messages.create` (including `stream=True`) / `.stream`, async + sync, beta resources; streamed calls are metered from the in-stream usage events |
| OpenAI SDK (direct or via a framework that constructs `OpenAI()` internally — LangChain, LlamaIndex, CrewAI native) | `patch_openai_classes` | `OpenAI.chat.completions.create`, `.responses.create` (including `stream=True`, metered from the final usage chunk / `response.completed`), `.embeddings.create`, async + sync; the `.stream()` / `.parse()` helpers are not intercepted |
| litellm (router that aggregates many providers behind one function surface) | `patch_litellm_functions` | `litellm.completion`, `litellm.acompletion`, `litellm.embedding`, `litellm.aembedding` |
| MCP (official Python `mcp` SDK, reached transitively by `langchain-mcp-adapters`, `llama-index-tools-mcp` and `mcpadapt`) | `patch_mcp_classes` | `mcp.client.session.ClientSession.initialize` (server fingerprint capture), `.list_tools`, `.call_tool`, `.list_resources`, `.read_resource`, `.list_prompts`, `.get_prompt` (one `mcp_*` event type each), plus the stdio / SSE / streamable-HTTP / websocket transport client factories for transport attribution. `call_tool` also enforces the MCP Protection Policy. Supported SDK range: `mcp>=1.20,<2` (2.x is on the README Roadmap). |
| CrewAI (sub-agent sessions) | `patch_crewai_classes` | `crewai.Agent.execute_task` / `.aexecute_task` — each Crew member's turn lands as a child session (`session_start` / `session_end`) with `parent_session_id`, `agent_role` taken from `Agent.role`, and incoming / outgoing message capture gated on `capture_prompts` |
| LangGraph (sub-agent sessions) | `patch_langgraph_classes` | `langgraph.graph.StateGraph.add_node` — the registered node callable is wrapped so each node run lands as a child session with `agent_role` taken from the node name; every node is treated as agent-bearing unless narrowed with `init(langgraph_agent_node_pattern=...)` |

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
    server="http://flightdeck.internal/ingest", token="ftd_...",
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

Install the optional dependency: `pip install flightdeck-sensor[litellm]`.

### What the litellm interceptor catches, and what it doesn't

**Catches.** Direct callers of `litellm.completion(**kwargs)` and
`litellm.acompletion(**kwargs)` — the vast majority of litellm
integrations, including the default chat-completion surface exposed
by user code, Router, and frameworks that route through the public
API (CrewAI non-native flavors, langchain-community's litellm
adapter, etc.). Embedding calls through `litellm.embedding(**kwargs)`
and `litellm.aembedding(**kwargs)` are wrapped the same way, so
embedding-model token usage lands too (`12_litellm.py` in the
playground exercises the capture round-trip).

**Does NOT catch.**
- **Streaming.** `stream=True` raises `NotImplementedError`; litellm
  streaming is not yet intercepted (listed under "Known limitations"
  in the root `README.md`). Use `stream=False` or reconstruct the
  stream downstream of the call.
- **Lower-level litellm entry points.** Some integrations reach
  past `completion` into `litellm.llms.custom_httpx.http_handler`
  or other internal helpers directly. Those calls bypass the
  module-level wrapper. A broader httpx-level interceptor was
  considered when the litellm interceptor was scoped and deferred —
  if framework reports surface calls that slip past the current
  coverage, file a new issue.
- **`litellm.text_completion`.** Legacy completion API, not
  wrapped.
