# Phase 4 Rule 40d smoke tests

Manual smoke tests that exercise the sensor against **real LLM providers**
through **real network**, via the local dev stack. They are the "does
this actually observe what we claim it observes?" verification that
Phase 4 added as Rule 40d in `CLAUDE.md`.

## What they do NOT do

- **Not run in CI.** Every test here costs money and requires valid API
  keys, so the CI pipeline only runs the cheap mocked integration
  tests under `tests/integration/`. Smoke tests are an operator-gated
  pre-PR step, not a gate machine can flip.
- **Not a substitute for unit tests.** The sensor's unit tests pin every
  classification / wrapping / emission contract against mocked
  clients. Smoke tests verify the classifiers and wrappers still hold
  when a real provider SDK's exception / streaming / chunking shape
  drifts.

## Running

All targets live in the root `Makefile` with the `smoke-*` prefix and
the Rule 40d convention:

| Target | Env vars required | Scope |
|---|---|---|
| `make smoke-anthropic` | `ANTHROPIC_API_KEY` | Chat (non-stream, sync stream, async stream), rate-limit error, timeout error, mid-stream error |
| `make smoke-openai` | `OPENAI_API_KEY` | Chat (all three stream modes), embeddings, rate_limit, context_overflow, auth error |
| `make smoke-litellm` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Chat (multi-provider), embeddings, provider-specific error pass-through |
| `make smoke-langchain` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | `ChatAnthropic.invoke`, `ChatOpenAI.invoke`, `OpenAIEmbeddings`, error propagation |
| `make smoke-claude-code` | (none) | Claude Code plugin against a locally installed `claude` CLI |
| `make smoke-bifrost` | `BIFROST_URL` + upstream provider key | OpenAI-compatible indirect path |

Each target calls its corresponding `pytest` file under this
directory. Tests that need a missing env var skip cleanly with a
clear message — running `smoke-all` without all keys still works; it
just covers fewer frameworks.

Smoke tests expect the dev stack to be running (`make dev`) so the
sensor has a control plane to POST events to. They assert that the
event actually lands in `/v1/events` and carries the Phase 4 fields
they were supposed to produce (`event_type="embeddings"`,
`streaming.ttft_ms`, `error.error_type`, etc.).

## After a run

Update the coverage matrix in `audit-phase-4.md` with the run date
and any anomalies observed. An anomaly here is "the real SDK threw a
class we didn't classify correctly" or "streaming chunks arrived in
a shape the TTFT measurement missed" — exactly the kind of thing
unit tests cannot catch.

## Rule 40d in one line

> Any framework-touching phase requires real-provider smoke tests
> alongside the mocked integration tests. Skipping the smoke run is
> a phase-gate failure.
