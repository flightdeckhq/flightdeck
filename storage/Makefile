.PHONY: help test test-sqlite lint

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

# The Postgres half of the tests runs when TEST_POSTGRES_URL names a
# database (scripts/go-db-tests.sh provides one); SQLite always runs.
test: ## Run the storage tests (SQLite always; Postgres with TEST_POSTGRES_URL)
	go test ./... -v -count=1

test-sqlite: ## Run the storage tests on SQLite only
	FLIGHTDECK_TEST_BACKEND=sqlite go test ./... -v -count=1

# gofmt from the toolchain this module's go.mod selects. make runs from the
# module directory, so go env GOROOT resolves that toolchain, the same Go
# release CI's setup-go installs. A gofmt from another release on PATH can
# format doc comments differently and disagree with CI.
GOFMT := $(shell go env GOROOT)/bin/gofmt

lint: ## Run gofmt and golangci-lint
	@test -x "$(GOFMT)" || { echo "gofmt not found at $(GOFMT)"; exit 1; }
	@test -z "$$($(GOFMT) -l .)" || { echo "gofmt reports unformatted files (run gofmt -w .):"; $(GOFMT) -l .; exit 1; }
	golangci-lint run ./...
