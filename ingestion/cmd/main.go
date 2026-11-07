// @title       Flightdeck Ingestion API
// @version     0.8.0
// @description Receives sensor events and delivers directives to agents
// @host        localhost:8080
// @BasePath    /

// Entry point for the Flightdeck ingestion API.
// Receives sensor events via HTTP, publishes to NATS JetStream.
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

	"github.com/flightdeckhq/flightdeck/ingestion/internal/assembler"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/config"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/directive"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/metrics"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// unavailablePostgresURL is the pool target of the stores that have not
// moved to the storage boundary when the database is SQLite: port 1 is
// reserved and never listens, so every use fails fast with a connection
// error. pgx parses the URL without connecting.
const unavailablePostgresURL = "postgres://flightdeck@127.0.0.1:1/unavailable?sslmode=disable"

// directiveAdapter wraps directive.Store to satisfy handlers.DirectiveLookup.
type directiveAdapter struct {
	store *directive.Store
}

func (a *directiveAdapter) LookupPending(ctx context.Context, sessionID string) (*handlers.DirectiveResponse, error) {
	d, err := a.store.LookupPending(ctx, sessionID)
	if err != nil || d == nil {
		return nil, err
	}
	// Payload is the JSONB blob for action="custom" directives
	// (directive_name / fingerprint / parameters). Project it through
	// so the sensor's DirectivePayloadSchema can validate and dispatch
	// to the registered handler. Dropping it here would leave the
	// sensor unable to dispatch the directive.
	return &handlers.DirectiveResponse{
		ID:            d.ID,
		Action:        d.Action,
		Reason:        d.Reason,
		DegradeTo:     d.DegradeTo,
		GracePeriodMs: d.GracePeriodMs,
		Payload:       d.Payload,
	}, nil
}

func main() {
	cfg := config.Load()

	// The database, through the storage boundary. The token validator
	// reads it here; the stores not yet converted (directives, sessions,
	// OTLP staging) still open a pgx pool of their own below.
	db, err := storage.Open(context.Background(), cfg.PostgresURL)
	if err != nil {
		slog.Error("database connection failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = db.Close() }()
	bus := storage.NewBus(db)

	// Postgres, for the stores that have not moved to storage yet. On
	// SQLite they have no database: the pool below points at a port
	// nothing listens on, so a request that reaches one of them fails
	// with an error instead of a nil dereference, and the GenAI
	// assembler (a background loop over the staging store) does not
	// start. Both go when the last store moves to the boundary.
	poolURL := cfg.PostgresURL
	if db.Backend != storage.Postgres {
		poolURL = unavailablePostgresURL
		slog.Warn("sqlite backend: directive polling, session attachment and OTLP staging are unavailable until their stores move to the storage boundary")
	}
	pool, err := pgxpool.New(context.Background(), poolURL)
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

	publisher, err := inats.NewPublisher(nc, inats.StreamSettings{
		MaxAge:   cfg.StreamMaxAge,
		MaxBytes: cfg.StreamMaxBytes,
		Replicas: cfg.StreamReplicas,
	})
	if err != nil {
		slog.Error("NATS publisher setup failed", "err", err)
		os.Exit(1)
	}

	validator := auth.NewValidator(db)

	// runCtx lives until shutdown begins; background loops stop with it.
	runCtx, stopRun := context.WithCancel(context.Background())
	defer stopRun()
	// Drop cached validations of a token as soon as its row is deleted.
	go validator.ListenRevocations(runCtx, bus)
	dirStore := &directiveAdapter{store: directive.NewStore(pool)}
	sessAttacher := session.NewStore(pool)

	addr := fmt.Sprintf(":%s", cfg.Port)
	// OTLP resources are routed by scope: Claude Code through its
	// dialect (which reads sessions through the same store that runs the
	// attachment check), the recorded GenAI frameworks to the staging
	// store the assembler drains, anything else counted as rejected.
	stagingStore := otlpstage.NewStore(pool)
	otlpDialect := handlers.NewOTLPRouter(handlers.NewClaudeCodeDialect(sessAttacher), stagingStore)
	durations := metrics.NewRequestDurations()
	srv := server.New(addr, validator, publisher, dirStore, sessAttacher, otlpDialect, cfg.RateLimitPerMinute, durations)

	// The OTLP GenAI assembler: every process claims due staged traces
	// and publishes them through the receiver's publish path. It stops
	// claiming when runCtx ends, before the server shuts down.
	genaiAssembler := assembler.New(
		stagingStore,
		handlers.NewOTLPPublisher(publisher, sessAttacher),
		assembler.WithInterval(cfg.GenAIClaimInterval),
	)
	assemblerDone := make(chan struct{})
	go func() {
		defer close(assemblerDone)
		if db.Backend != storage.Postgres {
			// The staging store is not on the storage boundary yet.
			return
		}
		genaiAssembler.Run(runCtx)
	}()

	// Start server
	go func() {
		slog.Info("ingestion API starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Metrics listener. A failure to bind is logged, not fatal: the
	// histogram is observability, and the API must keep serving events
	// because a port is taken.
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

	slog.Info("shutting down ingestion API")
	stopRun()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.ShutdownTimeoutSecs)*time.Second)
	defer cancel()

	// Let the assembly in progress finish its chunk and release its
	// lease before the database and bus connections close.
	select {
	case <-assemblerDone:
	case <-ctx.Done():
		slog.Warn("genai assembler did not stop before the shutdown timeout; its lease lapses")
	}

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(ctx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
	}
	slog.Info("ingestion API stopped")
}
