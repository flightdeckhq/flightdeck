.PHONY: help install build test lint clean

# Resolves through the project's pinned 3.12 venv by default. CI
# overrides via env: ``PYTHON=python make -C sensor test``.
PYTHON ?= ./.venv/bin/python

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install package in editable mode with dev dependencies
	$(PYTHON) -m pip install -e ".[dev,anthropic,openai]"

build: ## Build wheel and sdist
	$(PYTHON) -m build

test: ## Run unit tests
	$(PYTHON) -m pytest tests/unit/ -v

lint: ## Run mypy and ruff
	$(PYTHON) -m mypy flightdeck_sensor/ --strict
	$(PYTHON) -m ruff check flightdeck_sensor/

clean: ## Remove build artifacts
	rm -rf dist/ build/ *.egg-info
