.PHONY: help build test test-plugin test-integration test-sensor-e2e test-e2e test-e2e-ui seed-e2e lint dev dev-reset down logs release migrate-local-up migrate-local-status playground-anthropic playground-openai playground-langchain playground-langgraph playground-llamaindex playground-crewai playground-litellm playground-mcp playground-claude-code playground-bifrost playground-policies playground-subagents-crewai playground-subagents-langgraph playground-mcp-policy-warn playground-mcp-policy-block playground-mcp-policy-block-on-uncertainty playground-mcp-policy-blocklist playground-mcp-policy-crewai playground-mcp-policy-langgraph playground-mcp-policy-langchain playground-mcp-policy-llamaindex playground-mcp-policy-template-apply playground-all

# ---------------------------------------------------------------------------
# Python interpreter resolution.
#
# Every Python invocation in this Makefile (playground demos, integration
# tests, seed scripts) resolves through ``$(PYTHON)`` and points at the
# project's pinned 3.12 venv by default. CI overrides via the env --
# ``PYTHON=python make ...`` works because actions/setup-python already
# pinned the right interpreter at job start.
#
# Required Python: 3.10 ≤ x < 3.14 (sensor/pyproject.toml requires-python).
# Reasoning: crewai 1.x metadata declares <3.14, our floor matches the
# project's classifier list. The single 3.12 venv discipline (D124) is
# what eliminates the "silent skip on wrong Python" failure mode that
# bit us pre-D124 when ambient ``python`` was 3.14.
# ---------------------------------------------------------------------------
PYTHON ?= ./sensor/.venv/bin/python

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
	$(PYTHON) -m pytest tests/integration -v -m "not manual"

test-sensor-e2e: ## Run sensor respx-driven end-to-end tests (requires running stack)
	$(MAKE) -C docker dev
	$(PYTHON) -m pytest tests/integration/test_sensor_e2e.py -v

# ---------------------------------------------------------------------------
# Rule 40d playground demos. Each runs the per-framework playground
# script against a live provider; NONE of these run in CI (they cost
# money and need real API keys). Run manually before a release that
# touches framework-emission behaviour and document the results in
# the matching audit doc.
#
# Each playground script self-skips (exit 2) when the relevant API
# key / framework / optional gateway URL is missing, so the matrix
# never fails the user's local invocation; a skip just means "not
# exercised on this run".
# ---------------------------------------------------------------------------

playground-anthropic: ## Rule 40d playground: Anthropic SDK. Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/01_direct_anthropic.py

playground-openai: ## Rule 40d playground: OpenAI SDK. Requires OPENAI_API_KEY.
	$(PYTHON) playground/02_direct_openai.py

playground-langchain: ## Rule 40d playground: LangChain (chat + MCP). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/03_langchain.py

playground-langgraph: ## Rule 40d playground: LangGraph (StateGraph chat + ToolNode MCP). Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/04_langgraph.py

playground-llamaindex: ## Rule 40d playground: LlamaIndex (.complete + McpToolSpec). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/05_llamaindex.py

playground-crewai: ## Rule 40d playground: CrewAI (native chat + mcpadapt MCP canary). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/06_crewai.py

playground-litellm: ## Rule 40d playground: litellm multi-provider chat + embeddings + invalid-model error.
	$(PYTHON) playground/12_litellm.py

playground-mcp: ## Rule 40d playground: bare mcp SDK, all six event types + multi-server attribution.
	$(PYTHON) playground/13_mcp.py

playground-claude-code: ## Rule 40d playground: Claude Code plugin MCP-emission demo (success + PluginToolError). Requires Node 20+.
	$(PYTHON) playground/14_claude_code_plugin.py

playground-bifrost: ## Rule 40d playground: bifrost gateway (optional). Requires BIFROST_URL.
	$(PYTHON) playground/15_bifrost.py

# D126 § 11.9 sub-agent observability demos. The Claude Code plugin
# variant lives in playground/14_claude_code_plugin.py (already
# covered by playground-claude-code above — its third demo block
# exercises synthetic SubagentStart / SubagentStop). The CrewAI and
# LangGraph variants run real multi-agent flows against live APIs
# and emit child sessions per agent / node.

playground-subagents-crewai: ## Rule 40d D126 playground: real CrewAI Crew (Researcher + Writer). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/16_subagents_crewai.py

playground-subagents-langgraph: ## Rule 40d D126 playground: real LangGraph (two agent-bearing nodes). Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/17_subagents_langgraph.py

# MCP Protection Policy (D128 / D130 / D131) demos. Demos 18-21 do
# not require LLM API keys — the policy decision fires at call_tool
# time against the in-tree reference MCP server. Demos 22 / 23 do
# require API keys (CrewAI / LangGraph drive real LLM-led MCP calls).

playground-mcp-policy-warn: ## Rule 40d MCP policy: flavor warn entry → POLICY_MCP_WARN lands; no API key required.
	$(PYTHON) playground/18_mcp_policy_warn.py

playground-mcp-policy-block: ## Rule 40d MCP policy: flavor block entry → MCPPolicyBlocked raised; no API key required.
	$(PYTHON) playground/19_mcp_policy_block.py

playground-mcp-policy-block-on-uncertainty: ## Rule 40d MCP policy: cache miss + mcp_block_on_uncertainty=True → block via local_failsafe.
	$(PYTHON) playground/20_mcp_policy_block_on_uncertainty.py

playground-mcp-policy-blocklist: ## Rule 40d MCP policy: global blocklist + deny entry → block via global_entry. Mutates global; restores at end.
	$(PYTHON) playground/21_mcp_policy_blocklist.py

playground-mcp-policy-crewai: ## Rule 40d MCP policy: CrewAI transitive via mcpadapt. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/22_mcp_policy_crewai.py

playground-mcp-policy-langgraph: ## Rule 40d MCP policy: LangGraph transitive via langchain-mcp-adapters. Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/23_mcp_policy_langgraph.py

playground-mcp-policy-langchain: ## Rule 40d MCP policy: LangChain explicit (warn + block + allow) via langchain-mcp-adapters. Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/24_mcp_policy_langchain.py

playground-mcp-policy-llamaindex: ## Rule 40d MCP policy: LlamaIndex explicit (warn + block + allow) via llama-index-tools-mcp. Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/25_mcp_policy_llamaindex.py

playground-mcp-policy-template-apply: ## Rule 40d MCP policy: D138 apply_template across the three shipped templates. Mutates global mode for one scenario; restores at end. No API key required.
	$(PYTHON) playground/26_mcp_policy_template_apply.py

playground-policies: ## Rule 40d playground: policy WARN / DEGRADE / BLOCK / forced-DEGRADE demos via real Anthropic.
	$(PYTHON) playground/policy_demo_warn.py
	$(PYTHON) playground/policy_demo_block.py
	$(PYTHON) playground/policy_demo_degrade.py
	$(PYTHON) playground/policy_demo_forced_degrade.py

playground-all: ## Run every playground script (skips on missing API keys / optional CLI / optional gateway URL).
	$(PYTHON) playground/run_all.py

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
	$(PYTHON) tests/e2e-fixtures/seed.py

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
