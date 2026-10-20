package processor

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// scriptedLookup plays back a sequence of lookup states, repeating the
// last one, or fails every call with err. It counts calls so tests can
// assert how long the caller kept polling.
type scriptedLookup struct {
	states []sessionLookup
	err    error
	calls  int
}

func (l *scriptedLookup) lookup(context.Context) (sessionLookup, error) {
	l.calls++
	if l.err != nil {
		return sessionLookupMissing, l.err
	}
	i := l.calls - 1
	if i >= len(l.states) {
		i = len(l.states) - 1
	}
	return l.states[i], nil
}

func (l *scriptedLookup) bySession(ctx context.Context, _ string) (sessionLookup, error) {
	return l.lookup(ctx)
}

func sessionEndEvent() consumer.EventPayload {
	return consumer.EventPayload{
		SessionID: "7a3afb1b-232a-4dd8-a2ea-6886224bbb54",
		Flavor:    "test-agent",
		EventType: "session_end",
		Timestamp: "2026-10-20T10:51:22Z",
	}
}

func TestAwaitSessionRow_ReturnsOnceTheRowAppears(t *testing.T) {
	seq := &scriptedLookup{states: []sessionLookup{
		sessionLookupMissing, sessionLookupMissing, sessionLookupOpen,
	}}

	state, err := awaitSessionRow(context.Background(), seq.lookup, time.Second, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state != sessionLookupOpen {
		t.Fatalf("expected the open row to be reported, got %v", state)
	}
	if seq.calls != 3 {
		t.Fatalf("expected polling to stop at the third lookup, got %d calls", seq.calls)
	}
}

func TestAwaitSessionRow_ReportsMissingOnceTheGraceElapses(t *testing.T) {
	seq := &scriptedLookup{states: []sessionLookup{sessionLookupMissing}}
	const grace = 30 * time.Millisecond

	started := time.Now()
	state, err := awaitSessionRow(context.Background(), seq.lookup, grace, 5*time.Millisecond)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state != sessionLookupMissing {
		t.Fatalf("expected missing after the grace, got %v", state)
	}
	if elapsed < grace {
		t.Fatalf("gave up after %v, before the %v grace elapsed", elapsed, grace)
	}
	if seq.calls < 2 {
		t.Fatalf("expected at least one re-check during the grace, got %d calls", seq.calls)
	}
}

func TestAwaitSessionRow_ReturnsALookupErrorWithoutWaiting(t *testing.T) {
	boom := errors.New("connection reset by peer")
	seq := &scriptedLookup{err: boom}

	_, err := awaitSessionRow(context.Background(), seq.lookup, time.Second, time.Millisecond)
	if !errors.Is(err, boom) {
		t.Fatalf("expected the lookup error to surface, got %v", err)
	}
	if seq.calls != 1 {
		t.Fatalf("expected no retry after a lookup error, got %d calls", seq.calls)
	}
}

func TestAwaitSessionRow_StopsWhenTheContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lookup := func(context.Context) (sessionLookup, error) {
		cancel()
		return sessionLookupMissing, nil
	}

	started := time.Now()
	_, err := awaitSessionRow(ctx, lookup, 10*time.Second, time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("expected a prompt return on cancellation, took %v", elapsed)
	}
}

func TestHandleSessionEnd_DropsAnOrphanOnlyAfterTheGrace(t *testing.T) {
	metrics.Reset()
	seq := &scriptedLookup{states: []sessionLookup{sessionLookupMissing}}
	sp := &SessionProcessor{
		lookupSession:   seq.bySession,
		sessionEndGrace: 20 * time.Millisecond,
		sessionEndPoll:  2 * time.Millisecond,
	}

	err := sp.HandleSessionEnd(context.Background(), sessionEndEvent())
	if !errors.Is(err, ErrEventDropped) {
		t.Fatalf("expected ErrEventDropped for an orphan session_end, got %v", err)
	}
	if seq.calls < 2 {
		t.Fatalf("expected the handler to wait for the session_start, got %d lookups", seq.calls)
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}

func TestHandleSessionEnd_PropagatesALookupErrorInsteadOfDropping(t *testing.T) {
	metrics.Reset()
	boom := errors.New("connection reset by peer")
	seq := &scriptedLookup{err: boom}
	sp := &SessionProcessor{
		lookupSession:   seq.bySession,
		sessionEndGrace: 20 * time.Millisecond,
		sessionEndPoll:  2 * time.Millisecond,
	}

	err := sp.HandleSessionEnd(context.Background(), sessionEndEvent())
	if !errors.Is(err, boom) {
		t.Fatalf("expected the lookup error so the consumer NAKs, got %v", err)
	}
	if errors.Is(err, ErrEventDropped) {
		t.Fatalf("a database error must not read as an orphan: %v", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 0 {
		t.Fatalf("expected no orphan drop on a lookup error, got %d", got)
	}
}

// Process must turn ErrEventDropped into a nil return before it reaches
// the event insert. The processor's writer and pool are nil here, so
// any attempt to insert would panic and fail the test.
func TestProcess_AcksADroppedSessionEndWithoutInsertingIt(t *testing.T) {
	metrics.Reset()
	seq := &scriptedLookup{states: []sessionLookup{sessionLookupMissing}}
	p := &Processor{session: &SessionProcessor{
		lookupSession:   seq.bySession,
		sessionEndGrace: 5 * time.Millisecond,
		sessionEndPoll:  time.Millisecond,
	}}

	if err := p.Process(context.Background(), sessionEndEvent()); err != nil {
		t.Fatalf("expected a clean ACK (nil) for a dropped session_end, got %v", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}
