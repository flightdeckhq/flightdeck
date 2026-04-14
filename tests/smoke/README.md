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
- Python 3.12 available on `$PATH` as `python3.12` (used for the
  dedicated smoke venv -- see "Python 3.12 venv" below).
- `tok_dev` bearer token seeded in Postgres (the default `init.sql`
  does this; `make dev-reset` re-seeds if the volume is wiped).

## Python 3.12 venv

The smoke suite ships a dedicated venv at
`tests/smoke/.venv-py312/` so CrewAI and LangGraph (both of which
pin `tiktoken<0.6`, which has no Python 3.14 wheel) can be installed
cleanly. `make test-smoke` and `make test-smoke-deps` both target
this venv automatically; your system Python is untouched.

First-time setup (one command creates the venv + installs every
dependency including crewai and langgraph):

```bash
make test-smoke-deps
```

This runs:

```bash
python3.12 -m venv tests/smoke/.venv-py312
tests/smoke/.venv-py312/bin/pip install -e sensor/
tests/smoke/.venv-py312/bin/pip install -r tests/smoke/requirements.txt
tests/smoke/.venv-py312/bin/pip install crewai langgraph langgraph-prebuilt
```

The venv is gitignored. Delete and recreate it with
`rm -rf tests/smoke/.venv-py312 && make test-smoke-deps`.

## Running

Straight shot via Makefile:

```bash
make dev                  # start the stack if it's not up
make test-smoke           # installs venv deps if missing, then runs
```

Direct invocation (after `make test-smoke-deps`):

```bash
tests/smoke/.venv-py312/bin/python tests/smoke/smoke_test.py
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

## CrewAI and LangGraph note

Both pin `tiktoken<0.6.0` transitively, which has no prebuilt wheel
for Python 3.14 and fails to build from source. The
`tests/smoke/.venv-py312/` venv solves this by using Python 3.12 for
the smoke suite only; `make test-smoke-deps` installs both packages
into that venv. The 12e / 12f / 12g / 12h / 13e scenarios still skip
cleanly if you run the suite with a different interpreter that does
not have them installed.

Group 12e and 13e skip cleanly when `crewai` is not importable.
