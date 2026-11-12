package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/bootstrap"
	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

func TestPublicURL(t *testing.T) {
	cases := []struct {
		name         string
		opts         cli.Options
		want         string
		anyInterface bool
	}{
		{"the default, loopback", cli.Options{Listen: "127.0.0.1:4000"}, "http://localhost:4000", false},
		{"localhost and another port", cli.Options{Listen: "localhost:4100"}, "http://localhost:4100", false},
		{"IPv6 loopback", cli.Options{Listen: "[::1]:4000"}, "http://localhost:4000", false},
		{"every IPv4 interface", cli.Options{Listen: "0.0.0.0:4000"}, "http://<this-host>:4000", true},
		{"a port alone, the image's listen address", cli.Options{Listen: ":4000"}, "http://<this-host>:4000", true},
		{"every IPv6 interface", cli.Options{Listen: "[::]:4000"}, "http://<this-host>:4000", true},
		{"every interface, spelled out", cli.Options{Listen: "[0:0:0:0:0:0:0:0]:8080"}, "http://<this-host>:8080", true},
		{"one LAN address", cli.Options{Listen: "10.0.0.5:4000"}, "http://10.0.0.5:4000", false},
		{"one IPv6 address", cli.Options{Listen: "[fd00::5]:4000"}, "http://[fd00::5]:4000", false},
		{"a host name", cli.Options{Listen: "fd.internal:4000"}, "http://fd.internal:4000", false},
		{"a domain", cli.Options{Listen: ":4000", Domain: "example.com"}, "https://example.com", false},
		{"a domain over a loopback listen", cli.Options{Listen: "127.0.0.1:4000", Domain: "fd.example.com"}, "https://fd.example.com", false},
		{"an address with no port", cli.Options{Listen: "nonsense"}, "http://nonsense", false},
	}
	for _, c := range cases {
		got, anyInterface := publicURL(c.opts)
		if got != c.want || anyInterface != c.anyInterface {
			t.Errorf("%s: publicURL(%+v) = %q, %v; want %q, %v", c.name, c.opts, got, anyInterface, c.want, c.anyInterface)
		}
	}
}

// The start-up block never shows the operating system's host name: in
// a container that is the container's id, which no browser resolves.
func TestPrintBanner_ShowsAnAddressAPersonCanUse(t *testing.T) {
	host, err := os.Hostname()
	if err != nil || host == "" {
		t.Skip("this machine has no host name to keep out of the block")
	}
	layout := datadir.Layout{Root: "/data", NATS: "/data/nats", Secrets: "/data/secrets.json"}
	db := database{backend: storage.SQLite, display: "/data/flightdeck.db"}
	block := func(opts cli.Options, dev bool) string {
		t.Helper()
		f, err := os.CreateTemp(t.TempDir(), "banner")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = f.Close() }()
		token := bootstrap.Result{Token: "ftd_0123456789abcdef", Minted: !dev}
		if dev {
			token = bootstrap.Result{Token: bootstrap.DevToken, Dev: true}
		}
		printBanner(f, opts, dev, token, layout, db, true)
		out, err := os.ReadFile(f.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}

	for _, listen := range []string{":4000", "0.0.0.0:4000", "[::]:4000"} {
		out := block(cli.Options{Listen: listen}, false)
		if host != "localhost" && strings.Contains(out, host) {
			t.Errorf("--listen %s: the block names the host name %q:\n%s", listen, host, out)
		}
		for _, want := range []string{
			"  Dashboard   http://<this-host>:4000   (every interface of this machine: put its name or address in place of <this-host>)\n",
			"  Ingestion   http://<this-host>:4000/ingest   (FLIGHTDECK_SERVER for the sensor and the plugin)\n",
		} {
			if !strings.Contains(out, want) {
				t.Errorf("--listen %s: the block lacks %q:\n%s", listen, want, out)
			}
		}
	}

	out := block(cli.Options{Listen: "127.0.0.1:4000"}, true)
	for _, want := range []string{
		"  Dashboard   http://localhost:4000\n",
		"  Ingestion   http://localhost:4000/ingest   (FLIGHTDECK_SERVER for the sensor and the plugin)\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("loopback: the block lacks %q:\n%s", want, out)
		}
	}

	out = block(cli.Options{Listen: ":4000", Domain: "example.com"}, false)
	for _, want := range []string{
		"  Dashboard   https://example.com\n",
		"  Ingestion   https://example.com/ingest   (FLIGHTDECK_SERVER for the sensor and the plugin)\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("--domain: the block lacks %q:\n%s", want, out)
		}
	}
}

func TestSetServiceEnv_DevAndProductionModes(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_POSTGRES_URL", "FLIGHTDECK_NATS_URL", "FLIGHTDECK_JWT_SECRET",
		"ENVIRONMENT", "FLIGHTDECK_METRICS_PORT", "FLIGHTDECK_MIGRATIONS_DIR"} {
		t.Setenv(k, "inherited")
	}
	secrets := &datadir.Secrets{JWTSecret: "abc"}
	opts := cli.Options{}

	if err := setServiceEnv(opts, "postgres://x/db", true, secrets); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"FLIGHTDECK_POSTGRES_URL":   "postgres://x/db",
		"FLIGHTDECK_NATS_URL":       "inherited", // untouched: the embedded bus is injected
		"FLIGHTDECK_JWT_SECRET":     "abc",
		"ENVIRONMENT":               "dev",
		"FLIGHTDECK_METRICS_PORT":   "0",
		"FLIGHTDECK_MIGRATIONS_DIR": "",
	}
	for k, v := range want {
		if got := os.Getenv(k); got != v {
			t.Errorf("dev: %s = %q, want %q", k, got, v)
		}
	}

	opts.NatsURL = "nats://external:4222"
	opts.Metrics = true
	if err := setServiceEnv(opts, "sqlite:///data/flightdeck.db", false, secrets); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("ENVIRONMENT"); got != "" {
		t.Errorf("production: ENVIRONMENT = %q, want unset", got)
	}
	if got := os.Getenv("FLIGHTDECK_METRICS_PORT"); got != "" {
		t.Errorf("production with --metrics: FLIGHTDECK_METRICS_PORT = %q, want unset so each default applies", got)
	}
	if got := os.Getenv("FLIGHTDECK_NATS_URL"); got != "nats://external:4222" {
		t.Errorf("FLIGHTDECK_NATS_URL = %q", got)
	}
	// The services' database variable carries the URL of either backend.
	if got := os.Getenv("FLIGHTDECK_POSTGRES_URL"); got != "sqlite:///data/flightdeck.db" {
		t.Errorf("FLIGHTDECK_POSTGRES_URL = %q", got)
	}
}

func TestServeErr(t *testing.T) {
	if serveErr("x", nil) != nil || serveErr("x", http.ErrServerClosed) != nil {
		t.Fatal("a closed server is not an error")
	}
	err := serveErr("https", errors.New("boom"))
	if err == nil || err.Error() != "https server: boom" {
		t.Fatalf("%v", err)
	}
}

func TestRun_UsageErrorsExitTwo(t *testing.T) {
	t.Setenv("FLIGHTDECK_DATABASE_URL", "")
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()
	if code := run([]string{"--database-url", "mysql://u:p@h/db"}, devnull, devnull); code != 2 {
		t.Fatalf("a database of no supported kind: exit %d, want 2", code)
	}
	if code := run([]string{"serve"}, devnull, devnull); code != 2 {
		t.Fatalf("a stray argument: exit %d, want 2", code)
	}
	if code := run([]string{"--version"}, devnull, devnull); code != 0 {
		t.Fatalf("--version: exit %d, want 0", code)
	}
	if code := run([]string{"-h"}, devnull, devnull); code != 0 {
		t.Fatalf("-h: exit %d, want 0", code)
	}
}

// fakeService records when its context was cancelled and blocks until
// then (or returns the error it was given at once).
type fakeService struct {
	name      string
	cancelled atomic.Int64 // UnixNano of the cancellation, 0 until then
	fail      error
}

func (f *fakeService) run(ctx context.Context) error {
	if f.fail != nil {
		return f.fail
	}
	<-ctx.Done()
	f.cancelled.Store(time.Now().UnixNano())
	return nil
}

func TestSupervise_DrainsHTTPBeforeCancellingTheServices(t *testing.T) {
	a, b := &fakeService{name: "a"}, &fakeService{name: "b"}
	var drained atomic.Int64
	shutdownHTTP := func(context.Context) error {
		// The services must still be running while the drain happens.
		if a.cancelled.Load() != 0 || b.cancelled.Load() != 0 {
			t.Error("a service was cancelled before the HTTP drain")
		}
		drained.Store(time.Now().UnixNano())
		return nil
	}
	serveStarted := make(chan struct{})
	serveFn := func() error {
		close(serveStarted)
		select {} // a server blocks until Shutdown; the fake never returns
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- supervise(ctx, []service{{"a", a.run}, {"b", b.run}}, []func() error{serveFn}, shutdownHTTP, 5*time.Second)
	}()
	<-serveStarted
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a stop on ctx returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("supervise did not return")
	}
	if drained.Load() == 0 || a.cancelled.Load() == 0 || b.cancelled.Load() == 0 {
		t.Fatalf("drain=%d a=%d b=%d: every step must have run", drained.Load(), a.cancelled.Load(), b.cancelled.Load())
	}
	if a.cancelled.Load() < drained.Load() || b.cancelled.Load() < drained.Load() {
		t.Fatal("services were cancelled before the HTTP drain finished")
	}
}

func TestSupervise_AServiceFailureDrainsHTTPThenStopsTheRest(t *testing.T) {
	boom := errors.New("consumer setup: stream gone")
	bad, good := &fakeService{name: "bad", fail: boom}, &fakeService{name: "good"}
	var drained atomic.Bool
	shutdownHTTP := func(context.Context) error {
		if good.cancelled.Load() != 0 {
			t.Error("the healthy service was cancelled before the HTTP drain")
		}
		drained.Store(true)
		return nil
	}
	serveFn := func() error { select {} }
	err := supervise(context.Background(), []service{{"bad", bad.run}, {"good", good.run}}, []func() error{serveFn}, shutdownHTTP, 5*time.Second)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the failing service's error", err)
	}
	if !drained.Load() || good.cancelled.Load() == 0 {
		t.Fatalf("drained=%v good cancelled=%d", drained.Load(), good.cancelled.Load())
	}
}

func TestSupervise_AnHTTPServerFailureStopsTheServices(t *testing.T) {
	svc := &fakeService{name: "svc"}
	serveFn := func() error { return errors.New("https server: tls handshake listener closed") }
	err := supervise(context.Background(), []service{{"svc", svc.run}}, []func() error{serveFn}, func(context.Context) error { return nil }, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "https server") {
		t.Fatalf("err = %v", err)
	}
	if svc.cancelled.Load() == 0 {
		t.Fatal("the service was not stopped after the server failed")
	}
}

func TestBind_PlainModeBindsTheListenAddress(t *testing.T) {
	lns, err := bind(cli.Options{Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	defer lns.closeAll()
	if lns.plain == nil || lns.https != nil || lns.redirect != nil {
		t.Fatalf("%+v", lns)
	}
	busy := lns.plain.Addr().String()
	if _, err := bind(cli.Options{Listen: busy}); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("second bind of %s: %v", busy, err)
	}
}

// The process's one handle is opened with the connection parameters
// each service puts on a pool of its own; a SQLite URL passes through
// byte for byte, whatever its path holds.
func TestConnectionURL_CarriesEveryServicesPostgresParameters(t *testing.T) {
	got, err := connectionURL("postgres://u:p%40ss@db.example:5432/fd?sslmode=require")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"jit=off", "lock_timeout=8000", "sslmode=require", "u:p%40ss@db.example:5432/fd"} {
		if !strings.Contains(got, want) {
			t.Errorf("connectionURL = %q, lacks %q", got, want)
		}
	}
	// What the operator set is kept.
	got, err = connectionURL("postgresql://u@h/fd?jit=on&lock_timeout=500")
	if err != nil || !strings.Contains(got, "jit=on") || !strings.Contains(got, "lock_timeout=500") {
		t.Errorf("connectionURL = %q, %v; the operator's settings must win", got, err)
	}
	for _, same := range []string{
		"sqlite:///home/o m/a#b/x?y/50%/flightdeck.db",
		`sqlite://C:\Users\omria\AppData\Local\flightdeck\flightdeck.db`,
	} {
		if got, err := connectionURL(same); err != nil || got != same {
			t.Errorf("connectionURL(%q) = %q, %v; want it unchanged", same, got, err)
		}
	}
	if _, err := connectionURL("mysql://u@h/fd"); err == nil {
		t.Error("a URL of no supported backend must be refused")
	}
	// A Postgres URL that does not parse is refused without its text,
	// which holds the password, and as an error that is not retried.
	_, err = connectionURL("postgres://flightdeck:s3cret pass@localhost:5432/db%zz")
	if err == nil || !storage.PermanentOpenError(err) {
		t.Errorf("an unparsable URL: %v, want a permanent error", err)
	}
	if err != nil && strings.Contains(err.Error(), "s3cret") {
		t.Errorf("the error repeats the password: %v", err)
	}
}

// realDir is dir with its symbolic links resolved, the form the binary
// names a database by (a test's temp dir is itself behind a link on
// some systems).
func realDir(t *testing.T, dir string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func TestResolveDatabase(t *testing.T) {
	root := filepath.Join(realDir(t, t.TempDir()), "data dir #1")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout := datadir.Layout{Root: root, Database: filepath.Join(root, datadir.DatabaseFile)}

	def, err := resolveDatabase("", layout)
	if err != nil {
		t.Fatal(err)
	}
	if def.backend != storage.SQLite || def.path != layout.Database || def.display != layout.Database ||
		storage.SQLitePath(def.url) != layout.Database {
		t.Errorf("no --database-url: %+v, want the SQLite file in the data dir", def)
	}

	pg, err := resolveDatabase("postgres://u:secret@h:5432/fd?sslmode=disable&password=alsosecret", layout)
	if err != nil {
		t.Fatal(err)
	}
	if pg.backend != storage.Postgres || pg.path != "" || pg.url != "postgres://u:secret@h:5432/fd?sslmode=disable&password=alsosecret" {
		t.Errorf("postgres: %+v", pg)
	}
	if strings.Contains(pg.display, "secret") || !strings.Contains(pg.display, "u:***@h:5432/fd") {
		t.Errorf("postgres display %q must mask every password", pg.display)
	}
	// A URL that does not parse is displayed without its text.
	bad, err := resolveDatabase("postgres://u:s3cret pass@h/db%zz", layout)
	if err != nil || strings.Contains(bad.display, "s3cret") {
		t.Errorf("unparsable postgres URL: display %q, err %v", bad.display, err)
	}

	// A relative SQLite path is resolved once, so the lock file, the
	// start-up block and the storage module name one file.
	t.Chdir(root)
	rel, err := resolveDatabase("sqlite://fd #2.db", layout)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "fd #2.db")
	if rel.backend != storage.SQLite || rel.path != want || rel.display != want || storage.SQLitePath(rel.url) != want {
		t.Errorf("relative sqlite: %+v, want path %q", rel, want)
	}

	if _, err := resolveDatabase("mysql://u@h/fd", layout); err == nil {
		t.Error("a URL of no supported backend must be refused")
	}
	// A database in a directory that does not exist is refused by name.
	missing := filepath.Join(root, "no such dir", "x.db")
	if _, err := resolveDatabase("sqlite://"+missing, layout); err == nil || !strings.Contains(err.Error(), missing) {
		t.Errorf("a database in a missing directory: %v, want an error naming %s", err, missing)
	}
}

// One database reached by different names is one database: a link to
// the file, a link to its directory, a data dir that is itself a link,
// and a link to a file that does not exist yet all resolve to the real
// path, which is what the lock file is named after.
func TestResolveDatabase_ResolvesSymbolicLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	base := realDir(t, t.TempDir())
	realData := filepath.Join(base, "d1")
	if err := os.Mkdir(realData, 0o700); err != nil {
		t.Fatal(err)
	}
	realDB := filepath.Join(realData, datadir.DatabaseFile)
	if err := os.WriteFile(realDB, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := func(target, name string) string {
		t.Helper()
		path := filepath.Join(base, name)
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
		return path
	}
	fileLink := link(realDB, "sym.db")
	dirLink := link(realData, "d1-link")
	chained := link(fileLink, "sym-of-sym.db")
	relative := link(filepath.Join("d1", datadir.DatabaseFile), "relative.db")
	other := datadir.Layout{Root: base, Database: filepath.Join(base, datadir.DatabaseFile)}

	for name, url := range map[string]string{
		"a link to the file":      "sqlite://" + fileLink,
		"a link to its directory": "sqlite://" + filepath.Join(dirLink, datadir.DatabaseFile),
		"a link to a link":        "sqlite://" + chained,
		"a relative link":         "sqlite://" + relative,
		"the real path":           "sqlite://" + realDB,
	} {
		got, err := resolveDatabase(url, other)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if got.path != realDB || storage.SQLitePath(got.url) != realDB || got.display != realDB {
			t.Errorf("%s: %+v, want the real file %s", name, got, realDB)
		}
	}

	// A data dir that is a link: its database is the real one.
	linked := datadir.Layout{Root: dirLink, Database: filepath.Join(dirLink, datadir.DatabaseFile)}
	if got, err := resolveDatabase("", linked); err != nil || got.path != realDB {
		t.Errorf("a linked data dir: %+v, %v; want %s", got, err, realDB)
	}

	// A link to a file that does not exist yet resolves to where SQLite
	// will create it, not to the link.
	fresh := filepath.Join(realData, "fresh.db")
	dangling := link(fresh, "dangling.db")
	if got, err := resolveDatabase("sqlite://"+dangling, other); err != nil || got.path != fresh {
		t.Errorf("a link to a file not yet created: %+v, %v; want %s", got, err, fresh)
	}
	// A link that points at itself is refused, not followed forever.
	loop := filepath.Join(base, "loop.db")
	if err := os.Symlink(loop, loop); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveDatabase("sqlite://"+loop, other); err == nil {
		t.Error("a link to itself was accepted")
	}
}

// Each service's Postgres pool is a connection per processor within
// the process's budget: the three pools, the root pool and the LISTEN
// connections never add up to more than the budget, which is under the
// 97 connections a default Postgres gives to ordinary clients.
func TestPostgresServicePoolConns(t *testing.T) {
	for cpus, want := range map[int]int{1: 4, 2: 4, 4: 4, 8: 8, 16: 16, 24: 24, 25: 25, 32: 25, 64: 25, 256: 25} {
		got := postgresServicePoolConns(cpus)
		if got != want {
			t.Errorf("postgresServicePoolConns(%d) = %d, want %d", cpus, got, want)
		}
		if total := postgresServices*got + postgresRootPoolConns + postgresListenConns; total > postgresConnBudget {
			t.Errorf("%d processors: %d connections in all, over the budget of %d", cpus, total, postgresConnBudget)
		}
	}
	// Postgres' default max_connections less its superuser reserve.
	const defaultClientConns = 100 - 3
	if postgresConnBudget >= defaultClientConns {
		t.Errorf("the budget of %d leaves nothing of a default server's %d for another client", postgresConnBudget, defaultClientConns)
	}
}

func TestInUseMessagesNameTheHolderAndTheRemedy(t *testing.T) {
	held := &datadir.InUseError{Path: "/d/flightdeck.lock", PID: 4242}
	msg := dataDirInUse(held, "/d").Error()
	for _, want := range []string{"data dir /d", "another flightdeck", "pid 4242", "--data-dir"} {
		if !strings.Contains(msg, want) {
			t.Errorf("%q lacks %q", msg, want)
		}
	}
	msg = databaseInUse(&datadir.InUseError{Path: "/d/flightdeck.db.lock"}, "/d/flightdeck.db").Error()
	for _, want := range []string{"SQLite database /d/flightdeck.db", "another flightdeck", "--database-url postgres://"} {
		if !strings.Contains(msg, want) {
			t.Errorf("%q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "pid") {
		t.Errorf("%q names a pid the lock file did not give", msg)
	}
	// Any other lock failure is passed on as it is.
	other := errors.New("open lock file: permission denied")
	if dataDirInUse(other, "/d") != other || databaseInUse(other, "/d/x.db") != other {
		t.Error("an error that is not InUseError must be returned unchanged")
	}
}
