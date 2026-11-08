// Package app is the query API as a library: everything cmd/main.go used
// to wire, behind a Config and a Deps, so the standalone binary and the
// single flightdeck binary run the same service. New builds the service,
// Handler is its HTTP surface, Run drives its background loops (and its
// own listener when Config.ListenAddr is set) until the context ends,
// then joins the loops before it closes what it opened.
//
// The package also carries the bootstrap-token helpers the flightdeck
// binary uses to mint and check its dashboard token, since the token
// store is internal to this module.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/config"
	"github.com/flightdeckhq/flightdeck/api/internal/metrics"
	"github.com/flightdeckhq/flightdeck/api/internal/server"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/flightdeckhq/flightdeck/storage"
	"golang.org/x/sync/errgroup"
)

// Config is the query API's configuration. The environment is the one
// source of defaults: LoadEnv reads it as the standalone binary does.
type Config struct {
	// ListenAddr is the address of the service's own HTTP listener.
	// Empty means no listener: the caller mounts Handler() itself.
	ListenAddr string
	// PostgresURL is the database URL (sqlite:// or postgres://) opened
	// through the storage boundary when Deps.DB is nil.
	PostgresURL string
	// CORSOrigin is the Access-Control-Allow-Origin value: "*" or an
	// absolute URL.
	CORSOrigin string
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
		ListenAddr:      ":" + c.Port,
		PostgresURL:     c.PostgresURL,
		CORSOrigin:      c.CORSOrigin,
		MetricsPort:     c.MetricsPort,
		ShutdownTimeout: time.Duration(c.ShutdownTimeoutSecs) * time.Second,
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

// databaseConnectBudget is how long New keeps trying to reach the
// database before giving up. storage.Open pings, so a database that is
// a moment behind the service (compose starts both at once; a
// Kubernetes rollout restarts them independently) would otherwise end
// the process at once. Sixty seconds outlasts the compose Postgres
// healthcheck's worst case (five tries, five seconds apart, plus the
// start) while still failing a misconfigured URL within the first
// minute of a deploy.
const databaseConnectBudget = 60 * time.Second

// Deps are the connections the service runs on. A nil DB is opened
// with OpenDB from Config.PostgresURL and closed when Run returns; one
// the caller passes is left open.
type Deps struct {
	DB *storage.DB
}

// OpenDB opens the database the query API runs on, through the storage
// boundary, retrying a database that is not yet reachable for
// databaseConnectBudget. On Postgres the connections run with the JIT
// off: the API's queries are interactive aggregations over an analytics
// window, and Postgres's JIT compiles the long per-row cost expression
// on every query, which costs more than it saves at these sizes
// (estimated cost over 100,000 events: 780 ms with JIT, 250 ms without;
// 1,000,000 events: 2.6 s against 2.3 s).
func OpenDB(ctx context.Context, rawURL string) (*storage.DB, error) {
	if b, err := storage.BackendOf(rawURL); err == nil && b == storage.Postgres {
		rawURL = withJITOff(rawURL)
	}
	openCtx, cancel := context.WithTimeout(ctx, databaseConnectBudget)
	defer cancel()
	db, err := storage.OpenRetry(openCtx, rawURL, databaseConnectBudget)
	if err != nil {
		return nil, fmt.Errorf("database connection: %w", err)
	}
	return db, nil
}

// withJITOff adds jit=off to a Postgres URL's query (pgx passes a query
// parameter it does not know as a session runtime parameter). A URL
// that does not parse is returned as is, for Open to refuse.
func withJITOff(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	if q.Get("jit") == "" {
		q.Set("jit", "off")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// App is a built query API.
type App struct {
	cfg       Config
	db        *storage.DB
	ownsDB    bool
	bus       storage.Bus
	store     *store.Store
	hub       *ws.Hub
	validator *auth.Validator
	srv       *http.Server
	durations *metrics.RequestDurations
}

// New connects (when Deps.DB is nil), loads the price list and builds
// the handlers. It starts no goroutine; Run does.
func New(ctx context.Context, cfg Config, deps Deps) (*App, error) {
	// Build the price list from the embedded catalogue and the
	// pricing.yaml overrides. A bad pricing.yaml is logged and ignored:
	// the service must not crash on a bad pricing file.
	store.LoadPricing()

	a := &App{cfg: cfg, db: deps.DB}
	if a.db == nil {
		db, err := OpenDB(ctx, cfg.PostgresURL)
		if err != nil {
			return nil, err
		}
		a.db, a.ownsDB = db, true
	}
	a.bus = storage.NewBus(a.db)
	a.store = store.New(a.db, a.bus)
	a.hub = ws.NewHub(a.store)
	a.validator = auth.NewValidator(a.db)
	a.durations = metrics.NewRequestDurations()
	a.srv = server.New(cfg.ListenAddr, a.store, a.hub, a.validator, cfg.CORSOrigin, a.durations)
	return a, nil
}

// Handler is the service's HTTP surface: its routes at their own paths
// and under the /api prefix, with CORS, the request metrics, logging and
// recovery middleware.
func (a *App) Handler() http.Handler { return a.srv.Handler }

// Run syncs the price table and the global MCP policy, starts the hub,
// the fleet and revocation subscriptions, the metrics listener when
// configured and the HTTP listener when ListenAddr is set, and blocks
// until ctx ends or a listener fails. It then shuts the listeners down,
// waits for the background loops, both within ShutdownTimeout, and
// closes the database it opened.
func (a *App) Run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer a.closeOwned()

	// Every background loop returns when runCtx ends; they are joined
	// before the database they use is closed.
	var loops sync.WaitGroup
	spawn := func(f func()) {
		loops.Add(1)
		go func() {
			defer loops.Done()
			f()
		}()
	}

	// Write the price list into model_pricing for the cost queries. On
	// a fresh database the migrator may not have created the table yet,
	// so a failed first sync keeps retrying in the background; the
	// table keeps its previous content until a sync succeeds.
	if err := store.SyncPricingTable(runCtx, a.db); err != nil {
		slog.Warn("pricing table sync at boot failed; retrying in the background", "err", err)
		spawn(func() { store.RetryPricingSync(runCtx, a.db) })
	}
	// Ensure the empty blocklist global MCP policy exists before serving
	// traffic. Best-effort: a migration also seeds this row, so a
	// failure here (for example on a database that has not been
	// migrated yet) leaves nothing missing once the migrations have run.
	if err := a.store.EnsureGlobalMCPPolicy(runCtx); err != nil {
		slog.Warn("ensure global mcp policy at boot failed",
			"err", err,
			"note", "API will continue; the migration seeds the global policy",
		)
	} else {
		slog.Info("ensure global mcp policy at boot complete")
	}

	spawn(func() { a.hub.Run(runCtx) })
	spawn(func() { a.hub.ListenNotify(runCtx, a.bus) })
	// Drop cached validations of a token as soon as its row is deleted.
	spawn(func() { a.validator.ListenRevocations(runCtx, a.bus) })

	g, gctx := errgroup.WithContext(runCtx)
	if a.cfg.ListenAddr != "" {
		g.Go(func() error {
			slog.Info("query API starting", "addr", a.cfg.ListenAddr)
			if err := a.srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("query API server: %w", err)
			}
			return nil
		})
	}
	// Metrics listener. A failure to bind is logged, not fatal: the
	// histogram is observability, and the API must keep serving because
	// a port is taken.
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
	slog.Info("shutting down query API")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer shutdownCancel()
	// The listeners stop taking requests and drain first, so a request
	// in flight still has the hub and the database it may need.
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
	cancel() // stops the hub and the fleet and revocation subscriptions
	if !waitWithin(shutdownCtx, &loops) {
		slog.Warn("background loops did not stop before the shutdown timeout; closing the database anyway")
	}
	slog.Info("query API stopped")
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
	if a.ownsDB && a.db != nil {
		_ = a.db.Close()
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

// TokenValid reports whether raw resolves to an access_tokens row under
// the production rules (an ftd_ token's salted hash; the development
// token is refused here whatever the environment, since a bootstrap
// token is never tok_dev).
func TokenValid(ctx context.Context, db *storage.DB, raw string) (bool, error) {
	if raw == "" || raw == "tok_dev" {
		return false, nil
	}
	res, err := auth.NewValidator(db).Validate(ctx, raw)
	if err != nil {
		return false, err
	}
	return res.Valid, nil
}

// MintToken creates an ftd_ access token named name through the token
// store (salted hash and prefix stored, plaintext returned once).
func MintToken(ctx context.Context, db *storage.DB, name string) (string, error) {
	created, err := store.New(db, storage.NewBus(db)).CreateAccessToken(ctx, name)
	if err != nil {
		return "", err
	}
	return created.RawToken, nil
}
