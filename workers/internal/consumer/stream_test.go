package consumer

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// fakeStreamInfo answers StreamInfo from a list of results, one per
// call; past the end it repeats the last one.
type fakeStreamInfo struct {
	results []error
	calls   int
}

func (f *fakeStreamInfo) StreamInfo(string, ...nats.JSOpt) (*nats.StreamInfo, error) {
	i := min(f.calls, len(f.results)-1)
	f.calls++
	if err := f.results[i]; err != nil {
		return nil, err
	}
	return &nats.StreamInfo{State: nats.StreamState{FirstSeq: 7, LastSeq: 42}}, nil
}

// A worker that starts before ingestion waits for the stream and
// returns its info once it exists.
func TestWaitForStreamWaitsUntilTheStreamExists(t *testing.T) {
	f := &fakeStreamInfo{results: []error{nats.ErrStreamNotFound, nats.ErrStreamNotFound, nil}}
	info, err := waitForStream(context.Background(), f, time.Millisecond)
	if err != nil {
		t.Fatalf("waitForStream: %v", err)
	}
	if f.calls != 3 || info.State.LastSeq != 42 {
		t.Errorf("calls %d, last seq %d; want 3 calls and the stream's info", f.calls, info.State.LastSeq)
	}
}

// An error other than a missing stream ends the wait at once.
func TestWaitForStreamReturnsOtherErrors(t *testing.T) {
	f := &fakeStreamInfo{results: []error{nats.ErrJetStreamNotEnabled}}
	if _, err := waitForStream(context.Background(), f, time.Millisecond); !errors.Is(err, nats.ErrJetStreamNotEnabled) {
		t.Fatalf("err = %v, want ErrJetStreamNotEnabled", err)
	}
	if f.calls != 1 {
		t.Errorf("calls %d, want 1", f.calls)
	}
}

// Shutdown during the wait ends it with the context's error.
func TestWaitForStreamStopsWithTheContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &fakeStreamInfo{results: []error{nats.ErrStreamNotFound}}
	if _, err := waitForStream(ctx, f, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestRemovedUndelivered(t *testing.T) {
	for _, tc := range []struct {
		name          string
		existed       bool
		lastDelivered uint64
		firstSeq      uint64
		want          uint64
	}{
		{"caught up, nothing removed", true, 100, 1, 0},
		{"limits removed only delivered messages", true, 100, 101, 0},
		{"limits removed undelivered messages", true, 100, 151, 50},
		{"empty stream after the limits removed everything", true, 100, 251, 150},
		{"new consumer on a trimmed stream", false, 0, 500, 0},
		{"existing consumer never delivered, stream trimmed", true, 0, 11, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := removedUndelivered(tc.existed, tc.lastDelivered, tc.firstSeq); got != tc.want {
				t.Errorf("removedUndelivered(%v, %d, %d) = %d, want %d",
					tc.existed, tc.lastDelivered, tc.firstSeq, got, tc.want)
			}
		})
	}
}

// The waiting lines are INFO until the wait has gone on for
// streamWaitWarnAfter, then WARN.
func TestStreamWaitLevelEscalates(t *testing.T) {
	for waited, want := range map[time.Duration]slog.Level{
		0:                                 slog.LevelInfo,
		time.Minute:                       slog.LevelInfo,
		streamWaitWarnAfter - time.Second: slog.LevelInfo,
		streamWaitWarnAfter:               slog.LevelWarn,
		time.Hour:                         slog.LevelWarn,
	} {
		if got := streamWaitLevel(waited); got != want {
			t.Errorf("streamWaitLevel(%v) = %v, want %v", waited, got, want)
		}
	}
}
