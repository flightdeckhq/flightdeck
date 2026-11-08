// Package app is the worker service as a library: everything cmd/main.go
// used to wire, behind a Config and a Deps, so the standalone binary and
// the single flightdeck binary run the same service. Migrate applies the
// schema migrations; Run consumes the FLIGHTDECK stream until the
// context ends, then waits for its loops before it closes what it
// opened. Callers run Migrate first: the binaries do it once, at start,
// before any service touches the database.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/config"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/nats-io/nats.go"
)

// Config is the workers' configuration. The environment is the one
// source of defaults: LoadEnv reads it as the standalone binary does.
type Config struct {
	// PostgresURL is the database URL (FLIGHTDECK_POSTGRES_URL):
	// postgres://... or sqlite://<path>. Run opens it when Deps.DB is
	// nil, and Migrate runs against it in every case.
	PostgresURL string
	// NatsURL is dialled when Deps.NATS is nil.
	NatsURL string
	// WorkerPoolSize is the number of consumer lanes.
	WorkerPoolSize int
	// ReconcilerInterval and OrphanTimeout drive the background
	// reconciler; see config.Config for their bounds.
	ReconcilerInterval time.Duration
	OrphanTimeout      time.Duration
	// MetricsPort is the metrics listener's port; zero turns it off.
	MetricsPort int
	// ShutdownTimeout bounds the graceful shutdown: the wait for the
	// consumer lanes, the reconciler and the backfill to stop.
	ShutdownTimeout time.Duration
}

// fromEnv maps the service's environment configuration onto a Config.
func fromEnv(c config.Config) Config {
	return Config{
		PostgresURL:        c.PostgresURL,
		NatsURL:            c.NatsURL,
		WorkerPoolSize:     c.WorkerPoolSize,
		ReconcilerInterval: time.Duration(c.ReconcilerIntervalSecs) * time.Second,
		OrphanTimeout:      time.Duration(c.OrphanTimeoutHours) * time.Hour,
		MetricsPort:        c.MetricsPort,
		ShutdownTimeout:    time.Duration(c.ShutdownTimeoutSecs) * time.Second,
	}
}

// LoadEnv reads the service's environment as the standalone binary does
// (see internal/config) and maps it onto a Config. A value the
// environment refuses is returned as an error rather than the panic
// config.Load raises, so a caller that composes several services can
// report it.
func LoadEnv() (cfg Config, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return fromEnv(config.Load()), nil
}

// databaseConnectBudget is how long Run keeps trying to reach the
// database before giving up. storage.Open pings, so a database that is
// a moment behind the service (compose starts both at once; a
// Kubernetes rollout restarts them independently) would otherwise end
// the process at once. Sixty seconds outlasts the compose Postgres
// healthcheck's worst case (five tries, five seconds apart, plus the
// start) while still failing a misconfigured URL within the first
// minute of a deploy.
const databaseConnectBudget = 60 * time.Second

// Deps are the connections the service runs on. A nil one is opened
// from Config and closed when Run returns; one the caller passes is left
// open, since the caller shares it. DB is the database through the
// storage boundary (SQLite or Postgres); Bus carries the fleet
// notifications the query API hub subscribes to and defaults to the
// bus of DB's kind (in-process on SQLite, NOTIFY on Postgres) — the
// flightdeck binary passes the one bus its services share. Migrate
// never reads Deps: the migrations are the storage module's embedded
// set for the URL's backend.
type Deps struct {
	DB   *storage.DB
	Bus  storage.Bus
	NATS *nats.Conn
}

// Migrate applies every pending embedded migration of the backend
// Config.PostgresURL names. The migrator takes the URL as configured,
// without the lock timeout Run's connections carry: a migration that
// waits for a lock must wait, not abort halfway.
func Migrate(cfg Config, _ Deps) error {
	backend, err := storage.BackendOf(cfg.PostgresURL)
	if err != nil {
		return fmt.Errorf("database migration: %w", err)
	}
	slog.Info("running database migrations", "backend", backend)
	if err := storage.Migrate(context.Background(), cfg.PostgresURL); err != nil {
		return fmt.Errorf("database migration: %w", err)
	}
	slog.Info("database migrations complete")
	return nil
}

// Run connects (where Deps leaves a connection nil), starts the
// reconciler, the model backfill, the consumer lanes and the metrics
// listener when configured, and blocks until ctx ends or the consumer
// cannot be set up (JetStream unavailable, stream or subscription
// refused), which is returned so the supervisor restarts the worker. It
// then waits, within ShutdownTimeout, for the loops to stop, and closes
// the connections it opened. The schema must be current: call Migrate
// first.
func Run(ctx context.Context, cfg Config, deps Deps) error {
	db := deps.DB
	if db == nil {
		// The worker's Postgres connections carry its lock timeout
		// (writer.DatabaseURL); a SQLite URL is unchanged.
		dbURL, err := writer.DatabaseURL(cfg.PostgresURL)
		if err != nil {
			return fmt.Errorf("database URL: %w", err)
		}
		openCtx, cancelOpen := context.WithTimeout(ctx, databaseConnectBudget)
		opened, err := storage.OpenRetry(openCtx, dbURL, databaseConnectBudget)
		cancelOpen()
		if err != nil {
			return fmt.Errorf("database connection: %w", err)
		}
		defer func() { _ = opened.Close() }()
		db = opened
	}
	bus := deps.Bus
	if bus == nil {
		bus = storage.NewBus(db)
	}
	nc := deps.NATS
	if nc == nil {
		c, err := nats.Connect(cfg.NatsURL)
		if err != nil {
			return fmt.Errorf("NATS connection: %w", err)
		}
		defer c.Close()
		nc = c
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Every loop returns when runCtx ends; they are joined before the
	// connections they use are closed (the deferred closes above).
	var loops sync.WaitGroup
	spawn := func(f func()) {
		loops.Add(1)
		go func() {
			defer loops.Done()
			f()
		}()
	}

	proc := processor.NewProcessor(db, bus)
	// Background reconciler for stale/lost/orphaned sessions.
	spawn(func() { proc.StartReconciler(runCtx, cfg.ReconcilerInterval, cfg.OrphanTimeout) })
	// Rewrite events stored before the write path canonicalised model
	// ids; returns once none are left (see writer.RunModelBackfill).
	spawn(func() { writer.New(db, bus).RunModelBackfill(runCtx) })

	// The consumer returns an error only when setup fails; otherwise it
	// runs the lanes until runCtx ends. Each message is processed under
	// a context derived from runCtx, so cancelling it ends the work in
	// flight (the statement or the wait it was in returns an error) and
	// the message is left unacknowledged for NATS to redeliver; Start
	// returns once every lane has observed the cancellation.
	consumerErr := make(chan error, 1)
	cons := consumer.New(nc, cfg.WorkerPoolSize, proc)
	spawn(func() {
		slog.Info("workers starting", "pool_size", cfg.WorkerPoolSize, "backend", db.Backend)
		consumerErr <- cons.Start(runCtx)
	})

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

	var runErr error
	select {
	case <-runCtx.Done():
	case err := <-consumerErr:
		if err != nil {
			runErr = fmt.Errorf("consumer setup: %w", err)
		}
	}

	slog.Info("shutting down workers")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer shutdownCancel()
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
	}
	// The lanes return once their cancelled in-flight work has ended
	// (those messages are redelivered), and the reconciler and the
	// backfill stop, before the database and NATS connections close.
	if !waitWithin(shutdownCtx, &loops) {
		slog.Warn("consumer lanes or background loops did not stop before the shutdown timeout; closing the connections anyway")
	}
	slog.Info("workers stopped")
	return runErr
}

// waitWithin waits for wg until ctx ends and reports whether wg finished.
func waitWithin(ctx context.Context, wg *sync.WaitGroup) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}
