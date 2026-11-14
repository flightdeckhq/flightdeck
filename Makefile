.PHONY: help build build-webui build-flightdeck run-flightdeck test-flightdeck lint-flightdeck test test-plugin test-integration test-go-db test-sensor-e2e test-e2e test-e2e-ui seed-e2e lint dev dev-restart dev-reset down logs dev-split test-split down-split release-prep release-tag version-check vuln-scan release-snapshot pypi-wheels pricing-refresh playground-anthropic playground-openai playground-langchain playground-langgraph playground-llamaindex playground-crewai playground-litellm playground-mcp playground-claude-code playground-bifrost playground-policies playground-subagents-crewai playground-subagents-langgraph playground-mcp-policy-warn playground-mcp-policy-block playground-mcp-policy-block-on-uncertainty playground-mcp-policy-blocklist playground-mcp-policy-crewai playground-mcp-policy-langgraph playground-mcp-policy-langchain playground-mcp-policy-llamaindex playground-mcp-policy-template-apply playground-anthropic-platforms playground-claude-agent-sdk playground-stream-capture playground-parse-litellm-routes playground-lazy-patch-signals playground-agent-handoff playground-llamaindex-agents playground-genai-pydantic-ai playground-genai-strands playground-genai-openai-agents playground-genai-google-adk playground-all playground-openai-agents

# ---------------------------------------------------------------------------
# Python interpreter resolution.
#
# Every Python invocation in this Makefile (playground demos, integration
# tests, seed scripts) resolves through ``$(PYTHON)`` and points at the
# project's pinned 3.12 venv by default. CI overrides via the env --
# ``PYTHON=python make ...`` works because actions/setup-python already
# pinned the right interpreter at job start.
#
# Required Python for the playground and integration tests: 3.11 ≤ x < 3.14.
# The sensor itself supports 3.14 (sensor/pyproject.toml requires-python),
# but crewai 1.x declares <3.14 and is not installed there, so its demos
# and tests would SKIP. The single 3.12 venv discipline is what
# eliminates that "silent skip on wrong Python" failure mode.
# ---------------------------------------------------------------------------
PYTHON ?= ./sensor/.venv/bin/python

# The OpenTelemetry GenAI playground scripts run their framework with no
# sensor, from two venvs pinned to the versions the receiver's
# recordings were made with: Google ADK needs an older OpenTelemetry SDK
# than Pydantic AI, Strands and the OpenAI Agents SDK. playground/README.md
# has the commands that build them.
GENAI_PYTHON ?= $(HOME)/.cache/fd-genai-capture-venv/bin/python
GENAI_ADK_PYTHON ?= $(HOME)/.cache/fd-genai-capture-adk-venv/bin/python
# The OpenAI floor playground runs the sensor against the oldest openai
# it supports, from a venv of its own (playground/README.md).
OPENAI_FLOOR_PYTHON ?= $(HOME)/.cache/fd-openai-floor-venv/bin/python

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

build: ## Build all components, the flightdeck binary included
	$(MAKE) -C sensor build
	$(MAKE) -C ingestion build
	$(MAKE) -C workers build
	$(MAKE) -C api build
	$(MAKE) build-flightdeck

# ---------------------------------------------------------------------------
# The flightdeck binary: the root Go module (go.mod at the repo root,
# go.work lists the three service modules). The dashboard bundle is
# embedded with go:embed, so build-webui runs first and copies
# dashboard/dist into webui/dist. Source maps stay out: they are 12 MB
# the browser never asks for in production.
#
# Root-module Go commands name their packages ($(GO_ROOT_PKGS)) instead
# of ./..., which would walk dashboard/node_modules (a minute on a
# Windows mount) and pick up a stray Go package a dependency ships.
# ---------------------------------------------------------------------------
GO_ROOT_PKGS := ./cmd/... ./internal/... ./webui/...
GOFMT := $(shell go env GOROOT)/bin/gofmt

build-webui: ## Build the dashboard and copy its bundle (without source maps) into webui/dist
	$(MAKE) -C dashboard build
	rm -rf webui/dist
	mkdir -p webui/dist
	cp -R dashboard/dist/. webui/dist/
	find webui/dist -name '*.map' -delete
	touch webui/dist/.gitkeep

build-flightdeck: build-webui ## Build bin/flightdeck with the VERSION file's version
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=v$$(cat VERSION)" -o bin/flightdeck ./cmd/flightdeck

run-flightdeck: ## Run the binary from source; pass flags with ARGS="--listen 127.0.0.1:4100"
	go run ./cmd/flightdeck $(ARGS)

test-flightdeck: ## Tests of the root module: the binary's packages, and the real binary on SQLite (stop, restart, second instance)
	go test $(GO_ROOT_PKGS)

lint-flightdeck: ## gofmt and golangci-lint on the root module
	@test -x "$(GOFMT)" || { echo "gofmt not found at $(GOFMT)"; exit 1; }
	@test -z "$$($(GOFMT) -l cmd internal webui)" || { echo "gofmt reports unformatted files (run gofmt -w cmd internal webui):"; $(GOFMT) -l cmd internal webui; exit 1; }
	golangci-lint run $(GO_ROOT_PKGS)

test: ## Run all unit tests
	$(MAKE) -C sensor test
	$(MAKE) -C storage test
	$(MAKE) -C ingestion test
	$(MAKE) -C workers test
	$(MAKE) -C api test
	$(MAKE) test-flightdeck
	$(MAKE) test-plugin
	$(MAKE) -C dashboard test

test-plugin: ## Run the Claude Code plugin unit tests (zero-dep, node --test)
	cd plugin && node --test tests/*.test.mjs

# test-integration seeds the canonical fixture dataset (seed-e2e)
# before pytest: the agent-id-parity, fleet-recent-sessions and
# mcp-fixture-seed integration tests assert against the canonical
# agents / sessions (the e2e-test-* roles, the mcp-active fixture,
# framework attribution), so the suite needs them present. seed.py
# is idempotent -- a re-run against an already-seeded stack is a
# no-op per session -- so seeding is cheap and safe whether or not
# the stack was already seeded.
#
# The suite then runs in two phases. The first runs every test that
# keeps to its own flavors and session ids in parallel under
# pytest-xdist; the second runs the tests marked ``exclusive`` (see
# tests/integration/conftest.py) one at a time, because each needs
# the whole stack to itself: it pauses the worker, rewrites every
# agents row, or asserts fleet-wide state. Four workers: the worker
# service drains events through a pool of ten goroutines, and four
# pytest processes keep the event rate below the point where the
# suite's 5-10 s state waits start to miss on a laptop-class box;
# more workers make the parallel phase flake before they make it
# faster.
#
# The suite runs against the dev stack, on whichever database it was
# started with (`make dev`, `make dev DB=sqlite`); the target starts
# the stack when none runs. STACK_ENV hands the running stack's
# settings (base URL, database, log file) to the fixtures; a caller
# that sets FLIGHTDECK_TEST_BASE_URL has a stack of its own and is
# left to describe it (CONTRIBUTING.md).
INTEGRATION_WORKERS ?= 4
STACK_ENV = if [ -z "$$FLIGHTDECK_TEST_BASE_URL" ]; then eval "$$(scripts/dev-stack.sh env)"; fi
test-integration: ## Run the integration suite against the dev stack (starts it when none runs)
	@[ -n "$$FLIGHTDECK_TEST_BASE_URL" ] || scripts/dev-stack.sh up $(DB)
	$(MAKE) seed-e2e
	$(STACK_ENV); $(PYTHON) -m pytest tests/integration -p no:respx -v -n $(INTEGRATION_WORKERS) --dist load -m "not manual and not exclusive"
	$(STACK_ENV); $(PYTHON) -m pytest tests/integration -p no:respx -v -m "exclusive"

# test-go-db runs the Go tests that need Postgres (the ones gated on
# TEST_POSTGRES_URL) against the dev stack's Postgres container, each
# package on a fresh database of its own that the script creates,
# migrates and drops, and the storage-converted ones on SQLite as well.
# It never touches the `flightdeck` database. It also runs the Go tests
# gated on TEST_NATS_URL against a NATS server the script starts for
# the run. CI runs it in the integration job's Postgres legs.
test-go-db: ## Run the Go tests that need Postgres or NATS (requires the dev stack on Postgres)
	$(STACK_ENV); ./scripts/go-db-tests.sh

test-sensor-e2e: ## Run sensor respx-driven end-to-end tests against the dev stack (starts it when none runs)
	@[ -n "$$FLIGHTDECK_TEST_BASE_URL" ] || scripts/dev-stack.sh up $(DB)
	$(STACK_ENV); $(PYTHON) -m pytest tests/integration/test_sensor_e2e.py -p no:respx -v

# The split test stack (docker/docker-compose.split.yml): the three
# services as separate containers from source, with their own Postgres
# and NATS, on port $(SPLIT_PORT). It runs beside the dev stack and
# exists for the integration tests that pause the worker container,
# which skip against the binary (the workers are goroutines of the one
# process). Every such test is marked `exclusive`, so test-split runs
# the exclusive phase. CI runs it as its own integration leg.
SPLIT_PROJECT ?= flightdeck-split
SPLIT_PORT ?= 4010
SPLIT_COMPOSE = FLIGHTDECK_SPLIT_PORT=$(SPLIT_PORT) docker compose -p $(SPLIT_PROJECT) -f docker/docker-compose.split.yml
# The split stack's volumes are postgres_data and nats_data of its
# project, and down-split deletes them. Under the dev stack's project
# (docker, or FLIGHTDECK_DEV_PROJECT) or the user compose file's
# (flightdeck) those names are a real database's volume, so the three
# targets refuse those projects before they run anything.
SPLIT_GUARD = @case "$(SPLIT_PROJECT)" in \
	docker|flightdeck|"$(FLIGHTDECK_DEV_PROJECT)") \
	  echo "SPLIT_PROJECT=$(SPLIT_PROJECT) is the compose project of the dev stack or of a user install: the split test stack would share its volumes, and down-split deletes them. Give it a project of its own (the default is flightdeck-split)." >&2; \
	  exit 1 ;; \
	esac
SPLIT_ENV = FLIGHTDECK_TEST_BASE_URL=http://localhost:$(SPLIT_PORT) \
	FLIGHTDECK_TEST_DB=flightdeck \
	FLIGHTDECK_TEST_POSTGRES_CONTAINER=$(SPLIT_PROJECT)-postgres-1 \
	FLIGHTDECK_TEST_WORKER_CONTAINER=$(SPLIT_PROJECT)-workers-1

dev-split: ## Start the split test stack: ingestion, workers and api as containers from source, on :4010
	$(SPLIT_GUARD)
	$(SPLIT_COMPOSE) up -d --wait

test-split: dev-split ## Run the exclusive integration tests, the worker-pause ones included, against the split test stack
	$(SPLIT_ENV) $(PYTHON) tests/e2e-fixtures/seed.py
	$(SPLIT_ENV) $(PYTHON) -m pytest tests/integration -p no:respx -v -m "exclusive"

down-split: ## Remove the split test stack and its volumes (test data only)
	$(SPLIT_GUARD)
	$(SPLIT_COMPOSE) down -v

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

playground-anthropic-platforms: ## Rule 40d playground: Anthropic raw and streaming views, parse, and Bedrock/Vertex/Foundry sections that self-skip without credentials. Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/27_anthropic_platforms.py

playground-claude-agent-sdk: ## Rule 40d playground: Claude Agent SDK query() and ClaudeSDKClient runs as claude_agent_sdk sessions, plugin silent. Requires the SDK and a Claude login or API key.
	$(PYTHON) playground/28_claude_agent_sdk.py

playground-stream-capture: ## Rule 40d playground: every Anthropic and OpenAI streaming path (raw streams, OpenAI .stream() helpers, raw and streaming views, hosted MCP) stores its response and reports its tool calls. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/29_stream_capture.py

playground-parse-litellm-routes: ## Rule 40d playground: OpenAI beta.chat parse, an async streaming view left unread, litellm text_completion and responses on every route, one post_call each. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/30_parse_and_litellm_routes.py

playground-lazy-patch-signals: ## Rule 40a playground: patch() before the SDK imports loads no SDK and meters openai, anthropic and litellm imported afterwards; a SIGTERM inside the session lock ends the process after session_end. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/31_lazy_patch_signals.py

playground-agent-handoff: ## Rule 40a playground: the sensor's agent_handoff signal on its own session and on a child session lands as the OTLP receiver's does, with no content. Needs only the dev stack.
	$(PYTHON) playground/37_agent_handoff.py

playground-llamaindex-agents: ## Rule 40d playground: LlamaIndex FunctionAgent, AgentWorkflow hand-off and ReActAgent runs land as one child session per agent with the hand-off signal, their model and tool calls on the sensor's session. Requires OPENAI_API_KEY.
	$(PYTHON) playground/39_llamaindex_agents.py

playground-openai-agents: ## Rule 40d playground: the sensor's OpenAI Agents SDK wrap (hand-off, function tool and agent as a tool, streamed run, guardrails) against a real model. Requires OPENAI_API_KEY.
	$(PYTHON) playground/40_openai_agents.py

playground-genai-pydantic-ai: ## Rule 40a playground: Pydantic AI over OpenTelemetry, an agent running a sub-agent as a tool lands as two otlp sessions. Requires the GenAI venv + ANTHROPIC_API_KEY.
	$(GENAI_PYTHON) playground/32_genai_pydantic_ai.py

playground-genai-strands: ## Rule 40a playground: Strands Agents over OpenTelemetry (OpenAI provider), sub-agent as a tool. Requires the GenAI venv + OPENAI_API_KEY.
	$(GENAI_PYTHON) playground/33_genai_strands.py

playground-genai-openai-agents: ## Rule 40a playground: OpenAI Agents SDK over OpenTelemetry, sub-agent as a tool. Requires the GenAI venv + OPENAI_API_KEY.
	$(GENAI_PYTHON) playground/34_genai_openai_agents.py

playground-genai-google-adk: ## Rule 40a playground: Google ADK over OpenTelemetry (OpenAI through LiteLLM), sub-agent through AgentTool. Requires the ADK venv + OPENAI_API_KEY.
	$(GENAI_ADK_PYTHON) playground/35_genai_google_adk.py

playground-openai: ## Rule 40d playground: OpenAI SDK. Requires OPENAI_API_KEY.
	$(PYTHON) playground/02_direct_openai.py

playground-openai-floor: ## Rule 40d playground: chat, streams and embeddings on the oldest supported openai (built-in-constructor resources). Requires the OpenAI floor venv + OPENAI_API_KEY.
	$(OPENAI_FLOOR_PYTHON) playground/36_openai_floor.py

playground-langchain: ## Rule 40d playground: LangChain (chat + MCP). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/03_langchain.py

playground-langgraph: ## Rule 40d playground: LangGraph (StateGraph chat + ToolNode MCP). Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/04_langgraph.py

playground-llamaindex: ## Rule 40d playground: LlamaIndex (.complete + McpToolSpec). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/05_llamaindex.py

playground-crewai: ## Rule 40d playground: CrewAI (native chat + mcpadapt MCP canary). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/06_crewai.py

playground-litellm: ## Rule 40d playground: litellm multi-provider chat (sync + async streaming, single count via the OpenAI SDK) + embeddings + invalid-model error. Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/12_litellm.py

playground-mcp: ## Rule 40d playground: bare mcp SDK, all six event types + multi-server attribution.
	$(PYTHON) playground/13_mcp.py

playground-claude-code: ## Rule 40d playground: Claude Code plugin MCP-emission demo (success + PluginToolError). Requires Node 22+.
	$(PYTHON) playground/14_claude_code_plugin.py

playground-bifrost: ## Rule 40d playground: bifrost gateway (optional). Requires BIFROST_URL.
	$(PYTHON) playground/15_bifrost.py

# Sub-agent observability demos. The Claude Code plugin
# variant lives in playground/14_claude_code_plugin.py (already
# covered by playground-claude-code above — its third demo block
# exercises synthetic SubagentStart / SubagentStop). The CrewAI and
# LangGraph variants run real multi-agent flows against live APIs
# and emit child sessions per agent / node.

playground-subagents-crewai: ## Rule 40d sub-agent playground: real CrewAI Crew (Researcher + Writer). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY.
	$(PYTHON) playground/16_subagents_crewai.py

playground-subagents-langgraph: ## Rule 40d sub-agent playground: real LangGraph (two agent-bearing nodes). Requires ANTHROPIC_API_KEY.
	$(PYTHON) playground/17_subagents_langgraph.py

# MCP Protection Policy demos. Demos 18-21 do
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

playground-mcp-policy-template-apply: ## Rule 40d MCP policy: apply_template across the three shipped templates. Mutates global mode for one scenario; restores at end. No API key required.
	$(PYTHON) playground/26_mcp_policy_template_apply.py

playground-policies: ## Rule 40d playground: policy WARN / DEGRADE / BLOCK / forced-DEGRADE demos via real Anthropic.
	$(PYTHON) playground/policy_demo_warn.py
	$(PYTHON) playground/policy_demo_block.py
	$(PYTHON) playground/policy_demo_degrade.py
	$(PYTHON) playground/policy_demo_forced_degrade.py

playground-all: ## Run every playground script (skips on missing API keys / optional CLI / optional gateway URL / missing GenAI or OpenAI floor venvs).
	FD_GENAI_PYTHON=$(GENAI_PYTHON) FD_GENAI_ADK_PYTHON=$(GENAI_ADK_PYTHON) FD_OPENAI_FLOOR_PYTHON=$(OPENAI_FLOOR_PYTHON) $(PYTHON) playground/run_all.py

# `test-e2e` is the Playwright browser-end-to-end suite;
# `test-sensor-e2e` is the pytest respx suite. Two separate targets
# because the older `test-e2e` name collided when the Playwright
# target was added — whichever target `make` picked up last silently
# won, hiding the other. The split below avoids that ambiguity.
#
# Both browser targets take the stack from the dev stack's state, as
# the pytest targets do: the specs read the address, the Postgres
# container and the database from FLIGHTDECK_TEST_*
# (dashboard/tests/e2e/_stack.ts), so a second stack's run reads and
# writes that stack only.
test-e2e: ## Run Playwright E2E tests (requires make dev; fixtures seed automatically via globalSetup)
	$(STACK_ENV); cd dashboard && npx playwright test

test-e2e-ui: ## Run Playwright E2E tests in Playwright UI mode
	$(STACK_ENV); cd dashboard && npx playwright test --ui

seed-e2e: ## Seed the canonical E2E fixture dataset into the running dev stack (idempotent)
	$(STACK_ENV); $(PYTHON) tests/e2e-fixtures/seed.py

lint: ## Lint all components
	$(MAKE) -C sensor lint
	$(MAKE) -C storage lint
	$(MAKE) -C ingestion lint
	$(MAKE) -C workers lint
	$(MAKE) -C api lint
	$(MAKE) lint-flightdeck
	$(MAKE) -C dashboard lint

# The dev stack (scripts/dev-stack.sh): the flightdeck binary built from
# this checkout, with the dashboard bundle embedded, in the background
# on 127.0.0.1:4000, where the development token works. DB picks the
# database: postgres (the default; the Postgres container of
# docker/docker-compose.dev.yml, on the docker_postgres_data volume) or
# sqlite (a file in the stack's data dir, no container). A stack of the
# seven-container layout that is still running is moved over: its
# service containers stop, its Postgres and its volumes stay. Only
# dev-reset deletes data.
dev: ## Start the dev stack: the flightdeck binary from source on :4000 (DB=postgres, the default, or DB=sqlite)
	scripts/dev-stack.sh up $(DB)

dev-restart: ## Rebuild the binary (and a stale dashboard bundle) and restart it; Postgres keeps running
	scripts/dev-stack.sh restart $(DB)

# FLIGHTDECK_DEV_CONFIRM names what is deleted, for a database that
# holds more than a seed: the compose project on Postgres (make
# dev-reset FLIGHTDECK_DEV_CONFIRM=docker), sqlite on SQLite.
# scripts/dev-stack.sh says what it is about to delete and refuses
# without it.
dev-reset: ## Stop the dev stack, DELETE its database and bus store, start again (FLIGHTDECK_DEV_CONFIRM=<project> or sqlite for a database with data)
	FLIGHTDECK_DEV_CONFIRM="$(FLIGHTDECK_DEV_CONFIRM)" scripts/dev-stack.sh reset $(DB)

down: ## Stop the dev stack; volumes and the data dir stay
	scripts/dev-stack.sh down

logs: ## Follow the flightdeck binary's log
	scripts/dev-stack.sh logs

release-prep: ## Open the release PR: bump every version location, date the CHANGELOG (usage: make release-prep VERSION=v0.6.0)
	@test -n "$(VERSION)" || (echo "Usage: make release-prep VERSION=v0.6.0" && exit 1)
	./scripts/release.sh prep $(VERSION)

release-tag: ## After the release PR merges: tag main and push the tag (usage: make release-tag VERSION=v0.6.0)
	@test -n "$(VERSION)" || (echo "Usage: make release-tag VERSION=v0.6.0" && exit 1)
	./scripts/release.sh tag $(VERSION)

pricing-refresh: ## Regenerate the vendored pricing catalogue from litellm's current price list
	python3 scripts/pricing_refresh.py

version-check: ## Check every version location matches the VERSION file
	python3 scripts/version.py check

# The release build, without publishing: the six binaries, their
# archives, checksums.txt and the Homebrew formula land in dist/. Needs
# goreleaser (https://goreleaser.com/install/) and the dashboard's
# dependencies (make -C dashboard install). CI runs the same build on
# every pull request so a target that stops cross-compiling fails there.
release-snapshot: ## Build every release artifact into dist/ without publishing (needs goreleaser)
	HOMEBREW_TAP_GITHUB_TOKEN="$${HOMEBREW_TAP_GITHUB_TOKEN:-unset}" goreleaser release --snapshot --clean --skip=sign

# The flightdeck-cli wheels from the binaries release-snapshot (or the
# release workflow) left in dist/: one per platform, into
# packaging/pypi/dist. TAG names the version (v0.9.0, v0.9.0-rc.1).
pypi-wheels: ## Build the flightdeck-cli wheels from dist/artifacts.json (usage: make pypi-wheels TAG=v0.9.0)
	@test -n "$(TAG)" || (echo "Usage: make pypi-wheels TAG=v0.9.0" && exit 1)
	python3 packaging/pypi/build_wheels.py --artifacts dist/artifacts.json --tag $(TAG) --out packaging/pypi/dist

vuln-scan: ## Scan the npm and pip lockfiles for known vulnerabilities (the CI dependency scan)
	python3 scripts/vuln_scan.py

# Migrations run inside the binary at every start (the dev stack's
# included), from the files embedded in it, so there is no migrate
# target. The versions applied to the dev stack's Postgres:
#   docker exec docker-postgres-1 psql -U flightdeck -d flightdeck \
#     -c "SELECT version, dirty FROM schema_migrations"
