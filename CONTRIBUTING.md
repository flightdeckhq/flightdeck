# Contributing to Flightdeck

## Prerequisites

- **Go** 1.27+
- **Python** 3.11 to 3.14 (local development uses 3.12)
- **uv** 0.12+ (installs the exact versions CI uses from `sensor/uv.lock`; the dependency vulnerability scan needs it)
- **Node.js** 24+ (the Claude Code plugin itself runs on Node 22+)
- **Docker** and Docker Compose
- **golangci-lint** v2.13+ (for Go linting; earlier releases cannot type-check Go 1.27; CI pins v2.14.0)
- **govulncheck** (for the Go vulnerability scan CI runs: `go install golang.org/x/vuln/cmd/govulncheck@v1.9.0`)

## Getting Started

This is the contributor path: the stack from source, with the test
harness around it. A user who only wants to run Flightdeck installs a
release instead (README, Install) and never needs a clone.

```bash
git clone https://github.com/flightdeckhq/flightdeck.git
cd flightdeck
make dev
```

`make dev` starts the dev stack: it builds the `flightdeck` binary from
your checkout, with the dashboard bundle embedded, and runs it in the
background on `http://localhost:4000` against one Postgres container
(`docker-postgres-1`, data on the `docker_postgres_data` volume). It is the
same binary users run, so the test suites exercise what ships. The stack
accepts the development token `tok_dev`, which the plugin, the sensor and
the test suites default to. The first run installs the dashboard's
dependencies and builds the bundle (a minute or two); later runs rebuild the
bundle only when a dashboard source changed.

| Command | What it does |
|---|---|
| `make dev` | Start the stack on Postgres. A running stack is left as it is. |
| `make dev DB=sqlite` | Start it on a SQLite file instead: the binary alone, no container. |
| `make dev-restart` | Rebuild the binary (and a stale bundle) and restart it; Postgres keeps running. Run it after you change Go or dashboard code. A build that fails leaves the running binary serving. |
| `make logs` | Follow the binary's log (`.dev/flightdeck.log`). |
| `make down` | Stop the binary and the container. Volumes and the data dir stay. |
| `make dev-reset` | Stop, **delete the database** (and the bus store) and start again. The only command that deletes data; it says what it is about to delete first. |

The stack's files are under `.dev/` in the checkout (gitignored): the
binary, its log, a pid file and `stack.env`, which tells the test harness
which database the running stack uses. `scripts/dev-stack.sh` is the script
behind the targets; its header lists the environment variables that move the
ports, the compose project and the directories, for a second stack beside a
running one.

**One checkout, one stack.** The commands act on the containers their own
checkout started, which compose records on each container. From another
checkout or worktree with the same compose project, `make dev` refuses to
start (it would replace that stack, or attach a second binary to its
database), `make down` stops only its own binary and leaves the Postgres
container running, and `make dev-reset` refuses. `make dev` also refuses when
something else already listens on its port. A stack beside a running one
needs its own `FLIGHTDECK_DEV_PROJECT`, `FLIGHTDECK_DEV_PORT` and
`FLIGHTDECK_DEV_PG_PORT`.

**`make dev-reset` and a database with data.** On Postgres it prints the
volume it is about to delete and how many sessions and events are in it. A
database with more than 100 sessions (a test seed is about 60), or one it
cannot count, is deleted only when you name the compose project: `make
dev-reset CONFIRM=docker`, or type the name at its prompt in a terminal.
It refuses, on either database, while something else listens on its port.

For dashboard work with hot reload, run `npm run dev` in `dashboard/` beside
the stack: Vite serves the sources on `http://localhost:3000` and proxies
`/api` and `/ingest` to the stack on `:4000`.

**WSL with the repo on `/mnt/c`.** A Windows drive keeps no file modes, and
the binary refuses a `secrets.json` it cannot keep private. `make dev`
detects that and puts the data dir under `~/.local/state/flightdeck-dev/`
instead of `.dev/data`; the start-up block prints where.

### Moving from the seven-container stack

Earlier checkouts ran the dev stack as seven containers (nginx, dashboard,
ingestion, workers, api, NATS, Postgres). Your database carries over: `make
dev` serves the same `flightdeck` database on the same
`docker_postgres_data` volume.

Back up first if the data matters, while the old stack still runs:

```bash
docker exec docker-postgres-1 pg_dump -U flightdeck -Fc flightdeck > flightdeck.dump
```

Then, in the checkout the old stack was started from, with that stack still
running, update the checkout and run:

```bash
make dev
```

It does five things, in this order, and stops at the first that fails:

1. Builds the dashboard bundle and the binary. Nothing that runs has been
   touched yet: a build that fails (no network for `npm ci`, a machine short
   of memory, a compile error) leaves the old stack serving. On a small
   machine the build is the slow part, several minutes the first time;
   `make build-webui` and `go build ./cmd/flightdeck` beforehand warm it, so
   the move itself then takes seconds.
2. Makes sure the Postgres container answers. Its definition in
   `docker/docker-compose.dev.yml` is the one it was created from, so compose
   neither recreates nor restarts it.
3. Stops the old stack's service containers: nginx and the dashboard first,
   so nothing new arrives, then ingestion, then, once the NATS monitor shows
   the workers' queue empty, the workers, the api and NATS. A queue that
   cannot be read stops the move before anything is stopped; one that is not
   empty after 30 s stops it with only the front door and ingestion stopped.
   Either way the message says how to start them again, and that
   `FLIGHTDECK_DEV_ALLOW_UNDRAINED=1` moves all the same, leaving those events
   in the old NATS volume, which the binary does not read.
4. Starts the binary against that database and waits until it serves. The
   binary applies any migration the database is behind on, as the workers
   did at their start.
5. Removes the six stopped containers. Until the binary serves they are
   stopped, not removed: if the start fails, the message gives the `docker
   start` line that brings the old stack back.

No volume is removed at any step.

To stop the old stack by hand instead, build first, so that a failed build
cannot leave you with neither stack:

```bash
make build-webui && go build ./cmd/flightdeck
docker stop docker-nginx-1 docker-dashboard-1 docker-ingestion-1
sleep 10   # the workers store what ingestion had already accepted
docker stop docker-workers-1 docker-api-1 docker-nats-1
docker rm docker-nginx-1 docker-dashboard-1 docker-ingestion-1 docker-workers-1 docker-api-1 docker-nats-1
make dev
```

Do not run `make dev-reset` or `docker compose down -v` unless you mean to
delete the database. The binary's bus is embedded and starts empty; on its
first start the workers log `forgot session sequences from a previous
stream incarnation` once, which is expected (ARCHITECTURE.md, Stream
sequences). The old NATS volume, `docker_nats_data`, is no longer used;
`docker volume rm docker_nats_data` frees it when you are sure nothing in it
is unprocessed.

### Running the sensor and the plugin from source

- **Sensor:** `pip install -e sensor/` from the repo root installs the
  package from the checkout instead of PyPI (`sensor/README.md` has the
  venv layout the Makefile expects).
- **Plugin:** `claude --plugin-dir /path/to/flightdeck/plugin` loads the
  Claude Code plugin from the checkout instead of the marketplace.

### Playground

Working examples for every supported framework live in
[`playground/`](playground/). Each script runs the sensor against a real
LLM API and costs cents per run, so none of them run in CI:

```bash
make playground-anthropic    # Anthropic direct
make playground-openai       # OpenAI direct
make playground-langchain    # LangChain + ChatAnthropic / ChatOpenAI
make playground-langgraph    # LangGraph agent loops
make playground-llamaindex   # LlamaIndex
make playground-llamaindex-agents  # LlamaIndex agent workflows as child sessions
make playground-crewai       # CrewAI multi-agent
make playground-mcp          # MCP tool calls
make playground-policies     # token policy enforcement

make playground-all          # everything (~$0.50/run)
```

Each script self-skips when its API keys are not set, so `make
playground-all` runs cleanly on any box and only exercises what you have
credentials for. The `flavor` field on each session names the script
that produced it, so the sessions are easy to find on the dashboard.
[`playground/README.md`](playground/README.md) has the full matrix and
the per-framework venvs; the WSL note under [Releasing](#releasing)
applies to every playground run.

## Running Tests

```bash
# All unit tests across all components
make test

# Integration tests against the dev stack (starts it when none runs)
make test-integration

# The same suite with the stack on SQLite
make dev DB=sqlite && make test-integration

# The integration tests that pause the worker container, on the split test stack
make test-split

# Go tests that need a database, on Postgres and SQLite (requires the dev stack on Postgres)
make test-go-db

# Per-component
make -C sensor test
make -C ingestion test
make -C workers test
make -C api test
make -C dashboard test
```

`make test-integration` runs against the dev stack on whichever database it was
started with (CI runs it on Postgres 16, Postgres 18 and SQLite). It seeds the
canonical fixtures, then runs the suite in two phases. The parallel phase runs under [pytest-xdist](https://pypi.org/project/pytest-xdist/)
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

The tests reach the database through the helpers in `tests/shared/fixtures.py`
(`exec_sql`, `query_rows`): on Postgres through `psql` in the Postgres
container, on SQLite through Python's `sqlite3` on the stack's `flightdeck.db`.
They learn which from `.dev/stack.env`, so a pytest run by hand needs no
settings against the dev stack. A statement written for Postgres is translated
for SQLite when it keeps to the small subset the helper documents; anything
else takes the SQLite statement explicitly (`sqlite=`), and the helper refuses
to run half-translated SQL.

Two kinds of test skip, each with its reason in the pytest summary (`-rs`):

- **Four tests pause the worker container** to make an ordering between a
  session's events reproducible. The binary's workers are goroutines of the
  one process, so these skip against the dev stack and run against the split
  test stack: `make test-split` starts the three services as separate
  containers from source, with a Postgres and a NATS of their own, on
  `:4010` beside the dev stack, and runs the `exclusive` phase there (`make
  down-split` removes it). CI runs that as its own integration leg. A new
  test that pauses the worker must be marked `exclusive`, or no leg runs it.
- **On SQLite, the tests marked `@pytest.mark.postgres_only("<reason>")`**,
  which hold a row lock from a second database session, something SQLite
  does not have. Mark a new test `postgres_only` only when no SQLite
  equivalent exists, and say why in the marker.

To run the suite against a binary of your own instead of the dev stack, start
it on another port with the two overrides the dev stack sets, and describe it
to the fixtures:

```bash
make build-flightdeck
mkdir -p /tmp/fd-it
FLIGHTDECK_RATE_LIMIT_PER_MINUTE=1000000 FLIGHTDECK_RECONCILER_INTERVAL_SECS=5 \
  bin/flightdeck --listen 127.0.0.1:4100 --data-dir /tmp/fd-it/data > /tmp/fd-it/flightdeck.log 2>&1 &

export FLIGHTDECK_TEST_BASE_URL=http://localhost:4100
export FLIGHTDECK_TEST_WORKER_LOG=/tmp/fd-it/flightdeck.log     # where the tests read the worker's log lines
export FLIGHTDECK_TEST_SQLITE_DB=/tmp/fd-it/data/flightdeck.db   # the SQL helpers open this file
./sensor/.venv/bin/python tests/e2e-fixtures/seed.py
./sensor/.venv/bin/python -m pytest tests/integration -p no:respx -n 4 --dist load -m "not manual and not exclusive"
./sensor/.venv/bin/python -m pytest tests/integration -p no:respx -m "exclusive"
```

For a binary on Postgres, start it with `--database-url postgres://…/<your_db>`
(a database of your own, never the dev stack's `flightdeck`) and set
`FLIGHTDECK_TEST_DB=<your_db>` in place of `FLIGHTDECK_TEST_SQLITE_DB`. A second
dev stack does all of this for you: start it with its own
`FLIGHTDECK_DEV_PROJECT`, `FLIGHTDECK_DEV_PORT` and `FLIGHTDECK_DEV_PG_PORT`
(`scripts/dev-stack.sh`), then `eval "$(scripts/dev-stack.sh env)"`.

The fixtures refuse to load when nothing names the database of the stack
under test: against the dev stack's address without `.dev/stack.env` (the
stack was not started by `make dev`), and against any other address without
`FLIGHTDECK_TEST_DB` or `FLIGHTDECK_TEST_SQLITE_DB`. No worker container is
assumed anywhere, so a run cannot pause a container another stack depends on.

The browser suite (`make test-e2e`, `dashboard/tests/e2e/README.md`) runs
against a stack on Postgres: its seeder backdates rows with Postgres SQL, and
three of its files run `psql` in the stack's Postgres container. Its specs
take the stack from the same variables (`dashboard/tests/e2e/_stack.ts`), and
`make test-e2e` sets them from the dev stack's state, so the suite of a second
dev stack reads and writes that stack only. It applies the fixtures' refusals:
on a stack on SQLite, or at another address that names no Postgres container
and database of its own, the run stops at its global setup and says why.

### Go tests that need a database

Some Go tests run SQL against a real database: the store packages, the staging
store, the assembler, the workers' writer and processor, the token revocation
listeners, and the `storage` module itself. Flightdeck runs on SQLite or
Postgres (ARCHITECTURE.md, Storage), and a test opens its database through
`storage/storagetest`, which decides the backends from the environment:

| `FLIGHTDECK_TEST_BACKEND` | Runs on |
|---|---|
| unset | SQLite always; Postgres too when `TEST_POSTGRES_URL` names a database |
| `sqlite` | SQLite only |
| `postgres` | Postgres only (`TEST_POSTGRES_URL` required; the test skips otherwise) |

SQLite needs no server: every test gets a fresh file in its temp directory,
migrated from the embedded baseline, so `go test ./...` and the CI Go job run
the SQLite half everywhere. The Postgres half skips without
`TEST_POSTGRES_URL`. Every store package of the three services and the
`storage` module run on both.

`make test-go-db` runs the lot against the dev stack's Postgres container, and
CI runs it in the integration job's two Postgres legs. The one package whose
tests need a NATS server (`ingestion/internal/nats`) gets one the script starts
for the run: the `nats-server` the root module pins, the version the binary
embeds, on a free loopback port.
`scripts/go-db-tests.sh` creates a fresh Postgres database per test package,
seeds it with `docker/postgres/init.sql`, migrates it to the newest migration
through the workers' migrate-only mode, runs the package against it on
Postgres, runs the storage-converted packages (`DUAL_PACKAGES` in the script)
on SQLite as well, and drops every database it created; the `flightdeck`
database is never touched. `FLIGHTDECK_TEST_BACKEND=postgres` or `=sqlite`
limits the script to one pass (the Postgres databases are created either way:
the storage module's schema parity test compares the two engines). Each
package gets its own database because the assembler claims every due trace in
its database, the staging store tests' traces included.

The run fails when a test in those packages fails or skips, and when a test
file outside the script's `DB_PACKAGES` list opens a pool, reads any
`*POSTGRES_URL` variable or imports `storage/storagetest`. A new DB-gated test
package goes into `DB_PACKAGES`, and into `DUAL_PACKAGES` once it opens its
database through `storagetest`. To run one package by hand on SQLite:

```bash
cd storage && FLIGHTDECK_TEST_BACKEND=sqlite go test -count=1 ./...
```

and on Postgres, against a migrated database of your own, never `flightdeck`:

```bash
cd ingestion && TEST_POSTGRES_URL='postgres://flightdeck:flightdeck_dev@127.0.0.1:5432/<your_db>?sslmode=disable' \
  go test -count=1 ./internal/otlpstage/
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
- `gofmt -l .` then `golangci-lint run ./...` on storage, ingestion, workers, and api
- `npm run typecheck` and `npm run lint` on the dashboard

Run `shellcheck` on any script under `scripts/` you touch
(`uvx --from shellcheck-py shellcheck scripts/<name>.sh` needs no install).
After a change to the user compose files run `scripts/compose-smoke.sh <image>`
against an image built with `docker build -t flightdeck:dev .`.

`make lint` and CI both fail when `gofmt -l .` lists any file in storage,
ingestion, workers or api; run `gofmt -w .` in that module to fix what it lists. Use the gofmt from the
toolchain the module's `go.mod` requires (`$(go env GOROOT)/bin/gofmt`, run from
inside the module): gofmt from another Go release can format doc comments
differently, so CI and your machine would disagree.

## Dependency vulnerability scans

CI scans every dependency set for known vulnerabilities:

| Dependencies | Tool | CI job |
|---|---|---|
| Go modules (ingestion, workers, api) | `govulncheck` | Go (ingestion, workers, api) |
| npm (`dashboard/`, `plugin/`) and pip (`sensor/`) | `npm audit`, `pip-audit` via `scripts/vuln_scan.py` | Dependency vulnerability scan (npm, pip) |
| Release image | Trivy, govulncheck | Scan the all-in-one image and the Go modules (release workflow) |

Run the npm and pip scan locally with:

```bash
make vuln-scan   # python3 scripts/vuln_scan.py
```

It needs `npm`, `uv` and network access. It audits the lockfiles rather than
installed trees: `dashboard/package-lock.json`, and the pins it exports from
`sensor/uv.lock`. Nothing is installed into the project; `uvx` fetches the
pip-audit release the script pins into the uv cache, holding pip-audit's own
dependencies to the same 14-day cooldown as the sensor's lock. The scan fails
on:

- a **high or critical** advisory in **any dashboard dependency**, dev
  dependencies included: tailwindcss is compiled into the shipped CSS, vite and
  its plugins build the bundle, so the dev/prod split does not mark what ships;
- a **high or critical** advisory in a **plugin production** dependency
  (`npm audit --omit=dev`). The plugin runs its source as is, with no bundler,
  so its dev dependencies never reach a user. A `plugin/package.json` that
  declares dependencies without a `package-lock.json` fails too; the plugin has
  no dependencies today;
- **any** advisory in the sensor's **core runtime** dependencies (`uv export
  --no-dev`, no extras). pip-audit reports no severity, so every advisory
  counts. Environment markers are stripped so a pin for another platform or
  Python version is audited too, and a runtime pin pip-audit did not audit
  fails;
- an ignore entry past its `expires` date.

npm advisories below high, and the sensor's extras and dev tooling, are listed
in the job log without failing the job. The sensor's provider and framework
extras are resolved by each user's own installer, so the versions locked here
are not what a user gets. Bump them when a fix is available.

### Excusing an advisory

Fix a blocking finding by bumping the dependency. When no fixed release exists,
or the fix needs a breaking upgrade that has to wait, add an entry to
`.github/vuln-ignore.toml`:

```toml
[[ignore]]
id = "GHSA-xxxx-xxxx-xxxx"   # the ID the scan prints; for pip, any alias works
ecosystem = "npm"            # "npm" or "pypi"
package = "example-package"
reason = "No fixed release yet; the vulnerable parser only reads our own build config. Drop when 2.3.1 ships."
expires = 2027-02-01         # a TOML date, no quotes
```

Every key is required. The reason must say why the advisory cannot be fixed now
and what lets the entry go. Set `expires` a few months out: the scan fails the
day after it (dates are compared in UTC), so the entry gets a fresh look instead
of living forever, and it rejects a date more than 365 days ahead. The entry ships in a pull request like any other change, so it gets
reviewed. An entry that no longer matches anything is flagged as a warning on
the pull request; delete it then.

## Pull Request Process

1. Branch off `main` with a descriptive name (e.g. `feat/session-idle-state`)
2. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`
3. Ensure `make lint` and `make test` pass locally
4. Open a PR against `main` — CI runs automatically
5. All CI checks must pass before merge

### Which document a change belongs in

The README is written for someone who has never run Flightdeck: what it
looks like, the one command that installs it, connecting an agent, what
is covered, and running it for a team, each in its shortest form. It is
held to a budget that `scripts/readme-budget.sh` measures and CI enforces
(the `marketplace-schema` job, "Repo scripts and manifests"; the script's
header has the counting rules):

| What | Budget |
|---|---|
| The install block, the first code block under `## Install` | exactly one command, on one line |
| `## Install`, outside `<details>` | 2 commands (install, start) |
| `## Connect your agents` | 4 commands |
| `## Self-hosting` | 6 commands |
| The whole README, the channels folded in `<details>` included | 20 commands, 300 lines |

So a second install command fails the build wherever it is put, and so
does a step that creeps back in. The other install channels sit in the
`<details>` under the install block: they count toward the total, not
toward what the section shows. A command block must not carry a
sample-language tag (`json`, `yaml`, `python` and the like), which the
script does not count: tag it as the shell it is for (`bash`,
`powershell`, `text`), or the script fails naming the line. A step a
reader types goes in a code block, not in a sentence, where it would not
be counted.

When a README change goes over, the detail moves to the page that owns
it and the README links there; nothing a user needs leaves the
repository. The pages are in `guides/`, not `docs/`: `docs/` is the
website's root, and GitHub Pages serves every file in it.

| Content | Where |
|---|---|
| Contributor steps: a clone, `make dev`, per-component commands, the playground | this file |
| Every intercepted method, the framework matrices, client types, what is not planned | `guides/coverage.md` |
| Each dashboard page and control in full | `guides/features.md` |
| Claude Code and the agent frameworks over OpenTelemetry | `guides/opentelemetry.md` |
| The MCP Protection Policy | `guides/mcp-protection-policy.md` |
| Compose, Helm, the chart's values, upgrade notes, backups | `guides/self-hosting.md` |
| The sensor: identity, `patch()` and `wrap()`, environment variables, limitations | `sensor/README.md` (also the PyPI page: no relative images there) |
| The plugin: options, headless and CI runs, enforcement, privacy | `plugin/README.md` |

The README's images live in `assets/readme/` and show invented agents
only: `scripts/demo_seed.py` fills a throwaway `flightdeck` and
`scripts/readme_images.mjs` photographs it (its header has the
procedure). Never take them from a Flightdeck with real data.

ARCHITECTURE.md
describes the system as it is, CHANGELOG.md what changed per release, and
DECISIONS.md the decisions a future contributor would otherwise relitigate
(the Engineering principles below, L1 and L2).

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

[RELEASING.md](RELEASING.md) has the release flow: the `VERSION` file and
the locations `scripts/version.py` keeps in step with it, `make release-prep`
for the release pull request and `make release-tag` for the tag that starts
the release workflow.

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
Migration files live in the `storage` module, one directory per backend:
`storage/migrations/postgres/` (the full history) and
`storage/migrations/sqlite/` (`000001_baseline`, the Postgres schema at 000036
translated once, then one pair per later change). The Go binaries embed both
directories; the Helm chart copies the Postgres one (`make -C helm
sync-migrations`), which nothing reads.

### Creating a new migration

1. Name the files `000NNN_description.up.sql` and `000NNN_description.down.sql`
   where `NNN` is the next sequential number, and create the pair **in both
   directories** with the same number and description: the Postgres SQL
   and its SQLite translation (ARCHITECTURE.md, Storage, has the type
   mapping: `uuid` → `TEXT`, `timestamptz` → `TIMESTAMP` text in
   `storage.TimeLayout`, `jsonb` → `TEXT` with a `json_valid()` check,
   expression indexes on `json_extract`, no triggers).
2. The down file must be the **exact inverse** of the up file.
3. Never modify `docker/postgres/init.sql` for schema changes — it contains seed data only.
4. Never modify an existing migration file that has already been applied to any environment.
   Always add a new migration.
5. Run `scripts/check-migration-pairs.sh` (CI does): it fails when the two
   directories' version lists differ. Then run the storage tests on both
   backends (`make test-go-db`, or `cd storage && go test ./...` with
   `TEST_POSTGRES_URL` set): the schema parity test fails when the two
   schemas' tables, columns, nullability or indexes differ.

### Applying migrations

The `flightdeck` binary applies every pending migration of its database's
backend each time it starts, before any service runs, from the files embedded
in it. On the dev stack that is `make dev-restart` after you add a migration
(or `make dev-reset` for an empty database). There is no separate migrate
command, in development or under Docker Compose, which runs the same binary:
a new version migrates when its container starts.

### Verifying migrations applied

On the dev stack's Postgres:

```bash
docker exec -it docker-postgres-1 psql \
  -U flightdeck -d flightdeck \
  -c "SELECT version, dirty FROM schema_migrations ORDER BY version;"
```

`dirty` must be `f` (false). If `dirty` is `t`, a migration failed mid-apply and must
be investigated manually.

### The service binaries' migrate-only mode

The standalone workers binary (`workers/cmd`), which the split test stack and
`scripts/go-db-tests.sh` build from source, applies the same embedded
migrations when it starts, and with `FLIGHTDECK_MIGRATE_ONLY=true` applies
them and exits 0:

```bash
FLIGHTDECK_MIGRATE_ONLY=true \
  FLIGHTDECK_POSTGRES_URL=<url> \
  ./workers
```

The URL may be `postgres://…` or `sqlite://<path>`. The script uses it to
bring each test package's database to the newest migration.

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

The image carries `pricing.yaml` at `/etc/flightdeck/` (the root
`Dockerfile` copies it at build time). The dev stack runs the binary
from the repository root, where `./pricing.yaml` is found, so a local
edit takes effect on `make dev-restart`. The API writes the merged
list into the `model_pricing` table at startup, skipping the write
when nothing changed.

## Reporting Bugs

Open an issue at https://github.com/flightdeckhq/flightdeck/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Environment: OS, Python/Go/Node versions, Docker version
- Relevant logs (with any secrets redacted)
