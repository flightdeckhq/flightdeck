.PHONY: help install build run test test-e2e lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

build: ## Build for production
	npm run build

run: ## Start dev server
	npm run dev

test: ## Run unit tests
	npm run test

test-e2e: ## Run Playwright e2e tests
	npx playwright test

lint: ## Run typecheck and eslint
	npm run typecheck
	npm run lint

clean: ## Remove build artifacts
	rm -rf dist/ node_modules/
