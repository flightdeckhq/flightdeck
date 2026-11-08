// Package app is the ingestion API as a library: everything cmd/main.go
// used to wire, behind a Config and a Deps, so the standalone binary and
// the single flightdeck binary run the same service. New builds the
// service, Handler is its HTTP surface, Run drives its background loops
// (and its own listener when Config.ListenAddr is set) until the context
// ends, then shuts down in order: listeners, loops, connections.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
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
	"golang.org/x/sync/errgroup"
)

// Config is the ingestion API's configuration. The environment is the
// one source of defaults: LoadEnv reads it as the standalone binary
// does; the flightdeck binary sets the variables its flags decide and
// reads the same way.
type Config struct {
	// ListenAddr is the address of the service's own HTTP listener.
	// Empty means no listener: the caller mounts Handler() itself.
	ListenAddr string
	// PostgresURL is the database URL (FLIGHTDECK_POSTGRES_URL):
	// postgres://... or sqlite://... for the stores on the storage
	// boundary, which open it when Deps.DB is nil; the stores still on
	// pgx dial it too when Deps.Pool is nil and it is Postgres.
	PostgresURL string
	// NatsURL is dialled when Deps.NATS is nil.
	NatsURL string
	// RateLimitPerMinute is the per-token cap on POST /v1/events and the
	// OTLP routes; see config.Config.
	RateLimitPerMinute int
	// GenAIClaimInterval is the OTLP GenAI assembler's claim interval;
	// zero keeps the assembler's default.
	GenAIClaimInterval time.Duration
	// StreamMaxAge, StreamMaxBytes and StreamReplicas are the FLIGHTDECK
	// stream settings ingestion owns (see the nats package).
	StreamMaxAge   time.Duration
	StreamMaxBytes int64
	StreamReplicas int
	// MetricsPort is the metrics listener's port; zero turns it off.
	MetricsPort int
	// ShutdownTimeout bounds the graceful shutdown: the listeners'
	// drain and the wait for the background loops.
	ShutdownTimeout time.Duration
}

// fromEnv maps the service's environment configuration onto a Config
// with its own listener.
func fromEnv(c config.Config) Config {
	return Config{
		ListenAddr:         ":" + c.Port,
		PostgresURL:        c.PostgresURL,
		NatsURL:            c.NatsURL,
		RateLimitPerMinute: c.RateLimitPerMinute,
		GenAIClaimInterval: c.GenAIClaimInterval,
		StreamMaxAge:       c.StreamMaxAge,
		StreamMaxBytes:     c.StreamMaxBytes,
		StreamReplicas:     c.StreamReplicas,
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

// ReadTimeout and WriteTimeout are the per-request deadlines the
// service's own listener applies; a caller that mounts Handler() on a
// server of its own applies them itself (see server.ReadTimeout).
const (
	ReadTimeout  = server.ReadTimeout
	WriteTimeout = server.WriteTimeout
)

// databaseConnectBudget is how long New keeps trying to reach the
// database before giving up. storage.Open pings, so a database that is
// a moment behind the service (compose starts both at once; a
// Kubernetes rollout restarts them independently) would otherwise end
// the process at once. Sixty seconds outlasts the compose Postgres
// healthcheck's worst case (five tries, five seconds apart, plus the
// start) while still failing a misconfigured URL within the first
// minute of a deploy.
const databaseConnectBudget = 60 * time.Second

// unavailablePostgresURL is the pool target of the stores that have not
// moved to the storage boundary when the database is SQLite: port 1 is
// reserved and never listens, so every use fails fast with a connection
// error. pgx parses the URL without connecting.
const unavailablePostgresURL = "postgres://flightdeck@127.0.0.1:1/unavailable?sslmode=disable"

// Deps are the connections the service runs on. A nil one is opened
// from Config and closed when Run returns; one the caller passes is left
// open, since the caller shares it. DB is the database through the
// storage boundary (the token validator and its revocation bus); Pool
// serves the stores still on pgx (directives, sessions, OTLP staging),
// which have no database when DB is SQLite: a nil Pool then points at a
// port nothing listens on, so a request that reaches one of them fails
// with an error, and the GenAI assembler does not start. Both go when
// the last store moves to the boundary.
type Deps struct {
	DB   *storage.DB
	Pool *pgxpool.Pool
	NATS *nats.Conn
}

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
	// to the registered handler.
	return &handlers.DirectiveResponse{
		ID:            d.ID,
		Action:        d.Action,
		Reason:        d.Reason,
		DegradeTo:     d.DegradeTo,
		GracePeriodMs: d.GracePeriodMs,
		Payload:       d.Payload,
	}, nil
}

// App is a built ingestion API.
type App struct {
	cfg       Config
	db        *storage.DB
	pool      *pgxpool.Pool
	nc        *nats.Conn
	ownsDB    bool
	ownsPool  bool
	ownsNATS  bool
	bus       storage.Bus
	validator *auth.Validator
	assembler *assembler.Assembler
	srv       *http.Server
	durations *metrics.RequestDurations
}

// New connects (where Deps leaves a connection nil), creates or
// reconciles the FLIGHTDECK stream and builds the handlers. It starts no
// goroutine; Run does.
func New(ctx context.Context, cfg Config, deps Deps) (*App, error) {
	a := &App{cfg: cfg, db: deps.DB, pool: deps.Pool, nc: deps.NATS}
	if a.db == nil {
		openCtx, cancel := context.WithTimeout(ctx, databaseConnectBudget)
		db, err := storage.OpenRetry(openCtx, cfg.PostgresURL, databaseConnectBudget)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("database connection: %w", err)
		}
		a.db, a.ownsDB = db, true
	}
	if a.pool == nil {
		poolURL := cfg.PostgresURL
		if a.db.Backend != storage.Postgres {
			poolURL = unavailablePostgresURL
			slog.Warn("sqlite backend: directive polling, session attachment and OTLP staging are unavailable until their stores move to the storage boundary")
		}
		pool, err := pgxpool.New(ctx, poolURL)
		if err != nil {
			a.closeOwned()
			return nil, fmt.Errorf("postgres connection: %w", err)
		}
		a.pool, a.ownsPool = pool, true
	}
	if a.nc == nil {
		nc, err := nats.Connect(cfg.NatsURL)
		if err != nil {
			a.closeOwned()
			return nil, fmt.Errorf("NATS connection: %w", err)
		}
		a.nc, a.ownsNATS = nc, true
	}

	publisher, err := inats.NewPublisher(a.nc, inats.StreamSettings{
		MaxAge:   cfg.StreamMaxAge,
		MaxBytes: cfg.StreamMaxBytes,
		Replicas: cfg.StreamReplicas,
	})
	if err != nil {
		a.closeOwned()
		return nil, fmt.Errorf("NATS publisher setup: %w", err)
	}

	a.bus = storage.NewBus(a.db)
	a.validator = auth.NewValidator(a.db)
	dirStore := &directiveAdapter{store: directive.NewStore(a.pool)}
	sessAttacher := session.NewStore(a.pool)

	// OTLP resources are routed by scope: Claude Code through its
	// dialect (which reads sessions through the same store that runs the
	// attachment check), the recorded GenAI frameworks to the staging
	// store the assembler drains, anything else counted as rejected.
	stagingStore := otlpstage.NewStore(a.pool)
	otlpDialect := handlers.NewOTLPRouter(handlers.NewClaudeCodeDialect(sessAttacher), stagingStore)
	a.durations = metrics.NewRequestDurations()
	a.srv = server.New(cfg.ListenAddr, a.validator, publisher, dirStore, sessAttacher, otlpDialect,
		cfg.RateLimitPerMinute, a.durations)

	// The OTLP GenAI assembler: every process claims due staged traces
	// and publishes them through the receiver's publish path.
	a.assembler = assembler.New(
		stagingStore,
		handlers.NewOTLPPublisher(publisher, sessAttacher),
		assembler.WithInterval(cfg.GenAIClaimInterval),
	)
	return a, nil
}

// Handler is the service's HTTP surface: its routes at their own paths
// and under the /ingest prefix, with the request metrics, logging and
// recovery middleware.
func (a *App) Handler() http.Handler { return a.srv.Handler }

// Run starts the background loops (token revocation listener, GenAI
// assembler on Postgres, the metrics listener when configured, the HTTP
// listener when ListenAddr is set) and blocks until ctx ends or a
// listener fails. It then shuts the listeners down, stops the loops and
// waits for them (the assembly in progress finishes its chunk and
// releases its lease), both within ShutdownTimeout, and closes the
// connections it opened.
func (a *App) Run(ctx context.Context) error {
	runCtx, stopRun := context.WithCancel(ctx)
	defer stopRun()
	defer a.closeOwned()

	// Every background loop returns when runCtx ends; they are joined
	// before the connections they use are closed.
	var loops sync.WaitGroup
	spawn := func(f func()) {
		loops.Add(1)
		go func() {
			defer loops.Done()
			f()
		}()
	}
	// Drop cached validations of a token as soon as its row is deleted.
	spawn(func() { a.validator.ListenRevocations(runCtx, a.bus) })
	if a.db.Backend == storage.Postgres {
		// The staging store is not on the storage boundary yet.
		spawn(func() { a.assembler.Run(runCtx) })
	}

	g, gctx := errgroup.WithContext(runCtx)
	if a.cfg.ListenAddr != "" {
		g.Go(func() error {
			slog.Info("ingestion API starting", "addr", a.cfg.ListenAddr)
			if err := a.srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("ingestion server: %w", err)
			}
			return nil
		})
	}
	// Metrics listener. A failure to bind is logged, not fatal: the
	// histogram is observability, and the API must keep serving events
	// because a port is taken.
	var metricsSrv *http.Server
	if a.cfg.MetricsPort > 0 {
		metricsSrv = metrics.NewServer(fmt.Sprintf(":%d", a.cfg.MetricsPort), a.durations)
		go func() {
			slog.Info("metrics listener starting", "addr", metricsSrv.Addr)
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("metrics listener failed", "err", err)
			}
		}()
	}

	<-gctx.Done()
	slog.Info("shutting down ingestion API")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer cancel()
	// The listeners stop taking requests and drain first, so a request
	// in flight still has the loops and connections it may need.
	if a.cfg.ListenAddr != "" {
		if err := a.srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown error", "err", err)
		}
	}
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("metrics listener shutdown", "err", err)
		}
	}
	err := g.Wait()
	stopRun()
	if !waitWithin(shutdownCtx, &loops) {
		slog.Warn("genai assembler or revocation listener did not stop before the shutdown timeout; a lease in progress lapses")
	}
	slog.Info("ingestion API stopped")
	return err
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

func (a *App) closeOwned() {
	if a.ownsNATS && a.nc != nil {
		a.nc.Close()
		a.nc, a.ownsNATS = nil, false
	}
	if a.ownsPool && a.pool != nil {
		a.pool.Close()
		a.pool, a.ownsPool = nil, false
	}
	if a.ownsDB && a.db != nil {
		if err := a.db.Close(); err != nil {
			slog.Warn("database close", "err", err)
		}
		a.db, a.ownsDB = nil, false
	}
}

// Run builds the service and runs it until ctx ends.
func Run(ctx context.Context, cfg Config, deps Deps) error {
	a, err := New(ctx, cfg, deps)
	if err != nil {
		return err
	}
	return a.Run(ctx)
}
