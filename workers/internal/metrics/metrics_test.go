package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIncrDroppedStartsAtZeroAndCountsUp(t *testing.T) {
	Reset()
	// Unknown reason yields zero via Snapshot (missing key = not
	// present in the map, but Snapshot is exhaustive over known keys
	// only -- callers walk the returned map explicitly).
	if snap := Snapshot(); len(snap) != 0 {
		t.Fatalf("Snapshot on fresh registry should be empty, got %v", snap)
	}

	IncrDropped(ReasonOrphanSessionEnd)
	IncrDropped(ReasonOrphanSessionEnd)
	IncrDropped(ReasonUnmarshalError)

	snap := Snapshot()
	if snap[ReasonOrphanSessionEnd] != 2 {
		t.Errorf("orphan_session_end: want 2, got %d", snap[ReasonOrphanSessionEnd])
	}
	if snap[ReasonUnmarshalError] != 1 {
		t.Errorf("unmarshal_error: want 1, got %d", snap[ReasonUnmarshalError])
	}
	if snap[ReasonClosedSessionSkip] != 0 {
		t.Errorf("closed_session_skip: never incremented, want 0, got %d",
			snap[ReasonClosedSessionSkip])
	}
}

func TestSnapshotIsStableCopy(t *testing.T) {
	Reset()
	IncrDropped(ReasonOrphanSessionEnd)
	snap := Snapshot()
	// Further increments must not mutate the returned snapshot.
	IncrDropped(ReasonOrphanSessionEnd)
	if snap[ReasonOrphanSessionEnd] != 1 {
		t.Errorf("snapshot mutated after further IncrDropped: got %d",
			snap[ReasonOrphanSessionEnd])
	}
	// Calling Snapshot again must reflect the new state.
	if Snapshot()[ReasonOrphanSessionEnd] != 2 {
		t.Errorf("new snapshot should read live counter")
	}
}

func TestHandlerEmitsSortedTextFormat(t *testing.T) {
	Reset()
	IncrDropped(ReasonUnmarshalError)
	IncrDropped(ReasonFKViolation)
	IncrDropped(ReasonFKViolation)

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	// Deterministic ordering by reason alphabetical: fk_violation
	// should come before unmarshal_error.
	fkIdx := strings.Index(body, "fk_violation")
	umIdx := strings.Index(body, "unmarshal_error")
	if fkIdx == -1 || umIdx == -1 {
		t.Fatalf("missing counters in output: %q", body)
	}
	if fkIdx > umIdx {
		t.Errorf("output not sorted: fk_violation@%d should precede unmarshal_error@%d\n%s",
			fkIdx, umIdx, body)
	}
	if !strings.Contains(body, `dropped_events_total{reason="fk_violation"} 2`) {
		t.Errorf("expected structured line for fk_violation=2, got: %s", body)
	}
	if !strings.Contains(body, `dropped_events_total{reason="unmarshal_error"} 1`) {
		t.Errorf("expected structured line for unmarshal_error=1, got: %s", body)
	}
}

func TestIncrSessionClosedCountsAndExposesViaHandler(t *testing.T) {
	Reset()

	if snap := SnapshotClosed(); len(snap) != 0 {
		t.Fatalf("SnapshotClosed on fresh registry should be empty, got %v", snap)
	}

	IncrSessionClosed(CloseReasonOrphanTimeout)
	IncrSessionClosed(CloseReasonOrphanTimeout)
	IncrSessionClosed(CloseReasonOrphanTimeout)

	if got := SnapshotClosed()[CloseReasonOrphanTimeout]; got != 3 {
		t.Errorf("orphan_timeout: want 3, got %d", got)
	}

	// Reset clears closed counters as well as dropped counters.
	IncrDropped(ReasonOrphanSessionEnd)
	Reset()
	if got := SnapshotClosed()[CloseReasonOrphanTimeout]; got != 0 {
		t.Errorf("Reset did not clear closed counters: orphan_timeout=%d", got)
	}
	if got := Snapshot()[ReasonOrphanSessionEnd]; got != 0 {
		t.Errorf("Reset did not clear dropped counters: orphan_session_end=%d", got)
	}

	// Re-incr post-Reset and verify the /metrics handler emits the
	// sessions_closed_total line in the trivial text format.
	IncrSessionClosed(CloseReasonOrphanTimeout)
	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `sessions_closed_total{reason="orphan_timeout"} 1`) {
		t.Errorf("expected sessions_closed_total line, got: %s", body)
	}
}

func TestConcurrentIncrDroppedDoesNotRace(t *testing.T) {
	// Each goroutine increments the same reason; final count must
	// equal iterations * workers (no lost updates under the
	// sync/atomic path).
	Reset()
	const workers = 8
	const iterations = 1000
	done := make(chan struct{}, workers)
	for i := 0; i < workers; i++ {
		go func() {
			for j := 0; j < iterations; j++ {
				IncrDropped(ReasonOrphanSessionEnd)
			}
			done <- struct{}{}
		}()
	}
	for i := 0; i < workers; i++ {
		<-done
	}
	got := Snapshot()[ReasonOrphanSessionEnd]
	want := uint64(workers * iterations)
	if got != want {
		t.Errorf("race detected or counter lost updates: got %d, want %d", got, want)
	}
}

func TestIncrSessionClosedN_BatchAddSemantics(t *testing.T) {
	Reset()

	// n=0 must be a no-op (no map allocation, no counter creation).
	IncrSessionClosedN(CloseReasonOrphanTimeout, 0)
	if got := SnapshotClosed()[CloseReasonOrphanTimeout]; got != 0 {
		t.Errorf("n=0: want 0, got %d", got)
	}

	// Single batch adds n.
	IncrSessionClosedN(CloseReasonOrphanTimeout, 5)
	if got := SnapshotClosed()[CloseReasonOrphanTimeout]; got != 5 {
		t.Errorf("after batch=5: want 5, got %d", got)
	}

	// Mixed with single Incr — both feed the same counter.
	IncrSessionClosed(CloseReasonOrphanTimeout)
	IncrSessionClosedN(CloseReasonOrphanTimeout, 3)
	if got := SnapshotClosed()[CloseReasonOrphanTimeout]; got != 9 {
		t.Errorf("after 5 + 1 + 3: want 9, got %d", got)
	}
}

func TestConcurrentIncrSessionClosedDoesNotRace(t *testing.T) {
	// Mirrors TestConcurrentIncrDroppedDoesNotRace for the
	// closedSessions sharded map. Without this the race detector
	// never exercises the closedMu upgrade path; a future refactor
	// could break the double-checked locking in ensureCloseCounter
	// without any test flagging it.
	Reset()
	const workers = 8
	const iterations = 1000
	done := make(chan struct{}, workers)
	for i := 0; i < workers; i++ {
		go func() {
			for j := 0; j < iterations; j++ {
				IncrSessionClosed(CloseReasonOrphanTimeout)
			}
			done <- struct{}{}
		}()
	}
	for i := 0; i < workers; i++ {
		<-done
	}
	got := SnapshotClosed()[CloseReasonOrphanTimeout]
	want := uint64(workers * iterations)
	if got != want {
		t.Errorf("race detected or counter lost updates: got %d, want %d", got, want)
	}
}
