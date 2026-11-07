.PHONY: help build run test lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

build: ## Build the workers binary
	go build -o bin/workers ./cmd/

run: ## Run the workers locally
	go run ./cmd/

test: ## Run unit tests
	go test ./... -v

# gofmt from the toolchain this module's go.mod selects. make runs from the
# module directory, so go env GOROOT resolves that toolchain, the same Go
# release CI's setup-go installs. A gofmt from another release on PATH can
# format doc comments differently and disagree with CI.
GOFMT := $(shell go env GOROOT)/bin/gofmt

lint: ## Run gofmt and golangci-lint
	@test -x "$(GOFMT)" || { echo "gofmt not found at $(GOFMT)"; exit 1; }
	@test -z "$$($(GOFMT) -l .)" || { echo "gofmt reports unformatted files (run gofmt -w .):"; $(GOFMT) -l .; exit 1; }
	golangci-lint run ./...

clean: ## Remove build artifacts
	rm -rf bin/
