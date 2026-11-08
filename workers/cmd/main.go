// Entry point for the Flightdeck Go event processing workers.
// Consumes events from NATS JetStream, processes them and writes to the
// database (SQLite or Postgres, through the storage boundary).
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

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/config"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/nats-io/nats.go"
)

// databaseConnectBudget is how long the worker keeps trying to reach
// its database at boot before exiting. storage.Open pings, so a
// database that is a moment behind the service (compose starts both at
// once; a Kubernetes rollout restarts them independently) would
// otherwise end the process at once. Sixty seconds outlasts the compose
// Postgres healthcheck's worst case (five tries, five seconds apart,
// plus the start) while still failing a misconfigured URL within the
// first minute of a deploy.
const databaseConnectBudget = 60 * time.Second

func main() {
	os.Exit(run())
}

// run is main without os.Exit, so the deferred closes run on every
// path, migrate-only included.
func run() int {
	cfg := config.Load()

	// The database, through the storage boundary: SQLite or Postgres,
	// whichever the URL names. The worker's Postgres connections carry
	// its lock timeout (writer.DatabaseURL).
	dbURL, err := writer.DatabaseURL(cfg.PostgresURL)
	if err != nil {
		slog.Error("database URL invalid", "err", err)
		return 1
	}
	openCtx, cancelOpen := context.WithTimeout(context.Background(), databaseConnectBudget)
	db, err := storage.OpenRetry(openCtx, dbURL, databaseConnectBudget)
	cancelOpen()
	if err != nil {
		slog.Error("database connection failed", "err", err)
		return 1
	}
	defer func() { _ = db.Close() }()

	// Run database migrations before anything else: the embedded set of
	// the database's backend, on a connection of their own.
	slog.Info("running database migrations", "backend", db.Backend)
	if err := storage.Migrate(context.Background(), cfg.PostgresURL); err != nil {
		slog.Error("database migration failed", "err", err)
		return 1
	}
	slog.Info("database migrations complete")

	// Migrate-only mode: apply migrations and exit without starting consumers
	if os.Getenv("FLIGHTDECK_MIGRATE_ONLY") == "true" {
		slog.Info("migrate-only mode, exiting")
		return 0
	}

	// The bus the query API hub listens on for fleet changes: Postgres
	// NOTIFY, or in-process channels on SQLite.
	bus := storage.NewBus(db)

	// NATS
	nc, err := nats.Connect(cfg.NatsURL)
	if err != nil {
		slog.Error("NATS connection failed", "err", err)
		return 1
	}
	defer nc.Close()

	proc := processor.NewProcessor(db, bus)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start background reconciler for stale/lost/orphaned sessions.
	// reconcilerInterval is sourced from FLIGHTDECK_RECONCILER_INTERVAL_SECS
	// (default 60 s; the dev stack lowers it so the integration tests
	// that wait for a tick stay short) — see config.ReconcilerIntervalSecs.
	// orphanTimeout is sourced from FLIGHTDECK_ORPHAN_TIMEOUT_HOURS
	// (default 24h) — see config.OrphanTimeoutHours for the rationale.
	reconcilerInterval := time.Duration(cfg.ReconcilerIntervalSecs) * time.Second
	orphanTimeout := time.Duration(cfg.OrphanTimeoutHours) * time.Hour
	go proc.StartReconciler(ctx, reconcilerInterval, orphanTimeout)

	// Rewrite events stored before the write path canonicalised model
	// ids; returns once none are left (see writer.RunModelBackfill).
	go writer.New(db, bus).RunModelBackfill(ctx)

	// Start NATS consumer pool
	cons := consumer.New(nc, cfg.WorkerPoolSize, proc)
	go func() {
		slog.Info("workers starting", "pool_size", cfg.WorkerPoolSize, "backend", db.Backend)
		// Start returns an error only when setup fails (JetStream
		// unavailable, stream or subscription refused). Exit so the
		// supervisor restarts the worker and retries, rather than
		// leaving a live process that consumes nothing.
		if err := cons.Start(ctx); err != nil {
			slog.Error("consumer setup failed, exiting", "err", err)
			os.Exit(1)
		}
	}()

	// Metrics listener. A failure to bind is logged, not fatal: the
	// counters are observability, and event processing must not stop
	// because a port is taken.
	var metricsSrv *http.Server
	if cfg.MetricsPort > 0 {
		metricsSrv = metrics.NewServer(fmt.Sprintf(":%d", cfg.MetricsPort))
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

	slog.Info("shutting down workers")
	cancel()
	if metricsSrv != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(
			context.Background(), time.Duration(cfg.ShutdownTimeoutSecs)*time.Second)
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
		shutdownCancel()
	}

	// Allow in-flight messages to drain
	time.Sleep(time.Duration(cfg.ShutdownTimeoutSecs) * time.Second / 10)
	slog.Info("workers stopped")
	return 0
}
