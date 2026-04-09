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
2. Implement `estimate_tokens()`, `extract_usage()`, `extract_content()`, and `get_model()`
3. Create `sensor/flightdeck_sensor/interceptor/<provider>.py`
   with the Guarded* proxy classes following the Anthropic or OpenAI patterns
4. Update `__init__.py` to detect and wrap the new client type
   in `wrap()` and `_patch_<provider>()` in `patch()`
5. Add the provider to the optional dependencies in `pyproject.toml`
6. Write unit tests covering estimation, extraction, and interception
7. Update `ARCHITECTURE.md` with the new provider

## Reporting Bugs

Open an issue at https://github.com/flightdeckhq/flightdeck/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Environment: OS, Python/Go/Node versions, Docker version
- Relevant logs (with any secrets redacted)
