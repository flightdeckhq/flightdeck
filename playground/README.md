# Flightdeck Playground

Working examples for every framework Flightdeck supports. Each file is a minimal, copy-pasteable developer script showing how to wire `flightdeck-sensor` into a specific stack. Pick the file that matches your framework, copy it, adapt to your code.

The suite also doubles as a pre-release smoke check: `python playground/run_all.py` runs every file against a live Flightdeck stack with real provider API keys. Total cost under $0.05 per full run.

## Files

| File | Stack | What it shows |
|---|---|---|
| `01_direct_anthropic.py` | anthropic SDK | sync / async / streaming / beta.messages |
| `02_direct_openai.py` | openai SDK | sync / async / streaming / responses / embeddings |
| `03_langchain.py` | `langchain-anthropic`, `langchain-openai` | `ChatAnthropic.invoke` + `ChatOpenAI.invoke` |
| `04_langgraph.py` | langgraph | StateGraph routing through ChatAnthropic |
| `05_llamaindex.py` | `llama-index-llms-anthropic`, `llama-index-llms-openai` | `.complete(...)` for both providers |
| `06_crewai.py` | crewai | `LLM("anthropic/...").call(...)` + `LLM("openai/...").call(...)` |
| `07_directives.py` | anthropic | register → POST custom directive → handler runs |
| `08_enforcement.py` | anthropic | server policy `block_at_pct=1` → `BudgetExceededError` |
| `09_capture.py` | anthropic | `capture_prompts` OFF (404) vs ON (200) |
| `10_killswitch.py` | anthropic | POST `shutdown` directive → `DirectiveError` |
| `11_unavailability.py` | anthropic | `continue` vs `halt` against a dead URL |

## Running

Single file (framework must be installed):

```bash
python playground/03_langchain.py
```

Full suite:

```bash
make test-smoke
# or: python playground/run_all.py
```

`run_all.py` executes each file as an isolated subprocess with a 60-second timeout, streams stdout/stderr through in real time, and prints a PASS/SKIP/FAIL summary at the end. Exits 0 iff every file returned 0 (PASS) or 2 (SKIP).

## Prerequisites

- A running Flightdeck stack. Default: `make dev` on `localhost:4000`. Override via `FLIGHTDECK_SERVER` / `FLIGHTDECK_TOKEN` / `FLIGHTDECK_API_URL`.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment.
- Framework packages for the examples you want to run. Each file prints a `SKIP: pip install <package>` line and exits cleanly when its dependency is missing, so you can run the suite with only the frameworks you care about installed.

## Coverage notes

- **litellm** has its own module-level interceptor (`12_litellm.py`). `litellm.completion` and `litellm.acompletion` are wrapped regardless of underlying provider, closing the previous gap where litellm's raw-httpx Anthropic route bypassed the SDK-class patches. Streaming (`stream=True`) is not yet supported -- see the Roadmap in the root `README.md`. For the full "what's caught, what's not" breakdown of the litellm interceptor, see `sensor/README.md`.
- **CrewAI 1.14+** uses the official `anthropic` / `openai` SDKs directly, so its LLM calls are intercepted through the SDK-class patches (see `06_crewai.py`).
