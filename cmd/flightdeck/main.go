// Command flightdeck runs the Flightdeck control plane as one process:
// the ingestion API, the workers and the query API as goroutines, an
// embedded NATS server as the bus, and the dashboard served from the
// binary, behind one listener. The database is a SQLite file in the
// data dir, or the Postgres database --database-url names.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	apiapp "github.com/flightdeckhq/flightdeck/api/app"
	ingestionapp "github.com/flightdeckhq/flightdeck/ingestion/app"
	"github.com/flightdeckhq/flightdeck/internal/bootstrap"
	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/internal/natsembed"
	"github.com/flightdeckhq/flightdeck/internal/router"
	"github.com/flightdeckhq/flightdeck/internal/serve"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/webui"
	workersapp "github.com/flightdeckhq/flightdeck/workers/app"
	"github.com/nats-io/nats.go"
)

// version is set at build time from the VERSION file (make build-flightdeck).
var version = "dev"

// shutdownTimeout bounds each step of the exit: the HTTP drain, then the
// services' stop. The services have their own SHUTDOWN_TIMEOUT_SECS
// (30 s by default) inside the second step.
const shutdownTimeout = 30 * time.Second

// lockSuffix names the lock file of a SQLite database: the database's
// path with this suffix, beside the file it guards.
const lockSuffix = ".lock"

func main() {
	useUTC()
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// useUTC makes the process's local time zone UTC, as the containers the
// services ran in had. The query API formats the timestamps it reads
// from the database in the process's zone, and its contract is RFC 3339 in
// UTC (the "Z" suffix the dashboard and the integration suite expect);
// a laptop in another zone would otherwise serve "+02:00" offsets.
func useUTC() {
	time.Local = time.UTC
}

func run(args []string, stdout, stderr *os.File) int {
	opts, err := cli.Parse(args, os.Getenv, stderr)
	if errors.Is(err, cli.ErrHelp) {
		return 0
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "flightdeck:", err)
		return 2
	}
	if opts.Version {
		_, _ = fmt.Fprintln(stdout, "flightdeck", version)
		return 0
	}
	if err := serveAll(opts, stdout); err != nil {
		_, _ = fmt.Fprintln(stderr, "flightdeck:", err)
		return 1
	}
	return 0
}

// listeners are the bound sockets of one mode: plain on --listen, or
// :443 and :80 with --domain.
type listeners struct {
	plain, https, redirect net.Listener
}

func (l *listeners) closeAll() {
	for _, ln := range []net.Listener{l.plain, l.https, l.redirect} {
		if ln != nil {
			_ = ln.Close()
		}
	}
}

// bind opens the sockets of the mode before anything else is touched: a
// busy port, or a privileged one the process may not bind, is the most
// common failure, and it should be reported before any side effect.
func bind(opts cli.Options) (*listeners, error) {
	var l listeners
	var err error
	if opts.Domain == "" {
		l.plain, err = serve.Listen(opts.Listen)
		return &l, err
	}
	if l.https, err = serve.Listen(serve.HTTPSPort); err != nil {
		return nil, err
	}
	if l.redirect, err = serve.Listen(serve.HTTPPort); err != nil {
		l.closeAll()
		return nil, err
	}
	return &l, nil
}

func serveAll(opts cli.Options, stdout *os.File) error {
	dev := bootstrap.DevMode(opts.Listen, opts.Domain)

	lns, err := bind(opts)
	if err != nil {
		return err
	}
	defer lns.closeAll()

	layout, err := datadir.Ensure(opts.DataDir)
	if err != nil {
		return err
	}
	if layout.Warning != "" {
		slog.Warn(layout.Warning)
	}
	// One process per data dir: the bus store and the secrets file have
	// one owner. Taken before anything in the directory is written.
	dirLock, err := datadir.Acquire(layout.Lock)
	if err != nil {
		return dataDirInUse(err, layout.Root)
	}
	defer dirLock.Release()
	secrets, err := datadir.LoadSecrets(layout.Secrets)
	if err != nil {
		return err
	}

	database, err := resolveDatabase(opts.DatabaseURL, layout)
	if err != nil {
		return err
	}
	if database.backend == storage.SQLite {
		// One process per SQLite file: the single writer connection and
		// the in-process bus are per process, so a second process on
		// the file would write past both.
		fileLock, err := datadir.Acquire(database.path + lockSuffix)
		if err != nil {
			return databaseInUse(err, database.path)
		}
		defer fileLock.Release()
		if err := datadir.CreatePrivate(database.path); err != nil {
			return err
		}
	}

	// The services read their configuration from the environment the
	// standalone binaries use, so every tuning variable keeps its name,
	// bounds and default; the binary sets the values its flags decide.
	if err := setServiceEnv(opts, database.url, dev, secrets); err != nil {
		return err
	}
	ingCfg, err := ingestionapp.LoadEnv()
	if err != nil {
		return err
	}
	ingCfg.ListenAddr = ""
	wrkCfg, err := workersapp.LoadEnv()
	if err != nil {
		return err
	}
	apiCfg, err := apiapp.LoadEnv()
	if err != nil {
		return err
	}
	apiCfg.ListenAddr = ""

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// What is opened from here on is closed by the defers in reverse:
	// the storage bus, the services' database handles and the database,
	// the NATS connections, the embedded NATS server. The database
	// therefore closes (on SQLite: its write-ahead log checkpointed
	// into the file) as soon as nothing uses it, before the slower NATS
	// shutdown.

	// The NATS bus: embedded unless an external server is named.
	var ingNC, wrkNC *nats.Conn
	var embedded *natsembed.Server
	if opts.NatsURL == "" {
		embedded, err = natsembed.Start(natsembed.Options{StoreDir: layout.NATS, StreamMaxBytes: ingCfg.StreamMaxBytes})
		if err != nil {
			return err
		}
		defer embedded.Shutdown()
		if ingNC, err = embedded.Connect("flightdeck-ingestion"); err != nil {
			return err
		}
		defer ingNC.Close()
		if wrkNC, err = embedded.Connect("flightdeck-workers"); err != nil {
			return err
		}
		defer wrkNC.Close()
	}

	// The schema first, once, before any service or the token bootstrap
	// touches the database: the embedded migrations of its backend.
	if err := storage.Migrate(ctx, database.url); err != nil {
		return fmt.Errorf("database %s: %w", database.display, err)
	}
	slog.Info("database schema is current", "backend", database.backend)
	// One database and one storage bus for the whole process, injected
	// into the three services. On SQLite that is the point: the
	// database holds the file's single writer connection, and the bus
	// is in-process, so a service that opened the file or made a bus
	// for itself would collide with the others' writes and never hear
	// their notifications.
	connURL, err := connectionURL(database.url)
	if err != nil {
		return err
	}
	db, err := storage.Open(ctx, connURL)
	if err != nil {
		return fmt.Errorf("database %s: %w", database.display, err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			slog.Warn("database close", "err", err)
		}
	}()
	// Each service gets a handle of its own on that database, so the
	// dashboard's listing queries cannot take the connections the
	// workers need for every event: on SQLite the handles share the
	// one writer and read through a pool each; on Postgres each is a
	// pool, as each service has when it runs alone.
	var handles [3]*storage.DB
	for i := range handles {
		h, err := db.Share(ctx)
		if err != nil {
			return fmt.Errorf("database %s: %w", database.display, err)
		}
		defer func() { _ = h.Close() }()
		handles[i] = h
	}
	ingDB, wrkDB, apiDB := handles[0], handles[1], handles[2]
	// One bus for the three. On Postgres it notifies through the
	// workers' pool: they publish a notification for nearly every
	// event, as they do through their own pool when they run alone.
	bus := storage.NewBus(wrkDB)
	defer func() { _ = bus.Close() }()

	token, err := bootstrap.EnsureToken(ctx, db, secrets, layout.Secrets, dev)
	if err != nil {
		return err
	}

	ingApp, err := ingestionapp.New(ctx, ingCfg, ingestionapp.Deps{DB: ingDB, Bus: bus, NATS: ingNC})
	if err != nil {
		return err
	}
	apiApp, err := apiapp.New(ctx, apiCfg, apiapp.Deps{DB: apiDB, Bus: bus})
	if err != nil {
		return err
	}
	handler := router.New(router.Config{
		API:                apiApp.Handler(),
		Ingest:             ingApp.Handler(),
		UI:                 webui.FS(),
		Token:              token.Token,
		IngestReadTimeout:  ingestionapp.ReadTimeout,
		IngestWriteTimeout: ingestionapp.WriteTimeout,
		APIReadTimeout:     apiapp.ReadTimeout,
	})

	services := []service{
		{name: "ingestion", run: ingApp.Run},
		{name: "query API", run: apiApp.Run},
		{name: "workers", run: func(c context.Context) error {
			return workersapp.Run(c, wrkCfg, workersapp.Deps{DB: wrkDB, Bus: bus, NATS: wrkNC})
		}},
	}
	var srvs []*http.Server
	var serveFns []func() error
	if opts.Domain != "" {
		https, redirect := serve.ACME(opts.Domain, layout.ACME, handler)
		srvs = append(srvs, https, redirect)
		serveFns = append(serveFns,
			func() error { return serveErr("https", https.ServeTLS(lns.https, "", "")) },
			func() error { return serveErr("http redirect", redirect.Serve(lns.redirect)) })
	} else {
		srv := serve.Server(handler)
		srvs = append(srvs, srv)
		serveFns = append(serveFns, func() error { return serveErr("http", srv.Serve(lns.plain)) })
	}

	printBanner(stdout, opts, dev, token, layout, database, embedded != nil)
	return supervise(ctx, services, serveFns, func(c context.Context) error {
		var firstErr error
		for _, s := range srvs {
			if err := s.Shutdown(c); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		return firstErr
	}, shutdownTimeout)
}

// database is the database of this run.
type database struct {
	backend storage.Backend
	// url is what the storage module opens and migrates.
	url string
	// path is the SQLite file, absolute; empty on Postgres.
	path string
	// display is how the database is named to the operator: the SQLite
	// file's path, or the Postgres URL with its password masked.
	display string
}

// resolveDatabase turns --database-url into the database of this run:
// the SQLite file in the data dir when none is given, otherwise the URL
// as given. A SQLite path is made absolute, so the lock file, the
// start-up block and the storage module all name one file whatever the
// working directory. The SQLite URL is built by the storage module's
// own helper, which carries the path verbatim: a data dir with spaces,
// "#", "?", "%" or a Windows drive letter names the same file in every
// one of them.
func resolveDatabase(rawURL string, layout datadir.Layout) (database, error) {
	if rawURL == "" {
		return database{
			backend: storage.SQLite,
			url:     storage.SQLiteURL(layout.Database),
			path:    layout.Database,
			display: layout.Database,
		}, nil
	}
	backend, err := storage.BackendOf(rawURL)
	if err != nil {
		return database{}, err
	}
	if backend != storage.SQLite {
		return database{backend: backend, url: rawURL, display: maskURL(rawURL)}, nil
	}
	path, err := filepath.Abs(storage.SQLitePath(rawURL))
	if err != nil {
		return database{}, fmt.Errorf("SQLite database path: %w", err)
	}
	return database{backend: backend, url: storage.SQLiteURL(path), path: path, display: path}, nil
}

// connectionURL is the URL the process's database, and through it every
// service's handle, is opened with. On Postgres it carries the
// connection parameters each service sets on its pool when it runs
// alone: the workers' lock timeout and the query API's jit=off. Every
// pool of the process carries both, and both are safe on all three: a
// statement that waits for a row lock past the lock timeout would
// outlast its caller's own deadline in the other two services as
// well, and the JIT only ever engages for the query API's analytics
// queries. On SQLite the URL is unchanged. The
// migrations run on the plain URL: a migration that waits for a lock
// must wait, not abort halfway.
func connectionURL(rawURL string) (string, error) {
	withLockTimeout, err := workersapp.DatabaseURL(rawURL)
	if err != nil {
		return "", fmt.Errorf("database URL: %w", err)
	}
	return apiapp.DatabaseURL(withLockTimeout), nil
}

// dataDirInUse and databaseInUse turn a lock held by another process
// into the message the operator needs; any other lock error is
// returned as it is.
func dataDirInUse(err error, dir string) error {
	var inUse *datadir.InUseError
	if !errors.As(err, &inUse) {
		return err
	}
	return fmt.Errorf("data dir %s is in use by another flightdeck%s; stop it, or give this one a data dir of its own with --data-dir",
		dir, holder(inUse))
}

func databaseInUse(err error, path string) error {
	var inUse *datadir.InUseError
	if !errors.As(err, &inUse) {
		return err
	}
	return fmt.Errorf("the SQLite database %s is in use by another flightdeck%s; one process serves a SQLite file. "+
		"Stop it, or run several instances on one Postgres database with --database-url postgres://…",
		path, holder(inUse))
}

func holder(e *datadir.InUseError) string {
	if e.PID > 0 {
		return fmt.Sprintf(" (pid %d)", e.PID)
	}
	return ""
}

// service is one of the three in-process services.
type service struct {
	name string
	run  func(context.Context) error
}

// supervise runs the services and the HTTP servers and stops them in
// order when ctx ends or one of them fails: the HTTP servers stop
// accepting and drain their requests first (a request in flight still
// has the services it is calling), then the services are cancelled and
// waited for, each step within timeout. The caller's defers then close
// the storage bus, the database and NATS, which nothing uses any more.
// The error of
// the service or server that failed first is returned; a stop on ctx is
// nil.
func supervise(ctx context.Context, services []service, serveFns []func() error,
	shutdownHTTP func(context.Context) error, timeout time.Duration,
) error {
	// The services' context is not derived from ctx: a signal must not
	// stop them before the HTTP servers have drained.
	svcCtx, cancelServices := context.WithCancel(context.Background())
	defer cancelServices()

	type outcome struct {
		name string
		err  error
	}
	failed := make(chan outcome, len(services)+len(serveFns))
	var wg sync.WaitGroup
	for _, s := range services {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failed <- outcome{s.name, s.run(svcCtx)}
		}()
	}
	for _, fn := range serveFns {
		go func() { failed <- outcome{"http", fn()} }()
	}

	var cause error
	select {
	case <-ctx.Done():
	case o := <-failed:
		if o.err != nil {
			cause = o.err
		} else {
			cause = fmt.Errorf("%s stopped unexpectedly", o.name)
		}
		slog.Error("stopping: a component failed", "component", o.name, "err", o.err)
	}

	// 1. Stop accepting and drain the requests in flight.
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), timeout)
	defer cancelDrain()
	if err := shutdownHTTP(drainCtx); err != nil {
		slog.Warn("http server shutdown", "err", err)
	}
	// 2. Stop the services and wait for them.
	cancelServices()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		slog.Warn("services did not stop before the shutdown timeout; closing the database and the bus anyway")
	}
	return cause
}

// serveErr turns a listener's normal close into nil.
func serveErr(name string, err error) error {
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("%s server: %w", name, err)
}

// setServiceEnv sets the variables the three services read to the values
// the binary's flags decide. FLIGHTDECK_PORT is left alone: each app's
// listener is turned off after loading. In development mode the services
// accept the development token; otherwise the variable is cleared so an
// ENVIRONMENT=dev inherited from the shell cannot enable it.
func setServiceEnv(opts cli.Options, databaseURL string, dev bool, secrets *datadir.Secrets) error {
	set := map[string]string{
		// The services' database variable keeps its name; it carries
		// the URL of either backend.
		"FLIGHTDECK_POSTGRES_URL": databaseURL,
		"FLIGHTDECK_JWT_SECRET":   secrets.JWTSecret,
	}
	if opts.NatsURL != "" {
		set["FLIGHTDECK_NATS_URL"] = opts.NatsURL
	}
	unset := []string{"FLIGHTDECK_MIGRATIONS_DIR"}
	if dev {
		set["ENVIRONMENT"] = "dev"
	} else {
		unset = append(unset, "ENVIRONMENT")
	}
	if opts.Metrics {
		// Each service's default port applies; one shared value would
		// make two of the three listeners fail to bind.
		unset = append(unset, "FLIGHTDECK_METRICS_PORT")
	} else {
		set["FLIGHTDECK_METRICS_PORT"] = "0"
	}
	for k, v := range set {
		if err := os.Setenv(k, v); err != nil {
			return fmt.Errorf("set %s: %w", k, err)
		}
	}
	for _, k := range unset {
		if err := os.Unsetenv(k); err != nil {
			return fmt.Errorf("unset %s: %w", k, err)
		}
	}
	return nil
}

func printBanner(w *os.File, opts cli.Options, dev bool, token bootstrap.Result, layout datadir.Layout, db database, embedded bool) {
	base := publicURL(opts)
	p := func(format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }
	p("\nFlightdeck %s\n\n", version)
	p("  Dashboard   %s\n", base)
	p("  Ingestion   %s/ingest   (FLIGHTDECK_SERVER for the sensor and the plugin)\n", base)
	switch {
	case dev:
		p("  Token       %s   (development token: the server listens on loopback only)\n", token.Token)
	case token.Minted:
		p("  Token       %s   (minted now, named %q in Settings; kept in %s)\n", token.Token, bootstrap.TokenName, layout.Secrets)
	default:
		p("  Token       %s…   (from %s)\n", token.Token[:min(8, len(token.Token))], layout.Secrets)
	}
	p("  Data dir    %s\n", layout.Root)
	if db.backend == storage.SQLite {
		p("  Database    %s   (SQLite)\n", db.display)
	} else {
		p("  Database    %s   (Postgres)\n", db.display)
	}
	if embedded {
		p("  Bus         embedded NATS, store %s\n", layout.NATS)
	} else {
		p("  Bus         NATS at %s\n", maskURL(opts.NatsURL))
	}
	p("\nPress Ctrl+C to stop.\n\n")
}

// publicURL is the address to open in a browser: the domain in TLS
// mode; otherwise the listen address, with localhost for a loopback
// bind and the machine's host name for a bind on every interface.
func publicURL(opts cli.Options) string {
	if opts.Domain != "" {
		return "https://" + opts.Domain
	}
	host, port, err := net.SplitHostPort(opts.Listen)
	if err != nil {
		return "http://" + opts.Listen
	}
	switch {
	case host == "" || host == "0.0.0.0" || host == "::":
		if h, err := os.Hostname(); err == nil && h != "" {
			host = h
		} else {
			host = "localhost"
		}
	case bootstrap.Loopback(opts.Listen):
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// maskURL hides the password of a connection URL.
func maskURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); has {
		u.User = url.UserPassword(u.User.Username(), "***")
	}
	// url.String escapes the asterisks; show them as typed.
	return strings.Replace(u.String(), "%2A%2A%2A", "***", 1)
}
