.PHONY: help install build test lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install package in editable mode with dev dependencies
	pip install -e ".[dev,anthropic,openai]"

build: ## Build wheel and sdist
	python -m build

test: ## Run unit tests
	pytest tests/unit/ -v

lint: ## Run mypy and ruff
	mypy flightdeck_sensor/ --strict
	ruff check flightdeck_sensor/

clean: ## Remove build artifacts
	rm -rf dist/ build/ *.egg-info
