package session

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// fakeStamp records its calls and answers them from a script of
// (revived, applied) pairs; a call past the script's end reports a
// held row.
type fakeStamp struct {
	script [][2]bool
	err    error
	calls  int
}

func (f *fakeStamp) stamp(_ context.Context, _ string, _ int64) (bool, bool, error) {
	f.calls++
	if f.err != nil {
		return false, false, f.err
	}
	if f.calls <= len(f.script) {
		return f.script[f.calls-1][0], f.script[f.calls-1][1], nil
	}
	return false, false, nil
}

// quickDelays keeps a retrying test fast while still pausing between
// attempts.
var quickDelays = []time.Duration{time.Microsecond, time.Microsecond, time.Microsecond}

// captureLogs routes the default logger into a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func TestStampWithRetryStopsOnceApplied(t *testing.T) {
	f := &fakeStamp{script: [][2]bool{{false, false}, {false, true}}}
	if err := stampWithRetry(context.Background(), "s1", 7, quickDelays, f.stamp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.calls != 2 {
		t.Fatalf("stamp called %d times, want 2", f.calls)
	}
}

func TestStampWithRetryGivesUpAfterTheSchedule(t *testing.T) {
	logs := captureLogs(t)
	sampler := stampGiveUps
	stampGiveUps = newGiveUpSampler(time.Now)
	t.Cleanup(func() { stampGiveUps = sampler })

	f := &fakeStamp{}
	if err := stampWithRetry(context.Background(), "s1", 7, quickDelays, f.stamp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := len(quickDelays) + 1; f.calls != want {
		t.Fatalf("stamp called %d times, want %d", f.calls, want)
	}
	if !strings.Contains(logs.String(), "re-attachment stamp not applied") {
		t.Fatalf("give-up was not logged: %q", logs.String())
	}
}

func TestStampWithRetryLogsARevival(t *testing.T) {
	logs := captureLogs(t)
	f := &fakeStamp{script: [][2]bool{{true, true}}}
	if err := stampWithRetry(context.Background(), "s1", 7, quickDelays, f.stamp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(logs.String(), "session revived") {
		t.Fatalf("revival was not logged: %q", logs.String())
	}
}

func TestStampWithRetryReturnsTheStampsError(t *testing.T) {
	boom := errors.New("boom")
	f := &fakeStamp{err: boom}
	if err := stampWithRetry(context.Background(), "s1", 7, quickDelays, f.stamp); !errors.Is(err, boom) {
		t.Fatalf("error = %v, want %v", err, boom)
	}
	if f.calls != 1 {
		t.Fatalf("stamp called %d times, want 1", f.calls)
	}
}

func TestStampWithRetryStopsWhenTheRequestIsOver(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &fakeStamp{}
	// A pause long enough that only the ended context can finish the wait.
	if err := stampWithRetry(ctx, "s1", 7, []time.Duration{time.Hour}, f.stamp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.calls != 1 {
		t.Fatalf("stamp called %d times, want 1", f.calls)
	}
}

func TestGiveUpSamplerLogsOncePerIntervalWithTheSuppressedCount(t *testing.T) {
	logs := captureLogs(t)
	clock := time.Date(2026, time.October, 20, 12, 0, 0, 0, time.UTC)
	sampler := newGiveUpSampler(func() time.Time { return clock })

	sampler.note("s1", 1)
	sampler.note("s2", 2)
	sampler.note("s3", 3)
	if n := strings.Count(logs.String(), "re-attachment stamp not applied"); n != 1 {
		t.Fatalf("%d lines within one interval, want 1: %q", n, logs.String())
	}
	if !strings.Contains(logs.String(), "suppressed_since_last=0") {
		t.Fatalf("first line should report nothing suppressed: %q", logs.String())
	}

	clock = clock.Add(stampLogInterval)
	sampler.note("s4", 4)
	if n := strings.Count(logs.String(), "re-attachment stamp not applied"); n != 2 {
		t.Fatalf("%d lines after the interval, want 2: %q", n, logs.String())
	}
	if !strings.Contains(logs.String(), "suppressed_since_last=2") {
		t.Fatalf("second line should carry the two suppressed notes: %q", logs.String())
	}
	if !strings.Contains(logs.String(), "session_id=s4") {
		t.Fatalf("second line should name the session that triggered it: %q", logs.String())
	}
}
