.PHONY: help build test test-plugin test-integration test-sensor-e2e test-e2e test-e2e-ui test-smoke seed-e2e lint dev dev-reset down logs release migrate-local-up migrate-local-status

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

build: ## Build all components
	$(MAKE) -C sensor build
	$(MAKE) -C ingestion build
	$(MAKE) -C workers build
	$(MAKE) -C api build

test: ## Run all unit tests
	$(MAKE) -C sensor test
	$(MAKE) -C ingestion test
	$(MAKE) -C workers test
	$(MAKE) -C api test
	$(MAKE) test-plugin

test-plugin: ## Run the Claude Code plugin unit tests (zero-dep, node --test)
	cd plugin && node --test tests/*.test.mjs

test-integration: ## Run integration tests (requires running stack)
	$(MAKE) -C docker dev
	cd tests/integration && pytest -v -m "not manual"

test-sensor-e2e: ## Run sensor respx-driven end-to-end tests (requires running stack)
	$(MAKE) -C docker dev
	cd tests/integration && pytest -v test_sensor_e2e.py

test-smoke: ## Run the playground against a live stack (requires ANTHROPIC_API_KEY + OPENAI_API_KEY). See playground/README.md.
	python playground/run_all.py

# Phase 3 retired the duplicate `test-e2e` target. The prior target
# at this line drove sensor pytest e2e (now `test-sensor-e2e` above)
# but shared the name with the Playwright target the dashboard team
# added later — whichever target `make` picked up last silently won,
# hiding the other. `test-e2e` now means the browser end-to-end
# suite; `test-sensor-e2e` is the pytest respx suite.
test-e2e: ## Run Playwright E2E tests (requires make dev; fixtures seed automatically via globalSetup)
	cd dashboard && npx playwright test

test-e2e-ui: ## Run Playwright E2E tests in Playwright UI mode
	cd dashboard && npx playwright test --ui

seed-e2e: ## Seed the canonical E2E fixture dataset into the running dev stack (idempotent)
	python3 tests/e2e-fixtures/seed.py

lint: ## Lint all components
	$(MAKE) -C sensor lint
	$(MAKE) -C ingestion lint
	$(MAKE) -C workers lint
	$(MAKE) -C api lint

dev: ## Start full local dev environment
	$(MAKE) -C docker dev

dev-reset: ## Wipe volumes and restart
	$(MAKE) -C docker dev-reset

down: ## Stop local dev environment
	$(MAKE) -C docker down

logs: ## Tail logs from all services
	$(MAKE) -C docker logs

release: ## Tag and push release (usage: make release VERSION=v0.1.0)
	@test -n "$(VERSION)" || (echo "Usage: make release VERSION=v0.1.0" && exit 1)
	./scripts/release.sh $(VERSION)

# -----------------------------------------------
# Migration targets -- LOCAL DEVELOPMENT ONLY
# migrate-local-up and migrate-local-status use
# docker compose and require the stack to be
# running locally. For remote or production
# environments, see CONTRIBUTING.md.
# -----------------------------------------------

migrate-local-up: ## Apply all pending migrations (local dev only)
	docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml run --rm -e FLIGHTDECK_MIGRATE_ONLY=true workers

migrate-local-status: ## Show current migration version (local dev only)
	docker exec docker-postgres-1 psql -U flightdeck -d flightdeck -c "SELECT version, dirty FROM schema_migrations ORDER BY version;"
