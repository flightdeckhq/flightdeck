// Package app is the worker service as a library: everything cmd/main.go
// used to wire, behind a Config and a Deps, so the standalone binary and
// the single flightdeck binary run the same service. Migrate applies the
// schema migrations; Run consumes the FLIGHTDECK stream until the
// context ends. Callers run Migrate first: the binaries do it once, at
// start, before any service touches the database.
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
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

// Config is the workers' configuration. DefaultConfig gives every
// tunable the value the service's environment variable defaults to.
type Config struct {
	// PostgresURL is dialled when Deps.Pool is nil, and is the URL the
	// migrations run against in every case.
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
	// ShutdownTimeout bounds the graceful shutdown; a tenth of it is
	// the drain pause for in-flight messages.
	ShutdownTimeout time.Duration
}

// DefaultConfig is Config with the defaults the service's environment
// variables have.
func DefaultConfig() Config {
	return Config{
		WorkerPoolSize:     10,
		ReconcilerInterval: 60 * time.Second,
		OrphanTimeout:      24 * time.Hour,
		MigrationsDir:      "/migrations",
		ShutdownTimeout:    30 * time.Second,
	}
}

// FromEnv maps the service's environment configuration onto a Config,
// for the standalone binary.
func FromEnv(c config.Config) Config {
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
	return FromEnv(config.Load()), nil
}

// Deps are the connections and files the service runs on. A nil
// connection is dialled from Config and closed when Run returns; one the
// caller passes is left open. Migrations, when set, is a filesystem
// whose root holds the numbered migration pairs (the flightdeck binary's
// embedded copy); nil reads Config.MigrationsDir.
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
// refused), which is returned so the supervisor restarts the worker.
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

	proc := processor.NewProcessor(pool)
	// Background reconciler for stale/lost/orphaned sessions.
	go proc.StartReconciler(runCtx, cfg.ReconcilerInterval, cfg.OrphanTimeout)
	// Rewrite events stored before the write path canonicalised model
	// ids; returns once none are left (see writer.RunModelBackfill).
	go writer.New(pool).RunModelBackfill(runCtx)

	consumerErr := make(chan error, 1)
	cons := consumer.New(nc, cfg.WorkerPoolSize, proc)
	go func() {
		slog.Info("workers starting", "pool_size", cfg.WorkerPoolSize)
		consumerErr <- cons.Start(runCtx)
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
	if metricsSrv != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
		shutdownCancel()
	}
	// Allow in-flight messages to drain.
	time.Sleep(cfg.ShutdownTimeout / 10)
	slog.Info("workers stopped")
	return runErr
}
