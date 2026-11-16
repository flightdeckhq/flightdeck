package consumer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// startReturnTimeout bounds how long a test waits for Start to return
// once its context has ended. A fetch in flight when the context ends
// waits out its own MaxWait (nats.DefaultTimeout, two seconds) before
// the loop sees the stop, so ten seconds is margin for a loaded box.
const startReturnTimeout = 10 * time.Second

// streamOnJetStream starts an in-process NATS server with JetStream and
// the FLIGHTDECK stream ingestion creates, and returns a connection to
// it and its JetStream context.
func streamOnJetStream(t *testing.T) (*nats.Conn, nats.JetStreamContext) {
	t.Helper()
	ns, err := server.NewServer(&server.Options{
		DontListen: true, JetStream: true, StoreDir: t.TempDir(), NoSigs: true,
		JetStreamMaxMemory: 64 << 20, JetStreamMaxStore: 256 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(10 * time.Second) {
		t.Fatal("embedded NATS did not start")
	}
	t.Cleanup(ns.Shutdown)
	nc, err := nats.Connect("", nats.InProcessServer(ns))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	js, err := nc.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AddStream(&nats.StreamConfig{Name: streamName, Subjects: []string{subjectAll}}); err != nil {
		t.Fatal(err)
	}
	return nc, js
}

// readyProcessor is a Processor whose StreamReady is scripted: entered
// is closed when it is called, and it returns what ready returns.
type readyProcessor struct {
	entered chan struct{}
	once    sync.Once
	ready   func(ctx context.Context) error
}

func newReadyProcessor(ready func(ctx context.Context) error) *readyProcessor {
	return &readyProcessor{entered: make(chan struct{}), ready: ready}
}

func (p *readyProcessor) Process(context.Context, EventPayload) error { return nil }

func (p *readyProcessor) StreamReady(ctx context.Context, _ uint64) error {
	p.once.Do(func() { close(p.entered) })
	return p.ready(ctx)
}

// startInBackground runs Start on ctx and returns the channel its
// result arrives on.
func startInBackground(ctx context.Context, c *Consumer) <-chan error {
	done := make(chan error, 1)
	go func() { done <- c.Start(ctx) }()
	return done
}

// awaitStart waits for Start's result, failing the test past
// startReturnTimeout.
func awaitStart(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(startReturnTimeout):
		t.Fatalf("Start did not return within %s of its context ending", startReturnTimeout)
		return nil
	}
}

// A stop that comes while the start-up clearing of stale sequences
// runs cuts the clearing short. That is the stop, not a failure:
// nothing is logged as an error, Start returns nil as it does for any
// stop, and the consumer goes no further (it never creates its durable
// consumer or subscribes).
func TestStart_AStopDuringTheSequenceClearingIsNotAnError(t *testing.T) {
	logs := captureLogs(t)
	nc, js := streamOnJetStream(t)
	proc := newReadyProcessor(func(ctx context.Context) error {
		// The writer's statement fails as the database driver fails a
		// statement whose context ends: with the context's error,
		// wrapped.
		<-ctx.Done()
		return fmt.Errorf("clear sequences above 0: %w", ctx.Err())
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := startInBackground(ctx, New(nc, 2, proc))

	select {
	case <-proc.entered:
	case <-time.After(startReturnTimeout):
		t.Fatal("Start never reached the clearing of stale sequences")
	}
	cancel()
	if err := awaitStart(t, done); err != nil {
		t.Fatalf("Start returned %v after a stop during the clearing, want nil", err)
	}

	if lines := logs.lines("level=ERROR"); len(lines) != 0 {
		t.Errorf("a stop during the clearing logged an error: %q", lines)
	}
	if lines := logs.lines("clearing stale session sequences failed"); len(lines) != 0 {
		t.Errorf("a stop during the clearing was logged as a failed clearing: %q", lines)
	}
	if _, err := js.ConsumerInfo(streamName, durableName); !errors.Is(err, nats.ErrConsumerNotFound) {
		t.Errorf("consumer info after the stop: %v, want %v (the consumer went on past the stop)", err, nats.ErrConsumerNotFound)
	}
}

// A clearing that fails while the worker runs is a real failure: it is
// logged as an error, and the consumer goes on to consume (the clearing
// is a safety net, not a precondition). That holds for an error that
// is a cancellation from somewhere other than the consumer's own
// context too: only the consumer's stop is not an error.
func TestStart_AFailedSequenceClearingIsAnErrorAndConsumptionGoesAhead(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"database error", errors.New("clear sequences above 0: database unavailable")},
		{"cancellation not of the consumer's context", fmt.Errorf("clear sequences above 0: %w", context.Canceled)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLogs(t)
			nc, js := streamOnJetStream(t)
			proc := newReadyProcessor(func(context.Context) error { return tc.err })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := startInBackground(ctx, New(nc, 2, proc))

			// Consumption went ahead: the durable consumer exists.
			poll(t, func() bool {
				_, err := js.ConsumerInfo(streamName, durableName)
				return err == nil
			}, "the durable consumer after a failed clearing")
			cancel()
			if err := awaitStart(t, done); err != nil {
				t.Fatalf("Start returned %v, want nil after the stop", err)
			}

			lines := logs.lines("clearing stale session sequences failed")
			if len(lines) != 1 {
				t.Fatalf("%d failed-clearing lines, want 1: %q", len(lines), lines)
			}
			if !strings.Contains(lines[0], "level=ERROR") || !strings.Contains(lines[0], tc.err.Error()) {
				t.Errorf("the failed clearing is not an error line carrying the error: %q", lines[0])
			}
		})
	}
}
