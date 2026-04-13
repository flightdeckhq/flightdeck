# Flightdeck Smoke Test Suite

End-to-end smoke tests that exercise every sensor and platform
capability against a live Flightdeck stack using real LLM provider
calls. The suite doubles as a feature playground -- each scenario is
a small, readable example that a developer can copy into their own
code.

## What it covers

| Group | Area | Scenarios |
|---|---|---|
| 1 | Provider interception | Anthropic/OpenAI via `patch()` and `wrap()`, streaming, beta.messages, tool calls (native) |
| 2 | Prompt capture | `capture_prompts=True` on/off, `has_content` flag, `/v1/events/:id/content` |
| 3 | Local policy enforcement | `init(limit=...)` WARN; confirms D035 (local limit never BLOCKs) |
| 4 | Server-side policy | Flavor-scoped WARN / DEGRADE / BLOCK via `POST /v1/policies` |
| 5 | Kill switch | Single-session shutdown (5a) and flavor-wide shutdown fan-out (5b) |
| 6 | Custom directives | `@directive` registration, execution, parameters, handler-raise |
| 7 | Runtime context | `os` / `hostname` / `python_version` captured on `session_start` |
| 8 | Session visibility | `/v1/sessions` and session detail surface completed sessions |
| 9 | Sensor status | `get_status()` session_id / flavor / token counter |
| 10 | Unavailability policy | Sensor fails open with unreachable control plane |
| 11 | Multi-session fleet | Sequential init/teardown across flavors (KI15 workaround) |
| 12 | Framework interception | LangChain / LlamaIndex / CrewAI produce `post_call` via `patch()` |
| 13 | Framework tool calls | Same frameworks, but assert sensor emits `tool_call` events with correct `tool_name` |

Each framework scenario skips cleanly with a `SKIP` message when the
corresponding package is not installed or the required API key is not
set. Missing dependencies never produce a `FAIL`.

## Requirements

- Docker Compose dev stack up: `make dev`
- `ANTHROPIC_API_KEY` in the environment (otherwise Anthropic
  scenarios skip)
- `OPENAI_API_KEY` in the environment (otherwise OpenAI scenarios
  skip)
- `flightdeck-sensor` installed in editable mode:
  ```
  pip install -e sensor/
  ```
- Smoke test dependencies:
  ```
  pip install -r tests/smoke/requirements.txt
  ```
- `tok_dev` bearer token seeded in Postgres (the default `init.sql`
  does this; `make dev-reset` re-seeds if the volume is wiped).

## Running

Straight shot:

```bash
make dev                          # start the stack if it's not up
pip install -e sensor/
pip install -r tests/smoke/requirements.txt
python tests/smoke/smoke_test.py
```

Or via the all-in-one Makefile target (installs deps, then runs):

```bash
make test-smoke
```

Just the install step:

```bash
make test-smoke-deps
```

### Selecting groups

Run a subset (faster / cheaper than the full suite while iterating):

```bash
python tests/smoke/smoke_test.py --groups 1,13          # Group 1 + 13 only
python tests/smoke/smoke_test.py --groups 5              # Kill switch only
python tests/smoke/smoke_test.py --list                  # list available groups
```

### Other flags

| Flag | Effect |
|---|---|
| `--no-color` | Strip ANSI color codes (for piping to a file or CI log) |
| `--help` | Argparse usage + this file's intro |

## Cost

A full run costs **under $0.05**. All scenarios use
`claude-haiku-4-5-20251001` ($0.80/$4 per 1M) and `gpt-4o-mini`
($0.15/$0.60 per 1M) with `max_tokens=5` on trivial `"hi"` prompts,
except where the scenario needs a richer response (tool calls,
streaming, framework invocations that force a tool call).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All checks passed (or skipped cleanly) |
| 1 | One or more `FAIL` |
| 2 | Stack unhealthy / config error (e.g. Docker not running) |

## CrewAI note

`crewai` is listed as an optional extra in `requirements.txt`. On
Python 3.14 its transitive dependency `tiktoken<0.6.0` has no
prebuilt wheel and fails to build from source, so the default
install skips it. Install manually on a supported runtime:

```bash
pip install crewai
```

Group 12e and 13e skip cleanly when `crewai` is not importable.
