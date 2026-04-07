# Contributing to Flightdeck

## Prerequisites

- **Go** 1.22+
- **Python** 3.9+
- **Node.js** 20+
- **Docker** and Docker Compose
- **golangci-lint** (for Go linting)

## Getting Started

```bash
git clone https://github.com/flightdeckhq/flightdeck.git
cd flightdeck
make dev
```

This starts all services via Docker Compose. Dashboard is at
`http://localhost:4000`.

## Running Tests

```bash
# All unit tests across all components
make test

# Integration tests (requires running stack)
make test-integration

# Per-component
make -C sensor test
make -C ingestion test
make -C workers test
make -C api test
make -C dashboard test
```

## Linting

```bash
make lint
```

This runs:
- `mypy --strict` and `ruff check` on the sensor
- `golangci-lint run ./...` on ingestion, workers, and api
- `npm run typecheck` and `npm run lint` on the dashboard

## Pull Request Process

1. Branch off `main` with a descriptive name (e.g. `feat/session-idle-state`)
2. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`
3. Ensure `make lint` and `make test` pass locally
4. Open a PR against `main` -- CI runs automatically
5. All CI checks must pass before merge

## Adding a Provider

To add a new LLM provider to the sensor:

1. Create `sensor/flightdeck_sensor/providers/<provider>.py`
   implementing the `Provider` protocol from `protocol.py`
2. Implement `estimate_tokens()`, `extract_usage()`,
   `extract_content()`, and `get_model()`
3. Create `sensor/flightdeck_sensor/interceptor/<provider>.py`
   with the Guarded* proxy classes following the Anthropic or
   OpenAI patterns
4. Update `__init__.py` to detect and wrap the new client type
   in `wrap()` and `_patch_<provider>()` in `patch()`
5. Add the provider to the optional dependencies in `pyproject.toml`
6. Write unit tests covering estimation, extraction, and interception
7. Update ARCHITECTURE.md with the new provider

## Reporting Bugs

Open an issue at https://github.com/flightdeckhq/flightdeck/issues
with:

- Steps to reproduce
- Expected vs actual behavior
- Environment: OS, Python/Go/Node versions, Docker version
- Relevant logs (with any secrets redacted)
