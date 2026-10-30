# Contributing to Flightdeck

## Prerequisites

- **Go** 1.27+
- **Python** 3.11 to 3.14 (local development uses 3.12)
- **uv** 0.12+ (optional locally: installs the exact versions CI uses from `sensor/uv.lock`)
- **Node.js** 24+ (the Claude Code plugin itself runs on Node 22+)
- **Docker** and Docker Compose
- **golangci-lint** v2.13+ (for Go linting; earlier releases cannot type-check Go 1.27; CI pins v2.14.0)
- **govulncheck** (for the Go vulnerability scan CI runs: `go install golang.org/x/vuln/cmd/govulncheck@v1.9.0`)

## Getting Started

```bash
git clone https://github.com/flightdeckhq/flightdeck.git
cd flightdeck
make dev
```

This starts all services via Docker Compose. Dashboard is at `http://localhost:4000`.

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

`make test-integration` seeds the canonical fixtures, then runs the suite in two
phases. The parallel phase runs under [pytest-xdist](https://pypi.org/project/pytest-xdist/)
with four workers and covers every test that keeps to the flavors and session ids
it created. The exclusive phase then runs the tests marked `@pytest.mark.exclusive`
one at a time: each needs the whole stack to itself because it pauses the worker,
rewrites every agents row, or asserts fleet-wide state. Mark a new test `exclusive`
when it does any of those; otherwise keep its reads and writes to its own flavors
and session ids so it stays safe to run beside the rest. The parallel phase needs
`pytest-xdist`, which the sensor's `dev` extra installs into `sensor/.venv`; the
worker count is `INTEGRATION_WORKERS` (`make test-integration INTEGRATION_WORKERS=2`),
and the Makefile comment above the target explains why four is the default. The dev
stack runs the worker reconciler every 5 s (`FLIGHTDECK_RECONCILER_INTERVAL_SECS`)
where production ticks every 60 s: size any wait for a reconciler transition from
`RECONCILER_INTERVAL_SECS` in the test module, and never let user-facing behaviour
assume a transition lands sooner than the production tick. To run the phases by
hand, seed first (`make seed-e2e`), then:

```bash
./sensor/.venv/bin/python -m pytest tests/integration -n 4 --dist load -m "not manual and not exclusive"
./sensor/.venv/bin/python -m pytest tests/integration -m "exclusive"
```

## Test Coverage

Coverage is enforced in CI per component. API and ingestion thresholds measure handler
coverage only — the store layer (raw SQL against Postgres) is covered by integration tests.

| Component  | Threshold | Scope           | Notes                     |
|------------|-----------|-----------------|---------------------------|
| Sensor     | 70%       | Full package    | Hard fail below threshold |
| API        | 66%       | Handlers only   | Hard fail below threshold |
| Ingestion  | 67%       | Handlers only   | Hard fail below threshold |
| Workers    | none      | —               | Report only               |

Coverage HTML reports are uploaded as GitHub Actions artifacts on every CI run
(14 day retention). Download from the Actions run page to browse the full report.

To check coverage locally:

**Sensor:**
```bash
cd sensor && pytest tests/ \
  --cov=flightdeck_sensor \
  --cov-report=term-missing \
  --cov-fail-under=70
```

**Go components (handlers only):**
```bash
cd <component> && go test ./... \
  -coverprofile=coverage.out \
  -covermode=atomic \
  -coverpkg=./internal/handlers/... && \
  go tool cover -func=coverage.out
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
4. Open a PR against `main` — CI runs automatically
5. All CI checks must pass before merge

## Review pipeline (`.claude/`)

`.claude/` ships with this repo. The review agents, guidelines, the
`/audit-repo` slash command, and a Stop hook auto-load when you open
the repo with [Claude Code](https://claude.ai/code), so every
contributor inherits the same review pipeline with no setup.

To extend the pipeline, edit the relevant file in
`.claude/agents/` (agent specs) or `.claude/agents/guidelines/`
(language and topic rules). The Stop hook routes by file type to
the right reviewer; see [`.claude/agents/README.md`](.claude/agents/README.md)
for the routing table and the "how to extend" walkthrough. To opt
out of the pipeline for an emergency fix, pass `--no-hooks` to
Claude Code, or override at the user level in `~/.claude/`.

## Engineering principles

Standing rules every PR follows. The numbers are cited in code and tests
(for example the row-level failure cue, L8).

- **L1 — Docs describe the present.** ARCHITECTURE.md says what the system
  is, not how it got there: no phase tags, "was added" or "previously".
  History lives in CHANGELOG.md, DECISIONS.md and `git log`.
- **L2 — Docs change in the same PR as the code, first.** A PR that changes
  behaviour ARCHITECTURE.md describes, or makes a decision DECISIONS.md
  records (a contract, the schema, a trust boundary, or a rejected
  alternative someone would propose again), updates them before the code.
- **L3 — A dead end is a bug.** Anything a user can see but not act on (an
  error without details, a list without paging, a panel that opens onto
  nothing) is a defect, not polish.
- **L4 — Verify end to end, against the live stack.** Trace a feature from
  the client through ingestion, the workers and storage to the screen a user
  touches. Mocked tests passing is not evidence it works.
- **L5 — Every modality captures content.** Anything with a request and a
  response payload supports content capture behind `capture_prompts` (or a
  modality-specific flag). Check new modality work for capture parity before
  merge; a modality without it is a gap, not a choice.
- **L6 — Severity follows where code runs and a threat trace.** The same
  pattern is critical in a production handler and minor in a dev seed
  script. A P0 or P1 finding records its attack vector and impact.
- **L7 — Patch the protocol, not each adapter.** When several frameworks
  wrap one protocol (MCP through LangChain, LangGraph, LlamaIndex and the raw
  SDK), patch the protocol's canonical client once; framework attribution
  goes on the event's `framework` field.
- **L8 — Show failures on the row.** An event type with success and failure
  variants needs a cue visible without expanding the row (the session-row
  error dot, the MCP error indicator).

### Review rubric

A PR with meaningful code is reviewed in five passes, one per concern:
Python (sensor, playground, integration suites), Go (ingestion, workers,
API, migrations), TypeScript and UI (dashboard, both themes, accessibility),
architecture (doc alignment, contracts across components, L1 and L2), and
QA (tests at every layer, E2E discipline, live verification, L3 to L8). This
review before merge is what CLAUDE.md calls the phase audit or V-pass. The
agents in `.claude/agents/` encode these passes; they report Critical (a P0
or P1 here, Block) and Warnings (P2 or P3, Recommend or Defer).

Findings are graded **P0** (breaks, crashes, or silently loses or corrupts
data on a default install: a fail-open control, a silent zero-event path,
wrong numbers persisted), **P1** (a wrong number shown, a table-stakes gap,
or an end-of-life runtime or dependency), **P2** (valuable) or **P3**
(hygiene), with evidence **A** (executed), **B** (source with file and
line), **C** (dated documentation) or **D** (secondary); only A or B
evidence supports a P0. Each finding is **Block** (fix before merge),
**Recommend** (fix in this PR unless the maintainer agrees to defer it) or
**Defer** (a GitHub issue labelled `roadmap`, never an unowned follow-up).
A deferred finding gets its own `roadmap` issue that states the gap and
where it lives in the code; set a milestone only when the work is planned
for a release.

## Releasing

Before tagging a release, run `make playground-all` against a live stack with
real provider API keys (`ANTHROPIC_API_KEY` + `OPENAI_API_KEY` exported). It
runs every script under [`playground/`](playground/), exercising each framework
integration end-to-end and skipping any whose API key is absent. Cost: roughly
$0.50 per full run.

**WSL with the repo on `/mnt/c`.** A virtualenv on the Windows mount is slow
enough that playground scripts hit their timeouts. Keep one on the Linux
filesystem and point the Makefile at it (the `dev` extra includes every
framework the scripts use):

```bash
(cd sensor && UV_PROJECT_ENVIRONMENT=$HOME/.cache/fd-sensor-venv uv sync --extra dev)
PYTHON=$HOME/.cache/fd-sensor-venv/bin/python make playground-all
```

## Database Migrations

Schema changes are managed by [golang-migrate](https://github.com/golang-migrate/migrate).
Migration files live in `docker/postgres/migrations/`.

### Creating a new migration

1. Name the files `000NNN_description.up.sql` and `000NNN_description.down.sql`
   where `NNN` is the next sequential number.
2. The down file must be the **exact inverse** of the up file.
3. Never modify `docker/postgres/init.sql` for schema changes — it contains seed data only.
4. Never modify an existing migration file that has already been applied to any environment.
   Always add a new migration.

### Applying migrations

`make dev-reset` automatically applies all pending migrations. Workers run migrations on
startup before processing events.

### Verifying migrations applied

```bash
docker exec -it docker-postgres-1 psql \
  -U flightdeck -d flightdeck \
  -c "SELECT version, dirty FROM schema_migrations ORDER BY version;"
```

`dirty` must be `f` (false). If `dirty` is `t`, a migration failed mid-apply and must
be investigated manually.

### Common commands (local development)

```bash
make migrate-local-up       # Apply pending migrations (local dev only)
make migrate-local-status   # Check current version and dirty state
make dev-reset              # Full reset (wipe volumes + apply migrations)
```

### Running migrations in remote environments

For remote or production deployments, migrations are applied automatically by the workers
service on startup. To run migrations without starting the full workers service:

```bash
FLIGHTDECK_MIGRATE_ONLY=true \
  FLIGHTDECK_POSTGRES_URL=<url> \
  FLIGHTDECK_MIGRATIONS_DIR=<path> \
  ./workers
```

The workers binary will apply all pending migrations and exit 0.

In Kubernetes, the recommended pattern is an init container running the workers binary
with `FLIGHTDECK_MIGRATE_ONLY=true` before the main workers deployment starts.

## Adding a Provider

To add a new LLM provider to the sensor:

1. Create `sensor/flightdeck_sensor/providers/<provider>.py`
   implementing the `Provider` protocol from `protocol.py`
2. Implement every method of the `Provider` protocol: `estimate_tokens()`,
   `extract_usage()`, `usage_from_stream_chunk()`,
   `usage_from_finished_stream()`, `stream_completed()`, `final_message()`,
   `text_from_stream_chunk()` and `chunk_completes_stream()` (stream
   metering, the guard's `text_stream` and stream completion),
   `extract_content()`, `get_model()`,
   `extract_tool_invocations()`, `extract_response_metadata()` and
   `extract_output_dimensions()`. The conformance test
   `test_every_adapter_implements_every_provider_method` in
   `sensor/tests/unit/test_streaming_usage.py` fails when an adapter
   misses one.
3. Create `sensor/flightdeck_sensor/interceptor/<provider>.py`
   with the Sensor* proxy classes following the Anthropic or OpenAI
   patterns; stream entry points route through `base.call_stream` /
   `base.call_stream_async`, calling `.open()` for `create(stream=True)`
4. Update `__init__.py` to detect and wrap the new client type
   in `wrap()` and `_patch_<provider>()` in `patch()`
5. Add the provider to the optional dependencies in `pyproject.toml`
6. Write unit tests covering estimation, extraction, and interception
7. Update `ARCHITECTURE.md` with the new provider

To add a `client_type` value (a new kind of client, not a provider), follow
"Client type registry" in [ARCHITECTURE.md](ARCHITECTURE.md): edit
`contracts/client_types.json` and every literal copy it lists, and add the two
migrations that swap and then validate the `client_type` constraints.

## Updating pricing data

Model prices come from two layers (ARCHITECTURE.md, "Cost estimation"):

- **The catalogue**, `api/internal/store/pricing_catalogue.json`: a
  pruned copy of litellm's `model_prices_and_context_window.json`,
  embedded in the API binary. It carries each model's input, output,
  cache-read, five-minute and one-hour cache-write, reasoning, priority
  and long-context rates, for the providers' own APIs and for Bedrock,
  Vertex AI, Azure OpenAI and Foundry.
- **`pricing.yaml`** at the repo root: overrides on top of the
  catalogue (negotiated prices, retired models the catalogue dropped),
  deployment-name aliases, and the flat multipliers and server-tool
  fees.

### Refreshing the catalogue

```bash
make pricing-refresh        # downloads litellm's current file and prunes it
cd api && go test ./internal/store/ -run 'Catalogue|PricingYaml' -count=1
```

Commit the regenerated `pricing_catalogue.json` in a PR titled
`pricing: refresh catalogue`. The diff shows every price that moved;
skim it for surprises (a model priced at zero, a large jump) before
opening the PR. `scripts/pricing_refresh.py --source <file>` prunes a
local copy instead of downloading.

### Overriding or adding a price

1. Edit `pricing.yaml`. An entry under `overrides:` replaces the
   catalogue's rates for one model and platform (`direct`, `bedrock`,
   `vertex`, `azure`, `foundry`) field by field, so state only the
   rates that differ. A model the catalogue does not list needs
   `provider`, `input` and `output`. Rates are USD per 1M tokens. A
   retired model kept for historical cost also gets `deprecated_on:
   YYYY-MM-DD`, its retirement date, so token policies stop offering
   it as a degrade target.
2. Use the canonical model id the dashboard shows (the dated snapshot
   id when that is what the provider served).
3. Bump `updated:` and run the store tests:
   ```bash
   cd api && go test ./internal/store/ -run 'PricingYaml|ApplyPricingFile' -count=1
   ```
4. Link the provider's pricing page in the PR description for every
   change.

### Validation

`pricing.yaml` is validated when the API starts: `version` 1 or 2, no
unknown keys (a misspelt rate is an error, not ignored), finite rates
`>= 0`, known platforms and providers, no duplicate override, an alias
may not reuse a priced model id and must point at a priced model,
multipliers `> 0`. A file that fails is ignored as a whole and logged at
WARN, and the catalogue alone prices calls; fix the file before merging.

Overriding any base rate of a model with a long-context tier drops the
catalogue's tier for it, so calls above the threshold are priced at your
rates rather than a mix of yours and the catalogue's.

### Path resolution

Service startup tries these in order, first match wins:

1. `FLIGHTDECK_PRICING_PATH` env var
2. `/etc/flightdeck/pricing.yaml` (production container default)
3. `./pricing.yaml` (dev default, relative to the process working dir)

The API Dockerfile copies `pricing.yaml` to `/etc/flightdeck/` at
build time, and the docker-compose dev overlay mounts the repo copy
over that path so local edits take effect on `docker compose restart
api` without a rebuild. The API writes the merged list into the
`model_pricing` table at startup, skipping the write when nothing
changed.

## Reporting Bugs

Open an issue at https://github.com/flightdeckhq/flightdeck/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Environment: OS, Python/Go/Node versions, Docker version
- Relevant logs (with any secrets redacted)
