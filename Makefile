.PHONY: help build test test-plugin test-integration test-sensor-e2e test-e2e test-e2e-ui test-smoke-playground seed-e2e lint dev dev-reset down logs release migrate-local-up migrate-local-status smoke-anthropic smoke-openai smoke-litellm smoke-langchain smoke-claude-code smoke-bifrost smoke-policies smoke-mcp-python smoke-mcp-langchain smoke-mcp-langgraph smoke-mcp-llamaindex smoke-mcp-crewai smoke-mcp-claude-code smoke-mcp-all smoke-all

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

test-smoke-playground: ## Run the playground against a live stack (requires ANTHROPIC_API_KEY + OPENAI_API_KEY). See playground/README.md.
	python playground/run_all.py

# ---------------------------------------------------------------------------
# Phase 4 Rule 40d smoke targets. Each runs the per-framework smoke
# test against a live provider; NONE of these run in CI (they cost
# money and need real API keys). Run manually before a PR that
# touches framework-emission behaviour and document the results in
# the phase's audit doc.
#
# Smoke tests skip cleanly when the relevant env var is unset, so
# the target never fails the user's local pytest invocation; a skip
# just means "not exercised on this run". Operators who want to force
# a skipped target to fail can pass ``-o pytest.ini.addopts='--no-skips'``
# (see tests/smoke/README.md).
# ---------------------------------------------------------------------------

smoke-anthropic: ## Rule 40d smoke: Anthropic SDK. Requires ANTHROPIC_API_KEY.
	cd tests/smoke && pytest -v test_smoke_anthropic.py

smoke-openai: ## Rule 40d smoke: OpenAI SDK. Requires OPENAI_API_KEY.
	cd tests/smoke && pytest -v test_smoke_openai.py

smoke-litellm: ## Rule 40d smoke: litellm multi-provider. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	cd tests/smoke && pytest -v test_smoke_litellm.py

smoke-langchain: ## Rule 40d smoke: LangChain (Anthropic + OpenAI paths). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	cd tests/smoke && pytest -v test_smoke_langchain.py

smoke-claude-code: ## Rule 40d smoke: Claude Code plugin against locally installed `claude` CLI.
	cd tests/smoke && pytest -v test_smoke_claude_code.py

smoke-bifrost: ## Rule 40d smoke: bifrost gateway (optional). Requires BIFROST_URL + upstream provider key.
	cd tests/smoke && pytest -v test_smoke_bifrost.py

smoke-policies: ## Rule 40d smoke: policy enforcement events (warn/degrade/block) via real Anthropic + flavor policy. Requires ANTHROPIC_API_KEY.
	cd tests/smoke && pytest -v test_smoke_policies.py

# Phase 5 MCP smoke matrix (Rule 40d). Each target spawns the in-tree
# reference server (tests/smoke/fixtures/mcp_reference_server.py) over
# stdio so the schema and fingerprint contract stays aligned across
# frameworks. Targets pytest-skip when the relevant framework adapter
# is not installed; smoke-mcp-all runs cleanly on a box that has only
# the python smoke's prerequisites (just `mcp` itself).
smoke-mcp-python: ## Rule 40d smoke (Phase 5): direct mcp SDK against the in-tree reference server.
	pytest -v tests/smoke/test_smoke_mcp_python.py

smoke-mcp-langchain: ## Rule 40d smoke (Phase 5): LangChain MultiServerMCPClient. Requires `langchain-mcp-adapters`.
	pytest -v tests/smoke/test_smoke_mcp_langchain.py

smoke-mcp-langgraph: ## Rule 40d smoke (Phase 5): LangGraph ToolNode driving an MCP-adapter tool. Requires `langgraph` + `langchain-mcp-adapters`.
	pytest -v tests/smoke/test_smoke_mcp_langgraph.py

smoke-mcp-llamaindex: ## Rule 40d smoke (Phase 5): LlamaIndex McpToolSpec. Requires `llama-index-tools-mcp`.
	pytest -v tests/smoke/test_smoke_mcp_llamaindex.py

smoke-mcp-crewai: ## Rule 40d smoke (Phase 5): CrewAI via mcpadapt. Requires `mcpadapt` (pinned per D5) + `crewai`.
	pytest -v tests/smoke/test_smoke_mcp_crewai.py

smoke-mcp-claude-code: ## Rule 40d smoke (Phase 5): Claude Code plugin MCP path. Requires Node 20+.
	pytest -v tests/smoke/test_smoke_mcp_claude_code.py

smoke-mcp-all: smoke-mcp-python smoke-mcp-langchain smoke-mcp-langgraph smoke-mcp-llamaindex smoke-mcp-crewai smoke-mcp-claude-code ## Run every Phase 5 MCP smoke test (skips uninstalled adapters cleanly).

smoke-all: smoke-anthropic smoke-openai smoke-litellm smoke-langchain smoke-claude-code smoke-policies smoke-mcp-all ## Run every framework smoke test (Phase 4 + Phase 5 MCP; bifrost is optional, run separately).

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
