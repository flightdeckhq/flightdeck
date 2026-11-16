package processor

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// reconcileTestOrphanTimeout is the orphan timeout the reconciler tick
// tests pass. Neither test has a session to reap, so any value does;
// the default's order of magnitude keeps it realistic.
const reconcileTestOrphanTimeout = 24 * time.Hour

// captureDebugLogs routes the default logger, debug lines included,
// into a buffer for the test.
func captureDebugLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

// linesWith returns the lines of logs that contain substr.
func linesWith(logs *bytes.Buffer, substr string) []string {
	var out []string
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

// A stop that lands inside a reconciler tick cuts it short. That is the
// stop, not a failure: nothing is logged as an error, the cut is logged
// at debug level, and the tick ends there instead of running the
// orphan reaper on the ended context. The context has ended before the
// tick starts, so its first statement fails at once.
func TestReconcileOnce_AStopDuringATickIsNotAnError(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		logs := captureDebugLogs(t)
		sp := newTestSessionProcessor(db)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		sp.reconcileOnce(ctx, reconcileTestOrphanTimeout)

		if lines := linesWith(logs, "level=ERROR"); len(lines) != 0 {
			t.Errorf("a stop during a tick logged an error: %q", lines)
		}
		if lines := linesWith(logs, "reconciler tick stopped by the shutdown"); len(lines) != 1 || !strings.Contains(lines[0], "level=DEBUG") {
			t.Errorf("the cut tick is not one debug line: %q", lines)
		}
		if lines := linesWith(logs, "orphan reaper"); len(lines) != 0 {
			t.Errorf("the reaper ran after the stop cut the tick short: %q", lines)
		}
	})
}

// A tick that fails while the worker runs is a real failure: the
// transitions' failure and the reaper's are each logged as an error,
// and the failed transitions do not keep the reaper from running.
func TestReconcileOnce_AFailedTickIsAnError(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		logs := captureDebugLogs(t)
		sp := newTestSessionProcessor(db)
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}

		sp.reconcileOnce(context.Background(), reconcileTestOrphanTimeout)

		for _, msg := range []string{"reconciler error", "orphan reaper error"} {
			lines := linesWith(logs, msg)
			if len(lines) != 1 || !strings.Contains(lines[0], "level=ERROR") {
				t.Errorf("%q on a closed database: %q, want one error line", msg, lines)
			}
		}
		if lines := linesWith(logs, "stopped by the shutdown"); len(lines) != 0 {
			t.Errorf("a failure with the worker running was taken for the stop: %q", lines)
		}
	})
}
