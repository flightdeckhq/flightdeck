// Entry point for the standalone Flightdeck event processing workers:
// reads the service's environment, applies the migrations and runs
// workers/app until SIGTERM or SIGINT. FLIGHTDECK_MIGRATE_ONLY=true
// applies the migrations and exits.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/flightdeckhq/flightdeck/workers/app"
)

func main() {
	cfg, err := app.LoadEnv()
	if err != nil {
		slog.Error("configuration invalid", "err", err)
		os.Exit(1)
	}

	// Run database migrations before anything else.
	if err := app.Migrate(cfg, app.Deps{}); err != nil {
		slog.Error("database migration failed", "err", err)
		os.Exit(1)
	}
	// Migrate-only mode: exit without starting consumers.
	if os.Getenv("FLIGHTDECK_MIGRATE_ONLY") == "true" {
		slog.Info("migrate-only mode, exiting")
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := app.Run(ctx, cfg, app.Deps{}); err != nil {
		slog.Error("workers failed", "err", err)
		os.Exit(1)
	}
}
