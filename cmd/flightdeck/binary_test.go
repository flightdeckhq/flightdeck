package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/gorilla/websocket"
)

// The tests in this file run the real binary: the test executable
// starts itself as a child with runBinaryEnv set, and TestMain then
// runs main() instead of the tests. Nothing is mocked: the child binds
// a port, creates a data dir, migrates a SQLite file, starts the
// embedded NATS server and the three services, and is stopped with the
// signals an operator sends.

// runBinaryEnv, set to "1" in a child's environment, makes the test
// executable behave as the flightdeck binary.
const runBinaryEnv = "FLIGHTDECK_TEST_RUN_BINARY"

const (
	// startTimeout bounds the wait for a child to answer /api/health.
	// A start migrates an empty SQLite file and starts JetStream, about
	// a second on a laptop; under the race detector on a loaded CI
	// runner the pure-Go SQLite is several times slower, so a minute is
	// margin, not an expectation.
	startTimeout = 60 * time.Second
	// stopTimeout bounds the wait for a child to exit after a signal:
	// the binary's own shutdown budget is 30 s per step, and a healthy
	// stop takes well under a second.
	stopTimeout = 60 * time.Second
	// storeTimeout bounds the wait for posted events to be stored and
	// served, or for a WebSocket frame. Through the embedded bus this
	// is milliseconds; the bound only turns a hang into a failure.
	storeTimeout = 60 * time.Second
	// redeliveryTimeout bounds the wait for events that were queued in
	// a worker lane, delivered but not yet started, when the binary
	// was stopped. They stay unacknowledged; the stream hands them out
	// again once the consumer's acknowledgement wait (30 s) has
	// passed, so the restarted binary stores them up to that long
	// after it starts. Two minutes is the wait plus margin for a slow
	// runner.
	redeliveryTimeout = 120 * time.Second
	// pollInterval is how often a condition is re-checked while waiting.
	pollInterval = 50 * time.Millisecond
	// refusalTimeout bounds how long a second instance may take to
	// exit. It must refuse before it does any work, so a few seconds
	// would do; the bound covers a slow process start under -race.
	refusalTimeout = 30 * time.Second
	// forcedExitTimeout bounds how long the binary may take to end
	// after a second signal. The test holds a request open so that the
	// orderly stop would last the ten seconds of the ingestion read
	// deadline; ending within half of that shows the second signal,
	// not the drain, ended the process.
	forcedExitTimeout = 5 * time.Second
)

func TestMain(m *testing.M) {
	if os.Getenv(runBinaryEnv) == "1" {
		main() // exits the process
		return
	}
	os.Exit(m.Run())
}

func skipWithoutSignals(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("a child process cannot be sent SIGINT on Windows")
	}
}

// tempDir is a temporary directory of the test with its symbolic links
// resolved: the binary names its database by the real path, and a
// system's temp dir can itself be behind a link.
func tempDir(t *testing.T) string {
	t.Helper()
	return realDir(t, t.TempDir())
}

// freePort returns a TCP port nothing listens on right now.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

// lockedBuffer collects a child's output while the test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// child is one running binary.
type child struct {
	cmd  *exec.Cmd
	out  *lockedBuffer
	base string // http://127.0.0.1:<port>
	done chan error
}

// command builds the child's command line. Every FLIGHTDECK_* variable
// of the test's environment is dropped, so a developer's shell cannot
// point the child at another database or data dir.
func command(args ...string) (*exec.Cmd, *lockedBuffer) {
	cmd := exec.Command(os.Args[0], args...)
	env := []string{runBinaryEnv + "=1"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "FLIGHTDECK_") && !strings.HasPrefix(kv, "ENVIRONMENT=") {
			env = append(env, kv)
		}
	}
	cmd.Env = env
	out := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	return cmd, out
}

// start runs the binary on listen with dataDir and waits until it
// serves. The child is killed when the test ends if it is still alive.
func start(t *testing.T, listen, port, dataDir string, extra ...string) *child {
	t.Helper()
	return startWithEnv(t, nil, listen, port, dataDir, extra...)
}

// startWithEnv is start with extra environment variables for the child.
func startWithEnv(t *testing.T, env []string, listen, port, dataDir string, extra ...string) *child {
	t.Helper()
	args := append([]string{"--listen", listen, "--data-dir", dataDir}, extra...)
	cmd, out := command(args...)
	cmd.Env = append(cmd.Env, env...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c := &child{cmd: cmd, out: out, base: "http://127.0.0.1:" + port, done: make(chan error, 1)}
	go func() { c.done <- cmd.Wait() }()
	t.Cleanup(func() {
		select {
		case <-c.done:
		default:
			_ = cmd.Process.Kill()
			<-c.done
		}
	})

	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-c.done:
			c.done <- err
			t.Fatalf("the binary exited before it served (%v):\n%s", err, out.String())
		default:
		}
		if resp, err := http.Get(c.base + "/api/health"); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return c
			}
		}
		time.Sleep(pollInterval)
	}
	t.Fatalf("the binary did not serve within %s:\n%s", startTimeout, out.String())
	return nil
}

// stop sends sig and waits for the exit, returning the wait error.
func (c *child) stop(t *testing.T, sig os.Signal) error {
	t.Helper()
	if err := c.cmd.Process.Signal(sig); err != nil {
		t.Fatalf("signal the binary: %v", err)
	}
	select {
	case err := <-c.done:
		c.done <- err
		return err
	case <-time.After(stopTimeout):
		t.Fatalf("the binary did not exit within %s of %v:\n%s", stopTimeout, sig, c.out.String())
		return nil
	}
}

func (c *child) get(t *testing.T, path, token string, into any) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, c.base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("GET %s: read: %v", path, err)
	}
	if into != nil && resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, into); err != nil {
			t.Fatalf("GET %s: %v in %s", path, err, body)
		}
	}
	return resp.StatusCode
}

// dashboardToken is the token /runtime-config.json hands the dashboard.
func (c *child) dashboardToken(t *testing.T) string {
	t.Helper()
	var cfg struct {
		AccessToken string `json:"access_token"`
	}
	if code := c.get(t, "/runtime-config.json", "", &cfg); code != http.StatusOK || cfg.AccessToken == "" {
		t.Fatalf("/runtime-config.json: status %d, token %q", code, cfg.AccessToken)
	}
	return cfg.AccessToken
}

// postEvent sends one event and requires ingestion to accept it.
func (c *child) postEvent(t *testing.T, token, sessionID, agentID, flavor, eventType string) {
	t.Helper()
	// The event carries an id, as every event of the sensor and the
	// plugin does: the worker drops a redelivered copy of an event it
	// has stored by that id.
	event := map[string]any{
		"id":         newUUID(t),
		"session_id": sessionID, "agent_id": agentID, "agent_name": "binary-test",
		"agent_type": "coding", "client_type": "flightdeck_sensor", "user": "binary-test",
		"hostname": "binary-test-host", "host": "binary-test-host", "flavor": flavor,
		"event_type": eventType, "sensor_version": "0.0.0", "capture_prompts": false,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	}
	switch eventType {
	case "session_start":
		event["context"] = map[string]any{}
	case "post_call":
		event["model"] = "claude-sonnet-4-5"
		event["tokens_input"], event["tokens_output"], event["tokens_total"] = 10, 5, 15
		event["latency_ms"] = 12
	}
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, c.base+"/ingest/v1/events", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /ingest/v1/events: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /ingest/v1/events (%s): %d %s", eventType, resp.StatusCode, msg)
	}
}

// storedEvents is how many events of flavor the query API serves.
func (c *child) storedEvents(t *testing.T, token, flavor string) int {
	t.Helper()
	var page struct {
		Total int `json:"total"`
	}
	path := "/api/v1/events?from=1970-01-01T00:00:00Z&limit=1&flavor=" + flavor
	if code := c.get(t, path, token, &page); code != http.StatusOK {
		t.Fatalf("GET %s: %d", path, code)
	}
	return page.Total
}

// waitFor polls cond until it holds or timeout passes.
func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not within %s", what, timeout)
		}
		time.Sleep(pollInterval)
	}
}

// requireCleanLog fails the test when a child's log reports a locked
// database or an error. A stop is not an error: the worker lanes
// finish what they are processing, so no event is logged as failed.
// (The query API's hub may warn that it could not read a session for a
// broadcast it was building when it was told to stop; nobody is
// connected to receive it by then.)
func requireCleanLog(t *testing.T, out string) {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.Contains(line, "database is locked"), strings.Contains(line, "SQLITE_BUSY"):
			t.Errorf("the log reports a locked database: %s", line)
		case strings.Contains(line, " ERROR "):
			t.Errorf("the log has an error: %s", line)
		}
	}
}

// newUUID returns a random version-4 UUID in the canonical lower-case
// form the ingestion API requires of a session or agent id.
func newUUID(t *testing.T) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// migrationsLockSuffix names the lock file the storage module holds
// while it applies a SQLite database's migrations, beside the database.
const migrationsLockSuffix = ".migrate.lock"

// sqliteFiles lists what is in dataDir whose name starts with the
// database file's name: the database and whatever SQLite keeps beside it.
func sqliteFiles(t *testing.T, dataDir string) map[string]os.FileInfo {
	t.Helper()
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]os.FileInfo{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), datadir.DatabaseFile) {
			info, err := e.Info()
			if err != nil {
				t.Fatal(err)
			}
			out[e.Name()] = info
		}
	}
	return out
}

// The first-run path, then the property a single-file database must
// have: stop the binary with SIGINT while events it has accepted are
// still on their way to the database, start it again on the same data
// dir, and every session, every event and the dashboard token are
// there. The binary runs on every interface so that it mints a real
// token (the loopback mode's development token would be "the same"
// trivially), in a data dir whose name has the characters a URL would
// mangle.
func TestBinary_SQLiteKeepsEverythingAcrossAStopAndARestart(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data dir #1 50% ?x")
	port := freePort(t)
	const flavor = "binary-restart-test"
	const sessions, callsPerSession = 5, 20
	const events = sessions * (1 + callsPerSession)

	first := start(t, ":"+port, port, dataDir)
	token := first.dashboardToken(t)
	if !strings.HasPrefix(token, "ftd_") {
		t.Fatalf("dashboard token %q: a non-loopback start mints an ftd_ token", token)
	}
	banner := first.out.String()
	wantDB := filepath.Join(dataDir, datadir.DatabaseFile)
	if !strings.Contains(banner, "Database    "+wantDB+"   (SQLite)") {
		t.Fatalf("the start-up block does not name the SQLite file %s:\n%s", wantDB, banner)
	}
	if !strings.Contains(banner, "minted now") {
		t.Fatalf("the first start did not announce the token it minted:\n%s", banner)
	}
	if code := first.get(t, "/api/v1/fleet", "tok_dev", nil); code != http.StatusUnauthorized {
		t.Fatalf("the development token on a non-loopback start: %d, want 401", code)
	}
	files := sqliteFiles(t, dataDir)
	for name, info := range files {
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s has mode %04o, want 0600", name, info.Mode().Perm())
		}
	}
	if _, ok := files[datadir.DatabaseFile]; !ok {
		t.Fatalf("no %s in the data dir: %v", datadir.DatabaseFile, files)
	}

	ids := make([]string, sessions)
	for i := range ids {
		ids[i] = newUUID(t)
		agent := newUUID(t)
		first.postEvent(t, token, ids[i], agent, flavor, "session_start")
		for range callsPerSession {
			first.postEvent(t, token, ids[i], agent, flavor, "post_call")
		}
	}
	// No wait here: the stop races the workers on purpose.
	if err := first.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, first.out.String())
	}

	// A clean stop leaves one database file: the write-ahead log was
	// checkpointed into it and removed with its shared-memory file.
	// Beside it stay the two lock files, the instance's and the
	// migrations' (storage's <database>.migrate.lock): a lock file is
	// never removed, since a process that opened it to wait would then
	// hold its lock on a file a newcomer no longer finds.
	files = sqliteFiles(t, dataDir)
	for name := range files {
		switch name {
		case datadir.DatabaseFile, datadir.DatabaseFile + lockSuffix, datadir.DatabaseFile + migrationsLockSuffix:
		default:
			t.Errorf("%s is left beside the database after a clean stop", name)
		}
	}
	if info := files[datadir.DatabaseFile+migrationsLockSuffix]; info != nil && runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("%s has mode %04o, want 0600", datadir.DatabaseFile+migrationsLockSuffix, info.Mode().Perm())
	}
	if files[datadir.DatabaseFile] == nil || files[datadir.DatabaseFile].Size() == 0 {
		t.Fatalf("the database file is missing or empty after the stop: %v", files)
	}

	second := start(t, ":"+port, port, dataDir)
	if got := second.dashboardToken(t); got != token {
		t.Fatalf("the restart serves dashboard token %q, want the first start's %q", got, token)
	}
	if strings.Contains(second.out.String(), "minted now") {
		t.Fatalf("the restart minted a new token:\n%s", second.out.String())
	}
	// Events accepted before the stop and not yet stored are still in
	// the stream; the restarted workers store them, each exactly once,
	// including the ones whose processing the stop interrupted.
	var stored int
	waitFor(t, fmt.Sprintf("%d events stored after the restart", events), redeliveryTimeout, func() bool {
		stored = second.storedEvents(t, token, flavor)
		return stored >= events
	})
	if stored != events {
		t.Fatalf("%d events stored, want exactly %d (an event was stored twice)", stored, events)
	}
	for _, id := range ids {
		var detail struct {
			Session struct {
				SessionID  string `json:"session_id"`
				TokensUsed int    `json:"tokens_used"`
			} `json:"session"`
		}
		if code := second.get(t, "/api/v1/sessions/"+id, token, &detail); code != http.StatusOK {
			t.Fatalf("session %s after the restart: %d", id, code)
		}
		if want := callsPerSession * 15; detail.Session.SessionID != id || detail.Session.TokensUsed != want {
			t.Errorf("session %s: %+v, want tokens_used %d", id, detail.Session, want)
		}
	}
	if err := second.stop(t, syscall.SIGTERM); err != nil {
		t.Fatalf("exit after SIGTERM: %v\n%s", err, second.out.String())
	}
	requireCleanLog(t, first.out.String())
	requireCleanLog(t, second.out.String())
}

// A process that is killed (no shutdown at all) leaves its lock files
// and SQLite's write-ahead log behind. The next start takes the locks,
// which died with the process, and SQLite recovers the log: what was
// stored before the kill is served.
func TestBinary_SQLiteRecoversAfterAKill(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data")
	port := freePort(t)
	const flavor = "binary-kill-test"

	first := start(t, "127.0.0.1:"+port, port, dataDir)
	token := first.dashboardToken(t)
	if token != "tok_dev" {
		t.Fatalf("a loopback start serves token %q, want the development token", token)
	}
	sid, agent := newUUID(t), newUUID(t)
	first.postEvent(t, token, sid, agent, flavor, "session_start")
	first.postEvent(t, token, sid, agent, flavor, "post_call")
	waitFor(t, "both events stored", storeTimeout, func() bool { return first.storedEvents(t, token, flavor) == 2 })

	if err := first.stop(t, syscall.SIGKILL); err == nil {
		t.Fatal("a killed process reported a clean exit")
	}
	if _, err := os.Stat(filepath.Join(dataDir, datadir.LockFile)); err != nil {
		t.Fatalf("the lock file should outlive the process: %v", err)
	}

	second := start(t, "127.0.0.1:"+port, port, dataDir)
	if got := second.storedEvents(t, token, flavor); got != 2 {
		t.Fatalf("%d events after the kill and the restart, want 2", got)
	}
	if code := second.get(t, "/api/v1/sessions/"+sid, token, nil); code != http.StatusOK {
		t.Fatalf("the session after the kill and the restart: %d", code)
	}
	if err := second.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, second.out.String())
	}
	requireCleanLog(t, second.out.String())
}

// refused runs a second binary that must exit non-zero on its own,
// and returns what it printed.
func refused(t *testing.T, args ...string) string {
	t.Helper()
	cmd, out := command(args...)
	ctx, cancel := context.WithTimeout(context.Background(), refusalTimeout)
	defer cancel()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("flightdeck %v exited 0, want a refusal:\n%s", args, out.String())
		}
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("flightdeck %v was still running after %s; it must refuse at once:\n%s", args, refusalTimeout, out.String())
	}
	return out.String()
}

// One process per data dir and per SQLite file. The default case is
// stopped by the port; with another --listen the lock files refuse, and
// the message names what is in use and who holds it.
func TestBinary_ASecondInstanceIsRefused(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data")
	port := freePort(t)
	first := start(t, "127.0.0.1:"+port, port, dataDir)
	holder := fmt.Sprintf("pid %d", first.cmd.Process.Pid)

	// Same port: the listener refuses, before the data dir is touched.
	out := refused(t, "--listen", "127.0.0.1:"+port, "--data-dir", dataDir)
	if !strings.Contains(out, "already in use") || !strings.Contains(out, "--listen") {
		t.Errorf("same port: %q", out)
	}

	// Another port, same data dir: the data dir's lock refuses.
	out = refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", dataDir)
	for _, want := range []string{"data dir " + dataDir, "in use by another flightdeck", holder, "--data-dir"} {
		if !strings.Contains(out, want) {
			t.Errorf("same data dir: %q lacks %q", out, want)
		}
	}

	// Another port and another data dir, the same SQLite file: the
	// database's lock refuses.
	dbPath := filepath.Join(dataDir, datadir.DatabaseFile)
	out = refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", filepath.Join(tempDir(t), "other"),
		"--database-url", "sqlite://"+dbPath)
	for _, want := range []string{"SQLite database " + dbPath, "in use by another flightdeck", holder} {
		if !strings.Contains(out, want) {
			t.Errorf("same SQLite file: %q lacks %q", out, want)
		}
	}

	// The first instance never noticed.
	if code := first.get(t, "/api/v1/fleet", "tok_dev", nil); code != http.StatusOK {
		t.Fatalf("the first instance answers %d after the refusals", code)
	}
	if err := first.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, first.out.String())
	}
	// Once it is gone the data dir can be served again, on another port.
	port2 := freePort(t)
	again := start(t, "127.0.0.1:"+port2, port2, dataDir)
	if err := again.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, again.out.String())
	}
}

// The lock on a SQLite file follows the file, not the name it was
// reached by: a second instance that names the running instance's
// database through a symbolic link, from a data dir of its own, is
// refused like one that names it directly.
func TestBinary_ASecondInstanceThroughASymbolicLinkIsRefused(t *testing.T) {
	skipWithoutSignals(t)
	base := tempDir(t)
	dataDir := filepath.Join(base, "d1")
	port := freePort(t)
	first := start(t, "127.0.0.1:"+port, port, dataDir)
	realDB := filepath.Join(dataDir, datadir.DatabaseFile)
	link := filepath.Join(base, "sym.db")
	if err := os.Symlink(realDB, link); err != nil {
		t.Fatal(err)
	}
	out := refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", filepath.Join(base, "d2"),
		"--database-url", "sqlite://"+link)
	for _, want := range []string{"SQLite database " + realDB, "in use by another flightdeck", fmt.Sprintf("pid %d", first.cmd.Process.Pid)} {
		if !strings.Contains(out, want) {
			t.Errorf("a second instance through a link: %q lacks %q", out, want)
		}
	}
	// A data dir that is a link to the running instance's is refused
	// by the data dir's own lock.
	dirLink := filepath.Join(base, "d1-link")
	if err := os.Symlink(dataDir, dirLink); err != nil {
		t.Fatal(err)
	}
	out = refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", dirLink)
	if !strings.Contains(out, "in use by another flightdeck") {
		t.Errorf("a second instance on a link to the data dir: %q", out)
	}
	if err := first.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, first.out.String())
	}
}

// The first signal starts the orderly stop, which waits for the
// requests in flight; a second signal ends the process at once. The
// test holds a request open (headers sent, body never finished) so the
// stop has something to wait for, and the data survives the forced
// exit as it survives a kill.
func TestBinary_ASecondSignalEndsASlowStop(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data")
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, dataDir)
	sid := newUUID(t)
	c.postEvent(t, "tok_dev", sid, newUUID(t), "binary-second-signal-test", "session_start")
	waitFor(t, "the event stored", storeTimeout, func() bool {
		return c.storedEvents(t, "tok_dev", "binary-second-signal-test") == 1
	})

	conn, err := net.Dial("tcp", "127.0.0.1:"+port)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := fmt.Fprint(conn, "POST /ingest/v1/events HTTP/1.1\r\nHost: localhost\r\n"+
		"Authorization: Bearer tok_dev\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{\"session_id\":"); err != nil {
		t.Fatal(err)
	}

	if err := c.cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the notice that a second signal forces the exit", stopTimeout, func() bool {
		return strings.Contains(c.out.String(), "a second Ctrl+C or signal ends the process at once")
	})
	select {
	case err := <-c.done:
		c.done <- err
		t.Fatalf("the binary exited (%v) while a request was still open; the stop was not slow:\n%s", err, c.out.String())
	default:
	}
	second := time.Now()
	if err := c.cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-c.done:
		c.done <- err
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("exit after the second signal: %v, want the process ended by the signal", err)
		}
		if status, ok := exit.Sys().(syscall.WaitStatus); !ok || !status.Signaled() || status.Signal() != syscall.SIGINT {
			t.Fatalf("exit after the second signal: %v, want ended by SIGINT", err)
		}
	case <-time.After(forcedExitTimeout):
		t.Fatalf("the binary was still running %s after the second signal:\n%s", time.Since(second), c.out.String())
	}

	// What was stored before the forced exit is served by the next start.
	again := start(t, "127.0.0.1:"+port, port, dataDir)
	if got := again.storedEvents(t, "tok_dev", "binary-second-signal-test"); got != 1 {
		t.Fatalf("%d events after the forced exit and a restart, want 1", got)
	}
	if err := again.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, again.out.String())
	}
}

// The dashboard's live feed on SQLite: the workers publish a session
// change on the storage bus, the query API's hub hears it and pushes a
// frame to the WebSocket. That only works when the two services share
// one in-process bus, which the binary injects.
func TestBinary_FleetFeedReachesTheWebSocketOnSQLite(t *testing.T) {
	skipWithoutSignals(t)
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, filepath.Join(tempDir(t), "data"))

	ws, resp, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:"+port+"/api/v1/stream?token=tok_dev", nil)
	if err != nil {
		t.Fatalf("WebSocket upgrade: %v (response %v)", err, resp)
	}
	defer func() { _ = ws.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade answered %d", resp.StatusCode)
	}

	sid := newUUID(t)
	c.postEvent(t, "tok_dev", sid, newUUID(t), "binary-ws-test", "session_start")
	if err := ws.SetReadDeadline(time.Now().Add(storeTimeout)); err != nil {
		t.Fatal(err)
	}
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("no fleet frame for session %s within %s: %v", sid, storeTimeout, err)
		}
		var frame struct {
			Type    string `json:"type"`
			Session struct {
				SessionID string `json:"session_id"`
			} `json:"session"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			t.Fatalf("frame %s: %v", msg, err)
		}
		if frame.Session.SessionID == sid {
			if frame.Type != "session_start" {
				t.Fatalf("frame type %q for the new session, want session_start", frame.Type)
			}
			break
		}
	}
	if err := c.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, c.out.String())
	}
}

// The query API's contract is RFC 3339 in UTC, and it formats the
// timestamps it reads in the process's zone, so the binary makes that
// zone UTC at start. Run on a host in another zone (TZ in the child's
// environment), every timestamp it serves still ends in Z.
func TestBinary_TimestampsAreUTCWhateverTheHostZone(t *testing.T) {
	skipWithoutSignals(t)
	if _, err := time.LoadLocation("Asia/Jerusalem"); err != nil {
		t.Skip("no zone database on this host")
	}
	port := freePort(t)
	c := startWithEnv(t, []string{"TZ=Asia/Jerusalem"}, "127.0.0.1:"+port, port, filepath.Join(tempDir(t), "data"))
	sid := newUUID(t)
	c.postEvent(t, "tok_dev", sid, newUUID(t), "binary-utc-test", "session_start")
	var detail struct {
		Session struct {
			StartedAt  string `json:"started_at"`
			LastSeenAt string `json:"last_seen_at"`
		} `json:"session"`
		Events []struct {
			OccurredAt string `json:"occurred_at"`
		} `json:"events"`
	}
	waitFor(t, "the session stored", storeTimeout, func() bool {
		return c.get(t, "/api/v1/sessions/"+sid, "tok_dev", &detail) == http.StatusOK && len(detail.Events) == 1
	})
	for name, ts := range map[string]string{
		"started_at": detail.Session.StartedAt, "last_seen_at": detail.Session.LastSeenAt, "occurred_at": detail.Events[0].OccurredAt,
	} {
		parsed, err := time.Parse(time.RFC3339Nano, ts)
		if err != nil || !strings.HasSuffix(ts, "Z") {
			t.Errorf("%s = %q (%v), want RFC 3339 with a Z suffix", name, ts, err)
			continue
		}
		// The instant is now, not now shifted by the zone's offset.
		if d := time.Since(parsed); d < -time.Minute || d > storeTimeout+time.Minute {
			t.Errorf("%s = %q is %s away from now", name, ts, d)
		}
	}
	if err := c.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, c.out.String())
	}
}

// A Postgres that does not answer yet is waited for (it may be starting
// beside the binary), and a signal ends the wait at once. Port 1 is
// reserved and refuses every connection, so no Postgres is needed.
func TestBinary_WaitsForAnUnreachableDatabaseUntilASignal(t *testing.T) {
	skipWithoutSignals(t)
	cmd, out := command("--listen", "127.0.0.1:"+freePort(t), "--data-dir", filepath.Join(tempDir(t), "data"),
		"--database-url", "postgres://u:p@127.0.0.1:1/x?sslmode=disable&connect_timeout=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		select {
		case <-done:
		default:
			_ = cmd.Process.Kill()
			<-done
		}
	})
	exited := false
	waitFor(t, "a retry of the unreachable database", startTimeout, func() bool {
		select {
		case err := <-done:
			done <- err
			exited = true
			return true
		default:
		}
		return strings.Contains(out.String(), "database not reachable, retrying")
	})
	if exited {
		t.Fatalf("the binary gave up on a refused connection without waiting:\n%s", out.String())
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		done <- err
		if err == nil {
			t.Fatalf("a start that never reached its database exited 0:\n%s", out.String())
		}
	case <-time.After(refusalTimeout):
		t.Fatalf("the binary kept waiting for the database after SIGINT:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "postgres://u:***@127.0.0.1:1/x") {
		t.Errorf("the error does not name the database with its password masked:\n%s", out.String())
	}
}

// A database URL that waiting cannot fix ends the start at once, and
// the message never repeats the password: here a URL that does not
// parse because the password holds a reserved character.
func TestBinary_AnUnparsablePostgresURLIsRefusedWithoutItsPassword(t *testing.T) {
	skipWithoutSignals(t)
	out := refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", filepath.Join(tempDir(t), "data"),
		"--database-url", "postgres://flightdeck:s3cret pass@localhost:5432/db%zz")
	if strings.Contains(out, "s3cret") {
		t.Errorf("the output repeats the password: %s", out)
	}
	if !strings.Contains(out, "does not parse") || !strings.Contains(out, "percent-encode") {
		t.Errorf("the output does not say what is wrong with the URL: %s", out)
	}
}

// An explicit sqlite:// URL is served from that file, relative paths
// included, and the data dir then holds no database of its own.
func TestBinary_ExplicitSQLiteURL(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data")
	dbDir := filepath.Join(tempDir(t), "db dir")
	if err := os.Mkdir(dbDir, 0o700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dbDir, "custom.db")
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, dataDir, "--database-url", "sqlite://"+dbPath)
	if !strings.Contains(c.out.String(), "Database    "+dbPath+"   (SQLite)") {
		t.Fatalf("the start-up block does not name %s:\n%s", dbPath, c.out.String())
	}
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("the database is not at the path the URL names: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, datadir.DatabaseFile)); !os.IsNotExist(err) {
		t.Fatalf("a database was also created in the data dir (stat: %v)", err)
	}
	if err := c.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("exit after SIGINT: %v\n%s", err, c.out.String())
	}

	// A SQLite file in a directory that does not exist is refused with
	// the path, not with SQLite's "unable to open database file".
	missing := filepath.Join(tempDir(t), "no such dir", "x.db")
	out := refused(t, "--listen", "127.0.0.1:"+freePort(t), "--data-dir", filepath.Join(tempDir(t), "d2"),
		"--database-url", "sqlite://"+missing)
	if !strings.Contains(out, missing) {
		t.Errorf("a database in a missing directory: %q does not name %s", out, missing)
	}
}
