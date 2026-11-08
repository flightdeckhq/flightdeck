// @title       Flightdeck Query API
// @version     0.8.0
// @description Fleet visibility, session history, and control plane for AI agent fleets
// @host        localhost:8081
// @BasePath    /

// Entry point for the Flightdeck query API.
// Serves dashboard REST endpoints and WebSocket stream.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/config"
	"github.com/flightdeckhq/flightdeck/api/internal/metrics"
	"github.com/flightdeckhq/flightdeck/api/internal/server"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/flightdeckhq/flightdeck/storage"
)

// databaseConnectBudget is how long the API keeps trying to reach its
// database at boot before exiting. storage.Open pings, so a database
// that is a moment behind the service (compose starts both at once; a
// Kubernetes rollout restarts them independently) would otherwise end
// the process at once. Sixty seconds outlasts the compose Postgres
// healthcheck's worst case (five tries, five seconds apart, plus the
// start) while still failing a misconfigured URL within the first
// minute of a deploy.
const databaseConnectBudget = 60 * time.Second

func main() {
	cfg := config.Load()

	// Build the price list from the embedded catalogue and the
	// pricing.yaml overrides. A bad pricing.yaml is logged and ignored
	// -- the service must not crash on a bad pricing file.
	store.LoadPricing()

	// The database, through the storage boundary: sqlite:// or
	// postgres://. Every store of the API runs on it.
	openCtx, cancelOpen := context.WithTimeout(context.Background(), databaseConnectBudget)
	db, err := storage.OpenRetry(openCtx, cfg.PostgresURL, databaseConnectBudget)
	cancelOpen()
	if err != nil {
		slog.Error("database connection failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = db.Close() }()
	bus := storage.NewBus(db)

	s := store.New(db, bus)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Write the price list into model_pricing for the cost queries. On
	// a fresh database the workers may not have created the table yet,
	// so a failed first sync keeps retrying in the background; the
	// table keeps its previous content until a sync succeeds.
	if err := store.SyncPricingTable(ctx, db); err != nil {
		slog.Warn("pricing table sync at boot failed; retrying in the background", "err", err)
		go store.RetryPricingSync(ctx, db)
	}
	// Ensure the empty blocklist global MCP policy exists
	// before serving traffic. Idempotent INSERT with retry on
	// unique-violation handles parallel API instances on a shared
	// database. Best-effort: a migration also seeds this row, so a
	// failure here (for example on a database the workers have not
	// migrated yet) leaves nothing missing once the migrations have
	// run.
	if err := s.EnsureGlobalMCPPolicy(context.Background()); err != nil {
		slog.Warn("ensure global mcp policy at boot failed",
			"err", err,
			"note", "API will continue; the migration seeds the global policy",
		)
	} else {
		slog.Info("ensure global mcp policy at boot complete")
	}
	hub := ws.NewHub(s)
	validator := auth.NewValidator(db)

	// Start Hub event loop
	go hub.Run(ctx)

	// Start the fleet notification listener
	go hub.ListenNotify(ctx, bus)
	// Drop cached validations of a token as soon as its row is deleted.
	go validator.ListenRevocations(ctx, bus)

	addr := fmt.Sprintf(":%s", cfg.Port)
	durations := metrics.NewRequestDurations()
	srv := server.New(addr, s, hub, validator, cfg.CORSOrigin, durations)

	// Start server
	go func() {
		slog.Info("query API starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Metrics listener. A failure to bind is logged, not fatal: the
	// histogram is observability, and the API must keep serving because
	// a port is taken.
	var metricsSrv *http.Server
	if cfg.MetricsPort > 0 {
		metricsSrv = metrics.NewServer(fmt.Sprintf(":%d", cfg.MetricsPort), durations)
		go func() {
			slog.Info("metrics listener starting", "addr", metricsSrv.Addr)
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("metrics listener failed", "err", err)
			}
		}()
	}

	// Graceful shutdown on SIGTERM/SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("shutting down query API")
	cancel() // stops Hub and the notification listeners

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Duration(cfg.ShutdownTimeoutSecs)*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
	}
	slog.Info("query API stopped")
}
