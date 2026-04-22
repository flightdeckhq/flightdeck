# flightdeck-sensor

In-process agent observability sensor for [Flightdeck](https://github.com/flightdeckhq/flightdeck).

## Optional `session_id` hint (D094)

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
confirms attachment. See DECISIONS.md D094 and ARCHITECTURE.md
("Session attachment flow") for the full protocol.

## Framework support

`flightdeck_sensor.patch()` installs three class-level (or module-
level) interceptors process-wide. Every LLM call that flows through
a patched entry point emits a `pre_call` / `post_call` event pair
without any framework-specific wiring.

| Framework | Interceptor | Entry points |
| --- | --- | --- |
| Anthropic SDK (direct or via a framework that constructs `Anthropic()` internally — LangChain, LlamaIndex, CrewAI native) | `patch_anthropic_classes` | `Anthropic.messages.create` / `.stream`, async + sync, beta resources |
| OpenAI SDK (direct or via a framework that constructs `OpenAI()` internally — LangChain, LlamaIndex, CrewAI native) | `patch_openai_classes` | `OpenAI.chat.completions.create`, `.responses.create`, `.embeddings.create`, async + sync |
| litellm (router that aggregates many providers behind one function surface) | `patch_litellm_functions` | `litellm.completion`, `litellm.acompletion` |

### litellm example (KI21)

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
adapter, etc.).

**Does NOT catch.**
- **Streaming.** `stream=True` raises `NotImplementedError` in v1
  with a pointer to KI26 (the tracked follow-up). Use
  `stream=False` or reconstruct the stream downstream of the call.
- **Lower-level litellm entry points.** Some integrations reach
  past `completion` into `litellm.llms.custom_httpx.http_handler`
  or other internal helpers directly. Those calls bypass the
  module-level wrapper. A broader httpx-level interceptor was
  considered during the KI21 scoping and deferred — if framework
  reports surface calls that slip past the current coverage, file
  a new issue.
- **Embeddings (`litellm.embedding` / `aembedding`).** Not wrapped
  in v1. Out of scope; embeddings have no policy/budget surface
  in the current session layer.
- **`litellm.text_completion`.** Legacy completion API, not
  wrapped.
