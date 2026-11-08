// @title       Flightdeck Query API
// @version     0.8.0
// @description Fleet visibility, session history, and control plane for AI agent fleets
// @host        localhost:8081
// @BasePath    /

// Entry point for the standalone Flightdeck query API: reads the
// service's environment and runs api/app until SIGTERM or SIGINT.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/flightdeckhq/flightdeck/api/app"
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
		slog.Error("query API failed", "err", err)
		os.Exit(1)
	}
}
