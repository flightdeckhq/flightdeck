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

	"github.com/flightdeckhq/flightdeck/api/internal/config"
	"github.com/flightdeckhq/flightdeck/api/internal/server"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg := config.Load()

	// Postgres
	pool, err := pgxpool.New(context.Background(), cfg.PostgresURL)
	if err != nil {
		slog.Error("postgres connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	s := store.New(pool)
	hub := ws.NewHub()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start Hub event loop
	go hub.Run(ctx)

	// Start Postgres NOTIFY listener
	go hub.ListenNotify(ctx, pool)

	addr := fmt.Sprintf(":%s", cfg.Port)
	srv := server.New(addr, s, hub, cfg.CORSOrigin)

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
