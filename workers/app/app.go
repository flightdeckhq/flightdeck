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
	"io/fs"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/config"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	dbmigrate "github.com/flightdeckhq/flightdeck/workers/internal/migrate"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// Config is the workers' configuration. The environment is the one
// source of defaults: LoadEnv reads it as the standalone binary does.
type Config struct {
	// PostgresURL is dialled when Deps.Pool is nil, and is the URL
	// Migrate runs against in every case.
	PostgresURL string
	// NatsURL is dialled when Deps.NATS is nil.
	NatsURL string
	// WorkerPoolSize is the number of consumer lanes.
	WorkerPoolSize int
	// ReconcilerInterval and OrphanTimeout drive the background
	// reconciler; see config.Config for their bounds.
	ReconcilerInterval time.Duration
	OrphanTimeout      time.Duration
	// MigrationsDir holds the migration files when Deps.Migrations is nil.
	MigrationsDir string
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
		MigrationsDir:      c.MigrationsDir,
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

// Deps are the connections and files the service runs on. A nil
// connection is dialled from Config and closed when Run returns; one the
// caller passes is left open. Migrations, when set, is a filesystem
// whose root holds the numbered migration pairs (the flightdeck binary's
// embedded copy) that Migrate applies; nil reads Config.MigrationsDir.
// Run never reads it.
type Deps struct {
	Pool       *pgxpool.Pool
	NATS       *nats.Conn
	Migrations fs.FS
}

// Migrate applies every pending migration to Config.PostgresURL.
func Migrate(cfg Config, deps Deps) error {
	if deps.Migrations != nil {
		slog.Info("running database migrations", "source", "embedded")
		if err := dbmigrate.RunFS(cfg.PostgresURL, deps.Migrations); err != nil {
			return fmt.Errorf("database migration: %w", err)
		}
	} else {
		slog.Info("running database migrations", "dir", cfg.MigrationsDir)
		if err := dbmigrate.Run(cfg.PostgresURL, cfg.MigrationsDir); err != nil {
			return fmt.Errorf("database migration: %w", err)
		}
	}
	slog.Info("database migrations complete")
	return nil
}

// Run connects (where Deps leaves a connection nil), starts the
// reconciler, the model backfill, the consumer lanes and the metrics
// listener when configured, and blocks until ctx ends or the consumer
// cannot be set up (JetStream unavailable, stream or subscription
// refused), which is returned so the supervisor restarts the worker. It
// then waits, within ShutdownTimeout, for the lanes to finish their
// messages and the loops to stop, and closes the connections it opened.
// The schema must be current: call Migrate first.
func Run(ctx context.Context, cfg Config, deps Deps) error {
	pool := deps.Pool
	if pool == nil {
		p, err := writer.NewPool(ctx, cfg.PostgresURL)
		if err != nil {
			return fmt.Errorf("postgres connection: %w", err)
		}
		defer p.Close()
		pool = p
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

	proc := processor.NewProcessor(pool)
	// Background reconciler for stale/lost/orphaned sessions.
	spawn(func() { proc.StartReconciler(runCtx, cfg.ReconcilerInterval, cfg.OrphanTimeout) })
	// Rewrite events stored before the write path canonicalised model
	// ids; returns once none are left (see writer.RunModelBackfill).
	spawn(func() { writer.New(pool).RunModelBackfill(runCtx) })

	// The consumer returns an error only when setup fails; otherwise it
	// runs the lanes until runCtx ends and returns once they have
	// finished the messages they hold.
	consumerErr := make(chan error, 1)
	cons := consumer.New(nc, cfg.WorkerPoolSize, proc)
	spawn(func() {
		slog.Info("workers starting", "pool_size", cfg.WorkerPoolSize)
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
