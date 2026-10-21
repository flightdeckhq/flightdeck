package processor

import (
	"context"
	"errors"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// The stream sequence the consumer would stamp on the session_end.
const testEndSeq uint64 = 101

// scriptedSession stands in for the sessions table: settle answers with
// the scripted (applied, closedNow) pair, or with the next pair of
// settleSeq when set, and records the sequence it was given; lookup
// answers with the scripted state. Either can fail.
type scriptedSession struct {
	applied   bool
	closedNow bool
	settleSeq [][2]bool
	state     sessionLookup
	settleErr error
	lookupErr error
	settled   []uint64
	lookups   int
}

func (s *scriptedSession) settle(_ context.Context, _ string, closedSeq uint64) (bool, bool, error) {
	s.settled = append(s.settled, closedSeq)
	if s.settleErr != nil {
		return false, false, s.settleErr
	}
	if n := len(s.settled) - 1; n < len(s.settleSeq) {
		return s.settleSeq[n][0], s.settleSeq[n][1], nil
	}
	return s.applied, s.closedNow, nil
}

func (s *scriptedSession) lookup(context.Context, string) (sessionLookup, error) {
	s.lookups++
	if s.lookupErr != nil {
		return sessionLookupMissing, s.lookupErr
	}
	return s.state, nil
}

func (s *scriptedSession) processor() *SessionProcessor {
	return &SessionProcessor{lookupSession: s.lookup, settleEnd: s.settle}
}

func sessionEndEvent(finalDelivery bool) consumer.EventPayload {
	return consumer.EventPayload{
		SessionID:     "7a3afb1b-232a-4dd8-a2ea-6886224bbb54",
		Flavor:        "test-agent",
		EventType:     "session_end",
		Timestamp:     "2026-10-20T10:51:22Z",
		StreamSeq:     testEndSeq,
		FinalDelivery: finalDelivery,
	}
}

func TestHandleSessionEnd_ClosesAnOpenRowWithTheEndsSequence(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{applied: true, closedNow: true}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || !closed {
		t.Fatalf("expected the session to be reported closed, closed=%v err=%v", closed, err)
	}
	if len(s.settled) != 1 || s.settled[0] != testEndSeq {
		t.Fatalf("expected one settle with sequence %d, got %v", testEndSeq, s.settled)
	}
	if s.lookups != 0 {
		t.Fatalf("a settled end needs no extra read, got %d lookups", s.lookups)
	}
}

func TestHandleSessionEnd_SkipsAnAlreadyClosedRow(t *testing.T) {
	metrics.Reset()
	// The statement matched (the row is closed and may have taken this
	// end's greater sequence) but closed nothing now.
	s := &scriptedSession{applied: true, closedNow: false}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || closed {
		t.Fatalf("a duplicate session_end must be a no-op, closed=%v err=%v", closed, err)
	}
	if got := metrics.Snapshot()[metrics.ReasonClosedSessionSkip]; got != 1 {
		t.Fatalf("expected one closed_session_skip, got %d", got)
	}
}

func TestHandleSessionEnd_SkipsADuplicateEndThatMatchedNothing(t *testing.T) {
	metrics.Reset()
	// The statement matches nothing, twice (the row is closed by this
	// end or a later one, so no write is needed), and the read shows it
	// closed: a duplicate, not a superseded end.
	s := &scriptedSession{state: sessionLookupClosed}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || closed {
		t.Fatalf("a duplicate session_end must be a no-op, closed=%v err=%v", closed, err)
	}
	if len(s.settled) != 2 || s.lookups != 2 {
		t.Fatalf("expected a second attempt before the duplicate verdict, got settles=%d lookups=%d", len(s.settled), s.lookups)
	}
	if got := metrics.Snapshot()[metrics.ReasonClosedSessionSkip]; got != 1 {
		t.Fatalf("expected one closed_session_skip, got %d", got)
	}
	if got := metrics.Snapshot()[metrics.ReasonSupersededSessionEnd]; got != 0 {
		t.Fatalf("a duplicate is not a superseded end, counter=%d", got)
	}
}

func TestHandleSessionEnd_RecordsALaterEndOnARowClosedAfterTheFirstAttempt(t *testing.T) {
	metrics.Reset()
	// The first statement ran against a row that did not exist yet;
	// other goroutines created and closed it before the read. The second
	// attempt must still match, so this later end leaves its sequence on
	// the row (applied without closing it now).
	s := &scriptedSession{state: sessionLookupClosed, settleSeq: [][2]bool{{false, false}, {true, false}}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || closed {
		t.Fatalf("expected a no-close duplicate verdict, closed=%v err=%v", closed, err)
	}
	if len(s.settled) != 2 {
		t.Fatalf("expected the second attempt to run against the closed row, got %d settles", len(s.settled))
	}
	if got := metrics.Snapshot()[metrics.ReasonSupersededSessionEnd]; got != 0 {
		t.Fatalf("a later end is not a superseded end, counter=%d", got)
	}
}

func TestHandleSessionEnd_AsksForRedeliveryWhileTheRowIsMissing(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{state: sessionLookupMissing}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("expected ErrRetryLater while the session_start may still land, got %v", err)
	}
	if closed {
		t.Fatalf("nothing must be closed on a missing row")
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 0 {
		t.Fatalf("a retry is not an orphan drop, counter=%d", got)
	}
}

func TestHandleSessionEnd_DropsAnOrphanOnTheFinalDelivery(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{state: sessionLookupMissing}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(true))
	if !errors.Is(err, ErrEventDropped) {
		t.Fatalf("expected ErrEventDropped for an orphan session_end, got %v", err)
	}
	if closed {
		t.Fatalf("an orphan must not close anything")
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}

func TestHandleSessionEnd_LeavesARowOpenedAfterThisEndAlone(t *testing.T) {
	metrics.Reset()
	// The statement matches nothing, twice, while the row is there: its
	// current run began at a later sequence than this end (the session
	// was re-attached before the earlier run's end arrived).
	s := &scriptedSession{state: sessionLookupOpen}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || closed {
		t.Fatalf("a superseded session_end must not close the live run, closed=%v err=%v", closed, err)
	}
	if len(s.settled) != 2 || s.lookups != 2 {
		t.Fatalf("expected a second attempt once the row was seen, got settles=%d lookups=%d", len(s.settled), s.lookups)
	}
	if got := metrics.Snapshot()[metrics.ReasonSupersededSessionEnd]; got != 1 {
		t.Fatalf("expected one superseded_session_end drop, got %d", got)
	}
}

func TestHandleSessionEnd_ClosesARowThatAppearedAfterTheFirstAttempt(t *testing.T) {
	metrics.Reset()
	// The first statement found no row; by the time of the read another
	// goroutine had created it, and the second attempt closes it.
	s := &scriptedSession{state: sessionLookupOpen, settleSeq: [][2]bool{{false, false}, {true, true}}}

	closed, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(false))
	if err != nil || !closed {
		t.Fatalf("expected the second attempt to close the row, closed=%v err=%v", closed, err)
	}
	if got := metrics.Snapshot()[metrics.ReasonSupersededSessionEnd]; got != 0 {
		t.Fatalf("a row that appeared late is not a superseded end, counter=%d", got)
	}
}

func TestHandleSessionEnd_PropagatesASettleError(t *testing.T) {
	metrics.Reset()
	boom := errors.New("connection reset by peer")
	s := &scriptedSession{settleErr: boom}

	_, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(true))
	if !errors.Is(err, boom) {
		t.Fatalf("expected the database error so the consumer NAKs, got %v", err)
	}
	if errors.Is(err, ErrEventDropped) || errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("a database error must read as neither an orphan nor a retry: %v", err)
	}
}

func TestHandleSessionEnd_PropagatesALookupError(t *testing.T) {
	metrics.Reset()
	boom := errors.New("connection reset by peer")
	s := &scriptedSession{lookupErr: boom}

	_, err := s.processor().HandleSessionEnd(context.Background(), sessionEndEvent(true))
	if !errors.Is(err, boom) {
		t.Fatalf("expected the lookup error so the consumer NAKs, got %v", err)
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
	s := &scriptedSession{state: sessionLookupMissing}
	p := &Processor{session: s.processor()}

	if err := p.Process(context.Background(), sessionEndEvent(true)); err != nil {
		t.Fatalf("expected a clean ACK (nil) for a dropped session_end, got %v", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonOrphanSessionEnd]; got != 1 {
		t.Fatalf("expected one orphan_session_end drop, got %d", got)
	}
}

func TestProcess_PassesARetryRequestToTheConsumer(t *testing.T) {
	metrics.Reset()
	s := &scriptedSession{state: sessionLookupMissing}
	p := &Processor{session: s.processor()}

	err := p.Process(context.Background(), sessionEndEvent(false))
	if !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("expected ErrRetryLater to reach the consumer unchanged, got %v", err)
	}
}
