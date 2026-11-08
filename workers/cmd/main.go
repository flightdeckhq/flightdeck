// Entry point for the standalone Flightdeck event processing workers:
// reads the service's environment and runs workers/app until SIGTERM or
// SIGINT. FLIGHTDECK_MIGRATE_ONLY=true applies the migrations and exits.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/flightdeckhq/flightdeck/workers/app"
	"github.com/flightdeckhq/flightdeck/workers/internal/config"
)

func main() {
	cfg := app.FromEnv(config.Load())

	// Migrate-only mode: apply migrations and exit without starting consumers.
	if os.Getenv("FLIGHTDECK_MIGRATE_ONLY") == "true" {
		if err := app.Migrate(cfg, app.Deps{}); err != nil {
			slog.Error("database migration failed", "err", err)
			os.Exit(1)
		}
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
