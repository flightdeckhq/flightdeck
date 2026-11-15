package connect

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// The Flightdeck running on this machine: found through a data dir's
// instance file, checked with the health routes, and the server each
// case of `flightdeck connect <agent>` with no --server picks. The
// running Flightdecks are httptest servers on 127.0.0.1 that answer the
// two health routes as the binary does.

// noSuchPID is a process id no process has: above every Linux pid_max
// and, not being a multiple of four, never a Windows process id.
const noSuchPID = 1<<30 - 1

// testAnswers is the probe the tests use: the real health check for
// every server except the default, http://localhost:4000, whose answer is
// defaultAnswers, so a flightdeck the developer runs there changes no
// test.
func testAnswers(defaultAnswers bool) AnswersFunc {
	return func(ctx context.Context, server string) bool {
		if l, ok := parseLocal(server); ok && l.port == defaultPort && l.path == "" {
			return defaultAnswers
		}
		return flightdeckAnswers(ctx, server)
	}
}

// fakeFlightdeck is an HTTP server on 127.0.0.1 that answers the health
// routes as a flightdeck does; it returns the address it listens on.
func fakeFlightdeck(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(fakeFlightdeckHandler())
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().String()
}

// fakeFlightdeckHandler answers the two health routes as a flightdeck.
func fakeFlightdeckHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","service":"api"}`))
	})
	mux.HandleFunc("GET /ingest/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","service":"ingestion"}`))
	})
	return mux
}

// somethingElse is an HTTP server on 127.0.0.1 that answers 200 to every
// request, as a web server that is not a flightdeck may; it returns the
// address and how many requests it got.
func somethingElse(t *testing.T) (string, *atomic.Int64) {
	t.Helper()
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().String(), &requests
}

// silentPort is a port on 127.0.0.1 that nothing listens on now.
func silentPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	return port
}

func portOf(t *testing.T, addr string) string {
	t.Helper()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

// dataDirWith is a data dir whose instance file names listen and pid;
// "" names none.
func dataDirWith(t *testing.T, listen string, pid int) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if listen != "" {
		if err := datadir.WriteInstance(dir, datadir.Instance{Listen: listen, PID: pid}); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestFindRunning(t *testing.T) {
	ctx := context.Background()
	answers := testAnswers(false)
	live := fakeFlightdeck(t)
	t.Run("an instance that runs and answers", func(t *testing.T) {
		dir := dataDirWith(t, live, os.Getpid())
		got, ok := findRunning(ctx, dir, answers)
		if !ok || got.Server != "http://localhost:"+portOf(t, live) || got.Listen != live || got.DataDir != dir {
			t.Fatalf("findRunning = %+v, %v", got, ok)
		}
	})
	t.Run("no data dir at all, and none is created", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "none")
		if _, ok := findRunning(ctx, dir, answers); ok {
			t.Fatal("found an instance in a data dir that does not exist")
		}
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("the data dir was created: %v", err)
		}
	})
	t.Run("a stale file: the process is gone", func(t *testing.T) {
		if _, ok := findRunning(ctx, dataDirWith(t, live, noSuchPID), answers); ok {
			t.Fatal("found the instance of a process that does not run, though its port answers")
		}
	})
	t.Run("a stale file: nothing listens on the port", func(t *testing.T) {
		if _, ok := findRunning(ctx, dataDirWith(t, "127.0.0.1:"+silentPort(t), os.Getpid()), answers); ok {
			t.Fatal("found an instance where nothing answers")
		}
	})
	t.Run("something that is not a flightdeck answers on the port", func(t *testing.T) {
		other, requests := somethingElse(t)
		if _, ok := findRunning(ctx, dataDirWith(t, other, os.Getpid()), answers); ok {
			t.Fatal("took a web server that is not a flightdeck for one")
		}
		if requests.Load() == 0 {
			t.Fatal("the recorded address was not probed")
		}
	})
	t.Run("an address beyond loopback is never followed", func(t *testing.T) {
		// Every address the probe is asked about is recorded: none may be
		// one beyond this machine, and these files name no loopback
		// address at all, so none may be probed.
		var probed []string
		record := func(ctx context.Context, server string) bool {
			probed = append(probed, server)
			return true
		}
		port := portOf(t, live)
		for _, listen := range []string{
			"0.0.0.0:" + port, "[::]:" + port, "10.0.0.5:" + port, "localhost:" + port, "flightdeck.example.com:" + port,
			"127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536", "[::1%lo]:" + port, "http://127.0.0.1:" + port,
		} {
			if _, ok := findRunning(ctx, dataDirWith(t, listen, os.Getpid()), record); ok {
				t.Errorf("followed the instance file to %s", listen)
			}
		}
		if len(probed) != 0 {
			t.Fatalf("probed %q", probed)
		}
	})
}

func TestFlightdeckAnswers_ProbesOnlyThisMachine(t *testing.T) {
	ctx := context.Background()
	live := fakeFlightdeck(t)
	port := portOf(t, live)
	for _, server := range []string{"http://localhost:" + port, "http://127.0.0.1:" + port + "/", "http://LOCALHOST:" + port + "/ingest"} {
		if !flightdeckAnswers(ctx, server) {
			t.Errorf("%s: no answer from the flightdeck there", server)
		}
	}
	other, _ := somethingElse(t)
	for _, server := range []string{"http://" + other, "http://127.0.0.1:" + silentPort(t)} {
		if flightdeckAnswers(ctx, server) {
			t.Errorf("%s answered as a flightdeck", server)
		}
	}
	// No request at all: these are not an http:// server on this machine.
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	t.Cleanup(srv.Close)
	for _, server := range []string{"https://localhost:" + portOf(t, srv.Listener.Addr().String()), "https://flightdeck.example.com", "http://10.0.0.5:4000"} {
		if flightdeckAnswers(ctx, server) {
			t.Errorf("%s answered", server)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("an https:// server on this machine was probed")
	}
}

func TestReportsHere(t *testing.T) {
	cases := []struct {
		server, listen string
		want           bool
	}{
		{"", "127.0.0.1:4000", true},
		{"http://localhost:4000", "127.0.0.1:4000", true},
		{"http://localhost:4100/", "127.0.0.1:4100", true},
		{"http://localhost:4100/ingest", "127.0.0.1:4100", true},
		{"HTTP://LocalHost:4100", "127.0.0.1:4100", true},
		{"http://127.0.0.1:4100", "127.0.0.1:4100", true},
		{"http://[::1]:4100", "[::1]:4100", true},
		{"http://127.0.0.2:4100", "127.0.0.2:4100", true},
		// localhost is 127.0.0.1 alone: a stock system resolves it to no
		// other 127.x address, and often not to ::1, so a plugin saved as
		// localhost does not reach a listener there.
		{"http://localhost:4100", "[::1]:4100", false},
		{"http://localhost:4100", "127.0.0.2:4100", false},
		{"", "127.0.0.2:4000", false},
		{"", "127.0.0.1:4100", false},
		{"http://localhost:4000", "127.0.0.1:4100", false},
		{"http://127.0.0.2:4100", "127.0.0.1:4100", false},
		{"http://[::1]:4100", "127.0.0.1:4100", false},
		{"https://localhost:4100", "127.0.0.1:4100", false},
		{"http://localhost:4100/proxy", "127.0.0.1:4100", false},
		{"https://flightdeck.example.com", "127.0.0.1:4100", false},
	}
	for _, c := range cases {
		if got := reportsHere(c.server, c.listen); got != c.want {
			t.Errorf("reportsHere(%q, %q) = %v, want %v", c.server, c.listen, got, c.want)
		}
	}
}

func TestTheCommandsThatPointAnAgentAndStartAServer(t *testing.T) {
	for server, want := range map[string]string{
		"http://localhost:4100":   "flightdeck connect claude-code --port 4100",
		"http://127.0.0.1:4000":   "flightdeck connect claude-code --port 4000",
		"http://[::1]:4100":       "flightdeck connect claude-code --server http://[::1]:4100",
		"http://127.0.0.2:4100":   "flightdeck connect claude-code --server http://127.0.0.2:4100",
		"https://localhost:4100":  "flightdeck connect claude-code --server https://localhost:4100",
		"http://localhost:8080/x": "flightdeck connect claude-code --server http://localhost:8080/x",
	} {
		if got := connectCommand("claude-code", server); got != want {
			t.Errorf("connectCommand(%q) = %q, want %q", server, got, want)
		}
	}
	for server, want := range map[string]string{
		"":                        "start it with `flightdeck`,",
		"http://localhost:4000/":  "start it with `flightdeck`,",
		"http://localhost:4100":   "start it with `flightdeck --port 4100`,",
		"http://127.0.0.1:4100":   "start it with `flightdeck --port 4100`,",
		"http://[::1]:4100":       "start it with `flightdeck --listen [::1]:4100`,",
		"http://localhost:8080/x": "sessions are recorded once one does",
	} {
		if got := idleNote(server); !strings.Contains(got, want) || !strings.HasPrefix(got, "No Flightdeck answers at ") {
			t.Errorf("idleNote(%q) = %q, want it to say %q", server, got, want)
		}
	}
	for listen, want := range map[string]string{
		"127.0.0.1:4100":        "http://localhost:4100",
		"[::1]:4100":            "http://[::1]:4100",
		"127.0.0.2:4100":        "http://127.0.0.2:4100",
		"[::ffff:127.0.0.1]:41": "http://localhost:41",
	} {
		if got, ok := serverFor(listen); !ok || got != want {
			t.Errorf("serverFor(%q) = %q, %v; want %q", listen, got, ok, want)
		}
	}
}

// The cases of `flightdeck connect claude-code` with no --server.

func TestConnect_ANewConnectionGoesToTheFlightdeckRunningHere(t *testing.T) {
	f := newFakeClaude(t)
	live := fakeFlightdeck(t)
	server := "http://localhost:" + portOf(t, live)
	dir := dataDirWith(t, live, os.Getpid())
	env := map[string]string{"FLIGHTDECK_DATA_DIR": dir}

	r := runMain(t, env, "", false, "claude-code", "--dry-run")
	if r.code != ExitOK || !strings.Contains(r.stdout, "  - save the server "+server+" in the plugin's options") ||
		!strings.Contains(r.stdout, server+" is the Flightdeck running on this machine (data dir "+dir+").") ||
		!strings.Contains(r.stdout, "and sends them to "+server) || strings.Contains(r.stdout, "No Flightdeck answers") {
		t.Fatalf("--dry-run: %+v", r)
	}
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("--dry-run ran %q", got)
	}
	r = runMain(t, env, "", false, "claude-code")
	if r.code != ExitOK || f.read(t, "server") != server || !strings.Contains(r.stdout, "sessions started from now on report to "+server) {
		t.Fatalf("connect: %+v, server saved %q", r, f.read(t, "server"))
	}
	// Without the plan shown (no terminal, --yes, an installer), the
	// closing lines still say where the address came from.
	if want := "sessions already open report once restarted.\n" + server + " is the Flightdeck running on this machine (data dir " + dir + ").\n"; !strings.HasSuffix(r.stdout, want) {
		t.Fatalf("connect's closing lines:\n%s\nwant them to end with\n%s", r.stdout, want)
	}
	// The plugin's default needs no saving: an instance on port 4000.
	t.Run("an instance on the default address", func(t *testing.T) {
		f := newFakeClaude(t)
		defaultServer := func(ctx context.Context, server string) bool {
			return server == "http://127.0.0.1:4000" || testAnswers(true)(ctx, server)
		}
		r := runMainIO(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, "127.0.0.1:4000", os.Getpid())}, defaultServer, "", false, "claude-code")
		if r.code != ExitOK || f.has("server") || strings.Contains(r.stdout, "is the Flightdeck running") {
			t.Fatalf("%+v; want the plugin's default, nothing saved", r)
		}
	})
}

func TestConnect_NothingRunningYet(t *testing.T) {
	t.Run("a new connection, nothing anywhere: connects, and says to start it", func(t *testing.T) {
		f := newFakeClaude(t)
		note := "No Flightdeck answers at http://localhost:4000 yet: start it with `flightdeck`, and sessions are recorded from then on."
		r := runMain(t, nil, "", false, "claude-code", "--dry-run")
		if r.code != ExitOK || strings.Count(r.stdout, note) != 1 || strings.Contains(r.stdout, "save the server") {
			t.Fatalf("--dry-run: %+v", r)
		}
		// The note comes after what the plugin records, right before the
		// question an installer then asks.
		if !strings.HasSuffix(strings.TrimSpace(r.stdout), note) {
			t.Fatalf("the note is not the plan's last line:\n%s", r.stdout)
		}
		r = runMain(t, nil, "", false, "claude-code", "--yes")
		if r.code != ExitOK || !f.has("installed") || !strings.Contains(r.stdout, "Claude Code is connected: ") ||
			!strings.HasSuffix(strings.TrimSpace(r.stdout), note) || r.stderr != "" {
			t.Fatalf("connect: %+v", r)
		}
		// Connected, still nothing running: the line that it is unchanged
		// carries the note too.
		r = runMain(t, nil, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || !strings.Contains(r.stdout, note) {
			t.Fatalf("connect again: %+v", r)
		}
	})
	t.Run("a new connection with a flightdeck on the default address: no note", func(t *testing.T) {
		newFakeClaude(t)
		r := runMainIO(t, nil, testAnswers(true), "", false, "claude-code")
		if r.code != ExitOK || strings.Contains(r.stdout, "No Flightdeck answers") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("connected to another port where nothing runs: kept, with the command for that port", func(t *testing.T) {
		f := newFakeClaude(t)
		port := silentPort(t)
		f.set(t, "marketplace", "installed", "server=http://localhost:"+port)
		r := runMain(t, nil, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || len(f.changes(t)) != 0 ||
			!strings.Contains(r.stdout, "No Flightdeck answers at http://localhost:"+port+" yet: start it with `flightdeck --port "+port+"`") {
			t.Fatalf("%+v, changes %q", r, f.changes(t))
		}
	})
	t.Run("a stale instance file is no instance", func(t *testing.T) {
		f := newFakeClaude(t)
		live := fakeFlightdeck(t)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, noSuchPID)}, "", false, "claude-code")
		if r.code != ExitOK || f.has("server") || !strings.Contains(r.stdout, "No Flightdeck answers at http://localhost:4000 yet") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("something else answers on the recorded port: no instance", func(t *testing.T) {
		f := newFakeClaude(t)
		other, _ := somethingElse(t)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, other, os.Getpid())}, "", false, "claude-code")
		if r.code != ExitOK || f.has("server") || !strings.Contains(r.stdout, "No Flightdeck answers at http://localhost:4000 yet") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("--server on this machine where nothing runs: the note, with --port", func(t *testing.T) {
		f := newFakeClaude(t)
		port := silentPort(t)
		r := runMain(t, nil, "", false, "claude-code", "--server", "http://127.0.0.1:"+port)
		if r.code != ExitOK || f.read(t, "server") != "http://127.0.0.1:"+port ||
			!strings.Contains(r.stdout, "start it with `flightdeck --port "+port+"`") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a server beyond this machine is never probed and has no note", func(t *testing.T) {
		newFakeClaude(t)
		var probed []string
		answers := func(ctx context.Context, server string) bool {
			probed = append(probed, server)
			return testAnswers(false)(ctx, server)
		}
		r := runMainIO(t, map[string]string{"FLIGHTDECK_TOKEN": testToken}, answers, "", false, "claude-code", "--server", "https://flightdeck.example.com")
		if r.code != ExitOK || strings.Contains(r.stdout, "No Flightdeck answers") {
			t.Fatalf("%+v", r)
		}
		for _, p := range probed {
			if strings.Contains(p, "example.com") {
				t.Fatalf("probed %s", p)
			}
		}
	})
}

func TestConnect_AConnectionWhereNothingAnswersIsPointedAtTheFlightdeckRunningHere(t *testing.T) {
	live := fakeFlightdeck(t)
	server := "http://localhost:" + portOf(t, live)
	for name, saved := range map[string]string{
		"the plugin's default":      "",
		"a port saved earlier":      "http://localhost:" + silentPort(t),
		"another loopback spelling": "http://127.0.0.1:" + silentPort(t) + "/ingest",
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeClaude(t)
			f.set(t, "marketplace", "installed")
			if saved != "" {
				f.set(t, "server="+saved)
			}
			dir := dataDirWith(t, live, os.Getpid())
			env := map[string]string{"FLIGHTDECK_DATA_DIR": dir}
			r := runMain(t, env, "", false, "claude-code", "--dry-run")
			why := fmt.Sprintf("Claude Code reports to %s, where no Flightdeck answers; %s is the Flightdeck running on this machine (data dir %s).",
				describeServer(saved), server, dir)
			if r.code != ExitOK || !strings.Contains(r.stdout, "Connect Claude Code to Flightdeck:\n  - save the server "+server+" in the plugin's options\n") ||
				!strings.Contains(r.stdout, why) || len(f.changes(t)) != 0 {
				t.Fatalf("--dry-run: %+v; want the step and %q", r, why)
			}
			// On a terminal it asks, as any plan does, and a no changes nothing.
			if r = runMain(t, env, "n\n", true, "claude-code"); r.code != ExitFailed || !strings.Contains(r.stdout, why) ||
				!strings.Contains(r.stdout, "Continue? [Y/n] ") || f.read(t, "server") != saved {
				t.Fatalf("answered no: %+v", r)
			}
			r = runMain(t, env, "", false, "claude-code", "--yes")
			if r.code != ExitOK || f.read(t, "server") != server || !strings.Contains(r.stdout, "Saved the server "+server) ||
				!strings.HasSuffix(r.stdout, server+" is the Flightdeck running on this machine (data dir "+dir+").\n") {
				t.Fatalf("--yes: %+v, saved %q", r, f.read(t, "server"))
			}
			// Now it reports to the running one: nothing more to change.
			if r = runMain(t, env, "", false, "claude-code"); r.code != ExitOK || !strings.Contains(r.stdout, "already connected") {
				t.Fatalf("again: %+v", r)
			}
		})
	}
	t.Run("a token saved for another server is replaced by the development token", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=http://localhost:"+silentPort(t), "token="+testToken)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code", "--yes")
		if r.code != ExitOK || f.read(t, "server") != server || f.read(t, "token") != DevToken {
			t.Fatalf("%+v, token %q", r, f.read(t, "token"))
		}
	})
}

func TestConnect_AConnectionThatIsADeliberateChoiceIsKept(t *testing.T) {
	live := fakeFlightdeck(t)
	t.Run("a kept server beyond this machine probes nothing", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=https://flightdeck.example.com", "token="+testToken)
		var probed []string
		record := func(ctx context.Context, server string) bool {
			probed = append(probed, server)
			return testAnswers(false)(ctx, server)
		}
		r := runMainIO(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, record, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || len(probed) != 0 {
			t.Fatalf("%+v; probed %q, want nothing: the data dir is not read for a server that is kept", r, probed)
		}
	})
	t.Run("a server beyond this machine", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=https://flightdeck.example.com", "token="+testToken)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || f.read(t, "server") != "https://flightdeck.example.com" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("an https:// address on this machine", func(t *testing.T) {
		f := newFakeClaude(t)
		saved := "https://localhost:" + silentPort(t)
		f.set(t, "marketplace", "installed", "server="+saved)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || f.read(t, "server") != saved ||
			strings.Contains(r.stdout, "No Flightdeck answers") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a loopback address where another flightdeck answers", func(t *testing.T) {
		f := newFakeClaude(t)
		other := "http://localhost:" + portOf(t, fakeFlightdeck(t))
		f.set(t, "marketplace", "installed", "server="+other)
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") || f.read(t, "server") != other {
			t.Fatalf("%+v", r)
		}
	})
}

func TestConnect_Port(t *testing.T) {
	f := newFakeClaude(t)
	live := fakeFlightdeck(t)
	port := portOf(t, live)
	r := runMain(t, nil, "", false, "claude-code", "--port", port)
	if r.code != ExitOK || f.read(t, "server") != "http://localhost:"+port || strings.Contains(r.stdout, "No Flightdeck answers") {
		t.Fatalf("--port: %+v, saved %q", r, f.read(t, "server"))
	}
	// Surrounding white space is dropped, as the server's --port drops it.
	if r = runMain(t, nil, "", false, "claude-code", "--port", " "+port+" "); r.code != ExitOK || !strings.Contains(r.stdout, "already connected") {
		t.Fatalf("--port with spaces: %+v", r)
	}
	// The same server as --server http://localhost:<port>: nothing to do.
	if r = runMain(t, nil, "", false, "claude-code", "--server", "http://localhost:"+port+"/"); r.code != ExitOK || !strings.Contains(r.stdout, "already connected") {
		t.Fatalf("--server for the same address: %+v", r)
	}
	// --port wins over the instance file: it names the server.
	other := fakeFlightdeck(t)
	r = runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, other, os.Getpid())}, "", false, "claude-code", "--port", port)
	if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") {
		t.Fatalf("--port beside an instance file: %+v", r)
	}

	for _, c := range []struct {
		args []string
		says string
	}{
		{[]string{"claude-code", "--port", "4100", "--server", "http://localhost:4100"}, "--port and --server were both given"},
		{[]string{"claude-code", "--port", "0"}, "--port takes a port number from 1 to 65535"},
		{[]string{"claude-code", "--port", "65536"}, "--port takes a port number from 1 to 65535"},
		{[]string{"claude-code", "--port", "4100x"}, "--port takes a port number from 1 to 65535"},
		{[]string{"claude-code", "--port", "-1"}, "--port takes a port number from 1 to 65535"},
		{[]string{"claude-code", "--port", ""}, "--port takes a port number from 1 to 65535"},
		{[]string{"claude-code", "--remove", "--port", "4100"}, "--remove takes no --server, --port or --token-file"},
		{[]string{"--port", "4100"}, "name the agent"},
		{[]string{"claude-code", "--data-dir", ""}, "--data-dir is empty"},
	} {
		f.resetLog(t)
		if r := runMain(t, nil, "", false, c.args...); r.code != ExitUsage || !strings.Contains(r.stderr, c.says) || len(f.changes(t)) != 0 {
			t.Errorf("%v: %+v; want exit 2 and %q", c.args, r, c.says)
		}
	}
}

func TestConnect_DataDirFlag(t *testing.T) {
	f := newFakeClaude(t)
	live := fakeFlightdeck(t)
	server := "http://localhost:" + portOf(t, live)
	// The flag wins over the variable, as it does for the server.
	env := map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, "", 0)}
	r := runMain(t, env, "", false, "claude-code", "--data-dir", dataDirWith(t, live, os.Getpid()))
	if r.code != ExitOK || f.read(t, "server") != server {
		t.Fatalf("%+v, saved %q", r, f.read(t, "server"))
	}
}

func TestList_SaysWhenTheServerDoesNotAnswer(t *testing.T) {
	live := fakeFlightdeck(t)
	livePort := portOf(t, live)
	t.Run("a flightdeck runs here at another address", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed")
		r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false)
		want := "    no answer      no Flightdeck answers there; the one running on this machine is at http://localhost:" + livePort +
			": flightdeck connect claude-code --port " + livePort + "\n"
		if r.code != ExitOK || !strings.Contains(r.stdout, "connected      plugin 0.9.0, reporting to the local server at http://localhost:4000, no token saved\n"+want) {
			t.Fatalf("%+v; want %q", r, want)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("the listing ran %q", got)
		}
	})
	t.Run("nothing runs here", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed")
		r := runMain(t, nil, "", false)
		if r.code != ExitOK || !strings.Contains(r.stdout, "    no answer      no Flightdeck answers at http://localhost:4000 yet: start it with `flightdeck`, and sessions are recorded from then on\n") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("the server answers: no line", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=http://localhost:"+livePort)
		if r := runMain(t, nil, "", false); r.code != ExitOK || strings.Contains(r.stdout, "no answer") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a server beyond this machine: no line", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=https://flightdeck.example.com")
		if r := runMain(t, nil, "", false); r.code != ExitOK || strings.Contains(r.stdout, "no answer") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("--data-dir is the one flag the listing takes", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed")
		r := runMain(t, nil, "", false, "--data-dir", dataDirWith(t, live, os.Getpid()))
		if r.code != ExitOK || !strings.Contains(r.stdout, "flightdeck connect claude-code --port "+livePort) {
			t.Fatalf("%+v", r)
		}
	})
}

// stubConnector is a connector whose answers a test sets, for the
// start-up check's decision table.
type stubConnector struct {
	det       Detection
	detErr    error
	st        Status
	stErr     error
	block     bool // Detect waits for ctx to end
	statusRan atomic.Int64
}

func (s *stubConnector) ID() string   { return "stub-agent" }
func (s *stubConnector) Name() string { return "Stub Agent" }
func (s *stubConnector) Detect(ctx context.Context) (Detection, error) {
	if s.block {
		<-ctx.Done()
		return Detection{Found: true}, ctx.Err()
	}
	return s.det, s.detErr
}
func (s *stubConnector) Status(context.Context) (Status, error) {
	s.statusRan.Add(1)
	return s.st, s.stErr
}
func (s *stubConnector) PlanConnect(context.Context, Target) (Plan, error) { return Plan{}, nil }
func (s *stubConnector) PlanDisconnect(context.Context) (Plan, error)      { return Plan{}, nil }

func TestCheckReporting_OneLineExactlyWhenTheAgentReportsElsewhereOnThisMachine(t *testing.T) {
	found := Detection{Found: true, Path: "/bin/stub", Version: "1.0"}
	connected := func(server string) Status { return Status{Installed: true, Enabled: true, Server: server} }
	cases := []struct {
		name   string
		c      *stubConnector
		listen string
		line   string // "" for none
		errs   int
	}{
		{"not found", &stubConnector{det: Detection{Missing: "no stub"}}, "127.0.0.1:4100", "", 0},
		{"its command does not answer", &stubConnector{det: Detection{Found: true}, detErr: errors.New("boom")}, "127.0.0.1:4100", "", 1},
		{"its status cannot be read", &stubConnector{det: found, stErr: errors.New("boom")}, "127.0.0.1:4100", "", 1},
		{"found, not connected", &stubConnector{det: found, st: Status{}}, "127.0.0.1:4100", "", 0},
		{"installed and turned off", &stubConnector{det: found, st: Status{Installed: true, Server: "http://localhost:4000"}}, "127.0.0.1:4100", "", 0},
		{"connected here, by default", &stubConnector{det: found, st: connected("")}, "127.0.0.1:4000", "", 0},
		{"connected here, by name", &stubConnector{det: found, st: connected("http://127.0.0.1:4100/ingest")}, "127.0.0.1:4100", "", 0},
		{"connected beyond this machine", &stubConnector{det: found, st: connected("https://flightdeck.example.com")}, "127.0.0.1:4100", "", 0},
		{"connected to https:// on this machine", &stubConnector{det: found, st: connected("https://localhost:8443")}, "127.0.0.1:4100", "", 0},
		{"connected to the default, serving on 4100", &stubConnector{det: found, st: connected("")}, "127.0.0.1:4100",
			"Stub Agent reports to http://localhost:4000, not to this server at http://localhost:4100: its sessions are not recorded here. " +
				"To report here, run: flightdeck connect stub-agent --port 4100", 0},
		{"connected to 4100, serving on the default", &stubConnector{det: found, st: connected("http://localhost:4100")}, "127.0.0.1:4000",
			"Stub Agent reports to http://localhost:4100, not to this server at http://localhost:4000: its sessions are not recorded here. " +
				"To report here, run: flightdeck connect stub-agent --port 4000", 0},
		{"serving on ::1", &stubConnector{det: found, st: connected("")}, "[::1]:4100",
			"Stub Agent reports to http://localhost:4000, not to this server at http://[::1]:4100: its sessions are not recorded here. " +
				"To report here, run: flightdeck connect stub-agent --server http://[::1]:4100", 0},
		{"localhost on the port, serving on ::1", &stubConnector{det: found, st: connected("http://localhost:4100")}, "[::1]:4100",
			"Stub Agent reports to http://localhost:4100, not to this server at http://[::1]:4100: its sessions are not recorded here. " +
				"To report here, run: flightdeck connect stub-agent --server http://[::1]:4100", 0},
		{"localhost on the port, serving on 127.0.0.2", &stubConnector{det: found, st: connected("http://localhost:4100")}, "127.0.0.2:4100",
			"Stub Agent reports to http://localhost:4100, not to this server at http://127.0.0.2:4100: its sessions are not recorded here. " +
				"To report here, run: flightdeck connect stub-agent --server http://127.0.0.2:4100", 0},
		{"127.0.0.2 by name, serving there", &stubConnector{det: found, st: connected("http://127.0.0.2:4100")}, "127.0.0.2:4100", "", 0},
		{"a listen address that is not loopback", &stubConnector{det: found, st: connected("")}, "0.0.0.0:4100", "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lines, errs := CheckReporting(context.Background(), Registry{c.c}, c.listen)
			switch {
			case c.line == "" && len(lines) != 0:
				t.Fatalf("lines %q, want none", lines)
			case c.line != "" && (len(lines) != 1 || lines[0] != c.line):
				t.Fatalf("lines %q, want exactly %q", lines, c.line)
			case len(errs) != c.errs:
				t.Fatalf("errors %v, want %d", errs, c.errs)
			}
		})
	}
	t.Run("a listen address beyond loopback asks no agent", func(t *testing.T) {
		c := &stubConnector{det: found, st: connected("")}
		if lines, errs := CheckReporting(context.Background(), Registry{c}, "10.0.0.5:4100"); len(lines)+len(errs) != 0 || c.statusRan.Load() != 0 {
			t.Fatalf("lines %q, errors %v, status read %d times", lines, errs, c.statusRan.Load())
		}
	})
}

func TestCheckReporting_EndsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	blocked := &stubConnector{block: true}
	after := &stubConnector{det: Detection{Found: true}, st: Status{Installed: true, Enabled: true}}
	done := make(chan []string, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		lines, _ := CheckReporting(ctx, Registry{blocked, after}, "127.0.0.1:4100")
		done <- lines
	}()
	cancel()
	select {
	case lines := <-done:
		if len(lines) != 0 || after.statusRan.Load() != 0 {
			t.Fatalf("lines %q, the next agent asked %d times; want the check over", lines, after.statusRan.Load())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the check did not end when cancelled")
	}
	wg.Wait()
}

// The real connector against the stand-in: the check runs the read-only
// commands only.
func TestCheckReporting_ClaudeCode(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed")
	lines, errs := CheckReporting(context.Background(), Registry{newConnector()}, "127.0.0.1:4100")
	if len(errs) != 0 || len(lines) != 1 || !strings.HasSuffix(lines[0], "To report here, run: flightdeck connect claude-code --port 4100") {
		t.Fatalf("lines %q, errors %v", lines, errs)
	}
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("the check ran %q", got)
	}
	f.set(t, "server=http://localhost:4100")
	if lines, errs := CheckReporting(context.Background(), Registry{newConnector()}, "127.0.0.1:4100"); len(lines)+len(errs) != 0 {
		t.Fatalf("connected here: lines %q, errors %v", lines, errs)
	}
}

// A status that cannot be read chooses nothing: the plan reads it too
// and reports why, with its own exit status, and nothing is printed
// about servers.
func TestConnect_AStatusThatCannotBeReadIsThePlansToReport(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed")
	t.Setenv("FAKE_CLAUDE_FAIL", "configure-read")
	live := fakeFlightdeck(t)
	r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code")
	if r.code != ExitFailed || r.stdout != "" || strings.Count(r.stderr, "\n") != 1 ||
		!strings.Contains(r.stderr, "flightdeck connect claude-code: `claude plugin configure flightdeck@flightdeck-plugins --json` failed") {
		t.Fatalf("%+v; want exit 1 and the plan's one line", r)
	}
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("ran %q", got)
	}
}

// listenOn is an HTTP server answering as a flightdeck on addr, or ""
// when this machine cannot listen there (no 127.0.0.2 on macOS, no IPv6
// loopback in some containers).
func listenOn(t *testing.T, addr string) string {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return ""
	}
	srv := httptest.NewUnstartedServer(fakeFlightdeckHandler())
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return ln.Addr().String()
}

// localhost is 127.0.0.1 alone: a Flightdeck on another loopback address
// at the same port is not one a plugin saved as localhost reaches, and
// connect points the plugin at it by its address.
func TestLocalhostIs127001Alone(t *testing.T) {
	for _, host := range []string{"127.0.0.2", "[::1]"} {
		t.Run(host, func(t *testing.T) {
			addr := listenOn(t, host+":0")
			if addr == "" {
				t.Skipf("cannot listen on %s here", host)
			}
			port := portOf(t, addr)
			if ln, err := net.Listen("tcp", "127.0.0.1:"+port); err != nil {
				t.Skipf("127.0.0.1:%s is taken: %v", port, err)
			} else {
				_ = ln.Close()
			}
			if flightdeckAnswers(context.Background(), "http://localhost:"+port) {
				t.Fatalf("localhost:%s answered: the probe left 127.0.0.1", port)
			}
			if !flightdeckAnswers(context.Background(), "http://"+addr) {
				t.Fatalf("%s did not answer by its address", addr)
			}
			f := newFakeClaude(t)
			f.set(t, "marketplace", "installed", "server=http://localhost:"+port)
			dir := dataDirWith(t, addr, os.Getpid())
			r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dir}, "", false, "claude-code", "--yes")
			if want := "http://" + addr; r.code != ExitOK || f.read(t, "server") != want {
				t.Fatalf("%+v, saved %q; want %s", r, f.read(t, "server"), want)
			}
		})
	}
}

func TestProcessAlive(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Fatal("this process is not alive")
	}
	// Out of range: 0 and negatives name process groups, and the larger
	// values wrap in a 32-bit system call to 0, -1 or 1.
	for _, pid := range []int{0, -1, noSuchPID, 4294967296, 4294967295, 8589934593, 2147483648} {
		if processAlive(pid) {
			t.Errorf("processAlive(%d) = true", pid)
		}
	}
	// A process of another user is not this user's instance: init (pid
	// 1) refuses this user's signal unless the tests run as root.
	if runtime.GOOS != "windows" && os.Getuid() != 0 && processAlive(1) {
		t.Error("processAlive(1) = true: a process this user may not signal counts as this user's")
	}
}

// ExecIn runs the command with exactly the environment it is given.
func TestExecIn_TheCommandGetsThatEnvironmentAlone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no env command; the binary test of the check covers the server's use")
	}
	envCmd, err := exec.LookPath("env")
	if err != nil {
		t.Skip("no env command on PATH")
	}
	t.Setenv("FLIGHTDECK_JWT_SECRET", "must-not-pass")
	stdout, _, err := ExecIn([]string{"ONLY=this"})(context.Background(), claudeLocalTimeout, nil, envCmd)
	if err != nil || strings.TrimSpace(string(stdout)) != "ONLY=this" {
		t.Fatalf("env printed %q (%v); want ONLY=this alone", stdout, err)
	}
	// nil is this process's environment, as Exec runs a command.
	stdout, _, err = ExecIn(nil)(context.Background(), claudeLocalTimeout, nil, envCmd)
	if err != nil || !strings.Contains(string(stdout), "FLIGHTDECK_JWT_SECRET=must-not-pass") {
		t.Fatalf("env printed %q (%v); want this process's environment", stdout, err)
	}
}

// An agent too old to show its integration's options: the start-up
// check asks nothing more and says nothing, whatever it reports to.
func TestCheckReporting_AnOutdatedAgentIsNotAsked(t *testing.T) {
	c := &stubConnector{det: Detection{Found: true, Outdated: "too old"}, st: Status{Installed: true, Enabled: true}}
	if lines, errs := CheckReporting(context.Background(), Registry{c}, "127.0.0.1:4100"); len(lines)+len(errs) != 0 || c.statusRan.Load() != 0 {
		t.Fatalf("lines %q, errors %v, status read %d times; want nothing", lines, errs, c.statusRan.Load())
	}
	// The real connector against the stand-in of Claude Code 2.1.283,
	// connected from inside it: the check runs, and nothing but it.
	f := newOldFakeClaude(t)
	f.set(t, "marketplace", "installed")
	if lines, errs := CheckReporting(context.Background(), Registry{newConnector()}, "127.0.0.1:4100"); len(lines)+len(errs) != 0 {
		t.Fatalf("lines %q, errors %v", lines, errs)
	}
	for _, call := range f.calls(t) {
		if strings.HasPrefix(call, "plugin configure "+pluginID) || strings.HasPrefix(call, "plugin list") {
			t.Fatalf("the check ran %q on an outdated Claude Code", call)
		}
	}
}

// A connect that names no server chooses one from the status the plan
// read, once: the status is not read a second time.
func TestConnect_TheServerIsChosenFromThePlansStatus(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed")
	live := fakeFlightdeck(t)
	r := runMain(t, map[string]string{"FLIGHTDECK_DATA_DIR": dataDirWith(t, live, os.Getpid())}, "", false, "claude-code", "--dry-run")
	if r.code != ExitOK || !strings.Contains(r.stdout, "save the server http://localhost:"+portOf(t, live)) {
		t.Fatalf("%+v", r)
	}
	lists, configures := 0, 0
	for _, call := range f.calls(t) {
		switch call {
		case "plugin list --json":
			lists++
		case "plugin configure " + pluginID + " --json":
			configures++
		}
	}
	if lists != 1 || configures != 1 {
		t.Fatalf("the plugin list ran %d times and its options were read %d times; want once each:\n%q", lists, configures, f.calls(t))
	}
}
