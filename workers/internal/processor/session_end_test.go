package processor

import (
	"context"
	"errors"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// Stream sequences the consumer would stamp on an in-order pair of
// events: the start is published before the end.
const (
	testStartSeq uint64 = 100
	testEndSeq   uint64 = 101
)

// scriptedSession stands in for the sessions table: lookup returns the
// scripted row (or err) and close records the sequence it was given.
type scriptedSession struct {
	row    sessionRow
	err    error
	calls  int
	closed []uint64
}

func (s *scriptedSession) lookup(context.Context, string) (sessionRow, error) {
	s.calls++
	if s.err != nil {
		return sessionRow{}, s.err
	}
	return s.row, nil
}

func (s *scriptedSession) close(_ context.Context, _ string, closedSeq uint64) error {
	s.closed = append(s.closed, closedSeq)
	return nil
}

func (s *scriptedSession) processor() *SessionProcessor {
	return &SessionProcessor{lookupSession: s.lookup, closeSession: s.close}
}

func sessionEndEvent(seq uint64, finalDelivery bool) consumer.EventPayload {
	return consumer.EventPayload{
		SessionID:     "7a3afb1b-232a-4dd8-a2ea-6886224bbb54",
		Flavor:        "test-agent",
		EventType:     "session_end",
		Timestamp:     "2026-10-20T10:51:22Z",
		StreamSeq:     seq,
		FinalDelivery: finalDelivery,
	}
}

func TestHandleSessionEnd_AsksForRedeliveryWhileTheRowIsMissing(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupMissing}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, false))
	if !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("expected ErrRetryLater while the session_start may still land, got %v", err)
	}
	if closed || len(s.closed) != 0 {
		t.Fatalf("nothing must be closed on a missing row")
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 0 {
		t.Fatalf("a retry is not an orphan drop, counter=%d", got)
	}
}

func TestHandleSessionEnd_DropsAnOrphanOnTheFinalDelivery(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupMissing}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, true))
	if !errors.Is(err, ErrEventDropped) {
		t.Fatalf("expected ErrEventDropped for an orphan session_end, got %v", err)
	}
	if closed || len(s.closed) != 0 {
		t.Fatalf("an orphan must not close anything")
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}

func TestHandleSessionEnd_ClosesAnOpenRowWithTheEndsSequence(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupOpen, startSeq: testStartSeq}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, false))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !closed {
		t.Fatalf("expected the session to be reported closed")
	}
	if len(s.closed) != 1 || s.closed[0] != testEndSeq {
		t.Fatalf("expected one close recording sequence %d, got %v", testEndSeq, s.closed)
	}
}

func TestHandleSessionEnd_LeavesARowOpenedAfterThisEndAlone(t *testing.T) {
	metrics.Reset()
	// The row's current run started at a later sequence than this end:
	// the session was re-attached before the earlier run's end arrived.
	s := &scriptedSession{row: sessionRow{state: sessionLookupOpen, startSeq: testEndSeq + 1}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, false))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if closed || len(s.closed) != 0 {
		t.Fatalf("a superseded session_end must not close the live run, closed=%v calls=%v", closed, s.closed)
	}
	if got := metrics.Snapshot()[metrics.ReasonSupersededSessionEnd]; got != 1 {
		t.Fatalf("expected one superseded_session_end drop, got %d", got)
	}
}

func TestHandleSessionEnd_ClosesWhenTheSequencesAreUnknown(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupOpen}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(0, false))
	if err != nil || !closed {
		t.Fatalf("expected a plain close without sequences, closed=%v err=%v", closed, err)
	}
	if len(s.closed) != 1 || s.closed[0] != 0 {
		t.Fatalf("expected one close with an unknown (zero) sequence, got %v", s.closed)
	}
}

func TestHandleSessionEnd_SkipsAnAlreadyClosedRow(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupClosed, startSeq: testStartSeq}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, false))
	if err != nil || closed || len(s.closed) != 0 {
		t.Fatalf("a duplicate session_end must be a no-op, closed=%v err=%v calls=%v", closed, err, s.closed)
	}
	if got := metrics.Snapshot()[metrics.ReasonClosedSessionSkip]; got != 1 {
		t.Fatalf("expected one closed_session_skip, got %d", got)
	}
}

func TestHandleSessionEnd_PropagatesALookupErrorInsteadOfDropping(t *testing.T) {
	metrics.Reset()
	boom := errors.New("connection reset by peer")
	s := &scriptedSession{err: boom}

	_, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(testEndSeq, true))
	if !errors.Is(err, boom) {
		t.Fatalf("expected the lookup error so the consumer NAKs, got %v", err)
	}
	if errors.Is(err, ErrEventDropped) || errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("a database error must read as neither an orphan nor a retry: %v", err)
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
	s := &scriptedSession{row: sessionRow{state: sessionLookupMissing}}
	p := &Processor{session: s.processor()}

	if err := p.Process(context.Background(), sessionEndEvent(testEndSeq, true)); err != nil {
		t.Fatalf("expected a clean ACK (nil) for a dropped session_end, got %v", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}

func TestProcess_PassesARetryRequestToTheConsumer(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{row: sessionRow{state: sessionLookupMissing}}
	p := &Processor{session: s.processor()}

	err := p.Process(context.Background(), sessionEndEvent(testEndSeq, false))
	if !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("expected ErrRetryLater to reach the consumer unchanged, got %v", err)
	}
}
