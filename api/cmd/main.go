// @title       Flightdeck Query API
// @version     0.7.0
// @description Fleet visibility, session history, and control plane for AI agent fleets
// @host        localhost:8081
// @BasePath    /

// Entry point for the Flightdeck query API.
// Serves dashboard REST endpoints and WebSocket stream.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/config"
	"github.com/flightdeckhq/flightdeck/api/internal/server"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg := config.Load()

	// Build the price list from the embedded catalogue and the
	// pricing.yaml overrides. A bad pricing.yaml is logged and ignored
	// -- the service must not crash on a bad pricing file.
	store.LoadPricing()

	// Postgres
	poolConfig, err := pgxpool.ParseConfig(cfg.PostgresURL)
	if err != nil {
		slog.Error("postgres connection config invalid", "err", err)
		os.Exit(1)
	}
	// The API's queries are interactive aggregations over an analytics
	// window. Postgres's JIT compiles the long per-row cost expression
	// on every query, which costs more than it saves at these sizes
	// (estimated cost over 100,000 events: 780 ms with JIT, 250 ms
	// without; 1,000,000 events: 2.6 s against 2.3 s), so the API's
	// connections run without it.
	poolConfig.ConnConfig.RuntimeParams["jit"] = "off"
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		slog.Error("postgres connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	s := store.New(pool)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Write the price list into model_pricing for the cost queries. On
	// a fresh database the workers may not have created the table yet,
	// so a failed first sync keeps retrying in the background; the
	// table keeps its previous content until a sync succeeds.
	if err := store.SyncPricingTable(ctx, pool); err != nil {
		slog.Warn("pricing table sync at boot failed; retrying in the background", "err", err)
		go store.RetryPricingSync(ctx, pool)
	}
	// Ensure the empty blocklist global MCP policy exists
	// before serving traffic. Idempotent INSERT with retry on
	// unique-violation handles parallel API instances on shared
	// Postgres. Best-effort: a migration also seeds this row, so a
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
	validator := auth.NewValidator(pool)

	// Start Hub event loop
	go hub.Run(ctx)

	// Start Postgres NOTIFY listener
	go hub.ListenNotify(ctx, pool)
	// Drop cached validations of a token as soon as its row is deleted.
	go validator.ListenRevocations(ctx, pool)

	addr := fmt.Sprintf(":%s", cfg.Port)
	srv := server.New(addr, s, hub, validator, cfg.CORSOrigin)

	// Start server
	go func() {
		slog.Info("query API starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown on SIGTERM/SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("shutting down query API")
	cancel() // stops Hub and NOTIFY listener

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Duration(cfg.ShutdownTimeoutSecs)*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	slog.Info("query API stopped")
}
