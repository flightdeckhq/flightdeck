// @title       Flightdeck Ingestion API
// @version     0.9.0
// @description Receives sensor events and delivers directives to agents
// @host        localhost:8080
// @BasePath    /

// Entry point for the standalone Flightdeck ingestion API: reads the
// service's environment and runs ingestion/app until SIGTERM or SIGINT.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/flightdeckhq/flightdeck/ingestion/app"
)

func main() {
	cfg, err := app.LoadEnv()
	if err != nil {
		slog.Error("configuration invalid", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := app.Run(ctx, cfg, app.Deps{}); err != nil {
		slog.Error("ingestion API failed", "err", err)
		os.Exit(1)
	}
}
