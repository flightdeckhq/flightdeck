.PHONY: help build run test lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

build: ## Build the api binary
	go build -o bin/api ./cmd/

run: ## Run the query API locally
	go run ./cmd/

test: ## Run unit tests
	go test ./... -v

lint: ## Run golangci-lint
	golangci-lint run ./...

clean: ## Remove build artifacts
	rm -rf bin/
