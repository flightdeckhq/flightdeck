// Entry point for the Flightdeck ingestion API.
// Receives sensor events via HTTP, publishes to NATS JetStream.
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

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/config"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/directive"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// directiveAdapter wraps directive.Store to satisfy handlers.DirectiveLookup.
type directiveAdapter struct {
	store *directive.Store
}

func (a *directiveAdapter) LookupPending(ctx context.Context, sessionID string) (*handlers.DirectiveResponse, error) {
	d, err := a.store.LookupPending(ctx, sessionID)
	if err != nil || d == nil {
		return nil, err
	}
	return &handlers.DirectiveResponse{
		ID:            d.ID,
		Action:        d.Action,
		Reason:        d.Reason,
		GracePeriodMs: d.GracePeriodMs,
	}, nil
}

func main() {
	cfg := config.Load()

	// Postgres
	pool, err := pgxpool.New(context.Background(), cfg.PostgresURL)
	if err != nil {
		slog.Error("postgres connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// NATS
	nc, err := nats.Connect(cfg.NatsURL)
	if err != nil {
		slog.Error("NATS connection failed", "err", err)
		os.Exit(1)
	}
	defer nc.Close()

	publisher, err := inats.NewPublisher(nc)
	if err != nil {
		slog.Error("NATS publisher setup failed", "err", err)
		os.Exit(1)
	}

	validator := auth.NewValidator(pool)
	dirStore := &directiveAdapter{store: directive.NewStore(pool)}

	addr := fmt.Sprintf(":%s", cfg.Port)
	srv := server.New(addr, validator, publisher, dirStore)

	// Start server
	go func() {
		slog.Info("ingestion API starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown on SIGTERM/SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("shutting down ingestion API")
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.ShutdownTimeoutSecs)*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	slog.Info("ingestion API stopped")
}
