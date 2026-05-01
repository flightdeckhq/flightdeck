.PHONY: help build test test-plugin test-integration test-sensor-e2e test-e2e test-e2e-ui test-smoke-playground seed-e2e lint dev dev-reset down logs release migrate-local-up migrate-local-status smoke-anthropic smoke-openai smoke-litellm smoke-langchain smoke-langgraph smoke-llamaindex smoke-crewai smoke-claude-code smoke-bifrost smoke-policies smoke-mcp smoke-all

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
# Rule 40d smoke targets. Each runs the per-framework smoke test
# against a live provider; NONE of these run in CI (they cost money
# and need real API keys). Run manually before a release that touches
# framework-emission behaviour and document the results in the
# matching audit doc.
#
# Smoke tests skip cleanly when the relevant env var is unset, so
# the target never fails the user's local pytest invocation; a skip
# just means "not exercised on this run". Operators who want to force
# a skipped target to fail can pass ``-o pytest.ini.addopts='--no-skips'``
# (see tests/smoke/README.md).
# ---------------------------------------------------------------------------

# Smoke tests must run from the repo root, not ``tests/smoke``: the
# in-tree reference MCP server is spawned via
# ``python -m tests.smoke.fixtures.mcp_reference_server``, and that
# module path only resolves when the working directory is the repo
# root (or PYTHONPATH includes it). Per-framework MCP tests skip
# silently with this misconfigured before, masking real failures —
# uniform repo-root pytest invocations close that gap.
smoke-anthropic: ## Rule 40d smoke: Anthropic SDK. Requires ANTHROPIC_API_KEY.
	pytest -v tests/smoke/test_smoke_anthropic.py

smoke-openai: ## Rule 40d smoke: OpenAI SDK. Requires OPENAI_API_KEY.
	pytest -v tests/smoke/test_smoke_openai.py

smoke-litellm: ## Rule 40d smoke: litellm multi-provider. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	pytest -v tests/smoke/test_smoke_litellm.py

smoke-langchain: ## Rule 40d smoke: LangChain (chat via Anthropic + OpenAI; MCP via langchain-mcp-adapters). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY (+ `langchain-mcp-adapters` for the MCP half).
	pytest -v tests/smoke/test_smoke_langchain.py

smoke-claude-code: ## Rule 40d smoke: Claude Code plugin (CLI lifecycle gated on CLAUDE_CLI_AVAILABLE=1; MCP path requires Node 20+).
	pytest -v tests/smoke/test_smoke_claude_code.py

smoke-bifrost: ## Rule 40d smoke: bifrost gateway (optional). Requires BIFROST_URL + upstream provider key.
	pytest -v tests/smoke/test_smoke_bifrost.py

smoke-policies: ## Rule 40d smoke: policy enforcement events (warn/degrade/block) via real Anthropic + flavor policy. Requires ANTHROPIC_API_KEY.
	pytest -v tests/smoke/test_smoke_policies.py

# Per-framework smoke tests (Rule 40d). Each target covers chat
# (where the framework wraps an LLM provider) AND any MCP integration
# the framework exposes -- one target per framework, MCP folded in.
# The bare-SDK MCP smoke is a separate target. Tests pytest-skip when
# the relevant adapter is not installed.
smoke-langgraph: ## Rule 40d smoke: LangGraph (StateGraph chat + ToolNode MCP). Requires `langgraph` (+ `langchain-mcp-adapters` for the MCP half).
	pytest -v tests/smoke/test_smoke_langgraph.py

smoke-llamaindex: ## Rule 40d smoke: LlamaIndex (LLM .complete + McpToolSpec). Requires `llama-index-llms-*` (+ `llama-index-tools-mcp` for the MCP half).
	pytest -v tests/smoke/test_smoke_llamaindex.py

smoke-crewai: ## Rule 40d smoke: CrewAI (native-provider chat + MCPAdapt tools). Requires `crewai` (+ `mcpadapt` for the MCP half, pinned per D5).
	pytest -v tests/smoke/test_smoke_crewai.py

smoke-mcp: ## Rule 40d smoke: direct mcp SDK against the in-tree reference server (all six event types + multi-server attribution).
	pytest -v tests/smoke/test_smoke_mcp.py

smoke-all: smoke-anthropic smoke-openai smoke-litellm smoke-langchain smoke-langgraph smoke-llamaindex smoke-crewai smoke-claude-code smoke-policies smoke-mcp ## Run every framework smoke test (bifrost is optional, run separately).

# `test-e2e` is the Playwright browser-end-to-end suite;
# `test-sensor-e2e` is the pytest respx suite. Two separate targets
# because the older `test-e2e` name collided when the Playwright
# target was added — whichever target `make` picked up last silently
# won, hiding the other. The split below avoids that ambiguity.
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
