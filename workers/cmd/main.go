// Entry point for the Flightdeck Go event processing workers.
// Consumes events from NATS JetStream, processes and writes to Postgres.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/config"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	dbmigrate "github.com/flightdeckhq/flightdeck/workers/internal/migrate"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

func main() {
	cfg := config.Load()

	// Run database migrations before anything else
	slog.Info("running database migrations", "dir", cfg.MigrationsDir)
	if err := dbmigrate.Run(cfg.PostgresURL, cfg.MigrationsDir); err != nil {
		slog.Error("database migration failed", "err", err)
		os.Exit(1)
	}
	slog.Info("database migrations complete")

	// Migrate-only mode: apply migrations and exit without starting consumers
	if os.Getenv("FLIGHTDECK_MIGRATE_ONLY") == "true" {
		slog.Info("migrate-only mode, exiting")
		os.Exit(0)
	}

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

	proc := processor.NewProcessor(pool)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start background reconciler for stale/lost/orphaned sessions.
	// orphanTimeout is sourced from FLIGHTDECK_ORPHAN_TIMEOUT_HOURS
	// (default 24h) — see config.OrphanTimeoutHours for the rationale.
	orphanTimeout := time.Duration(cfg.OrphanTimeoutHours) * time.Hour
	go proc.StartReconciler(ctx, orphanTimeout)

	// Start NATS consumer pool
	cons := consumer.New(nc, cfg.WorkerPoolSize, proc)
	go func() {
		slog.Info("workers starting", "pool_size", cfg.WorkerPoolSize)
		if err := cons.Start(ctx); err != nil {
			slog.Error("consumer error", "err", err)
		}
	}()

	// Graceful shutdown on SIGTERM/SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("shutting down workers")
	cancel()

	// Allow in-flight messages to drain
	time.Sleep(time.Duration(cfg.ShutdownTimeoutSecs) * time.Second / 10)
	slog.Info("workers stopped")
}
