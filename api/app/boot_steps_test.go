package app

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// bootStepFailures are the lines Run logs when one of its start-up
// steps fails: the price table's first sync and the ensure of the
// global MCP policy.
var bootStepFailures = []string{
	"pricing table sync at boot failed",
	"ensure global mcp policy at boot failed",
}

// bootStepStops are the debug lines the same steps log when a stop cuts
// them short.
var bootStepStops = []string{
	"pricing table sync at boot stopped by the shutdown",
	"ensure global mcp policy at boot stopped by the shutdown",
}

// logBuffer collects the default logger's output while Run's
// goroutines write to it.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// lines returns the lines that contain substr.
func (b *logBuffer) lines(substr string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, l := range strings.Split(b.buf.String(), "\n") {
		if strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

// captureLogs routes the default logger, debug lines included, into a
// buffer for the test.
func captureLogs(t *testing.T) *logBuffer {
	t.Helper()
	buf := &logBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buf
}

// logPollInterval is how often waitForLine looks at the log again. Run
// logs its start-up steps within milliseconds, so ten milliseconds
// finds the line soon after it is written without a busy loop.
const logPollInterval = 10 * time.Millisecond

// waitForLine waits, within runTimeout, for a line of logs that
// contains substr and returns the first one.
func waitForLine(t *testing.T, logs *logBuffer, substr string) string {
	t.Helper()
	deadline := time.Now().Add(runTimeout)
	for {
		if lines := logs.lines(substr); len(lines) > 0 {
			return lines[0]
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %q line within %s", substr, runTimeout)
		}
		time.Sleep(logPollInterval)
	}
}

// A stop that comes while Run's start-up steps run cuts them short;
// that is the stop, not a failure of theirs, so neither logs one: each
// logs the cut at debug level. The context has ended before Run starts,
// so each step runs on a cancelled context, as it does when the binary
// is stopped right after it starts.
func TestRun_AStopDuringTheBootStepsLogsNoFailure(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		logs := captureLogs(t)
		a, err := New(context.Background(), Config{CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{DB: db})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		if err := awaitRun(t, done); err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
		for _, msg := range bootStepFailures {
			if lines := logs.lines(msg); len(lines) != 0 {
				t.Errorf("a stop during the start-up steps logged a failure: %q", lines)
			}
		}
		for _, msg := range bootStepStops {
			if lines := logs.lines(msg); len(lines) != 1 || !strings.Contains(lines[0], "level=DEBUG") {
				t.Errorf("%q: %q, want one debug line", msg, lines)
			}
		}
	})
}

// A start-up step that fails while the API runs still logs its
// warning: on a database the migrations have not reached, neither the
// price table nor the global MCP policy can be written.
func TestRun_AFailedBootStepIsStillLogged(t *testing.T) {
	logs := captureLogs(t)
	db, err := storage.Open(context.Background(), emptySQLiteURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	a, err := New(context.Background(), Config{CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	for _, msg := range bootStepFailures {
		if line := waitForLine(t, logs, msg); !strings.Contains(line, "level=WARN") {
			t.Errorf("the failed step is not logged as a warning: %q", line)
		}
	}
	if lines := logs.lines("stopped by the shutdown"); len(lines) != 0 {
		t.Errorf("a failure with the API running was taken for the stop: %q", lines)
	}
	cancel()
	if err := awaitRun(t, done); err != nil {
		t.Fatalf("Run returned %v after the stop, want nil", err)
	}
}
